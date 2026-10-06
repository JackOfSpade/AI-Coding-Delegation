import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter, join, posix, resolve, win32 } from 'node:path';
import { checkSyntaxTargets, discoverSyntaxTargets } from '../../scripts/check-syntax.mjs';
import {
  collectPackageTargets,
  isForbiddenPackagePath,
  npmPackCommand,
  npmPackEnvironment,
  validateOffloadPluginArtifacts,
} from '../../scripts/package-gate.mjs';
import { analyzeStrictSkips, parseTapSkips } from '../run-suite.mjs';
import { runCiTests } from '../../scripts/test-ci.mjs';
import { cleanArtifacts } from '../../scripts/clean-artifacts.mjs';
import { acquireArtifactLease, artifactLeaseRoot, formatArtifactLeaseMarker } from '../../scripts/artifact-lease.mjs';
import { coverageInvocation, runCoverage } from '../../scripts/run-coverage.mjs';
import { npmInvocation, runReleaseCheck } from '../../scripts/release-check.mjs';
import { LeaseError } from '../../src/lease.mjs';

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
    'ok 3 - macOS sandbox gives Node a physical disposable temp root and read-only private-worktree parent traversal # SKIP requires an available macOS sandbox',
    'ok 4 - newly skipped regression # SKIP oops',
    '# ok 5 - diagnostic text # SKIP oops',
    'ok 6 - text mentioning a skip but lacking a directive # TODO later',
  ].join('\r\n');
  assert.deepEqual(parseTapSkips(tap), [
    { number: 1, name: 'macOS sandbox blocks out-of-scope and git writes', reason: '' },
    { number: 2, name: 'nested loopback', reason: 'loopback networking is unavailable in this sandbox' },
    {
      number: 3,
      name: 'macOS sandbox gives Node a physical disposable temp root and read-only private-worktree parent traversal',
      reason: 'requires an available macOS sandbox',
    },
    { number: 4, name: 'newly skipped regression', reason: 'oops' },
  ]);
  const result = analyzeStrictSkips(tap);
  assert.equal(result.loopbackSkips.length, 1);
  assert.deepEqual(result.unapprovedSkips, [{ number: 4, name: 'newly skipped regression', reason: 'oops' }]);
});

