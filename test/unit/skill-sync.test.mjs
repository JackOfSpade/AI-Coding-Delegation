import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncPluginVersion } from '../../scripts/plugin-version.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const skills = join(root, 'plugins', 'offload', 'skills');

function splitSkill(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n?/g, '\n'));
  assert.ok(match, 'SKILL.md must start with a frontmatter block');
  return { metadata: JSON.parse(match[1]), body: match[2] };
}

test('the premium and economy skills are identical apart from frontmatter name and description', async () => {
  const premium = splitSkill(await readFile(join(skills, 'offload_premium', 'SKILL.md'), 'utf8'));
  const economy = splitSkill(await readFile(join(skills, 'offload_economy', 'SKILL.md'), 'utf8'));
  assert.equal(premium.body, economy.body, 'edit both SKILL.md bodies together; only frontmatter may differ');
  assert.equal(premium.metadata.name, 'offload_premium');
  assert.equal(economy.metadata.name, 'offload_economy');
  assert.equal(premium.metadata.description, economy.metadata.description.replaceAll('/offload_economy', '/offload_premium'));
  const rest = ({ name: _name, description: _description, ...other }) => other;
  assert.deepEqual(rest(premium.metadata), rest(economy.metadata));
});

test('the plugin manifests carry the current content version', async () => {
  const { stale } = await syncPluginVersion({ check: true });
  assert.deepEqual(stale, [], 'run npm run plugin:version after changing plugins/offload');
});

test('plugin:version rewrites only the content hash after a skill edit', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'offload-plugin-version-'));
  try {
    await cp(join(root, 'plugins'), join(temporary, 'plugins'), { recursive: true });
    const skill = join(temporary, 'plugins', 'offload', 'skills', 'offload_premium', 'SKILL.md');
    await writeFile(skill, `${await readFile(skill, 'utf8')}\nExtra rule.\n`);
    const manifest = join(temporary, 'plugins', 'offload', 'plugin.json');
    const before = JSON.parse(await readFile(manifest, 'utf8')).version;

    const checked = await syncPluginVersion({ cwd: temporary, check: true });
    assert.deepEqual(checked.stale, ['plugin.json', '.codex-plugin/plugin.json']);
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).version, before, 'check mode never writes');

    const written = await syncPluginVersion({ cwd: temporary });
    assert.deepEqual(written.stale, ['plugin.json', '.codex-plugin/plugin.json']);
    const after = JSON.parse(await readFile(manifest, 'utf8')).version;
    assert.equal(after, `${before.split('+')[0]}${written.suffix}`);
    assert.notEqual(after, before);
    const codex = JSON.parse(await readFile(join(temporary, 'plugins', 'offload', '.codex-plugin', 'plugin.json'), 'utf8'));
    assert.equal(codex.version, after);
    assert.deepEqual((await syncPluginVersion({ cwd: temporary, check: true })).stale, []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
