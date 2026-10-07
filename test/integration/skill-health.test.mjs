import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../../src/core.mjs';
import { doctor } from '../../src/doctor.mjs';
import { runtimeIdentity } from '../../src/identity.mjs';
import { SKILL_RESTART_ACTION, installedSkillHealth } from '../../src/skill-health.mjs';

const loaded = {
  disabled: false,
  repoConfig: {},
  config: {
    default: 'test',
    profiles: { test: { provider: 'test', model: 'test-model' } },
    providers: { test: { type: 'openai-chat', keyRef: 'env:IGNORED', baseUrl: 'https://example.test' } },
    limits: { maxTurns: 2, timeoutMinutes: 1, maxUsd: 1 },
  },
};
const packaged = await readFile(new URL('../../plugins/offload/skills/offload/SKILL.md', import.meta.url));
const OLDER = `${packaged}\nolder protocol\n`;

/** A temp HOME holding the given Claude/Codex skill copies; never the developer's real ~/.claude. */
async function homeWith(t, { claude, codex } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'offload-skill-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const [directory, content] of [
    ['.claude', claude],
    ['.codex', codex],
  ]) {
    if (content === undefined) continue;
    await mkdir(join(home, directory, 'skills', 'offload'), { recursive: true });
    await writeFile(join(home, directory, 'skills', 'offload', 'SKILL.md'), content);
  }
  return home;
}
const healthOf = async (home, extra = {}) => {
  const core = createCore({
    config: {
      loaded,
      probeVerifierTemp: async () => ({ status: 'writable' }),
      skillHealth: (options) => installedSkillHealth({ ...options, home, env: {} }),
      ...extra,
    },
  });
  try {
    return (await core.job()).health;
  } finally {
    await core.shutdown({ timeoutMs: 2_000 });
  }
};

test('health says the installed skill is current when it matches the server, and nothing needs a restart', async (t) => {
  const health = await healthOf(await homeWith(t, { claude: packaged }));
  const expected = runtimeIdentity().skillHash;
  assert.equal(health.staleSkill, false);
  assert.equal(health.restartRequired, false);
  assert.equal(health.restartAction, undefined);
  assert.equal(health.server.restartRequired, false);
  assert.deepEqual(
    { ...health.server.skill, clients: undefined },
    {
      expectedHash: expected,
      installedHash: expected,
      stale: false,
      state: 'current',
      reason: 'installed-skill-matches-server',
      clients: undefined,
    },
  );
  assert.equal(health.server.skill.clients.claude.status, 'current');
  assert.equal(health.server.skill.clients.codex.status, 'missing');
});

