import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeIdentity, skillHashOf } from '../../src/identity.mjs';
import {
  SKILL_RESTART_ACTION,
  assertStartRuntimeCurrent,
  installedSkillHealth,
  skillCopyStatus,
  skillFileHash,
  withSkillHealth,
} from '../../src/skill-health.mjs';

const SYMLINK_SKIP = process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation';
const SKILL = Buffer.from('# the skill this server was built with\n');
const EXPECTED = skillHashOf(SKILL);

async function home(t) {
  const path = await mkdtemp(join(tmpdir(), 'offload-skill-health-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function install(path, client, bytes) {
  const directory = join(path, client === 'claude' ? '.claude' : '.codex', 'skills', 'offload');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), bytes);
}
const health = (path) => installedSkillHealth({ expectedHash: EXPECTED, home: path, env: {} });

test('the skill hash is the identity hash of the skill bytes, so an installed copy compares exactly', () => {
  assert.match(EXPECTED, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(skillHashOf(Buffer.from('a')), skillHashOf(Buffer.from('b')));
  assert.equal(skillHashOf(SKILL), skillHashOf(Buffer.from(SKILL)));
  assert.match(runtimeIdentity().skillHash, /^sha256:[0-9a-f]{64}$/);
});

test('one installed copy is current, stale, missing or unreadable against an expected hash', async (t) => {
  const path = await home(t);
  await install(path, 'claude', SKILL);
  const file = join(path, '.claude', 'skills', 'offload', 'SKILL.md');
  assert.deepEqual(skillCopyStatus(file, EXPECTED), { status: 'current', installedHash: EXPECTED });
  await writeFile(file, 'older protocol\n');
  const stale = skillCopyStatus(file, EXPECTED);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.installedHash, skillHashOf(Buffer.from('older protocol\n')));
  assert.equal(skillCopyStatus(join(path, 'nope', 'SKILL.md'), EXPECTED).status, 'missing');
  assert.equal(skillCopyStatus(file, undefined).status, 'unknown', 'nothing to compare against is not a verdict');
  assert.deepEqual(skillFileHash(join(path, 'nope')), { error: 'missing' });
  await writeFile(join(path, 'big'), Buffer.alloc(1_048_577));
  assert.deepEqual(skillFileHash(join(path, 'big')), { error: 'unreadable' });
  await mkdir(join(path, 'dir'));
  assert.deepEqual(skillFileHash(join(path, 'dir')), { error: 'unreadable' });
});

test('a symlinked skill copy is unreadable, never trusted as current', { skip: SYMLINK_SKIP }, async (t) => {
  const path = await home(t);
  await writeFile(join(path, 'real.md'), SKILL);
  await mkdir(join(path, '.claude', 'skills', 'offload'), { recursive: true });
  await symlink(join(path, 'real.md'), join(path, '.claude', 'skills', 'offload', 'SKILL.md'));
  const result = health(path);
  assert.equal(result.clients.claude.status, 'unreadable');
  assert.equal(result.stale, false);
  assert.equal(result.state, 'unknown');
});

test('health compares every installed client copy and any difference is stale', async (t) => {
  const path = await home(t);
  const none = health(path);
  assert.deepEqual(
    { stale: none.stale, state: none.state, reason: none.reason, installedHash: none.installedHash, expectedHash: none.expectedHash },
    { stale: false, state: 'not-installed', reason: 'no-installed-skill-found', installedHash: null, expectedHash: EXPECTED },
    'no installed skill is normal and must not fail or flag health',
  );
  assert.deepEqual(none.clients, { claude: { status: 'missing' }, codex: { status: 'missing' } });

  await install(path, 'claude', SKILL);
  const fresh = health(path);
  assert.deepEqual(
    { stale: fresh.stale, state: fresh.state, reason: fresh.reason, installedHash: fresh.installedHash },
    { stale: false, state: 'current', reason: 'installed-skill-matches-server', installedHash: EXPECTED },
  );

  await install(path, 'codex', 'an older codex copy\n');
  const mixed = health(path);
  assert.equal(mixed.stale, true, 'one stale copy is enough: the hook flags it too');
  assert.equal(mixed.state, 'stale');
  assert.equal(mixed.reason, 'installed-skill-differs-from-server');
  assert.equal(mixed.installedHash, skillHashOf(Buffer.from('an older codex copy\n')), 'the reported hash is the stale copy');
  assert.equal(mixed.clients.claude.status, 'current');
  assert.equal(mixed.clients.codex.status, 'stale');

  const unknown = installedSkillHealth({ home: path, env: {} });
  assert.deepEqual([unknown.stale, unknown.state, unknown.reason], [false, 'unknown', 'no-expected-skill-hash']);
});

