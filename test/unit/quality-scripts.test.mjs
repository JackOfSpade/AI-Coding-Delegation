import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter, join, resolve } from 'node:path';
import { checkSyntaxTargets, discoverSyntaxTargets } from '../../scripts/check-syntax.mjs';
import {
  collectPackageTargets,
  isForbiddenPackagePath,
  npmPackCommand,
  npmPackEnvironment,
  validateOffloadPluginArtifacts,
} from '../../scripts/package-gate.mjs';
import { analyzeStrictSkips, parseTapSkips } from '../run-suite.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('package gate validates every exported runtime entry and keeps production dependencies empty', async () => {
  const result = spawnSync(process.execPath, ['scripts/package-gate.mjs'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(join(root, 'artifacts', 'package-contents.json'), 'utf8'));
  assert.deepEqual(summary.missing, []);
  assert.deepEqual(summary.unexpected, []);
  assert.deepEqual(summary.productionDependencies, []);
  assert.deepEqual(summary.lifecycleScripts, []);
  assert.deepEqual(summary.invalidPackageTargets, []);
  assert.deepEqual(summary.pluginArtifacts, []);
  for (const path of ['bin/offload.mjs', 'src/core.mjs', 'src/worktree.mjs']) assert.ok(summary.files.includes(path), `${path} must ship`);
});

test('package gate blocks secret conventions without blocking ordinary source names', () => {
  const blocked = [
    '.netrc',
    'nested/.pypirc',
    'nested/.git-credentials',
    '.pgpass',
    '.aws/credentials',
    'deploy/.ssh/id_ed25519',
    '.azure/accessTokens.json',
    '.kube/config',
    '.config/gcloud/application_default_credentials.json',
    '.docker/config.json',
    '.credentials/token',
    'deploy/credentials/token',
    'nested/credentials.json',
    'nested/credential.yaml',
    'nested/credentials.yml',
    'certs/client.jks',
    'certs/client.keystore',
    'terraform/production.tfstate',
    'terraform/production.tfstate.backup',
    'windows\\.docker\\config.json',
  ];
  const allowed = ['src/credentials.ts', 'src/credential-parser.mjs', 'docs/terraform.tfstate.md', 'src/keyring.mjs', 'docker/config.json'];
  for (const path of blocked) assert.equal(isForbiddenPackagePath(path), true, `${path} must be blocked`);
  for (const path of allowed) assert.equal(isForbiddenPackagePath(path), false, `${path} must be allowed`);
});

test('package gate gives npm an isolated credential-free environment', () => {
  const env = npmPackEnvironment(
    { PATH: '/bin', NPM_TOKEN: 'do-not-leak', OPENAI_API_KEY: 'do-not-leak', npm_config_userconfig: '/host/npmrc' },
    '/tmp/offload-home',
    '/tmp/offload-cache',
    'linux',
  );
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/tmp/offload-home');
  assert.equal(env.npm_config_cache, '/tmp/offload-cache');
  assert.equal(env.npm_config_ignore_scripts, 'true');
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.notEqual(env.npm_config_userconfig, '/host/npmrc');
});

test('package gate selects a runnable npm launcher on Windows', () => {
  assert.equal(npmPackCommand('linux'), 'npm');
  assert.equal(npmPackCommand('win32'), 'npm.cmd');
});

test('strict test runner parses TAP skips and rejects every skip outside the reviewed allowlist', () => {
  const tap = [
    'ok 1 - macOS sandbox blocks out-of-scope and git writes # SKIP',
    '  ok 2 - nested loopback # SKIP loopback networking is unavailable in this sandbox',
    'ok 3 - newly skipped regression # SKIP oops',
    '# ok 4 - diagnostic text # SKIP oops',
    'ok 5 - text mentioning a skip but lacking a directive # TODO later',
  ].join('\r\n');
  assert.deepEqual(parseTapSkips(tap), [
    { number: 1, name: 'macOS sandbox blocks out-of-scope and git writes', reason: '' },
    { number: 2, name: 'nested loopback', reason: 'loopback networking is unavailable in this sandbox' },
    { number: 3, name: 'newly skipped regression', reason: 'oops' },
  ]);
  const result = analyzeStrictSkips(tap);
  assert.equal(result.loopbackSkips.length, 1);
  assert.deepEqual(result.unapprovedSkips, [{ number: 3, name: 'newly skipped regression', reason: 'oops' }]);
});

