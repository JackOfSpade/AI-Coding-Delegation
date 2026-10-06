import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 as windowsPath } from 'node:path';
import { gunzipSync } from 'node:zlib';

function tarEntries(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/, '');
    const size = Number.parseInt(text(124, 12).trim() || '0', 8);
    const type = text(156, 1) || '0';
    const name = `${text(345, 155)}${text(345, 155) ? '/' : ''}${text(0, 100)}`;
    entries.push({ name, type, body: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function extractPackage(archive, destination) {
  for (const entry of tarEntries(await readFile(archive))) {
    if (!entry.name.startsWith('package/') || entry.name.includes('..')) throw new Error(`unsafe npm tar entry: ${entry.name}`);
    const relative = entry.name.slice('package/'.length);
    if (!relative) continue;
    const path = join(destination, relative);
    if (entry.type === '5') await mkdir(path, { recursive: true });
    else if (entry.type === '0' || entry.type === '\0') {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, entry.body);
    } else throw new Error(`unsupported npm tar entry type: ${entry.type}`);
  }
}

function windowsNpmPackInvocation(args, options, nodeExecutable = process.execPath) {
  // npm run supplies npm_execpath.  The sibling path lets direct `node --test`
  // invocations work too.  Execute npm's JavaScript entry point with Node so
  // a path containing spaces remains a single argv value instead of crossing
  // cmd.exe's nested command/batch-file quote parsing.
  const npmExecPath = options.env?.npm_execpath;
  const npmCli =
    typeof npmExecPath === 'string' && npmExecPath.endsWith('npm-cli.js')
      ? npmExecPath
      : windowsPath.join(windowsPath.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return { command: nodeExecutable, args: [npmCli, ...args] };
}

function npmPack(args, options) {
  if (process.platform !== 'win32') return execFileSync('npm', args, options);
  const invocation = windowsNpmPackInvocation(args, options);
  const result = spawnSync(invocation.command, invocation.args, { ...options, shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `npm pack failed with exit ${result.status ?? 'unknown'}: stderr=${JSON.stringify(result.stderr || '')}; stdout=${JSON.stringify(result.stdout || '')}`,
    );
  return result.stdout;
}

function npmInstall(args, options) {
  if (process.platform !== 'win32') {
    const result = spawnSync('npm', args, { ...options, shell: false, windowsHide: true });
    if (result.error) throw result.error;
    return result;
  }
  const invocation = windowsNpmPackInvocation(args, options);
  const result = spawnSync(invocation.command, invocation.args, { ...options, shell: false, windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

test('Windows npm packing calls npm CLI without cmd.exe argument reparsing', () => {
  const invocation = windowsNpmPackInvocation(
    ['pack', '--pack-destination', 'C:\\temporary path\\offload package'],
    { env: { npm_execpath: 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js' } },
    'C:\\node\\node.exe',
  );
  assert.deepEqual(invocation, {
    command: 'C:\\node\\node.exe',
    args: ['C:\\node\\node_modules\\npm\\bin\\npm-cli.js', 'pack', '--pack-destination', 'C:\\temporary path\\offload package'],
  });
});

test('the npm package contains the runnable product and excludes legacy or test artifacts', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'offload-npm-cache-'));
  try {
    const result = JSON.parse(
      npmPack(['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, npm_config_cache: cache, npm_config_ignore_scripts: 'true' },
      }),
    );
    assert.equal(result.length, 1);
    const paths = new Set(result[0].files.map((file) => file.path));
    for (const path of [
      'bin/offload.mjs',
      'install.mjs',
      'config.example.json',
      'templates/CLAUDE.md.block.md',
      'templates/AGENTS.md.block.md',
      'plugins/offload/plugin.json',
      'plugins/offload/.codex-plugin/plugin.json',
      'plugins/offload/skills/offload/SKILL.md',
    ])
      assert.equal(paths.has(path), true, `${path} must ship`);
    assert.ok(paths.has('docs/TESTING.md'));
    assert.ok(paths.has('docs/spikes/01-deepseek-facts.md'));
    assert.ok(paths.has('docs/spikes/02-openai-surface.md'));
    assert.equal(
      [...paths].some((path) => path.startsWith('docs/spikes/archive-claude-p/')),
      false,
    );
    assert.equal(
      [...paths].some((path) => path.startsWith('test/')),
      false,
    );
    assert.equal(paths.has('templates/commands/offload.md'), false, 'the legacy duplicate command must not ship');
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test('the extracted npm package installs, serves MCP, and uninstalls without touching the real home', async () => {
  // Keep a space in the path to exercise cmd.exe argument quoting on Windows.
  const temporary = await mkdtemp(join(tmpdir(), 'offload packed-'));
  const cache = join(temporary, 'npm-cache');
  const destination = join(temporary, 'package');
  const home = join(temporary, 'home');
  const configHome = join(temporary, 'config');
  try {
    await mkdir(cache, { recursive: true });
    const packed = JSON.parse(
      npmPack(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, npm_config_cache: cache, npm_config_ignore_scripts: 'true' },
      }),
    );
    assert.equal(packed.length, 1);
    const archives = (await readdir(temporary)).filter((name) => name.endsWith('.tgz'));
    assert.deepEqual(archives, [packed[0].filename]);
    await extractPackage(join(temporary, archives[0]), destination);
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: configHome,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      // Package tests must never invoke a host Claude installation. Dedicated
      // installer tests inject a fake official CLI and cover registration.
      PATH: join(temporary, 'no-claude-on-path'),
    };
    const install = spawnSync(process.execPath, ['install.mjs', '--skip-key', '--clients=claude,codex,cursor'], {
      cwd: destination,
      encoding: 'utf8',
      timeout: 10_000,
      env,
    });
    assert.ok([0, 2].includes(install.status), install.stderr || install.stdout);
    assert.match(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8'), /BEGIN offload/);
    assert.match(await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8'), /BEGIN offload/);
    const requests =
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'server/discover',
          params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'skills/list',
          params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
        },
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'skills/get',
          params: {
            uri: 'skill://offload/offload/SKILL.md',
            _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
          },
        },
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'resources/read',
          params: {
            uri: 'skill://offload/offload/SKILL.md',
            _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
          },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n';
    const mcp = spawn(process.execPath, ['bin/offload.mjs', 'mcp'], { cwd: destination, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderrText = '';
    mcp.stdout.setEncoding('utf8');
    mcp.stderr.setEncoding('utf8');
    mcp.stderr.on('data', (value) => {
      stderrText += value;
    });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        mcp.kill('SIGKILL');
        reject(new Error(`packed MCP discovery timed out: ${stderrText}`));
      }, 5_000);
      mcp.stdout.on('data', (value) => {
        stdout += value;
        if (stdout.trim().split('\n').filter(Boolean).length >= 5) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    mcp.stdin.write(requests);
    await ready;
    mcp.stdin.end();
    const exit = await new Promise((resolve) => mcp.once('exit', resolve));
    assert.equal(exit, 0, stderrText);
    const replies = stdout.trim().split('\n').map(JSON.parse);
    const byId = (id) => replies.find((reply) => reply.id === id).result;
    assert.equal(byId(1).serverInfo.name, 'offload');
    assert.equal(byId(2).resultType, 'complete');
    const skillText = await readFile(join(destination, 'plugins', 'offload', 'skills', 'offload', 'SKILL.md'), 'utf8');
    const pluginManifest = JSON.parse(await readFile(join(destination, 'plugins', 'offload', 'plugin.json'), 'utf8'));
    const codexPluginManifest = JSON.parse(await readFile(join(destination, 'plugins', 'offload', '.codex-plugin', 'plugin.json'), 'utf8'));
    for (const manifest of [pluginManifest, codexPluginManifest]) {
      assert.match(manifest.description, /only after an explicit \/offload slash-command invocation/);
      assert.match(manifest.description, /ordinary prose does not invoke it/);
      assert.doesNotMatch(manifest.description, /delegate|delegation|DeepSeek|implementation|testing|debugging|analysis/i);
      assert.deepEqual(manifest.keywords, ['slash-command']);
    }
    assert.equal(codexPluginManifest.interface.shortDescription, 'Explicit /offload slash command only');
    assert.match(codexPluginManifest.interface.longDescription, /only after the user explicitly enters \/offload/);
    assert.doesNotMatch(
      codexPluginManifest.interface.longDescription,
      /delegate|delegation|DeepSeek|implementation|testing|debugging|analysis/i,
    );
    assert.deepEqual(codexPluginManifest.interface.defaultPrompt, ['/offload ']);
    assert.match(skillText, /Run only after the user explicitly enters \/offload as a slash command/);
    assert.match(skillText, /Ordinary prose does not invoke this skill/);
    assert.doesNotMatch(
      skillText.match(/^---[\s\S]*?---/)?.[0] || '',
      /delegate|delegation|DeepSeek|implementation|testing|debugging|analysis/i,
    );
    assert.match(skillText, /On macOS, `\/private\/tmp` is also accepted/);
    assert.match(skillText, /If the pre-job rejection identifies canonical allowed roots/);
    const resource = {
      uri: 'skill://offload/offload/SKILL.md',
      digest: `sha256:${createHash('sha256').update(Buffer.from(skillText)).digest('hex')}`,
      size: Buffer.byteLength(skillText),
    };
    assert.deepEqual(byId(3).skills[0].resources, [resource]);
    assert.deepEqual(byId(4).skill, byId(3).skills[0]);
    assert.deepEqual(byId(5).contents, [{ uri: resource.uri, mimeType: 'text/markdown', text: skillText }]);
    const uninstall = spawnSync(process.execPath, ['install.mjs', '--uninstall', '--clients=claude,codex,cursor'], {
      cwd: destination,
      encoding: 'utf8',
      timeout: 10_000,
      env,
    });
    assert.ok([0, 2].includes(uninstall.status), uninstall.stderr || uninstall.stdout);
    assert.doesNotMatch(await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8'), /BEGIN offload/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a packed global install is a package copy whose installer registers its own MCP binary', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'offload packed-global-'));
  const cache = join(temporary, 'npm-cache');
  const prefix = join(temporary, 'prefix');
  const home = join(temporary, 'home');
  const configHome = join(temporary, 'config');
  try {
    await mkdir(cache, { recursive: true });
    const packed = JSON.parse(
      npmPack(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, npm_config_cache: cache, npm_config_ignore_scripts: 'true' },
      }),
    );
    assert.equal(packed.length, 1);
    const archive = join(temporary, packed[0].filename);
    const installPackage = npmInstall(['install', '--global', '--prefix', prefix, archive, '--ignore-scripts'], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, npm_config_cache: cache, npm_config_ignore_scripts: 'true' },
    });
    assert.equal(installPackage.status, 0, installPackage.stderr || installPackage.stdout);

    const installedRoot = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'offload');
    assert.equal((await lstat(installedRoot)).isSymbolicLink(), false, 'tarball installation must not link the source checkout');
    assert.notEqual(
      await realpath(installedRoot),
      await realpath(process.cwd()),
      'installed package root must differ from the source checkout',
    );

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: configHome,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      PATH: join(temporary, 'no-claude-on-path'),
    };
    const runInstaller = spawnSync(process.execPath, ['install.mjs', '--skip-key', '--clients=claude'], {
      cwd: installedRoot,
      encoding: 'utf8',
      timeout: 10_000,
      env,
    });
    assert.ok([0, 2].includes(runInstaller.status), runInstaller.stderr || runInstaller.stdout);
    const installerResult = JSON.parse(runInstaller.stdout);
    assert.equal(installerResult.claudeMcp.status, 'unavailable');
    await assert.rejects(readFile(join(home, '.claude', '.claude.json'), 'utf8'), /ENOENT/);

    const uninstall = spawnSync(process.execPath, ['install.mjs', '--uninstall', '--clients=claude'], {
      cwd: installedRoot,
      encoding: 'utf8',
      timeout: 10_000,
      env,
    });
    assert.ok([0, 2].includes(uninstall.status), uninstall.stderr || uninstall.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
