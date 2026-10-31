import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  chmod,
  constants,
  cp,
  link,
  mkdtemp as createTempDirectory,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
// Every temp home and product directory is removed once this file's tests finish.
const createdDirectories = [];
const mkdtemp = async (prefix) => {
  const directory = await createTempDirectory(prefix);
  createdDirectories.push(directory);
  return directory;
};
after(async () => {
  await Promise.all(createdDirectories.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => {})));
});
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
const doctorHookCommand = (root) => {
  const quote = (value) => (process.platform === 'win32' ? `"${value}"` : `'${value.replace(/'/g, `"'"'`)}'`);
  return `${quote(process.execPath)} ${quote(join(root, 'install.mjs'))} --doctor-hook`;
};
function fakeClaudeCli({ statePath, calls, mutate = true } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const operation = args?.[1];
    if (operation === 'add') {
      if (!mutate) return { status: 0, stdout: '' };
      const current = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
      current.mcpServers ||= {};
      if (current.mcpServers.offload) return { status: 1, stderr: 'offload already exists' };
      const divider = args.indexOf('--');
      const env = {};
      for (let index = 0; index < divider; index++)
        if (args[index] === '--env') {
          const [name, value] = String(args[++index]).split('=', 2);
          env[name] = value;
        }
      current.mcpServers.offload = { type: 'stdio', command: args[divider + 1], args: args.slice(divider + 2), env };
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(current));
      return { status: 0, stdout: '' };
    }
    if (operation === 'remove') {
      if (!mutate) return { status: 0, stdout: '' };
      const current = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
      if (!current.mcpServers?.offload) return { status: 1, stderr: 'offload not found' };
      delete current.mcpServers.offload;
      writeFileSync(statePath, JSON.stringify(current));
      return { status: 0, stdout: '' };
    }
    return { status: 1, stderr: 'unexpected Claude command' };
  };
}
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
  // Host drift warnings (stale skill, other hook roots) may sit before the suffix.
  assert.match(result.stdout, /schema 2 · report\/inputFiles yes(?: · [^\n]*)? · restart the MCP client after updates/);
});
test('installer CLI grammar rejects dangerous typos before any install mutation or prompt', async () => {
  assert.deepEqual(parseInstallerArgs(['--skip-key', '--clients', 'claude,codex']), {
    uninstall: false,
    skipKey: true,
    replaceKey: false,
    clients: 'claude,codex',
    doctorHook: false,
    approvalMode: undefined,
  });
  assert.deepEqual(parseInstallerArgs(['--doctor-hook']), {
    uninstall: false,
    skipKey: false,
    replaceKey: false,
    clients: 'detected',
    doctorHook: true,
    approvalMode: undefined,
  });
  for (const args of [
    ['--uninstal'],
    ['--clients'],
    ['--clients='],
    ['--clients=claude', '--clients', 'codex'],
    ['--skip-key', '--skip-key'],
    ['--uninstall', '--replace-key'],
    ['--uninstall', '--skip-key'],
    ['--uninstall', '--approval-mode=approve'],
    ['--approval-mode=unsafe'],
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
test('installer CLI forwards explicit approval mode into the client configuration', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-cli-approval-home-`);
  const configHome = join(home, 'config');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: configHome,
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    // Keep the test independent from whichever clients happen to be installed
    // on the machine running it.
    PATH: '',
  };
  const result = spawnSync(process.execPath, ['install.mjs', '--skip-key', '--clients=codex', '--approval-mode=approve'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  // The deliberately empty PATH makes the post-install doctor report Git as
  // unavailable (exit 2); the installer itself has completed before that
  // health result is emitted.
  assert.ok([0, 2].includes(result.status), result.stderr);
  const codex = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codex, /default_tools_approval_mode = "approve"/);
  const manifest = JSON.parse(await readFile(join(configHome, 'offload', 'installer-state.json'), 'utf8'));
  assert.equal(manifest.approvalMode, 'approve');
});
test('installer is idempotent and removes only managed routing blocks', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const root = process.cwd();
  await install({ root, home, configHome: join(home, 'config'), clients: ['claude', 'codex', 'cursor'] });
  const claudePath = join(home, '.claude', 'CLAUDE.md');
  const afterFirstInstall = await readFile(claudePath, 'utf8');
  const repeated = await install({ root, home, configHome: join(home, 'config'), clients: ['claude', 'codex', 'cursor'] });
  assert.ok(!repeated.changed.includes(claudePath), 'a repeated install must not rewrite the managed Claude memory block');
  assert.equal(await readFile(claudePath, 'utf8'), afterFirstInstall, 'a repeated install must not accumulate trailing newlines');
  const doc = await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8');
  assert.equal((doc.match(/BEGIN offload/g) || []).length, 1);
  assert.match(afterFirstInstall, /Use Offload only when the user invokes `\/offload_economy` or `\/offload_premium` as a slash command/);
  assert.match(afterFirstInstall, /profile `sonnet`/);
  assert.match(afterFirstInstall, /then to the latest provider-maintained DeepSeek Flash/);
  assert.match(afterFirstInstall, /latest Sonnet with adaptive thinking/);
  assert.match(afterFirstInstall, /on policy-only hosts they also have no worker shell/);
  assert.match(afterFirstInstall, /edit permitted private-worktree files with file tools/);
  assert.match(
    afterFirstInstall,
    /nor do bounded, multi-file, implementation, testing, debugging, Workflow, ultracode, or native-subagent requests/,
  );
  assert.match(afterFirstInstall, /including Sonnet ultracode\/native-agent workflows/);
  assert.match(afterFirstInstall, /A standalone instruction not to use native subagents does not select Offload/);
  assert.match(afterFirstInstall, /For either command invocation, end every final answer/);
  assert.match(
    afterFirstInstall,
    /A mention, quotation, negation, or discussion of `\/offload_economy`, offload, delegation, DeepSeek, OpenAI, Terra, Sol, a provider, or a model does not select Offload/,
  );
  assert.doesNotMatch(afterFirstInstall, /as well as for clearly bounded multi-file implementation/);
  assert.match(afterFirstInstall, /old `\/offload` command is removed/);
  assert.match(doc, /invokes `\/offload_economy` or `\/offload_premium` as a slash command/);
  assert.match(doc, /nor do bounded, multi-file, implementation, testing, debugging, Workflow, ultracode, or native-subagent requests/);
  assert.match(doc, /A standalone instruction not to use native subagents does not select Offload/);
  assert.match(doc, /provider or model name never routes work to Offload/);
  await install({ root, home, configHome: join(home, 'config'), clients: ['claude', 'codex', 'cursor'], uninstall: true });
  assert.doesNotMatch(await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8'), /BEGIN offload/);
  assert.throws(() => replaceManaged('<!-- BEGIN offload', 'x'), /malformed/);
});
test('installer stores a Claude skill recovery copy outside skill discovery', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-skill-backup-home-`);
  const configHome = join(home, 'config');
  const skills = [['claude', join(home, '.claude')]];
  for (const [, clientHome] of skills) {
    await mkdir(join(clientHome, 'skills', 'offload_economy'), { recursive: true });
    await writeFile(join(clientHome, 'skills', 'offload_economy', 'SKILL.md'), `user-owned ${basename(clientHome)} skill\n`);
  }

  const first = await install({ root: process.cwd(), home, configHome, clients: ['claude'] });
  for (const [, clientHome] of skills) {
    const legacy = join(clientHome, 'skills', 'offload_economy', 'SKILL.md.offload.bak');
    const backup = join(clientHome, 'offload-backups', 'SKILL.md.offload.bak');
    assert.equal(await readFile(backup, 'utf8'), `user-owned ${basename(clientHome)} skill\n`);
    await assert.rejects(access(legacy), /ENOENT/);
    assert.ok(first.backups.includes(backup));
  }

  const repeated = await install({ root: process.cwd(), home, configHome, clients: ['claude'] });
  assert.deepEqual(repeated.backups, [], 'a repeat must retain the first recovery copy without creating another one');
});
test('installer migrates legacy adjacent skill backups without replacing an existing recovery copy', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-legacy-skill-backup-home-`);
  const configHome = join(home, 'config');
  const skillDirectory = join(home, '.claude', 'skills', 'offload_economy');
  const legacy = join(skillDirectory, 'SKILL.md.offload.bak');
  const backupDirectory = join(home, '.claude', 'offload-backups');
  const preferred = join(backupDirectory, 'SKILL.md.offload.bak');
  const migrated = `${preferred}.legacy-1`;
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(backupDirectory, { recursive: true });
  await writeFile(legacy, 'older adjacent recovery copy\n');
  await writeFile(preferred, 'existing safe recovery copy\n');

  const first = await install({ root: process.cwd(), home, configHome, clients: ['claude'] });
  assert.equal(await readFile(preferred, 'utf8'), 'existing safe recovery copy\n');
  assert.equal(await readFile(migrated, 'utf8'), 'older adjacent recovery copy\n');
  await assert.rejects(access(legacy), /ENOENT/);
  assert.ok(first.backups.includes(migrated));

  const repeated = await install({ root: process.cwd(), home, configHome, clients: ['claude'] });
  assert.deepEqual(repeated.backups, [], 'a migrated legacy copy must not be copied again on a later update');
  await assert.rejects(access(`${preferred}.legacy-2`), /ENOENT/);
});
test('skill backups retain distinct command contents and later revisions without duplicating repeats', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'offload-distinct-skill-backups-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = { root: process.cwd(), home, configHome: join(home, 'config'), clients: ['claude'] };
  const names = ['offload_economy', 'offload_premium'];
  for (const name of names) {
    const file = join(home, '.claude', 'skills', name, 'SKILL.md');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `user ${name}`);
  }
  const first = await install(options);
  assert.equal(first.backups.filter((path) => path.includes('offload-backups')).length, 2);
  assert.deepEqual(
    await Promise.all(first.backups.filter((path) => path.includes('offload-backups')).map((path) => readFile(path, 'utf8'))),
    names.map((name) => `user ${name}`),
  );
  assert.deepEqual((await install(options)).backups, []);
  await writeFile(join(home, '.claude', 'skills', names[0], 'SKILL.md'), 'later user revision');
  const later = await install(options);
  assert.equal(later.backups.length, 1);
  assert.equal(await readFile(later.backups[0], 'utf8'), 'later user revision');
  assert.deepEqual((await install(options)).backups, []);
});
test('fresh-home uninstall does not create client or skill-backup directories', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-fresh-uninstall-home-`);
  try {
    const result = await install({
      root: process.cwd(),
      home,
      configHome: join(home, 'config'),
      clients: ['claude', 'codex'],
      uninstall: true,
    });
    assert.deepEqual(result.changed, []);
    for (const directory of [join(home, '.claude'), join(home, '.codex')]) {
      assert.equal(existsSync(directory), false, `no client root created at ${directory}`);
      assert.equal(existsSync(join(directory, 'offload-backups')), false, `no backup directory created below ${directory}`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test('installer refuses oversized client state before parsing or replacing it', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'offload-large-client-state-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const settings = join(home, '.claude', 'settings.json');
  await mkdir(dirname(settings), { recursive: true });
  const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 32);
  await writeFile(settings, bytes);
  await assert.rejects(
    install({ root: process.cwd(), home, configHome: join(home, 'config'), clients: ['claude'] }),
    /refusing unsafe installer file/,
  );
  assert.deepEqual(await readFile(settings), bytes);
});
test('installer refuses symlinked native skill and backup ancestry without touching external files', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-symlinked-skill-home-`);
  const configHome = join(home, 'config');
  const outsideSkill = await mkdtemp(`${tmpdir()}/offload-symlinked-skill-outside-`);
  const outsideBackups = await mkdtemp(`${tmpdir()}/offload-symlinked-backup-outside-`);
  const victim = join(outsideSkill, 'offload', 'SKILL.md');
  const externalBackup = join(outsideBackups, 'SKILL.md.offload.bak');
  try {
    await install({ root: process.cwd(), home, configHome, clients: ['claude'] });
    await mkdir(dirname(victim), { recursive: true });
    await writeFile(victim, 'external native skill must remain untouched\n');
    await rm(join(home, '.claude', 'skills'), { recursive: true, force: true });
    await symlink(outsideSkill, join(home, '.claude', 'skills'));
    await assert.rejects(() => install({ root: process.cwd(), home, configHome, clients: ['claude'] }), /symlinked client backup path/);
    await assert.rejects(
      () => install({ root: process.cwd(), home, configHome, clients: ['claude'], uninstall: true }),
      /symlinked client backup path/,
    );
    assert.equal(await readFile(victim, 'utf8'), 'external native skill must remain untouched\n');

    const backupHome = await mkdtemp(`${tmpdir()}/offload-symlinked-backup-home-`);
    try {
      await mkdir(join(backupHome, '.claude', 'skills', 'offload_economy'), { recursive: true });
      await symlink(outsideBackups, join(backupHome, '.claude', 'offload-backups'));
      await writeFile(externalBackup, 'external backup must remain untouched\n');
      await assert.rejects(
        () => install({ root: process.cwd(), home: backupHome, configHome: join(backupHome, 'config'), clients: ['claude'] }),
        /symlinked client backup path/,
      );
      assert.equal(await readFile(externalBackup, 'utf8'), 'external backup must remain untouched\n');
    } finally {
      await rm(backupHome, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outsideSkill, { recursive: true, force: true });
    await rm(outsideBackups, { recursive: true, force: true });
  }
});
test('installer preserves CRLF document boundaries through repeat, uninstall, and reinstall', async () => {
  const product = await mkdtemp(`${tmpdir()}/offload-crlf-memory-product-`);
  const home = await mkdtemp(`${tmpdir()}/offload-crlf-memory-home-`);
  const configHome = join(home, 'config');
  const claudePath = join(home, '.claude', 'CLAUDE.md');
  try {
    for (const path of ['bin', 'plugins', 'templates']) await cp(join(process.cwd(), path), join(product, path), { recursive: true });
    for (const path of ['install.mjs', 'config.example.json']) await cp(join(process.cwd(), path), join(product, path));
    await mkdir(dirname(claudePath), { recursive: true });
    await writeFile(claudePath, 'before\r\n<!-- BEGIN offload old -->old<!-- END offload -->\r\n\r\nafter\r\n');

    await install({ root: product, home, configHome, clients: ['claude'] });
    const afterFirstInstall = await readFile(claudePath, 'utf8');
    assert.match(afterFirstInstall, /^before\r\n<!--[\s\S]*<!-- END offload -->\r\n\r\nafter\r\n$/);
    assert.doesNotMatch(afterFirstInstall, /\r\r\n/, 'the replacement must retain, not duplicate, CRLF delimiters');
    assert.doesNotMatch(afterFirstInstall, /(?:^|[^\r])\n/, 'the replacement must not introduce bare LF into a CRLF document');

    const repeated = await install({ root: product, home, configHome, clients: ['claude'] });
    assert.ok(!repeated.changed.includes(claudePath));
    assert.equal(await readFile(claudePath, 'utf8'), afterFirstInstall);

    await install({ root: product, home, configHome, clients: ['claude'], uninstall: true });
    assert.equal(await readFile(claudePath, 'utf8'), 'before\r\n\r\n\r\nafter\r\n');

    await install({ root: product, home, configHome, clients: ['claude'] });
    const reinstalled = await readFile(claudePath, 'utf8');
    assert.match(reinstalled, /^before\r\n\r\n\r\nafter\r\n<!--[\s\S]*<!-- END offload -->\r\n$/);
    assert.doesNotMatch(reinstalled, /\r\r\n/);
    assert.doesNotMatch(reinstalled, /(?:^|[^\r])\n/, 'reinstall must retain CRLF rather than append a bare LF');
  } finally {
    await rm(product, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
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
test('installer preserves unrelated MCP configs and macOS key storage pipes to security -i and verifies the stored key', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const root = process.cwd();
  await (await import('node:fs/promises')).mkdir(join(home, '.cursor'), { recursive: true });
  await (await import('node:fs/promises')).writeFile(join(home, '.cursor', 'mcp.json'), '{"mcpServers":{"other":{"command":"x"}}}');
  await install({ root, home, configHome: join(home, 'config'), clients: ['cursor'] });
  const cursor = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cursor.mcpServers.other);
  assert.ok(cursor.mcpServers.offload);
  const secret = `sk-proj-${'A'.repeat(156)}`;
  const calls = [];
  const saved = await storeKeychainKey({
    platform: 'darwin',
    env: { PATH: '/usr/bin', HOME: '/private/home', OPENAI_API_KEY: 'must-not-reach-security' },
    macosInteractive: true,
    prompt: async () => secret,
    execFile: (cmd, values, opts) => {
      calls.push({ cmd, values, opts });
      return { status: 0 };
    },
    readExecFile: () => `${secret}\n`,
  });
  assert.equal(saved.stored, true);
  const [{ cmd, values, opts: options }] = calls;
  assert.equal(cmd, 'security');
  assert.deepEqual(values, ['-i']);
  assert.equal(
    values.some((value) => value.includes(secret)),
    false,
  );
  assert.equal(options.input, `add-generic-password -U -a offload -s offload-deepseek -w ${secret}\n`);
  assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.env.PATH, '/usr/bin');
  const truncated = storeKeychainKey({
    platform: 'darwin',
    macosInteractive: true,
    prompt: async () => secret,
    execFile: () => ({ status: 0 }),
    readExecFile: () => secret.slice(0, 128),
  });
  await assert.rejects(truncated, (error) => error.code === 'E_SECRET_STORE' && !error.message.includes(secret));
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
  // Default sonnet/opus route providers are checked too; point them at env refs.
  for (const name of ['anthropic', 'openai', 'deepseek'])
    config.providers[name] = { ...config.providers.custom, keyRef: `env:ROUTE_${name}` };
  await writeFile(configPath, JSON.stringify(config));
  let stored;
  await install({
    root: process.cwd(),
    home,
    configHome,
    clients: ['codex'],
    env: { PATH: '/usr/bin', ROUTE_anthropic: 'x', ROUTE_openai: 'x', ROUTE_deepseek: 'x' },
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
    env: { PATH: '/usr/bin', ROUTE_anthropic: 'x', ROUTE_openai: 'x', ROUTE_deepseek: 'x' },
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
  const crlfBlock = '<!-- BEGIN offload new -->\r\n<!-- END offload -->\r\n';
  assert.equal(replaceManaged('', crlfBlock), '<!-- BEGIN offload new -->\r\n<!-- END offload -->\r\n');
  assert.equal(replaceManaged('user\n', crlfBlock), 'user\n<!-- BEGIN offload new -->\n<!-- END offload -->\n');
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
  assert.match(claude, /Follow the command’s `offload_economy` or `offload_premium` skill/);
  assert.match(codex, /Follow the command’s `offload_economy` or `offload_premium` skill/);
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
test('installer flags a legacy managed update for restart once, then records the current runtime identity', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const first = await install({ root: process.cwd(), home, configHome, clients: ['claude'] });
  assert.equal(first.restart.required, false, 'a first install has no already-running managed server to replace');
  assert.match(first.runtime.buildHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.runtime.skillHash, /^sha256:[0-9a-f]{64}$/);
  const statePath = join(configHome, 'offload', 'installer-state.json');
  const legacy = JSON.parse(await readFile(statePath, 'utf8'));
  delete legacy.runtime;
  await writeFile(statePath, JSON.stringify(legacy));

  const upgraded = await install({ root: process.cwd(), home, configHome, clients: ['claude'] });
  assert.deepEqual(upgraded.restart, {
    required: true,
    reason: 'offload runtime artifacts changed',
    action:
      'Restart Claude Code or the MCP client to load the updated Offload server and skill. The installer does not kill live processes.',
  });
  const repeated = await install({ root: process.cwd(), home, configHome, clients: ['claude'] });
  assert.deepEqual(repeated.restart, { required: false });
});
test('installer uses the official Claude CLI for manifest-owned registration and preserves user replacements', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const root = process.cwd();
  const configHome = join(home, 'config');
  await install({ root, home, configHome, env: { PATH: '' } });
  await assert.rejects(readFile(join(home, '.claude.json')), /ENOENT/);
  const executable = join(home, 'bin', 'claude');
  const statePath = join(home, '.claude.json');
  const env = { PATH: dirname(executable), OFFLOAD_API_KEY: 'must-not-reach-claude' };
  const calls = [];
  const commandExists = async (path) => path === executable;
  const runCommand = fakeClaudeCli({ statePath, calls });
  await install({ root, home, configHome, env, clients: ['claude'], commandExists, runCommand });
  assert.deepEqual(calls[0].args, [
    'mcp',
    'add',
    '--scope',
    'user',
    'offload',
    '--',
    process.execPath,
    join(root, 'bin', 'offload.mjs'),
    'mcp',
  ]);
  assert.equal(calls[0].options.env.OFFLOAD_API_KEY, undefined);
  assert.equal(calls[0].options.env.HOME, home);
  const original = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).mcpServers.offload;
  const moved = await mkdtemp(`${tmpdir()}/offload-moved-`);
  await cp(join(root, 'templates'), join(moved, 'templates'), { recursive: true });
  await cp(join(root, 'plugins'), join(moved, 'plugins'), { recursive: true });
  await cp(join(root, 'bin'), join(moved, 'bin'), { recursive: true });
  await cp(join(root, 'install.mjs'), join(moved, 'install.mjs'));
  await cp(join(root, 'config.example.json'), join(moved, 'config.example.json'));
  calls.length = 0;
  await install({ root: moved, home, configHome, clients: ['claude'], env, commandExists, runCommand });
  assert.deepEqual(
    calls.map(({ args }) => args.slice(0, 5)),
    [
      ['mcp', 'remove', '--scope', 'user', 'offload'],
      ['mcp', 'add', '--scope', 'user', 'offload'],
    ],
  );
  const updated = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).mcpServers.offload;
  assert.notDeepEqual(updated, original);
  assert.equal(updated.args[0], join(moved, 'bin', 'offload.mjs'));
  updated.args.push('--user-edit');
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { offload: updated } }));
  calls.length = 0;
  const result = await install({ root, home, configHome, clients: ['claude'], env, commandExists, runCommand });
  assert.equal(result.claudeMcp.status, 'user-owned');
  assert.equal(calls.length, 0);
  const preserved = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).mcpServers.offload;
  assert.equal(preserved.args.at(-1), '--user-edit');
  await install({ root, home, configHome, clients: ['claude'], uninstall: true, env, commandExists, runCommand });
  assert.equal(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).mcpServers.offload.args.at(-1), '--user-edit');
});
test('installer approval mode can opt only Offload tools into unattended Claude and Codex calls', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-approval-home-`);
  const root = process.cwd();
  const configHome = join(home, 'config');
  const executable = join(home, 'bin', 'claude');
  const statePath = join(home, '.claude.json');
  const calls = [];
  const options = {
    root,
    home,
    configHome,
    clients: ['claude', 'codex'],
    approvalMode: 'approve',
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    runCommand: fakeClaudeCli({ statePath, calls }),
  };
  await install(options);
  const claude = JSON.parse(await readFile(statePath, 'utf8')).mcpServers.offload;
  assert.deepEqual(claude.env, { OFFLOAD_MCP_APPROVAL_MODE: 'approve' });
  assert.ok(calls[0].args.includes('OFFLOAD_MCP_APPROVAL_MODE=approve'));
  const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
  for (const rule of [
    'mcp__offload__offload_start',
    'mcp__offload__offload_repair',
    'mcp__offload__offload_continue',
    'mcp__offload__offload_apply',
    'mcp__offload__offload_revert',
    'mcp__offload__offload_cancel',
  ])
    assert.ok(settings.permissions.allow.includes(rule), rule);
  const codex = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codex, /default_tools_approval_mode = "approve"/);
  const manifest = JSON.parse(await readFile(join(configHome, 'offload', 'installer-state.json'), 'utf8'));
  assert.equal(manifest.approvalMode, 'approve');

  calls.length = 0;
  await install({ ...options, approvalMode: 'prompt' });
  const restoredClaude = JSON.parse(await readFile(statePath, 'utf8')).mcpServers.offload;
  assert.deepEqual(restoredClaude.env, {});
  const restoredSettings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!restoredSettings.permissions.allow.includes('mcp__offload__offload_cancel'));
  const restoredCodex = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(restoredCodex, /default_tools_approval_mode = "writes"/);
});
test('installer keeps ownership of still-installed mutating Claude rules across an approve rewrite', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-approval-home-`);
  const configHome = join(home, 'config');
  const executable = join(home, 'bin', 'claude');
  const statePath = join(home, '.claude.json');
  const calls = [];
  const options = {
    root: process.cwd(),
    home,
    configHome,
    clients: ['claude'],
    approvalMode: 'approve',
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    runCommand: fakeClaudeCli({ statePath, calls }),
  };
  const mutating = ['start', 'repair', 'continue', 'apply', 'revert', 'cancel'].map((name) => `mcp__offload__offload_${name}`);
  const settingsPath = join(home, '.claude', 'settings.json');
  const manifestPath = join(configHome, 'offload', 'installer-state.json');
  await install(options);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  settings.permissions.allow = settings.permissions.allow.filter((rule) => rule !== 'mcp__offload__offload_cancel');
  await writeFile(settingsPath, JSON.stringify(settings));
  await install(options);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const rule of mutating) assert.ok(manifest.claudeSettings.rules.includes(rule), rule);
  await install({ ...options, approvalMode: 'prompt' });
  const restored = JSON.parse(await readFile(settingsPath, 'utf8'));
  for (const rule of mutating) assert.ok(!restored.permissions.allow.includes(rule), rule);
});
test(
  'installer reports filesystem failures instead of mislabelling them as invalid Cursor JSON',
  { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'requires POSIX permissions and a non-root user' },
  async () => {
    const home = await mkdtemp(`${tmpdir()}/offload-home-`);
    const configHome = join(home, 'config');
    const cursorDir = join(home, '.cursor');
    await mkdir(cursorDir, { recursive: true });
    await writeFile(join(cursorDir, 'mcp.json'), '{"mcpServers":{}}\n');
    await chmod(cursorDir, 0o555);
    try {
      await assert.rejects(
        install({ root: process.cwd(), home, configHome, clients: ['cursor'] }),
        (error) => !/invalid Cursor MCP JSON/.test(error.message) && /EACCES|EPERM/.test(String(error.code || error.message)),
      );
    } finally {
      await chmod(cursorDir, 0o755);
    }
  },
);
test('installer never rewrites opaque Claude auth-shaped state when registering through the CLI', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const statePath = join(home, '.claude.json');
  const original =
    '{\n  "oauthSession": {"accessToken":"opaque", "refreshToken":"opaque"},\n  "mcpServers": {"other": {"command":"safe"}}\n}\n';
  await writeFile(statePath, original);
  const executable = join(home, 'bin', 'claude');
  const calls = [];
  const result = await install({
    root: process.cwd(),
    home,
    configHome,
    clients: ['claude'],
    env: { PATH: dirname(executable) },
    commandExists: async (path) => path === executable,
    // This fake is intentionally non-mutating: it represents the official
    // client boundary and proves the installer itself does not replace the
    // auth-adjacent file to make registration appear to succeed.
    runCommand: fakeClaudeCli({ statePath, calls, mutate: false }),
  });
  assert.equal(result.claudeMcp.status, 'add-unconfirmed');
  assert.equal(await readFile(statePath, 'utf8'), original);
  assert.deepEqual(calls[0].args.slice(0, 5), ['mcp', 'add', '--scope', 'user', 'offload']);
});
test('installer leaves malformed or symlinked Claude MCP state untouched without invoking Claude', async (t) => {
  for (const [label, setup] of [
    [
      'malformed',
      async ({ statePath }) => {
        const original = '{ malformed Claude state\n';
        await writeFile(statePath, original);
        return {
          assertUnchanged: async () => assert.equal(await readFile(statePath, 'utf8'), original),
        };
      },
    ],
    [
      'symlinked',
      async ({ home, statePath }) => {
        const target = join(home, 'external-claude-state.json');
        const original = '{"mcpServers":{"other":{"command":"safe"}}}\n';
        await writeFile(target, original);
        try {
          await symlink(target, statePath);
        } catch (error) {
          if (error.code === 'EPERM' || error.code === 'EACCES') t.skip(`symlink creation unavailable: ${error.code}`);
          else throw error;
          return undefined;
        }
        const link = await readlink(statePath);
        return {
          assertUnchanged: async () => {
            assert.equal(await readlink(statePath), link);
            assert.equal(await readFile(target, 'utf8'), original);
          },
        };
      },
    ],
  ]) {
    const home = await mkdtemp(`${tmpdir()}/offload-claude-state-${label}-`);
    const statePath = join(home, '.claude.json');
    const fixture = await setup({ home, statePath });
    if (!fixture) continue;
    const executable = join(home, 'bin', 'claude');
    const calls = [];
    const result = await install({
      root: process.cwd(),
      home,
      configHome: join(home, 'config'),
      clients: ['claude'],
      env: { PATH: dirname(executable) },
      commandExists: async (path) => path === executable,
      runCommand: fakeClaudeCli({ statePath, calls }),
    });
    assert.equal(result.claudeMcp.status, 'state-unreadable', `${label} state must block registration`);
    assert.deepEqual(calls, [], `${label} state must not invoke the Claude CLI`);
    await fixture.assertUnchanged();
  }
});
test('installer invokes a Windows Claude .cmd launcher through bounded cmd.exe quoting', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const executable = join(home, 'Program Files (x86)', 'Claude', 'claude.cmd');
  const claudeDir = join(home, 'private Claude config');
  const calls = [];
  const result = await install({
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['claude'],
    platform: 'win32',
    env: {
      Path: dirname(executable),
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      SystemRoot: 'C:\\Windows',
      CLAUDE_CONFIG_DIR: claudeDir,
      OFFLOAD_PROVIDER_SECRET: 'must-not-reach-child',
      NODE_OPTIONS: '--require=must-not-reach-child',
    },
    commandExists: async (path) => path === executable,
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '' };
    },
  });
  assert.equal(result.claudeMcp.status, 'add-unconfirmed');
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\cmd.exe');
  const expectedArguments = [
    executable,
    'mcp',
    'add',
    '--scope',
    'user',
    'offload',
    '--',
    process.execPath,
    join(process.cwd(), 'bin', 'offload.mjs'),
    'mcp',
  ];
  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', `"${expectedArguments.map((value) => `"${value}"`).join(' ')}"`]);
  assert.equal(calls[0].options.windowsVerbatimArguments, true, 'libuv must not re-escape the already quoted cmd payload');
  assert.equal(calls[0].options.shell, false, 'the explicit cmd.exe must not be wrapped in another shell');
  assert.equal(calls[0].options.timeout, 10_000);
  assert.equal(calls[0].options.maxBuffer, 64 * 1024);
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(calls[0].options.env, {
    Path: dirname(executable),
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    SystemRoot: 'C:\\Windows',
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeDir,
  });
  for (const metacharacter of ['\0', '\r', '\n', '"', '%', '^', '&', '|', '<', '>', '!']) {
    const rejectedHome = await mkdtemp(`${tmpdir()}/offload-unsafe-claude-`);
    const unsafeExecutable = join(rejectedHome, `bin${metacharacter}unsafe`, 'claude.cmd');
    const unsafeCalls = [];
    try {
      const rejected = await install({
        root: process.cwd(),
        home: rejectedHome,
        configHome: join(rejectedHome, 'config'),
        clients: ['claude'],
        platform: 'win32',
        env: { Path: dirname(unsafeExecutable) },
        commandExists: async (path) => path === unsafeExecutable,
        runCommand: (...args) => {
          unsafeCalls.push(args);
          return { status: 0, stdout: '' };
        },
      });
      assert.equal(rejected.claudeMcp.status, 'unavailable', JSON.stringify(metacharacter));
      assert.deepEqual(unsafeCalls, [], 'an unsafe .cmd executable must never reach the command runner');
    } finally {
      await rm(rejectedHome, { recursive: true, force: true });
    }
  }
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
  const executable = join(home, 'bin', 'claude');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir, PATH: dirname(executable) };
  await install({
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['claude', 'codex'],
    env,
    commandExists: async (path) => path === executable,
    runCommand: fakeClaudeCli({ statePath: join(claudeDir, '.claude.json'), calls: [] }),
  });
  assert.ok(JSON.parse(await readFile(join(claudeDir, '.claude.json'), 'utf8')).mcpServers.offload);
  await assert.rejects(readFile(join(home, '.claude.json')), /ENOENT/);
  assert.match(await readFile(join(claudeDir, 'skills', 'offload_economy', 'SKILL.md'), 'utf8'), /argument-hint/);
  assert.match(await readFile(join(codexDir, 'skills', 'offload_economy', 'SKILL.md'), 'utf8'), /argument-hint/);
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
  const command = doctorHookCommand(root);
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
test('Claude consolidates manifest-owned doctor hooks from legacy source and package roots', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-hook-migration-home-`);
  const configHome = join(home, 'config');
  const packagedRoot = join(home, 'prefix', 'lib', 'node_modules', 'offload');
  const sourceRoot = join(home, 'Desktop', 'AI-Coding-Delegation');
  for (const path of ['bin', 'plugins', 'templates']) await cp(join(process.cwd(), path), join(packagedRoot, path), { recursive: true });
  for (const path of ['install.mjs', 'config.example.json']) await cp(join(process.cwd(), path), join(packagedRoot, path));
  const canonical = doctorHookCommand(packagedRoot);
  const legacySource = doctorHookCommand(sourceRoot);
  const settingsPath = join(home, '.claude', 'settings.json');
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'user-hook' }] },
          {
            matcher: 'startup|resume|fork',
            hooks: [
              { type: 'command', command: canonical },
              { type: 'command', command: 'user-sibling' },
            ],
          },
          { matcher: 'resume', hooks: [{ type: 'command', command: legacySource }] },
          { matcher: 'fork', hooks: [{ type: 'command', command: legacySource }] },
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
      plugins: {},
      claudeSettings: {
        hookCommand: legacySource,
        hookMatcher: 'resume',
        hookOwned: true,
        rules: [],
      },
    }),
  );

  await install({ root: packagedRoot, home, configHome, clients: ['claude'] });
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  const hooks = settings.hooks.SessionStart.flatMap((entry) => entry.hooks);
  assert.equal(hooks.filter((hook) => hook.command === canonical).length, 1);
  assert.equal(
    hooks.some((hook) => hook.command === legacySource),
    true,
  );
  assert.equal(
    settings.hooks.SessionStart.some((entry) => entry.matcher === 'resume' && entry.hooks.some((hook) => hook.command === legacySource)),
    false,
  );
  assert.ok(settings.hooks.SessionStart.some((entry) => entry.matcher === 'startup' && entry.hooks[0].command === 'user-hook'));
  assert.ok(
    settings.hooks.SessionStart.some(
      (entry) => entry.matcher === 'startup|resume|fork' && entry.hooks.some((hook) => hook.command === 'user-sibling'),
    ),
  );
  const manifest = JSON.parse(await readFile(join(configHome, 'offload', 'installer-state.json'), 'utf8'));
  assert.equal(manifest.claudeSettings.hookOwned, false, 'a pre-existing canonical hook remains user-owned');
  await install({ root: packagedRoot, home, configHome, clients: ['claude'] });
  let repeated = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.ok(
    repeated.hooks.SessionStart.some((entry) => entry.matcher === 'fork' && entry.hooks.some((hook) => hook.command === legacySource)),
    'a same-looking hook outside the recorded matcher remains untouched on repeat',
  );
  await install({ root: packagedRoot, home, configHome, clients: ['claude'], uninstall: true });
  repeated = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.ok(
    repeated.hooks.SessionStart.some(
      (entry) => entry.matcher === 'startup|resume|fork' && entry.hooks.some((hook) => hook.command === canonical),
    ),
    'uninstall must retain the pre-existing canonical hook',
  );
});
test('Claude migrates only its manifest-recorded Windows-quoted doctor hook', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-windows-hook-migration-home-`);
  const configHome = join(home, 'config');
  const root = process.cwd();
  const current = `"${process.execPath}" "${join(root, 'install.mjs')}" --doctor-hook`;
  const legacySource = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\jack\\Desktop\\AI-Coding-Delegation\\install.mjs" --doctor-hook';
  const settingsPath = join(home, '.claude', 'settings.json');
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              { type: 'command', command: legacySource },
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
      plugins: {},
      claudeSettings: {
        hookCommand: legacySource,
        hookMatcher: 'startup',
        hookOwned: true,
        rules: [],
      },
    }),
  );

  await install({ root, home, configHome, clients: ['claude'], platform: 'win32' });
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  const hooks = settings.hooks.SessionStart.flatMap((entry) => entry.hooks);
  assert.equal(
    hooks.some((hook) => hook.command === legacySource),
    false,
  );
  assert.equal(hooks.filter((hook) => hook.command === current).length, 1);
  assert.ok(hooks.some((hook) => hook.command === 'user-hook'));
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
  const command = doctorHookCommand(root);
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
  await install({ root, home, configHome, clients: ['claude'] });
  settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.ok(
    settings.hooks.SessionStart.some((entry) => entry.matcher === 'startup' && entry.hooks.some((hook) => hook.command === command)),
    'a later reinstall must retain the pre-existing exact hook',
  );
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
  const skill = await readFile(join(root, 'plugins', 'offload', 'skills', 'offload_economy', 'SKILL.md'), 'utf8');
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
  await mkdir(join(home, '.claude', 'skills', 'offload_economy'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(join(home, '.claude', 'skills', 'offload_economy', 'SKILL.md'), skill);
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { offload: claude } }));
  await writeFile(join(home, '.codex', 'config.toml'), `${codex}\n`);
  await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { offload: cursor } }));
  await install({ root, home, configHome, clients: ['claude', 'codex', 'cursor'] });
  const manifest = JSON.parse(await readFile(join(configHome, 'offload', 'installer-state.json'), 'utf8'));
  assert.equal(manifest.files[join(home, '.claude', 'skills', 'offload_economy', 'SKILL.md')], undefined);
  assert.equal(manifest.registrations.claude, undefined);
  assert.equal(manifest.registrations.codex, undefined);
  assert.equal(manifest.registrations.cursor, undefined);
  await install({ root, home, configHome, clients: ['claude', 'codex', 'cursor'], uninstall: true });
  assert.equal(await readFile(join(home, '.claude', 'skills', 'offload_economy', 'SKILL.md'), 'utf8'), skill);
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
  await assert.rejects(access(join(codexHome, 'skills', 'offload_economy', 'SKILL.md')), /ENOENT/);
  assert.match(await readFile(join(home, 'plugins', 'offload', 'skills', 'offload_economy', 'SKILL.md'), 'utf8'), /argument-hint/);
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
  await assert.rejects(access(join(home, 'plugins', 'offload', 'skills', 'offload_economy', 'SKILL.md')), /ENOENT/);
});
test('Codex plugin list accepts the current pluginId-based structured response', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const executable = join(home, 'bin', 'codex');
  let adds = 0;
  const structuredList = {
    installed: [
      {
        pluginId: 'offload@personal',
        name: 'offload',
        marketplaceName: 'personal',
        version: '0.1.0+codex.7757ccd5d04f5ca6',
        installed: true,
        enabled: true,
        source: { source: 'local', path: '/outside-the-installer-home/plugins/offload' },
      },
    ],
  };
  try {
    const result = await rawInstall({
      root: process.cwd(),
      home,
      configHome: join(home, 'config'),
      clients: ['codex'],
      env: { PATH: dirname(executable) },
      commandExists: async (path) => path === executable,
      runCommand: (_command, args) => {
        if (args.includes('list')) return { status: 0, stdout: Buffer.from(JSON.stringify(structuredList)), stderr: 'harmless warning' };
        if (args.includes('add')) adds++;
        return { status: 0, stdout: '{}' };
      },
    });
    assert.equal(result.plugin.active, true, JSON.stringify(result.plugin));
    assert.equal(result.plugin.preexisting, true, JSON.stringify(result.plugin));
    assert.equal(adds, 0, 'a confirmed installed+enabled plugin must not be re-added');
    await assert.rejects(access(join(home, '.codex', 'skills', 'offload_economy', 'SKILL.md')), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test('Codex plugin list rejects a contradictory pluginId even when display fields match', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const executable = join(home, 'bin', 'codex');
  let adds = 0;
  try {
    const result = await rawInstall({
      root: process.cwd(),
      home,
      configHome: join(home, 'config'),
      clients: ['codex'],
      env: { PATH: dirname(executable) },
      commandExists: async (path) => path === executable,
      runCommand: (_command, args) => {
        if (args.includes('list'))
          return {
            status: 0,
            stdout: JSON.stringify({
              installed: [{ pluginId: 'offload@other', name: 'offload', marketplaceName: 'personal', installed: true, enabled: true }],
            }),
          };
        if (args.join(' ') === 'plugin --help') return { status: 0, stdout: 'Commands:\n  add\n  list\n  remove\n' };
        if (args.includes('add')) adds++;
        return { status: 0, stdout: '{}' };
      },
    });
    assert.equal(result.plugin.active, false, JSON.stringify(result.plugin));
    assert.equal(result.plugin.blockNative, true, JSON.stringify(result.plugin));
    assert.equal(result.plugin.retained, true, JSON.stringify(result.plugin));
    assert.equal(adds, 0, 'a mismatched identity must not trigger a potentially duplicate plugin add');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test('Codex plugin list rejects a malformed present pluginId even when display fields match', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const executable = join(home, 'bin', 'codex');
  let adds = 0;
  try {
    const result = await rawInstall({
      root: process.cwd(),
      home,
      configHome: join(home, 'config'),
      clients: ['codex'],
      env: { PATH: dirname(executable) },
      commandExists: async (path) => path === executable,
      runCommand: (_command, args) => {
        if (args.includes('list'))
          return {
            status: 0,
            stdout: JSON.stringify({
              installed: [{ pluginId: null, name: 'offload', marketplaceName: 'personal', installed: true, enabled: true }],
            }),
          };
        if (args.join(' ') === 'plugin --help') return { status: 0, stdout: 'Commands:\n  add\n  list\n  remove\n' };
        if (args.includes('add')) adds++;
        return { status: 0, stdout: '{}' };
      },
    });
    assert.equal(result.plugin.active, false, JSON.stringify(result.plugin));
    assert.equal(result.plugin.blockNative, true, JSON.stringify(result.plugin));
    assert.equal(result.plugin.retained, true, JSON.stringify(result.plugin));
    assert.equal(adds, 0, 'a malformed identity must not trigger a potentially duplicate plugin add');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test('plugin content versions remain canonical when a Windows checkout supplies CRLF artifacts', async () => {
  const product = await mkdtemp(`${tmpdir()}/offload-crlf-product-`);
  const home = await mkdtemp(`${tmpdir()}/offload-crlf-home-`);
  const executable = join(home, 'bin', 'codex');
  try {
    for (const path of ['bin', 'plugins', 'templates']) await cp(join(process.cwd(), path), join(product, path), { recursive: true });
    for (const path of ['install.mjs', 'config.example.json']) await cp(join(process.cwd(), path), join(product, path));
    for (const relativePath of [
      'plugin.json',
      '.codex-plugin/plugin.json',
      'skills/offload_economy/SKILL.md',
      'skills/offload_premium/SKILL.md',
    ]) {
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
    'plugins/offload/skills/offload_economy/SKILL.md',
    'plugins/offload/skills/offload_premium/SKILL.md',
  ]) {
    assert.match(attributes, new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} text eol=lf$`, 'm'));
    assert.doesNotMatch(await readFile(join(process.cwd(), path), 'utf8'), /\r\n?/);
  }
});
test('a user-owned native Codex skill prevents plugin activation', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const native = join(home, '.codex', 'skills', 'offload_economy', 'SKILL.md');
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
      ['.codex-plugin/plugin.json', 'plugin.json', 'skills/offload_economy/SKILL.md', 'skills/offload_premium/SKILL.md']
        .sort()
        .map(async (relativePath) => {
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
    const skillPath = join(product, 'plugins', 'offload', 'skills', 'offload_economy', 'SKILL.md');
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
    (await readFile(codexManifest, 'utf8')).replace(
      '"Explicit /offload_economy or /offload_premium slash command only"',
      '"Explicit /offload_economy command only"',
    ),
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
  assert.match(await readFile(join(home, '.codex', 'skills', 'offload_economy', 'SKILL.md'), 'utf8'), /argument-hint/);
});
test('Codex plugin upgrades the previous command paths and preserves user edits', async (t) => {
  for (const edited of [false, true]) {
    const home = await mkdtemp(`${tmpdir()}/offload-plugin-command-migration-`);
    t.after(() => rm(home, { recursive: true, force: true }));
    const executable = join(home, 'bin', 'codex');
    let installed = false;
    const options = {
      root: process.cwd(),
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
        if (args.includes('remove')) installed = false;
        return { status: 0, stdout: '{}' };
      },
    };
    await rawInstall(options);
    const manifestPath = join(home, 'config', 'offload', 'installer-state.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const state = manifest.plugins.codex;
    for (const [oldName, newName] of [
      ['offload_sonnet', 'offload_economy'],
      ['offload_opus', 'offload_premium'],
    ]) {
      const oldPath = join(state.source, 'skills', oldName, 'SKILL.md');
      const newPath = join(state.source, 'skills', newName, 'SKILL.md');
      const oldText = (await readFile(newPath, 'utf8')).replaceAll(newName, oldName);
      await mkdir(dirname(oldPath), { recursive: true });
      await writeFile(oldPath, oldText);
      state.files[oldPath] = createHash('sha256').update(oldText).digest('hex');
      await rm(dirname(newPath), { recursive: true });
      delete state.files[newPath];
    }
    const preserved = join(state.source, 'skills', 'offload_opus', 'SKILL.md');
    if (edited) await writeFile(preserved, 'user edit');
    state.version = '0.1.0+codex.0000000000000000';
    await writeFile(manifestPath, JSON.stringify(manifest));

    const result = await rawInstall(options);
    assert.equal(result.plugin.active, true, JSON.stringify(result.plugin));
    await assert.rejects(access(join(state.source, 'skills', 'offload_sonnet', 'SKILL.md')), /ENOENT/);
    if (edited) assert.equal(await readFile(preserved, 'utf8'), 'user edit');
    else await assert.rejects(access(preserved), /ENOENT/);
    for (const name of ['offload_economy', 'offload_premium'])
      assert.match(await readFile(join(state.source, 'skills', name, 'SKILL.md'), 'utf8'), new RegExp(`"name": "${name}"`));
    assert.equal((await rawInstall(options)).changed.length, 0);
    await rawInstall({ ...options, uninstall: true });
    for (const name of ['offload_economy', 'offload_premium'])
      await assert.rejects(access(join(state.source, 'skills', name, 'SKILL.md')), /ENOENT/);
    if (edited) assert.equal(await readFile(preserved, 'utf8'), 'user edit');
  }
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
  await assert.rejects(access(join(home, 'plugins', 'offload', 'skills', 'offload_economy', 'SKILL.md')), /ENOENT/);
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
  await writeFile(join(home, 'plugins', 'offload', 'skills', 'offload_economy', 'SKILL.md'), 'user edit');
  installed = false;
  await rawInstall(options);
  assert.match(await readFile(join(home, '.codex', 'skills', 'offload_economy', 'SKILL.md'), 'utf8'), /argument-hint/);
  malformed = true;
  await rawInstall(options);
  assert.match(await readFile(join(home, '.codex', 'skills', 'offload_economy', 'SKILL.md'), 'utf8'), /argument-hint/);
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
  await assert.rejects(access(join(conflictHome, '.codex', 'skills', 'offload_economy', 'SKILL.md')), /ENOENT/);
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
  await assert.rejects(access(join(home, '.codex', 'skills', 'offload_economy', 'SKILL.md')), /ENOENT/);
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
  await writeFile(join(ownedHome, 'plugins', 'offload', 'skills', 'offload_economy', 'SKILL.md'), 'user edit');
  await rawInstall(options);
  await assert.rejects(access(join(ownedHome, '.codex', 'skills', 'offload_economy', 'SKILL.md')), /ENOENT/);
});
test('Codex plugin uses cmd.exe safely on Windows and Cursor never receives a global rule', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const executable = join(home, 'Program Files (x86)', 'Codex', 'codex.cmd');
  const codexHome = join(home, 'private Codex config');
  const calls = [];
  const runCommand = (command, args, options) => {
    calls.push({ command, args, options });
    return args.includes('/c') && args.at(-1).includes('"plugin" "list"')
      ? { status: 0, stdout: '{"installed":[]}' }
      : { status: 0, stdout: '{}' };
  };
  await rawInstall({
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['codex'],
    platform: 'win32',
    env: {
      Path: dirname(executable),
      ComSpec: 'cmd.exe',
      SystemRoot: 'C:\\Windows',
      CODEX_HOME: codexHome,
      OFFLOAD_PROVIDER_SECRET: 'must-not-reach-child',
      NODE_OPTIONS: '--require=must-not-reach-child',
    },
    commandExists: async (path) => path === executable,
    runCommand,
  });
  assert.equal(calls[0].command, 'cmd.exe');
  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', `""${executable}" "plugin" "list" "--json""`]);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 10_000);
  assert.equal(calls[0].options.maxBuffer, 1_000_000);
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(calls[0].options.env, {
    Path: dirname(executable),
    ComSpec: 'cmd.exe',
    SystemRoot: 'C:\\Windows',
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
  });
  for (const metacharacter of ['\0', '\r', '\n', '"', '%', '^', '&', '|', '<', '>', '!']) {
    const rejectedHome = await mkdtemp(`${tmpdir()}/offload-unsafe-codex-`);
    const unsafeExecutable = join(rejectedHome, `bin${metacharacter}unsafe`, 'codex.cmd');
    const unsafeCalls = [];
    try {
      const rejected = await rawInstall({
        root: process.cwd(),
        home: rejectedHome,
        configHome: join(rejectedHome, 'config'),
        clients: ['codex'],
        platform: 'win32',
        env: { Path: dirname(unsafeExecutable) },
        commandExists: async (path) => path === unsafeExecutable,
        runCommand: (...args) => {
          unsafeCalls.push(args);
          return { status: 0, stdout: '{}' };
        },
      });
      assert.equal(rejected.plugin.active, false, JSON.stringify(metacharacter));
      assert.deepEqual(unsafeCalls, [], 'an unsafe .cmd executable must never reach the command runner');
    } finally {
      await rm(rejectedHome, { recursive: true, force: true });
    }
  }
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
  const victim = join(home, 'elsewhere', 'skills', 'offload_economy', 'SKILL.md.offload.bak');
  await mkdir(dirname(victim), { recursive: true });
  await writeFile(victim, 'user recovery copy');
  await mkdir(join(configHome, 'offload'), { recursive: true });
  await writeFile(
    join(configHome, 'offload', 'installer-state.json'),
    JSON.stringify({
      version: 1,
      registrations: {},
      files: {},
      plugins: { codex: { source: join(home, 'elsewhere'), files: {} } },
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
  assert.equal(await readFile(victim, 'utf8'), 'user recovery copy');
  await assert.rejects(access(join(home, '.codex', 'offload-backups', 'SKILL.md.offload.bak')), /ENOENT/);
});
test('plugin uninstall does not follow a substituted source symlink', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-plugin-`);
  const source = join(home, 'plugins', 'offload');
  const outside = join(home, 'outside');
  const victim = join(outside, 'skills', 'offload_economy', 'SKILL.md');
  await mkdir(dirname(victim), { recursive: true });
  await writeFile(victim, 'outside skill');
  await mkdir(dirname(source), { recursive: true });
  await symlink(outside, source);
  const configHome = join(home, 'config');
  const recorded = join(source, 'skills', 'offload_economy', 'SKILL.md');
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
  await assert.rejects(
    () =>
      rawInstall({
        root: join(home, 'missing'),
        home,
        configHome,
        clients: ['codex'],
        uninstall: true,
        env: { PATH: '' },
        commandExists: async () => false,
      }),
    /symlinked client backup path/,
  );
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
  await assert.rejects(access(join(home, '.codex', 'skills', 'offload_economy', 'SKILL.md')), /ENOENT/);
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
  assert.match(await readFile(join(home, '.codex', 'skills', 'offload_economy', 'SKILL.md'), 'utf8'), /argument-hint/);
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
  assert.match(await readFile(join(unsupportedHome, '.codex', 'skills', 'offload_economy', 'SKILL.md'), 'utf8'), /argument-hint/);
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
  await assert.rejects(access(join(ambiguousHome, '.codex', 'skills', 'offload_economy', 'SKILL.md')), /ENOENT/);
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
  await assert.rejects(access(join(home, '.codex', 'skills', 'offload_economy', 'SKILL.md')), /ENOENT/);
});
test('Claude migrates its owned startup health hook to resume and fork without removing a user hook', async () => {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const root = process.cwd();
  const command = doctorHookCommand(root);
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
test('doctor hook banner names a stale skill and a foreign hook root with the fix', async () => {
  const home = await mkdtemp(join(tmpdir(), 'offload-banner-home-'));
  const claudeDir = join(home, '.claude');
  await mkdir(join(claudeDir, 'skills', 'offload_economy'), { recursive: true });
  await writeFile(join(claudeDir, 'skills', 'offload_economy', 'SKILL.md'), 'older skill\n');
  await writeFile(
    join(claudeDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: `'/usr/bin/node' '/old/offload/install.mjs' --doctor-hook` }] },
        ],
      },
    }),
  );
  const result = spawnSync(process.execPath, [join(process.cwd(), 'install.mjs'), '--doctor-hook'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.match(result.stdout, /installed claude skill is STALE: run node install\.mjs from .* then restart/);
  assert.match(result.stdout, /another offload hook root is registered: \/old\/offload\/install\.mjs/);
  assert.match(result.stdout, / · restart the MCP client after updates\n$/);
});

test('installer migrates owned legacy commands to economy and premium while preserving user edits', async (t) => {
  const home = await mkdtemp(`${tmpdir()}/offload-two-command-migration-`);
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = {
    root: process.cwd(),
    home,
    configHome: join(home, 'config'),
    clients: ['claude', 'codex'],
    skipKey: true,
    env: { PATH: '' },
  };
  await install(options);
  const manifestPath = join(home, 'config', 'offload', 'installer-state.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const legacyNames = ['offload', 'offload_sonnet', 'offload_opus'];
  for (const name of legacyNames) {
    for (const client of ['.claude', '.codex']) {
      const file = join(home, client, 'skills', name, 'SKILL.md');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'old managed command');
      manifest.files[file] = createHash('sha256').update('old managed command').digest('hex');
    }
    await writeFile(join(home, '.codex', 'skills', name, 'SKILL.md'), 'user edit');
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  await install(options);
  for (const name of legacyNames) {
    await assert.rejects(access(join(home, '.claude', 'skills', name, 'SKILL.md')), /ENOENT/);
    assert.equal(await readFile(join(home, '.codex', 'skills', name, 'SKILL.md'), 'utf8'), 'user edit');
  }
  for (const client of ['.claude', '.codex'])
    for (const name of ['offload_economy', 'offload_premium'])
      assert.match(await readFile(join(home, client, 'skills', name, 'SKILL.md'), 'utf8'), new RegExp(`"name": "${name}"`));
  assert.equal((await install(options)).changed.length, 0);
  await install({ ...options, uninstall: true });
  for (const name of ['offload_economy', 'offload_premium'])
    await assert.rejects(access(join(home, '.claude', 'skills', name, 'SKILL.md')), /ENOENT/);
});
async function keyRoutesFixture(keyRefs) {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  await mkdir(join(configHome, 'offload'), { recursive: true });
  const provider = (keyRef) => ({ type: 'openai-chat', baseUrl: 'https://api.example.test', keyRef });
  await writeFile(
    join(configHome, 'offload', 'config.json'),
    JSON.stringify({
      providers: { anthropic: provider(keyRefs.anthropic), openai: provider(keyRefs.openai), deepseek: provider(keyRefs.deepseek) },
      profiles: {
        sonnet: { provider: 'anthropic', model: 'm', fallback: 'terra' },
        opus: { provider: 'anthropic', model: 'm', fallback: 'sol' },
        terra: { provider: 'openai', model: 'm', fallback: 'flash' },
        sol: { provider: 'openai', model: 'm', fallback: 'flash' },
        flash: { provider: 'deepseek', model: 'm' },
      },
      default: 'sonnet',
      limits: { maxTurns: 1, timeoutMinutes: 1, maxUsd: 1 },
    }),
  );
  return { home, configHome };
}
test('installer prompts for each missing route key, one provider at a time, and skips present ones', async () => {
  const { home, configHome } = await keyRoutesFixture({
    anthropic: 'env:KR_ANTHROPIC',
    openai: 'keychain:offload-test-openai-zz',
    deepseek: 'keychain:offload-test-deepseek-zz',
  });
  const calls = [];
  const result = await install({
    root: process.cwd(),
    home,
    configHome,
    clients: ['codex'],
    env: { PATH: '/usr/bin', KR_ANTHROPIC: 'present' },
    platform: 'linux',
    keyPrompt: async () => 'x',
    keychain: async (value) => {
      calls.push(value);
      return { stored: true, service: value.service };
    },
  });
  assert.deepEqual(
    calls.map((call) => call.service),
    ['offload-test-openai-zz', 'offload-test-deepseek-zz'],
  );
  assert.deepEqual(
    result.keys.map((entry) => entry.provider),
    ['anthropic', 'openai', 'deepseek'],
  );
  assert.match(result.keys[0].reason, /configure env/);
  assert.equal(result.key.provider, 'anthropic');
});
test('--key=openai stores only the OpenAI service through the injected keychain command and replaces it', async () => {
  assert.equal(parseInstallerArgs(['--key=openai']).keyProvider, 'openai');
  assert.equal(parseInstallerArgs(['--key', 'openai']).keyProvider, 'openai');
  assert.throws(() => parseInstallerArgs(['--key=openai', '--skip-key']), /--key/);
  assert.throws(() => parseInstallerArgs(['--key=openai', '--uninstall']), /--key/);
  assert.throws(() => parseInstallerArgs(['--key=sk-live-secret value']), /--key requires/);
  assert.throws(() => parseInstallerArgs(['--key']), /--key requires/);
  const { home, configHome } = await keyRoutesFixture({
    anthropic: 'env:KR_ANTHROPIC',
    openai: 'env:KR_OPENAI',
    deepseek: 'keychain:offload-test-deepseek-zz',
  });
  await writeFile(
    join(configHome, 'offload', 'config.json'),
    (await readFile(join(configHome, 'offload', 'config.json'), 'utf8')).replace('env:KR_OPENAI', 'keychain:offload-test-openai-zz'),
  );
  const calls = [];
  const result = await install({
    root: process.cwd(),
    home,
    configHome,
    clients: ['codex'],
    env: { PATH: '/usr/bin' },
    platform: 'linux',
    keyPrompt: async () => 'x',
    keyProvider: 'openai',
    keychain: async (value) => {
      calls.push(value);
      return { stored: true, service: value.service };
    },
  });
  assert.deepEqual(
    calls.map((call) => call.service),
    ['offload-test-openai-zz'],
  );
  assert.equal(result.key.provider, 'openai');
  const unknown = await install({
    root: process.cwd(),
    home,
    configHome,
    clients: ['codex'],
    keyPrompt: async () => 'x',
    keyProvider: 'nope',
    keychain: async () => assert.fail('must not store'),
  });
  assert.equal(unknown.key.stored, false);
  assert.match(unknown.key.reason, /unknown provider/);
  assert.doesNotMatch(JSON.stringify(unknown), /nope/);
  assert.throws(
    () => parseInstallerArgs(['--key=sk-abc123def456']),
    (error) => !/abc123/.test(error.message),
  );
});
test('storeKeychainKey on macOS never takes the secret from the prompt and labels the provider', async () => {
  let promptCalls = 0;
  const result = await storeKeychainKey({
    service: 'offload-openai',
    platform: 'darwin',
    macosInteractive: false,
    label: 'openai API key',
    prompt: async () => {
      promptCalls++;
      return 'secret';
    },
    execFile: () => assert.fail('must not run'),
  });
  assert.equal(result.stored, false);
  assert.equal(promptCalls, 0);
});
// config.example.json profiles as d5c7358 and a548949 shipped them.
const CLAUDE_GPT_FLASH_PROFILES = {
  sonnet: { provider: 'anthropic', model: 'latest-sonnet', fallback: 'terra' },
  opus: { provider: 'anthropic', model: 'latest-opus', fallback: 'sol' },
  terra: { provider: 'openai', model: 'latest-terra', fallback: 'flash' },
  sol: { provider: 'openai', model: 'latest-sol', fallback: 'flash' },
  flash: { provider: 'deepseek', model: 'latest-flash' },
};
const CLAUDE_FLASH_PROFILES = {
  sonnet: { provider: 'anthropic', model: 'latest-sonnet', fallback: 'flash' },
  opus: { provider: 'anthropic', model: 'latest-opus', fallback: 'flash' },
  flash: { provider: 'deepseek', model: 'latest-flash' },
};
async function legacyConfigHome(content, { mode } = {}) {
  const home = await mkdtemp(`${tmpdir()}/offload-home-`);
  const configHome = join(home, 'config');
  const configPath = join(configHome, 'offload', 'config.json');
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, content, mode === undefined ? undefined : { mode });
  const options = { root: process.cwd(), home, configHome, clients: ['codex'], env: { PATH: '/usr/bin' } };
  const legacyStatus = () => doctor({ root: process.cwd(), home, configPath, repoPath: process.cwd() }).config.legacyClaudeFirst;
  return { home, configPath, options, legacyStatus };
}
test('installer migrates a config copied from the Claude-first example, backing up the exact bytes and keeping the mode', async () => {
  // A BOM and CRLF line endings must survive in the backup byte for byte.
  const original =
    '﻿' +
    JSON.stringify({ profiles: CLAUDE_GPT_FLASH_PROFILES, limits: { maxTurns: 40, timeoutMinutes: 30, maxUsd: 2 } }, null, 4).replace(
      /\n/g,
      '\r\n',
    );
  const { home, configPath, options, legacyStatus } = await legacyConfigHome(original, { mode: 0o640 });
  try {
    assert.deepEqual(legacyStatus(), { profiles: ['sonnet', 'opus'], fix: 'install' });
    const result = await install(options);
    assert.deepEqual(result.configMigration, { migrated: ['sonnet', 'opus'], pending: [] });
    assert.ok(result.changed.includes(configPath));
    const backup = `${configPath}.claude-first.offload.bak`;
    assert.ok(result.backups.includes(backup));
    assert.deepEqual(await readFile(backup), Buffer.from(original, 'utf8'));
    if (process.platform !== 'win32') assert.equal(statSync(configPath).mode & 0o777, 0o640);
    const migrated = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(migrated.profiles.sonnet, { provider: 'openai', model: 'latest-terra', fallback: 'claude-sonnet' });
    assert.deepEqual(migrated.profiles.opus, { provider: 'openai', model: 'latest-sol', fallback: 'claude-opus' });
    assert.deepEqual(migrated.profiles['claude-sonnet'], { provider: 'anthropic', model: 'latest-sonnet', fallback: 'flash' });
    assert.deepEqual(migrated.profiles['claude-opus'], { provider: 'anthropic', model: 'latest-opus', fallback: 'flash' });
    assert.equal(migrated.limits.maxTurns, 40, 'unrelated settings survive');
    assert.equal(legacyStatus(), undefined);
    const again = await install(options);
    assert.equal(again.configMigration, undefined);
    assert.ok(!again.changed.includes(configPath));
    // Restoring the old example and installing again keeps both originals.
    await writeFile(configPath, JSON.stringify({ profiles: CLAUDE_FLASH_PROFILES }));
    const restored = await install(options);
    assert.deepEqual(restored.configMigration.migrated, ['sonnet', 'opus']);
    assert.deepEqual(await readFile(backup), Buffer.from(original, 'utf8'));
    assert.ok(restored.backups.includes(`${backup}.legacy-1`));
    assert.equal(await readFile(`${backup}.legacy-1`, 'utf8'), JSON.stringify({ profiles: CLAUDE_FLASH_PROFILES }));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test('installer leaves a config it cannot safely migrate untouched and still completes', async () => {
  const cases = [
    // Invalid elsewhere: migration must not turn a loadable install into an aborted one.
    ['invalid', JSON.stringify({ profiles: CLAUDE_FLASH_PROFILES, limits: { maxTurns: 1, timeoutMinutes: 1, maxUsd: -1 } })],
    [
      'conflict',
      JSON.stringify({ profiles: { ...CLAUDE_FLASH_PROFILES, 'claude-sonnet': { provider: 'anthropic', model: 'latest-opus' } } }),
    ],
    ['readonly', JSON.stringify({ profiles: CLAUDE_FLASH_PROFILES })],
    ['hardlink', JSON.stringify({ profiles: CLAUDE_FLASH_PROFILES })],
    ['customized', JSON.stringify({ profiles: { sonnet: { ...CLAUDE_FLASH_PROFILES.sonnet, effort: 'high' } } })],
  ];
  for (const [kind, content] of cases) {
    if (kind === 'readonly' && (process.platform === 'win32' || process.getuid?.() === 0)) continue;
    const { home, configPath, options, legacyStatus } = await legacyConfigHome(content, kind === 'readonly' ? { mode: 0o444 } : {});
    try {
      if (kind === 'hardlink') await link(configPath, join(home, 'dotfiles-copy.json'));
      const result = await install(options);
      assert.ok(existsSync(join(home, '.agents')) || existsSync(join(home, '.codex')), `${kind}: the install completes`);
      if (kind !== 'conflict') {
        assert.equal(await readFile(configPath, 'utf8'), content, `${kind}: config untouched`);
        assert.ok(!result.backups.some((backup) => backup.includes('claude-first')), kind);
      }
      if (kind === 'customized') {
        assert.equal(result.configMigration, undefined);
        assert.equal(legacyStatus(), undefined);
      } else if (kind === 'conflict') {
        // opus is free to migrate; sonnet's Claude name is taken by the user.
        assert.deepEqual(result.configMigration, { migrated: ['opus'], pending: ['sonnet'], reason: 'conflict' });
        assert.deepEqual(legacyStatus(), { profiles: ['sonnet'], fix: 'manual', reason: 'conflict' });
        const partly = JSON.parse(await readFile(configPath, 'utf8')).profiles;
        assert.deepEqual(partly.sonnet, CLAUDE_FLASH_PROFILES.sonnet);
        assert.deepEqual(partly['claude-sonnet'], { provider: 'anthropic', model: 'latest-opus' });
        assert.equal(partly.opus.provider, 'openai');
        assert.equal(await readFile(`${configPath}.claude-first.offload.bak`, 'utf8'), content);
      } else {
        assert.deepEqual(result.configMigration, { migrated: [], pending: ['sonnet', 'opus'], reason: kind });
        if (kind !== 'invalid') assert.deepEqual(legacyStatus(), { profiles: ['sonnet', 'opus'], fix: 'manual', reason: kind });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});
test('installer never rewrites a symlinked config, and doctor says it needs a manual edit', async () => {
  const { home, configPath, options, legacyStatus } = await legacyConfigHome('{}');
  const target = join(home, 'dotfiles', 'offload.json');
  const legacy = JSON.stringify({ profiles: CLAUDE_FLASH_PROFILES, default: 'sonnet' });
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, legacy);
    await rm(configPath);
    await symlink(target, configPath);
    const linked = await install(options);
    assert.deepEqual(linked.configMigration, { migrated: [], pending: ['sonnet', 'opus'], reason: 'symlink' });
    assert.equal(await readlink(configPath), target);
    assert.equal(await readFile(target, 'utf8'), legacy);
    assert.deepEqual(legacyStatus(), { profiles: ['sonnet', 'opus'], fix: 'manual', reason: 'symlink' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test('the session banner warns while a config still routes the commands Claude first', async () => {
  const configHome = await mkdtemp(`${tmpdir()}/offload-xdg-`);
  try {
    await mkdir(join(configHome, 'offload'));
    await writeFile(
      join(configHome, 'offload', 'config.json'),
      JSON.stringify({ profiles: { opus: { provider: 'anthropic', model: 'latest-opus', fallback: 'flash' } } }),
    );
    const run = spawnSync(process.execPath, ['install.mjs', '--doctor-hook'], {
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
    });
    assert.match(run.stdout, /config still routes opus Claude first \(old example\): run node install\.mjs from /);
    await writeFile(join(configHome, 'offload', 'config.json'), '{}');
    const clean = spawnSync(process.execPath, ['install.mjs', '--doctor-hook'], {
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
    });
    assert.doesNotMatch(clean.stdout, /Claude first/);
    await writeFile(
      join(configHome, 'offload', 'config.json'),
      JSON.stringify({
        profiles: {
          opus: { provider: 'anthropic', model: 'latest-opus', fallback: 'flash' },
          'claude-opus': { provider: 'anthropic', model: 'latest-sonnet' },
        },
      }),
    );
    const manual = spawnSync(process.execPath, ['install.mjs', '--doctor-hook'], {
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
    });
    assert.match(manual.stdout, /config still routes opus Claude first \(old example\): edit .*config\.json by hand \(conflict\)/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});