test('health follows CLAUDE_CONFIG_DIR like the installer', async (t) => {
  const path = await home(t);
  await mkdir(join(path, 'claude-cfg', 'skills', 'offload'), { recursive: true });
  await writeFile(join(path, 'claude-cfg', 'skills', 'offload', 'SKILL.md'), 'stale\n');
  const result = installedSkillHealth({ expectedHash: EXPECTED, home: path, env: { CLAUDE_CONFIG_DIR: join(path, 'claude-cfg') } });
  assert.equal(result.stale, true);
  assert.equal(health(path).stale, false, 'without the variable the default location holds nothing');
});

test('a stale skill sets restartRequired and an actionable restartAction without erasing a server restart', () => {
  const server = { name: 'offload', stale: false, restartRequired: false };
  const fresh = withSkillHealth(server, { stale: false, state: 'current' });
  assert.deepEqual(fresh, { server: { ...server, skill: { stale: false, state: 'current' } }, staleSkill: false, restartRequired: false });

  const staleSkill = withSkillHealth(server, { stale: true, state: 'stale' });
  assert.equal(staleSkill.staleSkill, true);
  assert.equal(staleSkill.restartRequired, true);
  assert.equal(staleSkill.server.restartRequired, true, 'server.restartRequired is what the preflight already obeys');
  assert.equal(staleSkill.restartAction, SKILL_RESTART_ACTION);
  assert.equal(staleSkill.server.restartAction, SKILL_RESTART_ACTION);
  assert.match(SKILL_RESTART_ACTION, /node install\.mjs/);
  assert.match(SKILL_RESTART_ACTION, /restart/i);
  assert.match(SKILL_RESTART_ACTION, /never hot-reloads or kills/);

  const both = withSkillHealth(
    { ...server, stale: true, restartRequired: true, restartAction: 'Restart the MCP client.' },
    { stale: true },
  );
  assert.equal(both.restartAction, `Restart the MCP client. ${SKILL_RESTART_ACTION}`);

  const serverOnly = withSkillHealth({ ...server, restartRequired: true, restartAction: 'Restart the MCP client.' }, { stale: false });
  assert.equal(serverOnly.staleSkill, false);
  assert.equal(serverOnly.restartRequired, true, 'the top-level flag also reflects a stale server');
  assert.equal(serverOnly.restartAction, 'Restart the MCP client.');
});

test('a stale server or installed skill is a hard, actionable start boundary', () => {
  const current = withSkillHealth({ name: 'offload', stale: false, restartRequired: false }, { stale: false, state: 'current' });
  assert.doesNotThrow(() => assertStartRuntimeCurrent(current));

  const staleServer = withSkillHealth(
    { name: 'offload', stale: true, restartRequired: true, restartAction: 'Restart the MCP client.' },
    { stale: false, state: 'current' },
  );
  assert.throws(
    () => assertStartRuntimeCurrent(staleServer),
    /OFFLOAD START REFUSED: the Offload server runtime is STALE\. No job was created and no provider budget was spent\. Restart the MCP client\./,
  );

  const staleSkill = withSkillHealth({ name: 'offload', stale: false, restartRequired: false }, { stale: true, state: 'stale' });
  assert.throws(
    () => assertStartRuntimeCurrent(staleSkill),
    /OFFLOAD START REFUSED: the installed Offload skill is STALE\. No job was created and no provider budget was spent\. .*node install\.mjs.*restart/i,
  );
});
