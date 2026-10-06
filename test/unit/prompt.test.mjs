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
test('write prompt gives finite remaining-turn guidance without changing report prompts', async () => {
  const prompt = await buildSystemPrompt({ ownedPaths: ['src/**'], remainingTurns: 3 });
  assert.match(prompt, /3 model turns available/);
  assert.match(prompt, /Batch independent reads and lists/);
  assert.match(prompt, /Prefer read_file, list_dir, glob, and grep for ordinary inspection/);
  assert.match(prompt, /\[truncated; next offset N\], continue that file with exactly offset N/);
  assert.match(prompt, /Reserve run_command for focused build, test, or diagnostic work after changes/);
  assert.match(prompt, /after their required reads make an allowed tool call immediately/);
  assert.match(prompt, /Do not emit source code, a plan, progress update, or other narrative outside tool calls/);
  assert.match(prompt, /put source only in write_file.content/);
  assert.match(prompt, /complete final file content with write_file/);
  assert.match(prompt, /write one complete file per tool-call response, then continue with the next file/);
  assert.match(prompt, /edit_file requires a fresh read of that file, including after write_file/);
  assert.match(prompt, /configured verifier and the mandatory single finish call/);

  const report = await buildSystemPrompt({ mode: 'report', remainingTurns: 3 });
  assert.doesNotMatch(report, /model turns available/);
  assert.doesNotMatch(report, /make an allowed tool call immediately/);
  assert.doesNotMatch(report, /Reserve run_command for focused build/);
  assert.match(report, /read-only analysis worker/);

  const unknown = await buildSystemPrompt({ ownedPaths: ['src/**'], remainingTurns: Infinity });
  assert.doesNotMatch(unknown, /model turns available/);
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
