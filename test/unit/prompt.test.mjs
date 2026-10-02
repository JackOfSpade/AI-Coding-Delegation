import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt, repoConventions } from '../../src/agent/prompt.mjs';

test('prompt keeps the task in the user turn rather than duplicating it in system rules', async () => {
  const prompt = await buildSystemPrompt({
    repoPath: '/not-a-repo',
    task: 'unique task text',
    ownedPaths: ['src/**'],
    extraWritable: ['tmp/**'],
    relevantPaths: ['src/main.mjs'],
    allowNetwork: true,
    acceptanceCriteria: ['works'],
  });
  assert.doesNotMatch(prompt, /unique task text/);
  assert.match(prompt, /Acceptance criteria/);
  assert.match(prompt, /Relevant starting paths[\s\S]*src\/main\.mjs/);
  assert.match(prompt, /src\/\*\*, tmp\/\*\*/);
  assert.match(prompt, /Network access is permitted/);
});
test('repository conventions reject an outside symlink and malformed content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-prompt-'));
  const outside = path.join(os.tmpdir(), `offload-outside-${Date.now()}.md`);
  await writeFile(outside, 'HOST SECRET');
  await symlink(outside, path.join(dir, 'AGENTS.md'));
  await writeFile(path.join(dir, 'CLAUDE.md'), 'safe convention');
  const conventions = await repoConventions(dir);
  assert.match(conventions, /safe convention/);
  assert.doesNotMatch(conventions, /HOST SECRET/);
});
test('repository conventions reject oversized files before reading them', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-prompt-large-'));
  await writeFile(path.join(dir, 'AGENTS.md'), 'x'.repeat(129 * 1024));
  assert.equal(await repoConventions(dir), '');
});