test('health flags a stale installed skill like a stale server: staleSkill, restartRequired and an install-then-restart action', async (t) => {
  const health = await healthOf(await homeWith(t, { claude: OLDER, codex: packaged }));
  assert.equal(health.staleSkill, true);
  assert.equal(health.restartRequired, true);
  assert.equal(health.restartAction, SKILL_RESTART_ACTION);
  assert.match(health.restartAction, /node install\.mjs/);
  assert.match(health.restartAction, /restart/i);
  // The same flags the existing preflight already obeys.
  assert.equal(health.server.restartRequired, true);
  assert.equal(health.server.restartAction, SKILL_RESTART_ACTION);
  assert.equal(health.server.stale, false, 'the server itself is current: only the skill differs');
  const skill = health.server.skill;
  assert.equal(skill.stale, true);
  assert.equal(skill.state, 'stale');
  assert.equal(skill.reason, 'installed-skill-differs-from-server');
  assert.equal(skill.expectedHash, runtimeIdentity().skillHash);
  assert.match(skill.installedHash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(skill.installedHash, skill.expectedHash);
  assert.equal(skill.clients.claude.status, 'stale');
  assert.equal(skill.clients.codex.status, 'current');
});

test('a missing or unreadable installed skill is reported without failing health or flagging staleness', async (t) => {
  const none = await healthOf(await homeWith(t));
  assert.equal(none.staleSkill, false);
  assert.equal(none.restartRequired, false);
  assert.equal(none.server.skill.state, 'not-installed');
  assert.equal(none.server.skill.reason, 'no-installed-skill-found');
  assert.equal(none.server.skill.installedHash, null);
  assert.equal(none.server.skill.expectedHash, runtimeIdentity().skillHash);
  // Even a check that throws must not take health down.
  const broken = await healthOf('/unused', {
    skillHealth: () => {
      throw new Error('boom at /private/path');
    },
  });
  assert.equal(broken.staleSkill, false);
  assert.equal(broken.server.skill.state, 'unknown');
  assert.equal(broken.server.skill.reason, 'skill-check-failed');
  assert.doesNotMatch(JSON.stringify(broken), /boom|private\/path/);
  assert.equal(typeof broken.sandboxReason, 'string', 'the rest of health is intact');
});

test('the session hook and health agree about the same installed skill', async (t) => {
  const spawnProcess = (_command, args) => ({
    status: 0,
    stdout: args.includes('--show-toplevel') ? `${process.cwd()}\n` : 'git version test',
  });
  for (const [claude, stale] of [
    [packaged, false],
    [OLDER, true],
  ]) {
    const home = await homeWith(t, { claude });
    const hook = doctor({ root: process.cwd(), repoPath: process.cwd(), home, spawnProcess, env: { HOME: home } });
    assert.equal(hook.skill.claude, stale ? 'stale' : 'current');
    assert.equal((await healthOf(home)).staleSkill, stale, 'health reaches the hook verdict for the same file');
    const banner = spawnSync(process.execPath, [join(process.cwd(), 'install.mjs'), '--doctor-hook'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' },
    });
    assert.equal(/installed claude skill is STALE/.test(banner.stdout), stale, banner.stdout);
  }
});

/** A bare stdio MCP client for the real server entry point, with a private HOME. */
async function realServerCall(home, name, args = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state') };
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'CURSOR_PROJECT_DIR']) delete env[name];
  const child = spawn(process.execPath, ['bin/offload.mjs', 'mcp'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], env });
  let buffer = '';
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      waiting.get(message.id)?.(message);
    }
  });
  const rpc = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  try {
    await rpc(1, 'initialize');
    const reply = await rpc(2, 'tools/call', { name, arguments: args });
    return reply.result;
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => (child.kill('SIGKILL'), resolve()), 5_000);
      child.once('exit', () => (clearTimeout(timer), resolve()));
    });
  }
}

const realServerHealth = async (home) => (await realServerCall(home, 'offload_job')).structuredContent.health;

test('the real MCP server reads the installed skill from its own HOME and flags a stale copy', async (t) => {
  const fresh = await realServerHealth(await homeWith(t, { claude: packaged }));
  assert.equal(fresh.staleSkill, false);
  assert.equal(fresh.server.skill.state, 'current');
  assert.equal(fresh.restartRequired, false);
  const stale = await realServerHealth(await homeWith(t, { claude: OLDER }));
  assert.equal(stale.staleSkill, true);
  assert.equal(stale.server.skill.state, 'stale');
  assert.equal(stale.restartRequired, true);
  assert.equal(stale.server.restartRequired, true);
  assert.match(stale.restartAction, /node install\.mjs/);
  assert.equal(stale.server.skill.expectedHash, fresh.server.skill.expectedHash);
  assert.equal(stale.server.skill.expectedHash, runtimeIdentity().skillHash);
});

test('the real MCP host refuses a stale installed skill before it creates a job', async (t) => {
  const reply = await realServerCall(await homeWith(t, { claude: OLDER }), 'offload_start', {
    task: 'must not start from a stale skill',
    ownedPaths: ['src/**'],
  });
  assert.equal(reply.isError, true);
  const text = reply.content.map((part) => part.text || '').join('\n');
  assert.match(text, /OFFLOAD START REFUSED.*installed Offload skill is STALE/i);
  assert.match(text, /No job was created and no provider budget was spent/i);
  assert.match(text, /node install\.mjs.*restart/i);
});
