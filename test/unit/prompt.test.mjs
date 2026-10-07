import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalTools } from '../../src/agent/tools.mjs';
import { WORKER_TEST_QUALITY_RULE, annotateRelevantPaths, buildSystemPrompt, repoConventions } from '../../src/agent/prompt.mjs';

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
test('every worker brief states read_file byte limit, even without finite-turn guidance', async () => {
  for (const options of [{ ownedPaths: ['src/**'] }, { mode: 'report' }, { ownedPaths: ['src/**'], remainingTurns: 3 }]) {
    const prompt = await buildSystemPrompt(options);
    assert.match(prompt, /read_file's limit is a byte count of at most 64000 per call \(omit it for that default\)/);
    assert.match(prompt, /returns at most about 24000 characters/);
    assert.match(prompt, /continuing at the exact offset N printed after \[truncated; next offset N\]/);
  }
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
test('a configured server verifier tells a write worker to finish instead of rediscovering the test command', async () => {
  const prompt = await buildSystemPrompt({ ownedPaths: ['src/**'], remainingTurns: 3, serverVerifierConfigured: true });
  assert.match(prompt, /focused server verifier is already configured and runs after finish/);
  assert.match(prompt, /do not spend turns rediscovering or rerunning it/);
  assert.match(prompt, /reserve the final turn for finish rather than rerunning or searching for tests/);
  assert.doesNotMatch(prompt, /npm test|secret-token/, 'the command itself is never copied into the worker brief');
  const ordinary = await buildSystemPrompt({ ownedPaths: ['src/**'], remainingTurns: 3 });
  assert.match(ordinary, /Reserve run_command for focused build, test, or diagnostic work after changes/);
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

test('every worker prompt carries the falsifiable-assertions rule exactly once, as its own line', async () => {
  assert.equal(WORKER_TEST_QUALITY_RULE, 'Assertions must be falsifiable; no substring checks that match unrelated text.');
  const prompts = await Promise.all([
    buildSystemPrompt({ ownedPaths: ['src/**'] }),
    buildSystemPrompt({ ownedPaths: ['src/**'], remainingTurns: 12 }),
    buildSystemPrompt({ ownedPaths: ['src/**'], allowCommand: false }),
    buildSystemPrompt({ mode: 'report' }),
    buildSystemPrompt({ mode: 'report', remainingTurns: 12, allowCommand: false }),
  ]);
  for (const prompt of prompts) {
    const lines = prompt.split('\n');
    assert.equal(lines.filter((line) => line === WORKER_TEST_QUALITY_RULE).length, 1);
  }
});
test('the range guidance line appears only when a relevant path carries a line range', async () => {
  const plain = await buildSystemPrompt({ ownedPaths: ['src/**'], relevantPaths: ['src/a.mjs', 'b.txt:7'] });
  assert.doesNotMatch(plain, /caller-selected line ranges/);
  const ranged = await buildSystemPrompt({ ownedPaths: ['src/**'], relevantPaths: ['src/a.mjs:10-20'] });
  assert.ok(ranged.split('\n').some((line) => line.startsWith('Entries suffixed :START-END are caller-selected line ranges.')));
  const annotated = await buildSystemPrompt({
    ownedPaths: ['src/**'],
    relevantPaths: ['src/a.mjs:10-20 (read_file offset 900, about 1 read; read outside the range only if needed)'],
  });
  assert.match(annotated, /caller-selected line ranges/);
});
test('annotateRelevantPaths turns a line range into the exact read_file byte offset without reading content into the prompt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-prompt-ranges-'));
  // Multi-byte characters make the byte offset differ from a character count.
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1} ${i % 3 === 0 ? 'é€' : 'plain'}`);
  const text = `${lines.join('\n')}\n`;
  await writeFile(path.join(dir, 'src.txt'), text);
  await writeFile(path.join(dir, '.env'), 'A=1\nB=2\nC=3\n');
  const tools = new LocalTools({ repoPath: dir, ownedPaths: ['*.txt'] });
  const out = await annotateRelevantPaths(tools, [
    'src.txt:11-13',
    'src.txt',
    '.env:1-2',
    'missing.txt:1-2',
    'src.txt:900-950',
    'plain/*.js',
  ]);
  const startOfLine11 = Buffer.byteLength(`${lines.slice(0, 10).join('\n')}\n`);
  assert.equal(out[0], `src.txt:11-13 (read_file offset ${startOfLine11}, about 1 read; read outside the range only if needed)`);
  const page = await tools.read_file({ path: 'src.txt', offset: startOfLine11 });
  assert.ok(page.startsWith(lines[10]), 'read_file at the offset starts on line 11');
  assert.equal(out[1], 'src.txt');
  assert.equal(out[2], '.env:1-2');
  assert.equal(out[3], 'missing.txt:1-2');
  assert.equal(out[4], 'src.txt:900-950');
  assert.equal(out[5], 'plain/*.js');
  assert.equal(out.join('\n').includes('A=1'), false);
  // A tool set without the server-only method leaves entries untouched.
  assert.deepEqual(await annotateRelevantPaths({}, ['src.txt:1-2']), ['src.txt:1-2']);
});
test('both worker prompts tell the worker to call finish by itself', async () => {
  for (const options of [{ ownedPaths: ['src/**'] }, { ownedPaths: ['src/**'], remainingTurns: 5 }, { mode: 'report' }]) {
    const prompt = await buildSystemPrompt(options);
    const sentences = prompt.split('\n').filter((line) => line.startsWith('You must call finish'));
    assert.equal(sentences.length, 1, JSON.stringify(options));
    assert.ok(sentences[0].endsWith(' Call finish by itself: never in the same response as another tool call.'), sentences[0]);
  }
});