test('package gate keeps the two plugin manifests semantically aligned and requires JSON skill frontmatter', () => {
  const marketplace = {
    name: 'offload',
    version: '1.2.3',
    description: 'delegate work',
    author: { name: 'Offload' },
    keywords: ['delegation'],
  };
  const codex = { ...marketplace, skills: './skills/' };
  const skill = '---\n{"name":"offload","description":"delegate work"}\n---\n\n# Offload\n';
  assert.deepEqual(validateOffloadPluginArtifacts(marketplace, codex, skill), []);
  assert.deepEqual(validateOffloadPluginArtifacts(marketplace, { ...codex, version: '1.2.4' }, skill), ['plugin manifest version differs']);
  assert.deepEqual(
    validateOffloadPluginArtifacts({ ...marketplace, author: {}, keywords: [] }, { ...codex, author: {}, keywords: [] }, skill),
    [
      'plugin manifest author must have the same non-empty name',
      'plugin manifest keywords must be the same bounded non-empty string array',
    ],
  );
  assert.deepEqual(validateOffloadPluginArtifacts(marketplace, codex, '---\nname: offload\n---\n'), [
    'plugin SKILL.md frontmatter must be strict JSON',
  ]);
});

test('syntax gate includes project scripts while excluding generated and dependency directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'offload-syntax-targets-'));
  try {
    await Promise.all(['scripts', 'src', 'node_modules', 'artifacts', 'coverage', '.cache'].map((name) => mkdir(join(directory, name))));
    await writeFile(join(directory, 'root.mjs'), 'export default 1;\n');
    await Promise.all([
      writeFile(join(directory, 'scripts', 'release.cjs'), 'module.exports = 1;\n'),
      writeFile(join(directory, 'src', 'entry.js'), 'export default 1;\n'),
      writeFile(join(directory, 'node_modules', 'ignored.mjs'), 'not valid JavaScript'),
      writeFile(join(directory, 'artifacts', 'ignored.mjs'), 'not valid JavaScript'),
      writeFile(join(directory, 'coverage', 'ignored.mjs'), 'not valid JavaScript'),
      writeFile(join(directory, '.cache', 'ignored.mjs'), 'not valid JavaScript'),
    ]);
    const targets = await discoverSyntaxTargets(directory);
    assert.deepEqual(
      targets.map((path) => path.slice(directory.length + 1)),
      ['root.mjs', 'scripts/release.cjs', 'src/entry.js'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('syntax gate checks every target rather than passing later files as arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'offload-syntax-invalid-'));
  try {
    await mkdir(join(directory, 'scripts'));
    await writeFile(join(directory, 'a-valid.mjs'), 'export default 1;\n');
    await writeFile(join(directory, 'scripts', 'z-invalid.mjs'), 'function {\n');
    const targets = await discoverSyntaxTargets(directory);
    await assert.rejects(checkSyntaxTargets(targets, { stdio: 'ignore' }), /z-invalid\.mjs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('package gate rejects lifecycle scripts that npm can run during install or publishing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'offload-package-lifecycle-'));
  try {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, files: ['install.mjs'], scripts: { prepare: 'node attack.mjs' } }),
    );
    await writeFile(join(directory, 'install.mjs'), 'export {};\n');
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'package-gate.mjs')], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden lifecycle scripts prepare/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('package gate validates conventional package entry fields as well as exports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'offload-package-entry-'));
  try {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, files: ['install.mjs'], main: 'missing.mjs' }),
    );
    await writeFile(join(directory, 'install.mjs'), 'export {};\n');
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'package-gate.mjs')], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing missing\.mjs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('package targets fail closed for unsafe paths and malformed export targets', () => {
  assert.deepEqual(collectPackageTargets('../outside.mjs', { field: 'main', allowBarePaths: true }), {
    targets: [],
    invalid: ['main: ../outside.mjs'],
  });
  assert.deepEqual(collectPackageTargets({ '.': 'node:fs' }, { field: 'exports', compound: true, allowNull: true }), {
    targets: [],
    invalid: ['exports: node:fs'],
  });
  assert.deepEqual(collectPackageTargets('./src/index.mjs', { field: 'exports', compound: true, allowNull: true }), {
    targets: ['src/index.mjs'],
    invalid: [],
  });
});

test('client smoke validates a disposable registration lifecycle without touching the real home', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'offload-fake-client-'));
  const executable = join(directory, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  try {
    await writeFile(executable, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') await chmod(executable, 0o755);
    const env = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH || process.env.Path || ''}` };
    const result = spawnSync(process.execPath, ['scripts/client-smoke.mjs', '--clients=claude'], {
      cwd: root,
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed install, registration, and uninstall for claude/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
