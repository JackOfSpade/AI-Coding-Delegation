import test from 'node:test';
import assert from 'node:assert/strict';
import { access, constants, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  install as rawInstall,
  isMainModule,
  parseInstallerArgs,
  promptNoEcho,
  replaceManaged,
  sameModulePath,
  scanCodexOffloadToml,
  storeKeychainKey,
} from '../../install.mjs';
import { EventEmitter } from 'node:events';
import { doctor } from '../../src/doctor.mjs';
// Ambient Codex installations are deliberately not part of generic installer
// tests; dedicated plugin cases inject an executable and command runner.
const install = (options) =>
  rawInstall({
    commandExists: async (path) => {
      const pathValue = options?.env?.PATH ?? options?.env?.Path ?? '';
      return String(pathValue)
        .split(/[:;]/)
        .filter(Boolean)
        .some((directory) => path.startsWith(directory));
    },
    ...options,
  });
test('installer main-module detection resolves symlinks and Windows casing without import side effects', async (t) => {
  assert.equal(sameModulePath('C:\\Program Files\\Offload\\INSTALL.MJS', 'c:\\program files\\offload\\install.mjs', 'win32'), true);
  assert.equal(
    isMainModule({
      entry: '/tmp/link.mjs',
      moduleUrl: new URL('../../install.mjs', import.meta.url).href,
      realpath: (path) => (path === '/tmp/link.mjs' ? process.cwd() + '/install.mjs' : path),
    }),
    true,
  );
  const directory = await mkdtemp(`${tmpdir()}/offload-install-link-`);
  const link = join(directory, 'offload-install.mjs');
  try {
    await symlink(join(process.cwd(), 'install.mjs'), link);
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.code || error.message}`);
    return;
  }
  const result = spawnSync(process.execPath, [link, '--doctor-hook'], { cwd: process.cwd(), encoding: 'utf8', timeout: 5_000 });
  assert.ok([0, 2].includes(result.status), result.stderr);
  assert.match(result.stdout, /^offload: node /);
});
test('installer CLI grammar rejects dangerous typos before any install mutation or prompt', async () => {
  assert.deepEqual(parseInstallerArgs(['--skip-key', '--clients', 'claude,codex']), {
    uninstall: false,
    skipKey: true,
    replaceKey: false,
    clients: 'claude,codex',
    doctorHook: false,
  });
  assert.deepEqual(parseInstallerArgs(['--doctor-hook']), {
    uninstall: false,
    skipKey: false,
    replaceKey: false,
    clients: 'detected',
    doctorHook: true,
  });
  for (const args of [
    ['--uninstal'],
    ['--clients'],
    ['--clients='],
    ['--clients=claude', '--clients', 'codex'],
    ['--skip-key', '--skip-key'],
    ['--uninstall', '--replace-key'],
    ['--uninstall', '--skip-key'],
    ['--doctor-hook', '--skip-key'],
    ['unexpected-positional'],
  ])
    assert.throws(
      () => parseInstallerArgs(args),
      /installer option|requires|cannot be combined|cannot be used|unexpected installer argument/,
    );
  const home = await mkdtemp(`${tmpdir()}/offload-cli-home-`);
  const configHome = join(home, 'config');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: configHome,
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
  };
  for (const args of [
    ['--uninstal'],
    ['--clients'],
    ['--uninstall', '--replace-key'],
    ['--clients=claude,'],
    ['--clients=claude,claude'],
    ['stray'],
  ]) {
    const result = spawnSync(process.execPath, ['install.mjs', ...args], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 5_000 });
    assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded`);
    assert.match(result.stderr, /installer option|requires|cannot be used|unexpected installer argument|clients must/);
    await assert.rejects(access(join(configHome, 'offload', 'config.json')), /ENOENT/);
    await assert.rejects(access(join(home, '.codex', 'AGENTS.md')), /ENOENT/);
  }
});
test('installer is idempotent and removes only managed routing blocks', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const root = process.cwd();
  await install({ root, home, configHome: join(home, 'config'), clients: ['claude', 'codex', 'cursor'] });
  await install({ root, home, configHome: join(home, 'config'), clients: ['claude', 'codex', 'cursor'] });
  const doc = await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8');
  assert.equal((doc.match(/BEGIN offload/g) || []).length, 1);
  await install({ root, home, configHome: join(home, 'config'), clients: ['claude', 'codex', 'cursor'], uninstall: true });
  assert.doesNotMatch(await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8'), /BEGIN offload/);
  assert.throws(() => replaceManaged('<!-- BEGIN offload', 'x'), /malformed/);
});
test('installer rejects malformed state before changing client routing files', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const state = join(configHome, 'offload', 'installer-state.json');
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(dirname(state), { recursive: true });
  await writeFile(join(home, '.codex', 'AGENTS.md'), 'user routing\n');
  await writeFile(state, JSON.stringify({ version: 1, registrations: null, files: {} }));
  await assert.rejects(install({ root: process.cwd(), home, configHome, clients: ['codex'] }), /invalid offload installer manifest/);
  assert.equal(await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8'), 'user routing\n');
});
test('installer validates selected client JSON shape before changing routing files', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(join(home, '.codex', 'AGENTS.md'), 'user routing\n');
  await writeFile(join(home, '.cursor', 'mcp.json'), '[]\n');
  await assert.rejects(install({ root: process.cwd(), home, configHome, clients: ['codex', 'cursor'] }), /invalid Cursor MCP JSON/);
  assert.equal(await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8'), 'user routing\n');
});
test(
  'installer refuses a symlinked client config without reading, backing up, or replacing its target',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  async () => {
    const home = await mkdtemp(`${tmpdir()}/offload-home-`);
    const configHome = join(home, 'config');
    const outside = join(home, 'outside-secret.json');
    const cursor = join(home, '.cursor', 'mcp.json');
    await mkdir(dirname(cursor), { recursive: true });
    await writeFile(outside, '{"token":"do-not-copy"}\n');
    await symlink(outside, cursor);
    await assert.rejects(install({ root: process.cwd(), home, configHome, clients: ['cursor'] }), /unsafe installer file/);
    assert.equal(await readFile(outside, 'utf8'), '{"token":"do-not-copy"}\n');
    await assert.rejects(access(`${cursor}.offload.bak`), /ENOENT/);
  },
);
test('installer preserves unrelated MCP configs and macOS key storage uses security’s own prompt', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const root = process.cwd();
  await (await import('node:fs/promises')).mkdir(join(home, '.cursor'), { recursive: true });
  await (await import('node:fs/promises')).writeFile(join(home, '.cursor', 'mcp.json'), '{"mcpServers":{"other":{"command":"x"}}}');
  await install({ root, home, configHome: join(home, 'config'), clients: ['cursor'] });
  const cursor = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cursor.mcpServers.other);
  assert.ok(cursor.mcpServers.offload);
  let args;
  let options;
  let prompted = false;
  const saved = await storeKeychainKey({
    platform: 'darwin',
    env: { PATH: '/usr/bin', HOME: '/private/home', OPENAI_API_KEY: 'must-not-reach-security' },
    macosInteractive: true,
    prompt: async () => {
      prompted = true;
      return 'TOP_SECRET';
    },
    execFile: (cmd, values, opts) => {
      args = [cmd, values];
      options = opts;
      return { status: 0 };
    },
  });
  assert.equal(saved.stored, true);
  assert.equal(prompted, false);
  assert.deepEqual(args[0], 'security');
  assert.equal(args[1].includes('TOP_SECRET'), false);
  assert.deepEqual(options.stdio, 'inherit');
  assert.equal(Object.hasOwn(options, 'input'), false);
  assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.env.PATH, '/usr/bin');
});
test('installer sends a Windows key to Credential Locker only on stdin', async () => {
  let command, args, options;
  const result = await storeKeychainKey({
    platform: 'win32',
    prompt: async () => 'WINDOWS_INSTALL_SECRET',
    execFile: (cmd, values, opts) => {
      command = cmd;
      args = values;
      options = opts;
      return { status: 0 };
    },
  });
  assert.deepEqual(result, { stored: true, service: 'offload-deepseek' });
  assert.equal(command, 'powershell.exe');
  assert.doesNotMatch(args.join(' '), /WINDOWS_INSTALL_SECRET/);
  assert.doesNotMatch(options.input, /WINDOWS_INSTALL_SECRET/);
  assert.equal(Buffer.from(options.input, 'base64').toString('utf8').includes('WINDOWS_INSTALL_SECRET'), true);
  assert.equal(options.stdio[1], 'ignore');
});
test('installer stores only the configured keychain service and never prompts for env/file refs', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const configPath = join(configHome, 'offload', 'config.json');
  await mkdir(join(configHome, 'offload'), { recursive: true });
  const config = {
    providers: { custom: { type: 'openai-chat', baseUrl: 'https://api.example.test', keyRef: 'keychain:custom-service' } },
    profiles: { custom: { provider: 'custom', model: 'm' } },
    default: 'custom',
    limits: { maxTurns: 1, timeoutMinutes: 1, maxUsd: 1 },
  };
  await writeFile(configPath, JSON.stringify(config));
  let stored;
  await install({
    root: process.cwd(),
    home,
    configHome,
    clients: ['codex'],
    keyPrompt: async () => 'x',
    keychain: async (value) => {
      stored = value;
      return { stored: true };
    },
  });
  assert.equal(stored.service, 'custom-service');
  config.providers.custom.keyRef = 'env:CUSTOM_KEY';
  await writeFile(configPath, JSON.stringify(config));
  let prompted = false;
  const result = await install({
    root: process.cwd(),
    home,
    configHome,
    clients: ['codex'],
    keyPrompt: async () => {
      prompted = true;
      return 'x';
    },
    keychain: async () => ({ stored: true }),
  });
  assert.equal(prompted, false);
  assert.match(result.key.reason, /configure env/);
});
test('managed replacement preserves unrelated bytes and rejects duplicate markers', () => {
  const before = '  pre\n<!-- BEGIN offload old -->x<!-- END offload -->\n\npost  ';
  const next = replaceManaged(before, '<!-- BEGIN offload new -->y<!-- END offload -->');
  assert.equal(next, '  pre\n<!-- BEGIN offload new -->y<!-- END offload -->\n\npost  ');
  assert.equal(replaceManaged(next, '', true), '  pre\n\n\npost  ');
  assert.throws(
    () => replaceManaged('<!-- BEGIN offload -->a<!-- END offload --><!-- BEGIN offload -->b<!-- END offload -->', 'x'),
    /duplicate/,
  );
});
test('installer uses client-specific blocks and installs reversible narrow Claude settings', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const root = process.cwd();
  await install({ root, home, configHome: join(home, 'config'), clients: ['claude', 'codex', 'cursor'] });
  const [claude, codex, settings] = await Promise.all([
    readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8'),
    readFile(join(home, '.codex', 'AGENTS.md'), 'utf8'),
    readFile(join(home, '.claude', 'settings.json'), 'utf8'),
  ]);
  assert.match(claude, /Follow the `offload` skill/);
  assert.match(codex, /Follow the `offload` skill/);
  const parsed = JSON.parse(settings);
  assert.ok(parsed.permissions.allow.includes('mcp__offload__offload_wait'));
  assert.ok(parsed.permissions.allow.includes('mcp__offload__offload_job'));
  assert.ok(!parsed.permissions.allow.includes('mcp__offload__offload_start'));
  assert.equal(parsed.hooks.SessionStart[0].matcher, 'startup|resume|fork');
  assert.equal(parsed.hooks.SessionStart[0].hooks[0].type, 'command');
  await install({ root, home, configHome: join(home, 'config'), clients: ['claude', 'codex', 'cursor'], uninstall: true });
  const after = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!after.permissions.allow.includes('mcp__offload__offload_start'));
  assert.equal(after.hooks.SessionStart.length, 0);
});
test('installer detects clients, updates only manifest-owned registrations, and preserves edits', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const root = process.cwd();
  const configHome = join(home, 'config');
  await install({ root, home, configHome, env: { PATH: '' } });
  await assert.rejects(readFile(join(home, '.claude.json')), /ENOENT/);
  await mkdir(join(home, '.claude'), { recursive: true });
  await install({ root, home, configHome });
  const original = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).mcpServers.offload;
  const moved = await mkdtemp(`${tmpdir()}/offload-moved-`);
  await cp(join(root, 'templates'), join(moved, 'templates'), { recursive: true });
  await cp(join(root, 'plugins'), join(moved, 'plugins'), { recursive: true });
  await cp(join(root, 'bin'), join(moved, 'bin'), { recursive: true });
  await cp(join(root, 'install.mjs'), join(moved, 'install.mjs'));
  await cp(join(root, 'config.example.json'), join(moved, 'config.example.json'));
  await install({ root: moved, home, configHome, clients: ['claude'] });
  const updated = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).mcpServers.offload;
  assert.notDeepEqual(updated, original);
  assert.equal(updated.args[0], join(moved, 'bin', 'offload.mjs'));
  updated.args.push('--user-edit');
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { offload: updated } }));
  await install({ root, home, configHome, clients: ['claude'] });
  const preserved = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).mcpServers.offload;
  assert.equal(preserved.args.at(-1), '--user-edit');
  await install({ root, home, configHome, clients: ['claude'], uninstall: true });
  assert.equal(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).mcpServers.offload.args.at(-1), '--user-edit');
});
test('installer rejects invalid client JSON on uninstall and uses a Windows-safe hook command', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const root = process.cwd();
  const configHome = join(home, 'config');
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(join(home, '.cursor', 'mcp.json'), '{bad');
  await assert.rejects(install({ root, home, configHome, clients: ['cursor'], uninstall: true }), /invalid Cursor MCP JSON/);
  await install({ root, home, configHome, clients: ['claude'], platform: 'win32' });
  const hook = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command;
  assert.doesNotMatch(hook, /\\\\/);
  assert.match(hook, /--doctor-hook$/);
});
test('Windows Claude hook accepts Program Files (x86) paths but rejects unsafe expansion/separator paths before writes', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  await install({ root: process.cwd(), home, configHome, clients: ['claude'], platform: 'win32' });
  const hook = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command;
  assert.match(hook, /^".*" ".*" --doctor-hook$/);
  const parent = await mkdtemp(`${tmpdir()}/offload-root-`);
  const programFiles = join(parent, 'Program Files (x86)');
  await mkdir(programFiles);
  await cp(join(process.cwd(), 'templates'), join(programFiles, 'templates'), { recursive: true });
  await cp(join(process.cwd(), 'plugins'), join(programFiles, 'plugins'), { recursive: true });
  await cp(join(process.cwd(), 'bin'), join(programFiles, 'bin'), { recursive: true });
  await cp(join(process.cwd(), 'install.mjs'), join(programFiles, 'install.mjs'));
  await cp(join(process.cwd(), 'config.example.json'), join(programFiles, 'config.example.json'));
  const commonHome = await mkdtemp(`${tmpdir()}/offload-home-`);
  await install({ root: programFiles, home: commonHome, configHome: join(commonHome, 'config'), clients: ['claude'], platform: 'win32' });
  const commonHook = JSON.parse(await readFile(join(commonHome, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart[0].hooks[0]
    .command;
  assert.match(commonHook, /Program Files \(x86\)/);
  const rejectedHome = await mkdtemp(`${tmpdir()}/offload-home-`);
  await assert.rejects(
    install({
      root: `${process.cwd()}&unsafe`,
      home: rejectedHome,
      configHome: join(rejectedHome, 'config'),
      clients: ['claude'],
      platform: 'win32',
    }),
    /unsupported command metacharacters/,
  );
  await assert.rejects(readFile(join(rejectedHome, '.claude', 'settings.json')), /ENOENT/);
});
test('installer derives Windows config paths from the injected environment', async () => {
  const base = await mkdtemp(`${tmpdir()}/offload-home-`);
  const env = { USERPROFILE: join(base, 'profile'), APPDATA: join(base, 'appdata') };
  const result = await install({ root: process.cwd(), platform: 'win32', env, clients: ['codex'] });
  assert.equal(result.configPath, join(env.APPDATA, 'offload', 'config.json'));
});
test('installer detects a client executable from injected PATH without pre-existing config', async () => {
  const base = await mkdtemp(`${tmpdir()}/offload-home-`);
  const bin = join(base, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'codex'), '');
  await install({ root: process.cwd(), home: join(base, 'home'), configHome: join(base, 'config'), env: { PATH: bin } });
  assert.match(await readFile(join(base, 'home', '.codex', 'AGENTS.md'), 'utf8'), /BEGIN offload/);
});
test('installer detects a Windows client from conventional Path casing', async () => {
  const base = await mkdtemp(`${tmpdir()}/offload-home-`);
  const bin = join(base, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'codex.exe'), '');
  await install({ root: process.cwd(), home: join(base, 'home'), configHome: join(base, 'config'), platform: 'win32', env: { Path: bin } });
  assert.match(await readFile(join(base, 'home', '.codex', 'AGENTS.md'), 'utf8'), /BEGIN offload/);
});
test('hidden key prompt removes listeners and restores raw mode', async () => {
  class FakeInput extends EventEmitter {
    constructor() {
      super();
      this.isTTY = true;
      this.raw = [];
    }
    setRawMode(value) {
      this.raw.push(value);
    }
    resume() {}
    pause() {}
  }
  const input = new FakeInput();
  let wire = '';
  const output = {
    write: (value) => {
      wire += value;
    },
  };
  const pending = promptNoEcho({ input, output });
  input.emit('data', 'sec\bret\n');
  assert.equal(await pending, 'seret');
  assert.deepEqual(input.raw, [true, false]);
  assert.equal(input.listenerCount('data'), 0);
  assert.match(wire, /input hidden/);
});
test('installer uses relocated Claude and Codex homes consistently with doctor', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const claudeDir = join(home, 'claude-state');
  const codexDir = join(home, 'codex-state');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir };
  await install({ root: process.cwd(), home, configHome: join(home, 'config'), clients: ['claude', 'codex'], env });
  assert.ok(JSON.parse(await readFile(join(claudeDir, '.claude.json'), 'utf8')).mcpServers.offload);
  await assert.rejects(readFile(join(home, '.claude.json')), /ENOENT/);
  assert.match(await readFile(join(claudeDir, 'skills', 'offload', 'SKILL.md'), 'utf8'), /argument-hint/);
  assert.match(await readFile(join(codexDir, 'skills', 'offload', 'SKILL.md'), 'utf8'), /argument-hint/);
  const result = doctor({ root: process.cwd(), home, env });
  assert.equal(result.registration.claude, true);
  assert.equal(result.registration.codex, true);
});
test('installer preflights required artifacts before writing a selected client', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const root = await mkdtemp(`${tmpdir()}/offload-incomplete-`);
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'CLAUDE.md'), 'user text\n');
  await assert.rejects(install({ root, home, configHome: join(home, 'config'), clients: ['claude'] }), /required installer artifact/);
  assert.equal(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'user text\n');
  await assert.rejects(access(join(home, '.claude.json'), constants.F_OK), /ENOENT/);
});
test(
  'installer refuses a symlinked package artifact before altering a client',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  async () => {
    const home = await mkdtemp(`${tmpdir()}/offload-home-`),
      root = await mkdtemp(`${tmpdir()}/offload-artifact-root-`),
      outside = join(root, 'outside-secret.mjs');
    await mkdir(join(root, 'bin'));
    await writeFile(outside, 'host-only artifact');
    await symlink(outside, join(root, 'bin', 'offload.mjs'));
    await writeFile(join(root, 'install.mjs'), 'installer placeholder');
    await writeFile(join(root, 'config.example.json'), '{}');
    const cursor = join(home, '.cursor', 'mcp.json');
    await mkdir(dirname(cursor), { recursive: true });
    await writeFile(cursor, '{"mcpServers":{"user":{"command":"safe"}}}');
    await assert.rejects(install({ root, home, configHome: join(home, 'config'), clients: ['cursor'] }), /required installer artifact/);
    assert.equal(await readFile(cursor, 'utf8'), '{"mcpServers":{"user":{"command":"safe"}}}');
  },
);
test('Claude upgrade removes only owned legacy hooks and permissions, preserving siblings and user grants', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const root = process.cwd();
  const command = `'${process.execPath.replace(/'/g, `"'"'`)}' '${join(root, 'install.mjs').replace(/'/g, `"'"'`)}' --doctor-hook`;
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['mcp__offload__offload_start', 'mcp__offload__offload_wait', 'mcp__offload__offload_job'] },
      hooks: {
        SessionStart: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command },
              { type: 'command', command: 'user-hook' },
            ],
          },
        ],
      },
    }),
  );
  await mkdir(join(configHome, 'offload'), { recursive: true });
  await writeFile(
    join(configHome, 'offload', 'installer-state.json'),
    JSON.stringify({
      version: 1,
      registrations: {},
      files: {},
      claudeSettings: {
        hookCommand: command,
        rules: ['mcp__offload__offload_start', 'mcp__offload__offload_wait', 'mcp__offload__offload_job'],
      },
    }),
  );
  await install({ root, home, configHome, clients: ['claude'] });
  let settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!settings.permissions.allow.includes('mcp__offload__offload_start'));
  assert.ok(settings.hooks.SessionStart.some((entry) => entry.matcher === '' && entry.hooks[0].command === 'user-hook'));
  assert.ok(
    settings.hooks.SessionStart.some(
      (entry) => entry.matcher === 'startup|resume|fork' && entry.hooks.some((hook) => hook.command === command),
    ),
  );
  settings.permissions.allow.push('mcp__offload__offload_start');
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  await install({ root, home, configHome, clients: ['claude'], uninstall: true });
  settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.allow.includes('mcp__offload__offload_start'), 'user-owned grant remains');
  assert.ok(!settings.permissions.allow.includes('mcp__offload__offload_wait'));
  assert.ok(settings.hooks.SessionStart.some((entry) => entry.matcher === '' && entry.hooks[0].command === 'user-hook'));
});
test('Claude uninstall removes owned grants even when the hook was deleted', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  await install({ root: process.cwd(), home, configHome, clients: ['claude'] });
  const path = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(await readFile(path, 'utf8'));
  settings.hooks.SessionStart = [];
  await writeFile(path, JSON.stringify(settings));
  await install({ root: process.cwd(), home, configHome, clients: ['claude'], uninstall: true });
  const after = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(!after.permissions.allow.includes('mcp__offload__offload_wait'));
  assert.ok(!after.permissions.allow.includes('mcp__offload__offload_job'));
});
test('Claude preserves a pre-existing exact startup hook while removing only installer-owned grants', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const root = process.cwd();
  const settingsPath = join(home, '.claude', 'settings.json');
  const command = `'${process.execPath.replace(/'/g, `"'"'`)}' '${join(root, 'install.mjs').replace(/'/g, `"'"'`)}' --doctor-hook`;
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({
      permissions: { allow: ['mcp__offload__offload_wait'] },
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command }] }] },
    }),
  );
  await install({ root, home, configHome, clients: ['claude'] });
  let settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.ok(settings.permissions.allow.includes('mcp__offload__offload_wait'));
  assert.ok(settings.permissions.allow.includes('mcp__offload__offload_job'));
  const manifest = JSON.parse(await readFile(join(configHome, 'offload', 'installer-state.json'), 'utf8'));
  assert.equal(manifest.claudeSettings.hookOwned, true);
  assert.equal(manifest.claudeSettings.hookMatcher, 'startup|resume|fork');
  assert.deepEqual(manifest.claudeSettings.rules, ['mcp__offload__offload_job']);
  await install({ root, home, configHome, clients: ['claude'], uninstall: true });
  settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.ok(settings.permissions.allow.includes('mcp__offload__offload_wait'));
  assert.ok(!settings.permissions.allow.includes('mcp__offload__offload_job'));
  assert.ok(
    settings.hooks.SessionStart.some((entry) => entry.matcher === 'startup' && entry.hooks.some((hook) => hook.command === command)),
  );
});
test('Codex TOML scanner preserves CRLF, rejects duplicates, and owns an EOF block exactly', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const config = join(home, '.codex', 'config.toml');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(config, '[other]\r\nvalue = 1\r\n');
  await install({ root: process.cwd(), home, configHome, clients: ['codex'] });
  const once = await readFile(config, 'utf8');
  assert.ok(once.includes('\r\n'));
  assert.doesNotMatch(once, /required = true/);
  assert.match(once, /default_tools_approval_mode = "writes"/);
  assert.equal(scanCodexOffloadToml(once).length, 1);
  await install({ root: process.cwd(), home, configHome, clients: ['codex'] });
  assert.equal(await readFile(config, 'utf8'), once);
  await install({ root: process.cwd(), home, configHome, clients: ['codex'], uninstall: true });
  assert.equal(await readFile(config, 'utf8'), '[other]\r\nvalue = 1\r\n');
  await writeFile(config, '[mcp_servers.offload]\ncommand = "x"\n[mcp_servers.offload]\ncommand = "y"\n');
  await assert.rejects(install({ root: process.cwd(), home, configHome, clients: ['codex'] }), /duplicate Codex/);
});
test('Codex TOML scanner recognizes quoted aliases, ambiguous headers, and indented table boundaries', async () => {
  const root = process.cwd();
  const variants = [
    '[ "mcp_servers" . "offload" ] # user entry\r\n',
    "[ 'mcp_servers' . 'offload' ]\n",
    '["mcp_servers"."off\\u006coad"]\n',
    '  [mcp_servers.offload] # leading whitespace\n',
  ];
  for (const value of variants) {
    const scanned = scanCodexOffloadToml(value);
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].managed, false);
    const home = await mkdtemp(`${tmpdir()}/offload-home-`);
    const config = join(home, '.codex', 'config.toml');
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, value);
    await assert.rejects(install({ root, home, configHome: join(home, 'config'), clients: ['codex'] }), /unmanaged Codex/);
  }
  const ambiguous = scanCodexOffloadToml('["mcp_servers".offload\n');
  assert.equal(ambiguous.ambiguous, true);
  const ambiguousHome = await mkdtemp(`${tmpdir()}/offload-home-`);
  const ambiguousConfig = join(ambiguousHome, '.codex', 'config.toml');
  await mkdir(dirname(ambiguousConfig), { recursive: true });
  await writeFile(ambiguousConfig, '["mcp_servers".offload\n');
  await assert.rejects(
    install({ root, home: ambiguousHome, configHome: join(ambiguousHome, 'config'), clients: ['codex'] }),
    /ambiguous Codex/,
  );
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const config = join(home, '.codex', 'config.toml');
  const original = '[base]\r\nvalue = 1\r\n';
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, original);
  await install({ root, home, configHome, clients: ['codex'] });
  await writeFile(config, `${await readFile(config, 'utf8')}  [later] # kept\r\nvalue = 2\r\n`);
  await install({ root, home, configHome, clients: ['codex'], uninstall: true });
  assert.equal(await readFile(config, 'utf8'), `${original}  [later] # kept\r\nvalue = 2\r\n`);
});
test('Codex uninstall removes its MCP table when a plugin table follows after blank lines', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const config = join(home, '.codex', 'config.toml');
  await install({ root: process.cwd(), home, configHome, clients: ['codex'] });
  await writeFile(config, `${await readFile(config, 'utf8')}\n[plugins."offload@personal"]\nenabled = true\n`);
  await install({ root: process.cwd(), home, configHome, clients: ['codex'], uninstall: true });
  const after = await readFile(config, 'utf8');
  assert.doesNotMatch(after, /mcp_servers\.offload/);
  assert.match(after, /\[plugins\."offload@personal"\]/);
});
test('Claude skill replaces legacy command without creating a duplicate command', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  await install({ root: process.cwd(), home, configHome, clients: ['claude'] });
  await assert.rejects(access(join(home, '.claude', 'commands', 'offload.md'), constants.F_OK), /ENOENT/);
});
test('legacy Claude command migration deletes only a manifest-owned exact file', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const commandPath = join(home, '.claude', 'commands', 'offload.md');
  const content = 'old offload command\n';
  await mkdir(dirname(commandPath), { recursive: true });
  await writeFile(commandPath, content);
  await mkdir(join(configHome, 'offload'), { recursive: true });
  await writeFile(
    join(configHome, 'offload', 'installer-state.json'),
    JSON.stringify({ version: 1, registrations: {}, files: { [commandPath]: createHash('sha256').update(content).digest('hex') } }),
  );
  await install({ root: process.cwd(), home, configHome, clients: ['claude'] });
  await assert.rejects(access(commandPath, constants.F_OK), /ENOENT/);
  const userHome = await mkdtemp(`${tmpdir()}/offload-home-`);
  const userCommand = join(userHome, '.claude', 'commands', 'offload.md');
  await mkdir(dirname(userCommand), { recursive: true });
  await writeFile(userCommand, content);
  await install({ root: process.cwd(), home: userHome, configHome: join(userHome, 'config'), clients: ['claude'] });
  assert.equal(await readFile(userCommand, 'utf8'), content);
});
test('installer does not adopt identical pre-existing native skills or MCP registrations', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const root = process.cwd();
  const skill = await readFile(join(root, 'plugins', 'offload', 'skills', 'offload', 'SKILL.md'), 'utf8');
  const claude = { type: 'stdio', command: process.execPath, args: [join(root, 'bin', 'offload.mjs'), 'mcp'], env: {} };
  const cursor = { command: process.execPath, args: [join(root, 'bin', 'offload.mjs'), 'mcp'] };
  const codex = [
    '# offload managed MCP',
    '[mcp_servers.offload]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(join(root, 'bin', 'offload.mjs'))}, "mcp"]`,
    'startup_timeout_sec = 15',
    'tool_timeout_sec = 60',
  ].join('\n');
  await mkdir(join(home, '.claude', 'skills', 'offload'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(join(home, '.claude', 'skills', 'offload', 'SKILL.md'), skill);
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { offload: claude } }));
  await writeFile(join(home, '.codex', 'config.toml'), `${codex}\n`);
  await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { offload: cursor } }));
  await install({ root, home, configHome, clients: ['claude', 'codex', 'cursor'] });
  const manifest = JSON.parse(await readFile(join(configHome, 'offload', 'installer-state.json'), 'utf8'));
  assert.equal(manifest.files[join(home, '.claude', 'skills', 'offload', 'SKILL.md')], undefined);
  assert.equal(manifest.registrations.claude, undefined);
  assert.equal(manifest.registrations.codex, undefined);
  assert.equal(manifest.registrations.cursor, undefined);
  await install({ root, home, configHome, clients: ['claude', 'codex', 'cursor'], uninstall: true });
  assert.equal(await readFile(join(home, '.claude', 'skills', 'offload', 'SKILL.md'), 'utf8'), skill);
  assert.deepEqual(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).mcpServers.offload, claude);
  assert.equal(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), `${codex}\n`);
  assert.deepEqual(JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.offload, cursor);
});
test('Codex desktop plugin installs from the personal marketplace without a duplicate native skill', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const codexHome = join(home, 'custom-codex');
  const executable = join(home, 'bin', 'codex');
  const calls = [];
  let installed = false;
  const runCommand = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('list'))
      return {
        status: 0,
        stdout: JSON.stringify({ installed: installed ? [{ name: 'offload', marketplace: 'personal', installed: true }] : [] }),
      };
    if (args.includes('add')) installed = true;
    if (args.includes('remove')) installed = false;
    return { status: 0, stdout: '{}' };
  };
  await rawInstall({
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    env: { PATH: dirname(executable), CODEX_HOME: codexHome },
    commandExists: async (path) => path === executable,
    runCommand,
  });
  const marketplace = JSON.parse(await readFile(join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(marketplace.name, 'personal');
  assert.deepEqual(marketplace.plugins.at(-1).source, { source: 'local', path: './plugins/offload' });
  assert.ok(calls.some((call) => call.args.join(' ') === 'plugin add offload@personal --json'));
  assert.match(await readFile(join(codexHome, 'config.toml'), 'utf8'), /mcp_servers\.offload/);
  await assert.rejects(access(join(codexHome, 'skills', 'offload', 'SKILL.md')), /ENOENT/);
  assert.match(await readFile(join(home, 'plugins', 'offload', 'skills', 'offload', 'SKILL.md'), 'utf8'), /argument-hint/);
  assert.equal(calls[0].options.env.HOME, home);
  assert.equal(Object.hasOwn(calls[0].options.env, 'DEEPSEEK_API_KEY'), false);
  await rawInstall({
    root: join(home, 'missing-package'),
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    uninstall: true,
    env: { PATH: dirname(executable), CODEX_HOME: codexHome },
    commandExists: async (path) => path === executable,
    runCommand,
  });
  assert.ok(calls.some((call) => call.args.join(' ') === 'plugin remove offload@personal --json'));
  assert.doesNotMatch(await readFile(join(codexHome, 'config.toml'), 'utf8'), /mcp_servers\.offload/);
  await assert.rejects(access(join(home, 'plugins', 'offload', 'skills', 'offload', 'SKILL.md')), /ENOENT/);
});
test('plugin content versions remain canonical when a Windows checkout supplies CRLF artifacts', async () => {
  const product = await mkdtemp(`${tmpdir()}/offload-crlf-product-`);
  const home = await mkdtemp(`${tmpdir()}/offload-crlf-home-`);
  const executable = join(home, 'bin', 'codex');
  try {
    for (const path of ['bin', 'plugins', 'templates']) await cp(join(process.cwd(), path), join(product, path), { recursive: true });
    for (const path of ['install.mjs', 'config.example.json']) await cp(join(process.cwd(), path), join(product, path));
    for (const relativePath of ['plugin.json', '.codex-plugin/plugin.json', 'skills/offload/SKILL.md']) {
      const path = join(product, 'plugins', 'offload', relativePath);
      await writeFile(path, (await readFile(path, 'utf8')).replace(/\n/g, '\r\n'));
    }
    let installed = false;
    const result = await rawInstall({
      root: product,
      home,
      configHome: join(home, 'config'),
      clients: ['codex'],
      env: { PATH: dirname(executable) },
      commandExists: async (path) => path === executable,
      runCommand: (_command, args) => {
        if (args.includes('list'))
          return {
            status: 0,
            stdout: JSON.stringify({ installed: installed ? [{ name: 'offload', marketplace: 'personal', installed: true }] : [] }),
          };
        if (args.includes('add')) installed = true;
        return { status: 0, stdout: '{}' };
      },
    });
    assert.equal(result.plugin.active, true, JSON.stringify(result.plugin));
    assert.equal(await readFile(join(home, 'plugins', 'offload', 'plugin.json'), 'utf8').then((text) => text.includes('\r\n')), true);
  } finally {
    await rm(product, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
test('Git pins canonical plugin artifacts to LF for cache-version stability', async () => {
  const attributes = await readFile(join(process.cwd(), '.gitattributes'), 'utf8');
  for (const path of [
    'plugins/offload/plugin.json',
    'plugins/offload/.codex-plugin/plugin.json',
    'plugins/offload/skills/offload/SKILL.md',
  ]) {
    assert.match(attributes, new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} text eol=lf$`, 'm'));
    assert.doesNotMatch(await readFile(join(process.cwd(), path), 'utf8'), /\r\n?/);
  }
});
test('a user-owned native Codex skill prevents plugin activation', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const native = join(home, '.codex', 'skills', 'offload', 'SKILL.md');
  await mkdir(dirname(native), { recursive: true });
  await writeFile(native, 'user-native-skill');
  const executable = join(home, 'bin', 'codex');
  let calls = 0;
  await rawInstall({
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    runCommand: () => {
      calls++;
      return { status: 0, stdout: '{}' };
    },
  });
  assert.equal(calls, 0);
  assert.equal(await readFile(native, 'utf8'), 'user-native-skill');
  await assert.rejects(access(join(home, 'plugins', 'offload', 'plugin.json')), /ENOENT/);
});
test('an installer-owned Codex plugin refreshes on its content version and falls back if refresh fails', async () => {
  const product = await mkdtemp(`${tmpdir()}/offload-product-`);
  for (const path of ['bin', 'plugins', 'templates']) await cp(join(process.cwd(), path), join(product, path), { recursive: true });
  for (const path of ['install.mjs', 'config.example.json']) await cp(join(process.cwd(), path), join(product, path));
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const executable = join(home, 'bin', 'codex');
  const calls = [];
  let installed = false,
    failAdd = false;
  const runner = (_command, args) => {
    calls.push(args.join(' '));
    if (args.includes('list'))
      return {
        status: 0,
        stdout: JSON.stringify({ installed: installed ? [{ name: 'offload', marketplace: 'personal', installed: true }] : [] }),
      };
    if (args.includes('remove')) {
      installed = false;
      return { status: 0, stdout: '{}' };
    }
    if (args.includes('add')) {
      if (failAdd) return { status: 1, stdout: '', stderr: 'failure' };
      installed = true;
    }
    return { status: 0, stdout: '{}' };
  };
  const options = {
    root: product,
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    runCommand: runner,
  };
  await rawInstall(options);
  const cacheVersion = async () => {
    const root = join(product, 'plugins', 'offload');
    const bytes = await Promise.all(
      ['.codex-plugin/plugin.json', 'plugin.json', 'skills/offload/SKILL.md'].map(async (relativePath) => {
        let text = await readFile(join(root, relativePath), 'utf8');
        if (relativePath.endsWith('plugin.json')) text = text.replace(/("version"\s*:\s*)"(?:[^"\\]|\\.)*"/, '$1"<cache-version>"');
        return `${relativePath}\0${text}\0`;
      }),
    );
    return `0.1.0+codex.${createHash('sha256').update(bytes.join('')).digest('hex').slice(0, 16)}`;
  };
  const setVersion = async () => {
    const version = await cacheVersion();
    for (const path of [
      join(product, 'plugins', 'offload', 'plugin.json'),
      join(product, 'plugins', 'offload', '.codex-plugin', 'plugin.json'),
    ])
      await writeFile(path, (await readFile(path, 'utf8')).replace(/"version": "[^"]+"/, `"version": "${version}"`));
  };
  const bump = async (marker) => {
    const skillPath = join(product, 'plugins', 'offload', 'skills', 'offload', 'SKILL.md');
    await writeFile(skillPath, `${await readFile(skillPath, 'utf8')}\n<!-- ${marker} -->\n`);
    await setVersion();
  };
  await bump('refresh1');
  calls.length = 0;
  await rawInstall(options);
  assert.ok(JSON.parse(await readFile(join(home, 'config', 'offload', 'installer-state.json'), 'utf8')).plugins.codex.enabled);
  assert.deepEqual(
    calls.filter((call) => /plugin (remove|add)/.test(call)),
    ['plugin remove offload@personal --json', 'plugin add offload@personal --json'],
  );
  const codexManifest = join(product, 'plugins', 'offload', '.codex-plugin', 'plugin.json');
  await writeFile(
    codexManifest,
    (await readFile(codexManifest, 'utf8')).replace('Delegate bounded local coding work', 'Delegate scoped local coding work'),
  );
  await setVersion();
  calls.length = 0;
  await rawInstall(options);
  assert.deepEqual(
    calls.filter((call) => /plugin (remove|add)/.test(call)),
    ['plugin remove offload@personal --json', 'plugin add offload@personal --json'],
    'manifest-only changes refresh the cached plugin',
  );
  await bump('refresh2');
  failAdd = true;
  const failed = await rawInstall(options);
  assert.equal(failed.plugin.active, false, JSON.stringify(failed.plugin));
  assert.match(await readFile(join(home, '.codex', 'skills', 'offload', 'SKILL.md'), 'utf8'), /argument-hint/);
});
test('installer-owned activation survives a user-owned identical marketplace entry and preserves it on uninstall', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const executable = join(home, 'bin', 'codex');
  const entry = {
    name: 'offload',
    source: { source: 'local', path: './plugins/offload' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  };
  await mkdir(join(home, '.agents', 'plugins'), { recursive: true });
  const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
  const original = JSON.stringify({ name: 'personal', plugins: [entry] });
  await writeFile(marketplacePath, original);
  let installed = false;
  const runner = (_command, args) =>
    args.includes('list')
      ? {
          status: 0,
          stdout: JSON.stringify({ installed: installed ? [{ name: 'offload', marketplace: 'personal', installed: true }] : [] }),
        }
      : args.includes('remove')
        ? ((installed = false), { status: 0, stdout: '{}' })
        : ((installed = true), { status: 0, stdout: '{}' });
  const options = {
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    runCommand: runner,
  };
  await rawInstall(options);
  await rawInstall(options);
  await rawInstall({ ...options, uninstall: true });
  assert.equal(await readFile(marketplacePath, 'utf8'), original);
  await assert.rejects(access(join(home, 'plugins', 'offload', 'skills', 'offload', 'SKILL.md')), /ENOENT/);
});
test('indeterminate or manually removed conflicting plugins avoid duplication only while state is ambiguous', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const executable = join(home, 'bin', 'codex');
  let installed = false,
    malformed = false;
  const runner = (_command, args) =>
    args.includes('list')
      ? malformed
        ? { status: 0, stdout: '{}' }
        : {
            status: 0,
            stdout: JSON.stringify({ installed: installed ? [{ name: 'offload', marketplace: 'personal', installed: true }] : [] }),
          }
      : ((installed = true), { status: 0, stdout: '{}' });
  const options = {
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    runCommand: runner,
  };
  await rawInstall(options);
  await writeFile(join(home, 'plugins', 'offload', 'skills', 'offload', 'SKILL.md'), 'user edit');
  installed = false;
  await rawInstall(options);
  assert.match(await readFile(join(home, '.codex', 'skills', 'offload', 'SKILL.md'), 'utf8'), /argument-hint/);
  malformed = true;
  await rawInstall(options);
  assert.match(await readFile(join(home, '.codex', 'skills', 'offload', 'SKILL.md'), 'utf8'), /argument-hint/);
});
test('Codex plugin treats available entries as inactive and leaves ambiguous conflicts without a duplicate skill', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const executable = join(home, 'bin', 'codex');
  const calls = [];
  const runner = (_command, args) => {
    calls.push(args);
    return args.includes('list')
      ? { status: 0, stdout: JSON.stringify({ available: [{ name: 'offload', marketplace: 'personal', installed: false }] }) }
      : { status: 0, stdout: '{}' };
  };
  await rawInstall({
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    runCommand: runner,
  });
  assert.ok(
    calls.some((args) => args.join(' ') === 'plugin add offload@personal --json'),
    'available is not installed',
  );
  const conflictHome = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  await mkdir(join(conflictHome, '.agents', 'plugins'), { recursive: true });
  await writeFile(
    join(conflictHome, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name: 'personal', plugins: [{ name: 'offload', source: { source: 'local', path: './plugins/user-offload' } }] }),
  );
  await rawInstall({
    root: process.cwd(),
    home: conflictHome,
    configHome: join(conflictHome, 'config'),
    clients: ['codex'],
    env: { PATH: '' },
    commandExists: async () => false,
  });
  await assert.rejects(access(join(conflictHome, '.codex', 'skills', 'offload', 'SKILL.md')), /ENOENT/);
  assert.equal(
    await readFile(join(conflictHome, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
    JSON.stringify({ name: 'personal', plugins: [{ name: 'offload', source: { source: 'local', path: './plugins/user-offload' } }] }),
  );
});
test('active or installer-owned conflicting plugins never receive a duplicate native skill', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const executable = join(home, 'bin', 'codex');
  const runner = (_command, args) =>
    args.includes('list')
      ? { status: 0, stdout: JSON.stringify({ installed: [{ name: 'offload', marketplace: 'personal', installed: true }] }) }
      : { status: 0, stdout: '{}' };
  await mkdir(join(home, '.agents', 'plugins'), { recursive: true });
  await writeFile(
    join(home, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name: 'personal', plugins: [{ name: 'offload', source: { source: 'local', path: './plugins/user-offload' } }] }),
  );
  await rawInstall({
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    runCommand: runner,
  });
  await assert.rejects(access(join(home, '.codex', 'skills', 'offload', 'SKILL.md')), /ENOENT/);
  const ownedHome = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  let installed = false;
  const ownedRunner = (_command, args) =>
    args.includes('list')
      ? {
          status: 0,
          stdout: JSON.stringify({ installed: installed ? [{ name: 'offload', marketplace: 'personal', installed: true }] : [] }),
        }
      : ((installed = true), { status: 0, stdout: '{}' });
  const options = {
    root: process.cwd(),
    home: ownedHome,
    configHome: join(ownedHome, 'config'),
    clients: ['codex'],
    env: { PATH: dirname(executable) },
    commandExists: async () => true,
    runCommand: ownedRunner,
  };
  await rawInstall(options);
  await writeFile(join(ownedHome, 'plugins', 'offload', 'skills', 'offload', 'SKILL.md'), 'user edit');
  await rawInstall(options);
  await assert.rejects(access(join(ownedHome, '.codex', 'skills', 'offload', 'SKILL.md')), /ENOENT/);
});
test('Codex plugin uses cmd.exe safely on Windows and Cursor never receives a global rule', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const executable = join(home, 'bin', 'codex.cmd');
  const calls = [];
  const runCommand = (command, args) => {
    calls.push({ command, args });
    return args.includes('/c') && args.at(-1).includes('plugin list')
      ? { status: 0, stdout: '{"installed":[]}' }
      : { status: 0, stdout: '{}' };
  };
  await rawInstall({
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    platform: 'win32',
    env: { Path: dirname(executable), ComSpec: 'cmd.exe' },
    commandExists: async (path) => path === executable,
    runCommand,
  });
  assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(calls[0].args[3], /^".*codex\.cmd" "plugin"/);
  const cursorHome = await mkdtemp(`${tmpdir()}/offload-cursor-`);
  const oldRule = join(cursorHome, '.cursor', 'rules', 'offload.md');
  await mkdir(dirname(oldRule), { recursive: true });
  await writeFile(oldRule, '<!-- BEGIN offload old -->legacy<!-- END offload -->\n');
  await install({ root: process.cwd(), home: cursorHome, configHome: join(cursorHome, 'config'), clients: ['cursor'] });
  await assert.rejects(access(oldRule), /ENOENT/);
  await install({ root: process.cwd(), home: cursorHome, configHome: join(cursorHome, 'config'), clients: ['cursor'] });
  await assert.rejects(access(oldRule), /ENOENT/);
});
test('tampered Codex plugin state cannot delete arbitrary files during uninstall', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const configHome = join(home, 'config');
  const victim = join(home, 'keep-me.txt');
  await writeFile(victim, 'user data');
  await mkdir(join(configHome, 'offload'), { recursive: true });
  await writeFile(
    join(configHome, 'offload', 'installer-state.json'),
    JSON.stringify({
      version: 1,
      registrations: {},
      files: {},
      plugins: { codex: { source: join(home, 'elsewhere'), files: { [victim]: '0'.repeat(64) } } },
    }),
  );
  await assert.rejects(
    rawInstall({
      root: join(home, 'missing'),
      home,
      configHome,
      clients: ['codex'],
      uninstall: true,
      env: { PATH: '' },
      commandExists: async () => false,
    }),
    /invalid offload Codex plugin installer state/,
  );
  assert.equal(await readFile(victim, 'utf8'), 'user data');
});
test('plugin uninstall does not follow a substituted source symlink', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const source = join(home, 'plugins', 'offload');
  const outside = join(home, 'outside');
  const victim = join(outside, 'skills', 'offload', 'SKILL.md');
  await mkdir(dirname(victim), { recursive: true });
  await writeFile(victim, 'outside skill');
  await mkdir(dirname(source), { recursive: true });
  await symlink(outside, source);
  const configHome = join(home, 'config');
  const recorded = join(source, 'skills', 'offload', 'SKILL.md');
  await mkdir(join(configHome, 'offload'), { recursive: true });
  await writeFile(
    join(configHome, 'offload', 'installer-state.json'),
    JSON.stringify({
      version: 1,
      registrations: {},
      files: {},
      plugins: { codex: { source, files: { [recorded]: createHash('sha256').update('outside skill').digest('hex') } } },
    }),
  );
  await rawInstall({
    root: join(home, 'missing'),
    home,
    configHome,
    clients: ['codex'],
    uninstall: true,
    env: { PATH: '' },
    commandExists: async () => false,
  });
  assert.equal(await readFile(victim, 'utf8'), 'outside skill');
});
test('uninstall relinquishes ownership after an owned plugin source was manually deleted', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const configHome = join(home, 'config');
  const executable = join(home, 'bin', 'codex');
  let installed = false;
  const runner = (_command, args) => {
    if (args.includes('list'))
      return {
        status: 0,
        stdout: JSON.stringify({ installed: installed ? [{ name: 'offload', marketplace: 'personal', installed: true }] : [] }),
      };
    if (args.includes('add')) installed = true;
    if (args.includes('remove')) installed = false;
    return { status: 0, stdout: '{}' };
  };
  const options = {
    root: process.cwd(),
    home,
    configHome,
    clients: ['codex'],
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    runCommand: runner,
  };
  await rawInstall(options);
  await rm(join(home, 'plugins', 'offload'), { recursive: true, force: true });
  await rawInstall({ ...options, uninstall: true });
  const manifestPath = join(configHome, 'offload', 'installer-state.json');
  const manifest = await readFile(manifestPath, 'utf8').then(JSON.parse, (error) =>
    error.code === 'ENOENT' ? undefined : Promise.reject(error),
  );
  assert.equal(manifest?.plugins?.codex, undefined);
  await assert.rejects(access(join(home, '.codex', 'skills', 'offload', 'SKILL.md')), /ENOENT/);
});
test('plugin install refuses a nested source symlink before writing an artifact', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const source = join(home, 'plugins', 'offload');
  const outside = join(home, 'outside');
  await mkdir(source, { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(source, 'skills'));
  await rawInstall({
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    env: { PATH: '' },
    commandExists: async () => false,
  });
  await assert.rejects(access(join(outside, 'offload', 'SKILL.md')), /ENOENT/);
});
test('a disabled installed plugin entry keeps the native fallback', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const executable = join(home, 'bin', 'codex');
  let adds = 0;
  const runner = (_command, args) =>
    args.includes('list')
      ? {
          status: 0,
          stdout: JSON.stringify({ installed: [{ name: 'offload', marketplace: 'personal', installed: true, enabled: false }] }),
        }
      : (adds++, { status: 0, stdout: '{}' });
  await rawInstall({
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    runCommand: runner,
  });
  assert.equal(adds, 0);
  assert.match(await readFile(join(home, '.codex', 'skills', 'offload', 'SKILL.md'), 'utf8'), /argument-hint/);
});
test('Codex falls back only when the installed CLI positively lacks plugin commands', async () => {
  const unsupportedHome = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const executable = join(unsupportedHome, 'bin', 'codex');
  const calls = [];
  const unsupported = (_command, args) => {
    calls.push(args.join(' '));
    if (args.join(' ') === 'plugin list --json') return { status: 2, stdout: '', stderr: 'unknown command plugin' };
    if (args.join(' ') === 'plugin --help') return { status: 0, stdout: 'Usage: codex <COMMAND>\nCommands:\n  mcp\n' };
    return { status: 1, stdout: '' };
  };
  await rawInstall({
    root: process.cwd(),
    home: unsupportedHome,
    configHome: join(unsupportedHome, 'config'),
    clients: ['codex'],
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    runCommand: unsupported,
  });
  assert.match(await readFile(join(unsupportedHome, '.codex', 'skills', 'offload', 'SKILL.md'), 'utf8'), /argument-hint/);
  assert.equal(
    calls.some((call) => call.startsWith('plugin add ')),
    false,
  );

  const ambiguousHome = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const ambiguousCalls = [];
  const ambiguous = (_command, args) => {
    ambiguousCalls.push(args.join(' '));
    if (args.join(' ') === 'plugin list --json') return { status: 0, stdout: '{"unexpected":"shape"}' };
    if (args.join(' ') === 'plugin --help') return { status: 0, stdout: 'Manage Codex plugins\nCommands:\n  add\n  list\n  remove\n' };
    return { status: 1, stdout: '' };
  };
  await rawInstall({
    root: process.cwd(),
    home: ambiguousHome,
    configHome: join(ambiguousHome, 'config'),
    clients: ['codex'],
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    runCommand: ambiguous,
  });
  await assert.rejects(access(join(ambiguousHome, '.codex', 'skills', 'offload', 'SKILL.md')), /ENOENT/);
  assert.equal(
    ambiguousCalls.some((call) => call.startsWith('plugin add ')),
    false,
  );
});
test('Codex preserves an invalid marketplace rather than treating malformed entries as available', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
  const original = JSON.stringify({ name: 'personal', plugins: ['not-a-plugin-object'] });
  await mkdir(dirname(marketplacePath), { recursive: true });
  await writeFile(marketplacePath, original);
  await rawInstall({
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    env: { PATH: '' },
    commandExists: async () => false,
  });
  assert.equal(await readFile(marketplacePath, 'utf8'), original);
  await assert.rejects(access(join(home, 'plugins', 'offload', 'plugin.json')), /ENOENT/);
  await assert.rejects(access(join(home, '.codex', 'skills', 'offload', 'SKILL.md')), /ENOENT/);
});
test('Claude migrates its owned startup health hook to resume and fork without removing a user hook', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const root = process.cwd();
  const command = `'${process.execPath.replace(/'/g, `"'"'`)}' '${join(root, 'install.mjs').replace(/'/g, `"'"'`)}' --doctor-hook`;
  const settingsPath = join(home, '.claude', 'settings.json');
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({
      permissions: { allow: ['mcp__offload__offload_wait', 'mcp__offload__offload_job'] },
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command }] }] },
    }),
  );
  await mkdir(join(configHome, 'offload'), { recursive: true });
  await writeFile(
    join(configHome, 'offload', 'installer-state.json'),
    JSON.stringify({
      version: 1,
      registrations: {},
      files: {},
      plugins: {},
      claudeSettings: { hookCommand: command, hookOwned: true, rules: ['mcp__offload__offload_wait', 'mcp__offload__offload_job'] },
    }),
  );
  await rawInstall({ root, home, configHome, clients: ['claude'] });
  let settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(
    settings.hooks.SessionStart.some((entry) => entry.matcher === 'startup' && entry.hooks.some((hook) => hook.command === command)),
    false,
  );
  assert.equal(
    settings.hooks.SessionStart.filter(
      (entry) => entry.matcher === 'startup|resume|fork' && entry.hooks.some((hook) => hook.command === command),
    ).length,
    1,
  );
  settings.hooks.SessionStart.push({ matcher: 'startup', hooks: [{ type: 'command', command }] });
  await writeFile(settingsPath, JSON.stringify(settings));
  await rawInstall({ root, home, configHome, clients: ['claude'], uninstall: true });
  settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(
    settings.hooks.SessionStart.some(
      (entry) => entry.matcher === 'startup|resume|fork' && entry.hooks.some((hook) => hook.command === command),
    ),
    false,
  );
  assert.equal(
    settings.hooks.SessionStart.some((entry) => entry.matcher === 'startup' && entry.hooks.some((hook) => hook.command === command)),
    true,
  );
});