test('CI test launcher preserves a strict runner failure exit code', async () => {
  const calls = [];
  const child = {
    once(event, listener) {
      if (event === 'exit') queueMicrotask(() => listener(1));
      return this;
    },
  };
  const code = await runCiTests({
    cwd: '/test/root',
    environment: { PATH: '/bin', OFFLOAD_TEST_SUMMARY_FILE: '/tmp/offload-test-summary.json' },
    platform: 'linux',
    makeDirectory: async (directory, options) => calls.push({ directory, options }),
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(calls[0], {
    directory: '/tmp',
    options: { recursive: true },
  });
  assert.deepEqual(calls[1], {
    command: process.execPath,
    args: ['test/run-suite.mjs', 'all'],
    options: {
      cwd: '/test/root',
      env: { PATH: '/bin', OFFLOAD_REQUIRE_LOOPBACK: '1', OFFLOAD_TEST_SUMMARY_FILE: '/tmp/offload-test-summary.json' },
      stdio: 'inherit',
      windowsHide: true,
    },
  });
});

test('CI test launcher publishes its private diagnostic summary under a reentrant artifact lease', async () => {
  const calls = [];
  const temporaryDirectory = '/tmp/private-summary';
  const summaryFile = posix.resolve(temporaryDirectory, 'test-summary.json');
  const publishedSummary = posix.join('/repo', 'artifacts', 'test-summary.json');
  const code = await runCiTests({
    cwd: '/repo',
    environment: { PATH: '/bin' },
    platform: 'linux',
    createTemporaryDirectory: async () => temporaryDirectory,
    makeDirectory: async () => {},
    checkAccess: async (path) => calls.push(['access', path]),
    acquireLease: async (options) => {
      calls.push(['acquire', options]);
      return { release: () => calls.push(['release']) };
    },
    publishFile: async (options) => calls.push(['publish', options]),
    remove: async (path, options) => calls.push(['rm', path, options]),
    spawnProcess: () => fakeCoverageChild(1),
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, [
    ['access', summaryFile],
    ['acquire', { cwd: '/repo', environment: { PATH: '/bin' }, platform: 'linux' }],
    ['publish', { source: summaryFile, destination: publishedSummary, platform: 'linux' }],
    ['release'],
    ['rm', temporaryDirectory, { recursive: true, force: true }],
  ]);
});

test('CI test launcher uses injected Windows paths for its private summary publication', async () => {
  const calls = [];
  const temporaryDirectory = 'C:\\Temp\\private-summary';
  const summaryFile = win32.resolve(temporaryDirectory, 'test-summary.json');
  const publishedSummary = win32.join('C:\\repo', 'artifacts', 'test-summary.json');
  const code = await runCiTests({
    cwd: 'C:\\repo',
    environment: { PATH: 'C:\\Windows\\System32' },
    platform: 'win32',
    createTemporaryDirectory: async () => temporaryDirectory,
    makeDirectory: async () => {},
    checkAccess: async (path) => calls.push(['access', path]),
    acquireLease: async (options) => {
      calls.push(['acquire', options]);
      return { release: () => calls.push(['release']) };
    },
    publishFile: async (options) => calls.push(['publish', options]),
    remove: async (path, options) => calls.push(['rm', path, options]),
    spawnProcess: () => fakeCoverageChild(1),
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, [
    ['access', summaryFile],
    ['acquire', { cwd: 'C:\\repo', environment: { PATH: 'C:\\Windows\\System32' }, platform: 'win32' }],
    ['publish', { source: summaryFile, destination: publishedSummary, platform: 'win32' }],
    ['release'],
    ['rm', temporaryDirectory, { recursive: true, force: true }],
  ]);
});

test('artifact cleanup holds the shared lease while deleting both public roots', async () => {
  const calls = [];
  await cleanArtifacts({
    cwd: '/repo',
    environment: { OFFLOAD_ARTIFACT_LEASE: 'marker' },
    platform: 'linux',
    acquireLease: async (options) => {
      calls.push(['acquire', options]);
      return { release: () => calls.push(['release']) };
    },
    remove: async (path, options) => calls.push(['rm', path, options]),
  });
  assert.deepEqual(calls, [
    ['acquire', { cwd: '/repo', environment: { OFFLOAD_ARTIFACT_LEASE: 'marker' }, platform: 'linux' }],
    ['rm', posix.join('/repo', 'artifacts'), { recursive: true, force: true }],
    ['rm', posix.join('/repo', 'coverage'), { recursive: true, force: true }],
    ['release'],
  ]);
});

test('artifact cleanup uses injected Windows path semantics', async () => {
  const calls = [];
  await cleanArtifacts({
    cwd: 'C:\\repo',
    environment: { OFFLOAD_ARTIFACT_LEASE: 'marker' },
    platform: 'win32',
    acquireLease: async (options) => {
      calls.push(['acquire', options]);
      return { release: () => calls.push(['release']) };
    },
    remove: async (path, options) => calls.push(['rm', path, options]),
  });
  assert.deepEqual(calls, [
    ['acquire', { cwd: 'C:\\repo', environment: { OFFLOAD_ARTIFACT_LEASE: 'marker' }, platform: 'win32' }],
    ['rm', win32.join('C:\\repo', 'artifacts'), { recursive: true, force: true }],
    ['rm', win32.join('C:\\repo', 'coverage'), { recursive: true, force: true }],
    ['release'],
  ]);
});

function fakeCoverageChild(exitCode) {
  return {
    once(event, listener) {
      if (event === 'exit') queueMicrotask(() => listener(exitCode));
      return this;
    },
  };
}

test('coverage runner invokes c8 through Node with isolated cross-platform paths', () => {
  const unix = coverageInvocation({
    c8: '/deps/c8.js',
    cwd: '/repo',
    temporaryDirectory: '/tmp/offload-coverage-a',
    node: '/node',
    platform: 'linux',
  });
  assert.equal(unix.command, '/node');
  assert.deepEqual(unix.args.slice(0, 10), [
    '/deps/c8.js',
    '--all',
    '--include=src/**/*.mjs',
    '--reporter=text',
    '--reporter=json-summary',
    '--reports-dir=/tmp/offload-coverage-a/reports',
    '--temp-directory=/tmp/offload-coverage-a/v8',
    '--check-coverage',
    '--lines=90',
    '--functions=90',
  ]);
  assert.deepEqual(unix.args.slice(-2), ['/node', '/repo/scripts/test-ci.mjs']);
  const windows = coverageInvocation({
    c8: 'C:\\deps\\c8.js',
    cwd: 'C:\\repo',
    temporaryDirectory: 'C:\\Temp\\offload-coverage-a',
    node: 'C:\\node\\node.exe',
    platform: 'win32',
  });
  assert.equal(windows.command, 'C:\\node\\node.exe');
  assert.ok(windows.args.includes('--reports-dir=C:\\Temp\\offload-coverage-a\\reports'));
  assert.ok(windows.args.includes('--temp-directory=C:\\Temp\\offload-coverage-a\\v8'));
  assert.deepEqual(windows.args.slice(-2), ['C:\\node\\node.exe', 'C:\\repo\\scripts\\test-ci.mjs']);
});

test('coverage runner publishes isolated reports only after a successful c8 exit and always cleans up', async () => {
  const calls = [];
  const code = await runCoverage({
    cwd: '/repo',
    platform: 'linux',
    environment: { PATH: '/bin' },
    c8: '/deps/c8.js',
    node: '/node',
    temporaryRoot: '/tmp',
    createTemporaryDirectory: async (prefix) => {
      calls.push(['mkdtemp', prefix]);
      return '/tmp/offload-coverage-fixed';
    },
    spawnProcess: (command, args, options) => {
      calls.push(['spawn', command, args, options]);
      return fakeCoverageChild(0);
    },
    checkAccess: async (path) => calls.push(['access', path]),
    makeDirectory: async (path, options) => calls.push(['mkdir', path, options]),
    copy: async (source, destination) => calls.push(['copy', source, destination]),
    move: async (source, destination) => calls.push(['rename', source, destination]),
    remove: async (path, options) => calls.push(['rm', path, options]),
    unique: () => 'unique',
    pid: 123,
    acquireLease: async () => ({ release: () => calls.push(['release-lease']) }),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls[0], ['mkdtemp', '/tmp/offload-coverage-']);
  assert.deepEqual(calls[1], [
    'spawn',
    '/node',
    [
      '/deps/c8.js',
      '--all',
      '--include=src/**/*.mjs',
      '--reporter=text',
      '--reporter=json-summary',
      '--reports-dir=/tmp/offload-coverage-fixed/reports',
      '--temp-directory=/tmp/offload-coverage-fixed/v8',
      '--check-coverage',
      '--lines=90',
      '--functions=90',
      '--branches=72',
      '/node',
      '/repo/scripts/test-ci.mjs',
    ],
    {
      cwd: '/repo',
      env: { PATH: '/bin', OFFLOAD_TEST_SUMMARY_FILE: '/tmp/offload-coverage-fixed/test-summary.json' },
      stdio: 'inherit',
      windowsHide: true,
    },
  ]);
  assert.deepEqual(
    calls.filter(([operation]) => operation === 'access'),
    [
      ['access', '/tmp/offload-coverage-fixed/reports/coverage-summary.json'],
      ['access', '/tmp/offload-coverage-fixed/test-summary.json'],
    ],
  );
  assert.deepEqual(
    calls.filter(([operation]) => operation === 'rename'),
    [
      ['rename', '/repo/coverage/.coverage-summary.json.123.unique.tmp', '/repo/coverage/coverage-summary.json'],
      ['rename', '/repo/artifacts/.test-summary.json.123.unique.tmp', '/repo/artifacts/test-summary.json'],
    ],
  );
  assert.deepEqual(calls.at(-1), ['rm', '/tmp/offload-coverage-fixed', { recursive: true, force: true }]);
});

test('coverage runner propagates c8 failure without reading or publishing generated artifacts', async () => {
  const calls = [];
  const code = await runCoverage({
    cwd: '/repo',
    platform: 'linux',
    createTemporaryDirectory: async () => '/tmp/offload-coverage-fixed',
    spawnProcess: () => fakeCoverageChild(7),
    checkAccess: async () => calls.push('access'),
    makeDirectory: async () => calls.push('mkdir'),
    copy: async () => calls.push('copy'),
    move: async () => calls.push('rename'),
    remove: async (path, options) => calls.push(['rm', path, options]),
  });
  assert.equal(code, 7);
  assert.deepEqual(calls, [['rm', '/tmp/offload-coverage-fixed', { recursive: true, force: true }]]);
});

test('artifact lease root is a private stable hash of the canonical workspace on each platform', () => {
  const posixRoot = artifactLeaseRoot({
    cwd: '/workspace/alias',
    platform: 'linux',
    temporaryRoot: '/tmp',
    realpath: () => '/workspace/actual',
  });
  assert.equal(
    posixRoot,
    artifactLeaseRoot({ cwd: '/workspace/actual', platform: 'linux', temporaryRoot: '/tmp', realpath: (path) => path }),
  );
  assert.notEqual(
    posixRoot,
    artifactLeaseRoot({ cwd: '/workspace/other', platform: 'linux', temporaryRoot: '/tmp', realpath: (path) => path }),
  );
  assert.ok(posixRoot.startsWith('/tmp/offload-artifact-leases/'));
  assert.equal(posixRoot.includes('workspace'), false);
  assert.notEqual(
    artifactLeaseRoot({
      cwd: 'C:\\REPO',
      platform: 'win32',
      temporaryRoot: 'C:\\Temp',
      realpath: (path) => path,
    }),
    artifactLeaseRoot({
      cwd: 'c:\\repo',
      platform: 'win32',
      temporaryRoot: 'C:\\Temp',
      realpath: (path) => path,
    }),
  );
  const canonicalWindowsWorkspace = 'C:\\\\Repo';
  assert.equal(
    artifactLeaseRoot({
      cwd: 'c:/repo',
      platform: 'win32',
      temporaryRoot: 'C:\\\\Temp',
      realpath: () => canonicalWindowsWorkspace,
    }),
    artifactLeaseRoot({
      cwd: '\\\\?\\C:\\\\REPO',
      platform: 'win32',
      temporaryRoot: 'C:\\\\Temp',
      realpath: () => canonicalWindowsWorkspace,
    }),
  );
  const canonicalUncWorkspace = '\\\\server\\share\\repo';
  assert.equal(
    artifactLeaseRoot({
      cwd: '\\\\?\\UNC\\server\\share\\repo',
      platform: 'win32',
      temporaryRoot: 'C:\\\\Temp',
      realpath: () => canonicalUncWorkspace,
    }),
    artifactLeaseRoot({
      cwd: canonicalUncWorkspace,
      platform: 'win32',
      temporaryRoot: 'C:\\\\Temp',
      realpath: () => canonicalUncWorkspace,
    }),
  );
});

test('artifact lease gives release a fresh retry window after acquisition contention', async () => {
  let clock = 0;
  let acquires = 0;
  let releases = 0;
  const manager = {
    acquire() {
      acquires += 1;
      if (acquires === 1) throw new LeaseError('busy', 'E_LEASE_BUSY');
    },
    release() {
      releases += 1;
      if (releases === 1) throw new LeaseError('busy', 'E_LEASE_BUSY');
      return true;
    },
  };
  const lease = await acquireArtifactLease({
    cwd: '/repo',
    // The release gate deliberately passes its marker to every test process.
    // This unit exercises a new local acquisition, not inherited reentrancy;
    // isolate it from that ambient parent lease so the stub need only model
    // acquire/release contention.
    environment: {},
    platform: 'linux',
    maxWaitMs: 10,
    retryMs: 1,
    now: () => clock,
    wait: async () => {
      // Make acquisition consume its entire window. Release must not reuse it.
      clock = 10;
    },
    createId: () => '1234567890123456',
    temporaryRoot: '/tmp',
    realpath: (path) => path,
    ensureDirectory: () => {},
    makeLeaseManager: () => manager,
  });
  assert.equal(acquires, 2);
  assert.equal(await lease.release(), true);
  assert.equal(releases, 2);
});

test('inherited artifact marker rejects a live lease with disjoint owned paths', async () => {
  const marker = {
    jobId: 'quality-artifacts-1234567890123456',
    ownerNonce: '1234567890123456',
    pid: 123,
    workspace: artifactLeaseRoot({ cwd: '/repo', platform: 'linux', temporaryRoot: '/tmp', realpath: (path) => path })
      .split('/')
      .at(-1),
  };
  await assert.rejects(
    acquireArtifactLease({
      cwd: '/repo',
      environment: { OFFLOAD_ARTIFACT_LEASE: formatArtifactLeaseMarker(marker) },
      platform: 'linux',
      temporaryRoot: '/tmp',
      realpath: (path) => path,
      ensureDirectory: () => {},
      makeLeaseManager: () => ({ list: () => [{ ...marker, ownedPaths: ['src/**'] }] }),
    }),
    /does not name a live lease/,
  );
});

test('a marker from another workspace acquires locally without inspecting the parent lease', async () => {
  let acquired = 0;
  const parentWorkspace = artifactLeaseRoot({ cwd: '/parent', platform: 'linux', temporaryRoot: '/tmp', realpath: (path) => path })
    .split('/')
    .at(-1);
  const marker = formatArtifactLeaseMarker({
    jobId: 'quality-artifacts-1234567890123456',
    ownerNonce: '1234567890123456',
    pid: 123,
    workspace: parentWorkspace,
  });
  const lease = await acquireArtifactLease({
    cwd: '/child',
    environment: { OFFLOAD_ARTIFACT_LEASE: marker },
    platform: 'linux',
    temporaryRoot: '/tmp',
    realpath: (path) => path,
    ensureDirectory: () => {},
    createId: () => '1234567890123456',
    makeLeaseManager: () => ({
      list: () => assert.fail('must not inspect a foreign marker'),
      acquire: () => (acquired += 1),
      release: () => true,
    }),
  });
  assert.equal(acquired, 1);
  assert.equal(lease.inherited, false);
});

test('coverage publishers hold the shared artifact lease across both public renames', async () => {
  const events = [];
  let tail = Promise.resolve();
  const acquireLease = async () => {
    const previous = tail;
    let unlock;
    tail = new Promise((resolve) => {
      unlock = resolve;
    });
    await previous;
    return { release: () => unlock() };
  };
  let temporary = 0;
  const run = () =>
    runCoverage({
      cwd: '/repo',
      platform: 'linux',
      createTemporaryDirectory: async () => `/tmp/run-${(temporary += 1)}`,
      spawnProcess: () => fakeCoverageChild(0),
      checkAccess: async () => {},
      makeDirectory: async () => {},
      copy: async (source) => events.push(`copy:${source}`),
      move: async (source, destination) => events.push(`rename:${source}:${destination}`),
      remove: async () => {},
      unique: () => 'unique',
      acquireLease,
    });
  await Promise.all([run(), run()]);
  const renames = events.filter((event) => event.startsWith('rename:'));
  assert.deepEqual(renames, [
    'rename:/repo/coverage/.coverage-summary.json.' + process.pid + '.unique.tmp:/repo/coverage/coverage-summary.json',
    'rename:/repo/artifacts/.test-summary.json.' + process.pid + '.unique.tmp:/repo/artifacts/test-summary.json',
    'rename:/repo/coverage/.coverage-summary.json.' + process.pid + '.unique.tmp:/repo/coverage/coverage-summary.json',
    'rename:/repo/artifacts/.test-summary.json.' + process.pid + '.unique.tmp:/repo/artifacts/test-summary.json',
  ]);
  assert.ok(
    events.indexOf('copy:/tmp/run-1/reports/coverage-summary.json') < events.indexOf('copy:/tmp/run-2/reports/coverage-summary.json'),
  );
});

test('coverage publisher releases the artifact lease if a public rename fails', async () => {
  const events = [];
  let failOnce = true;
  await assert.rejects(
    runCoverage({
      cwd: '/repo',
      platform: 'linux',
      createTemporaryDirectory: async () => '/tmp/run-failure',
      spawnProcess: () => fakeCoverageChild(0),
      checkAccess: async () => {},
      makeDirectory: async () => {},
      copy: async (source, destination) => events.push(`copy:${source}:${destination}`),
      move: async (_source, destination) => {
        events.push(`rename:${_source}:${destination}`);
        if (destination === '/repo/artifacts/test-summary.json' && failOnce) {
          failOnce = false;
          throw new Error('simulated rename failure');
        }
      },
      remove: async () => {},
      acquireLease: async () => ({ release: () => events.push('release') }),
      unique: () => 'unique',
      pid: 123,
    }),
    /simulated rename failure/,
  );
  assert.deepEqual(
    events.filter((event) => event.startsWith('rename:')),
    [
      'rename:/repo/coverage/.coverage-summary.json.123.unique.tmp:/repo/coverage/coverage-summary.json',
      'rename:/repo/artifacts/.test-summary.json.123.unique.tmp:/repo/artifacts/test-summary.json',
      'rename:/repo/coverage/.coverage-summary.json.123.unique.tmp:/repo/coverage/coverage-summary.json',
      'rename:/repo/artifacts/.test-summary.json.123.unique.tmp:/repo/artifacts/test-summary.json',
    ],
  );
  assert.equal(events.at(-1), 'release');
});

test('release gate holds one artifact lease across cleanup and passes it to its coverage child', async () => {
  const events = [];
  const markerValue = '{"version":1,"jobId":"quality-artifacts-1234567890123456","ownerNonce":"1234567890123456","pid":1}';
  const code = await runReleaseCheck({
    cwd: '/repo',
    environment: { PATH: '/bin', npm_execpath: '/deps/npm-cli.js' },
    node: '/node',
    acquireLease: async (options) => {
      events.push(['acquire', options]);
      return { markerValue, release: () => events.push(['release']) };
    },
    spawnProcess: (command, args, options) => {
      events.push(['spawn', command, args, options]);
      return fakeCoverageChild(0);
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(events[0], [
    'acquire',
    { cwd: '/repo', environment: { PATH: '/bin', npm_execpath: '/deps/npm-cli.js' }, platform: process.platform, allowInherited: false },
  ]);
  assert.equal(events.filter(([event]) => event === 'spawn').length, 7);
  assert.equal(events[1][3].env.OFFLOAD_ARTIFACT_LEASE, markerValue);
  assert.deepEqual(events.at(-1), ['release']);
  assert.deepEqual(npmInvocation({ phase: 'coverage', environment: { npm_execpath: '/deps/npm-cli.js' }, node: '/node' }), {
    command: '/node',
    args: ['/deps/npm-cli.js', 'run', 'coverage'],
  });
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
      targets.map((path) => path.slice(directory.length + 1).replaceAll('\\', '/')),
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
    const fakeClaude =
      'const fs=require("fs");const path=require("path");const args=process.argv.slice(1);if(args[0]==="--version")process.exit(0);const file=path.join(process.env.CLAUDE_CONFIG_DIR,".claude.json");const current=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};current.mcpServers||={};if(args[1]==="add"){const mark=args.indexOf("--");current.mcpServers.offload={type:"stdio",command:args[mark+1],args:args.slice(mark+2),env:{}};}else if(args[1]==="remove"){delete current.mcpServers.offload;}else process.exit(2);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(current));';
    await writeFile(
      executable,
      process.platform === 'win32'
        ? `@echo off\r\nnode -e "${fakeClaude.replaceAll('"', '\\"')}" %*\r\n`
        : `#!/bin/sh\nnode -e '${fakeClaude}' "$@"\n`,
    );
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
