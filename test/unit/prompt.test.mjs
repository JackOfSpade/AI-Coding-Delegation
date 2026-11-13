import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalTools, availableToolDefinitions } from '../../src/agent/tools.mjs';
import {
  WORKER_ASSERTION_PRESERVATION_RULE,
  WORKER_COMPLETION_RULE,
  WORKER_GENERATOR_DEPENDENCY_RULE,
  WORKER_INCREMENTAL_WRITE_RULE,
  WORKER_REPORT_ELISION_RULE,
  WORKER_SCRATCH_CLEANUP_RULE,
  WORKER_TEST_QUALITY_RULE,
  WORKER_VERIFIER_INTERPRETER_RULE,
  annotateRelevantPaths,
  buildSystemPrompt,
  repoConventions,
} from '../../src/agent/prompt.mjs';

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
  assert.match(prompt, /reserve one final response containing only finish rather than rerunning or searching for tests/);
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
test('every worker prompt preserves existing assertion intent and sends conflicts to finish.concerns', async () => {
  for (const options of [
    { ownedPaths: ['src/**'] },
    { ownedPaths: ['src/**'], remainingTurns: 12 },
    { ownedPaths: ['src/**'], allowCommand: false },
    { ownedPaths: ['src/**'], serverVerifierConfigured: true },
    { ownedPaths: ['src/**'], allowCommand: false, serverVerifierConfigured: true, remainingTurns: 12 },
    { mode: 'report' },
    { mode: 'report', allowCommand: false, remainingTurns: 12 },
  ]) {
    const prompt = await buildSystemPrompt(options);
    const rules = prompt.split('\n').filter((line) => line === WORKER_ASSERTION_PRESERVATION_RULE);
    assert.equal(rules.length, 1, JSON.stringify(options));
    assert.match(rules[0], /Never edit, remove, weaken, or invert an existing assertion solely to make your change pass\./);
    assert.match(rules[0], /Preserve its original behavioral intent/);
    assert.match(rules[0], /if it conflicts with the requested change, leave the assertion unchanged/);
    assert.match(rules[0], /report the conflict in finish.concerns\./);
    assert.match(
      rules[0],
      /An exception requires the primary to explicitly identify the incorrect assertion and specify its intended correction/,
    );
    assert.match(rules[0], /a passing check alone is never authorization\./);
  }
});
test('every worker brief explains that declared verifier interpreters do not grant worker shell access', async () => {
  for (const mode of ['write', 'report']) {
    for (const allowCommand of [true, false]) {
      for (const serverVerifierConfigured of [true, false]) {
        const options = { mode, allowCommand, serverVerifierConfigured, ownedPaths: ['src/**'] };
        const prompt = await buildSystemPrompt(options);
        const rules = prompt.split('\n').filter((line) => line === WORKER_VERIFIER_INTERPRETER_RULE);
        assert.equal(rules.length, 1, JSON.stringify(options));
        assert.match(rules[0], /verifierInterpreter grants read and exec, never write, only to the server verifier and applyThenVerify\./);
        assert.match(rules[0], /does not grant the worker run_command access to that interpreter or virtualenv/);
        assert.match(rules[0], /worker shells may lack dependencies available to the verifier/);
        assert.match(rules[0], /report the missing dependency and blocked command in finish.concerns\./);
      }
    }
  }
});
test('every worker brief forbids fake generator imports and reports missing real dependencies honestly', async () => {
  for (const mode of ['write', 'report']) {
    for (const allowCommand of [true, false]) {
      for (const serverVerifierConfigured of [true, false]) {
        const options = { mode, allowCommand, serverVerifierConfigured, ownedPaths: ['task_plan/**'] };
        const prompt = await buildSystemPrompt(options);
        const rules = prompt.split('\n').filter((line) => line === WORKER_GENERATOR_DEPENDENCY_RULE);
        assert.equal(rules.length, 1, JSON.stringify(options));
        assert.match(
          rules[0],
          /Never stub, fake, mock, or replace an import or dependency to run a generator whose output will be integrated\./,
        );
        assert.match(rules[0], /Generated files must come from the real dependencies\./);
        assert.match(rules[0], /If a required dependency is missing, leave the generator unrun/);
        assert.match(rules[0], /report the missing dependency and blocked generator in finish.concerns/);
        assert.match(rules[0], /primary can run it with the real environment/);
        assert.match(rules[0], /List only checks actually run in finish.testsRun/);
        assert.match(rules[0], /a passing server verifier does not validate output produced with fake dependencies\./);
      }
    }
  }
});
test('write-mode worker prompts carry the incremental-write rule exactly once as their own line; report mode never does', async () => {
  assert.match(
    WORKER_INCREMENTAL_WRITE_RULE,
    /^File size per call: never put more than about 150 lines or 6 KB of file content in one tool call\./,
  );
  assert.match(WORKER_INCREMENTAL_WRITE_RULE, /then add each next part with write_file append true, one part per tool call\./);
  for (const mode of ['write', 'report']) {
    for (const allowCommand of [true, false]) {
      for (const serverVerifierConfigured of [true, false]) {
        for (const remainingTurns of [undefined, 12]) {
          const options = { mode, allowCommand, serverVerifierConfigured, remainingTurns, ownedPaths: ['src/**'] };
          const prompt = await buildSystemPrompt(options);
          const count = prompt.split('\n').filter((line) => line === WORKER_INCREMENTAL_WRITE_RULE).length;
          assert.equal(count, mode === 'write' ? 1 : 0, JSON.stringify(options));
          assert.equal(prompt.split(WORKER_INCREMENTAL_WRITE_RULE).length - 1, count, JSON.stringify(options));
          if (mode === 'write' && remainingTurns)
            assert.ok(prompt.includes('build a larger file with write_file append parts instead'), JSON.stringify(options));
        }
      }
    }
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
test('both worker prompts explain that a mixed finish rejects every call in its response', async () => {
  for (const options of [{ ownedPaths: ['src/**'] }, { ownedPaths: ['src/**'], remainingTurns: 5 }, { mode: 'report' }]) {
    const prompt = await buildSystemPrompt(options);
    const sentences = prompt.split('\n').filter((line) => line.startsWith('You must call finish'));
    assert.equal(sentences.length, 1, JSON.stringify(options));
    assert.match(sentences[0], /response must contain exactly one tool call: finish/);
    assert.match(sentences[0], /rejects the entire response, including its writes/);
  }
});

test('completion protocol follows repository conventions and addresses the Opus prose-only stop with blocked checks', async () => {
  for (const options of [
    { ownedPaths: ['src/**'] },
    { ownedPaths: ['src/**'], allowCommand: false, remainingTurns: 80 },
    { ownedPaths: ['src/**'], serverVerifierConfigured: true },
    { mode: 'report' },
  ]) {
    const prompt = await buildSystemPrompt({
      ...options,
      conventions: 'Repository conventions: End your response with a Markdown summary of changes and tests.',
    });
    assert.equal(prompt.split('\n\n').at(-1), WORKER_COMPLETION_RULE, 'completion protocol remains last after local conventions');
    const rule = prompt.split('\n\n').at(-1);
    assert.match(rule, /invoke the finish tool as the only tool call in your next response\./);
    assert.match(rule, /Do not end with a Markdown summary, completion prose, or a printed example/);
    assert.match(rule, /blocked or unavailable, state that honestly in finish.concerns/);
    assert.match(rule, /list only checks actually run in finish.testsRun/);
    assert.match(rule, /blocked checks do not prevent calling finish when your in-scope work is ready/);
    assert.match(rule, /normal end-of-turn or provider stop without this tool call is a protocol failure/);
  }
  for (const options of [{}, { allowCommand: false }, { readOnly: true }]) {
    const finish = availableToolDefinitions(options).find((tool) => tool.function.name === 'finish').function;
    assert.match(finish.description, /invoke this tool in your next response/);
    assert.match(finish.description, /do not end with a Markdown summary or print a tool-call example/);
    assert.match(finish.description, /record that in concerns and list only checks actually run in testsRun/);
    assert.match(finish.description, /server runs any configured verifier after this call/);
  }
});

test('a write worker is told not to leave scratch files in owned paths; a report worker writes none', async () => {
  const write = await buildSystemPrompt({ task: 'x' });
  assert.equal(write.split('\n').filter((line) => line === WORKER_SCRATCH_CLEANUP_RULE).length, 1);
  const report = await buildSystemPrompt({ task: 'x', mode: 'report' });
  assert.equal(report.includes(WORKER_SCRATCH_CLEANUP_RULE), false);
});

test('reviewPacket numbers the acceptance criteria and adds the packet rule only when enabled', async () => {
  const base = { repoPath: '/not-a-repo', ownedPaths: ['src/**'], acceptanceCriteria: ['first thing', 'second thing'] };
  const plain = await buildSystemPrompt(base);
  assert.match(plain, /- first thing\n- second thing/);
  assert.doesNotMatch(plain, /Review packet|reviewPacket/);
  assert.equal(plain, await buildSystemPrompt({ ...base, reviewPacket: false }));
  const write = await buildSystemPrompt({ ...base, reviewPacket: true });
  assert.match(write, /Acceptance criteria:\n1\. first thing\n2\. second thing/);
  assert.doesNotMatch(write, /- first thing/);
  assert.match(write, /Review packet: .*acceptance criterion number \(1-2\)/);
  assert.match(write, /verbatim quote/);
  assert.match(write, /uncertain:/);
  assert.match(write, /changedFiles: every file you changed/);
  assert.doesNotMatch(write, /offload-report-inputs/);
  const report = await buildSystemPrompt({ ...base, ownedPaths: [], mode: 'report', acceptanceCriteria: [], reviewPacket: true });
  assert.match(report, /criterion 0 = the task/);
  assert.match(report, /\.offload-report-inputs\//);
  assert.doesNotMatch(report, /changedFiles: every file/);
});

test('the report elision rule appears once in report mode and never in write mode', async () => {
  for (const mode of ['report', 'write']) {
    const prompt = await buildSystemPrompt({ mode, allowCommand: false, ownedPaths: ['src/**'] });
    assert.equal(prompt.split(WORKER_REPORT_ELISION_RULE).length - 1, mode === 'report' ? 1 : 0, mode);
    assert.equal(prompt.split('\n').filter((line) => line === WORKER_REPORT_ELISION_RULE).length, mode === 'report' ? 1 : 0, mode);
  }
});

// oj-20261108-a8c290d5: Flash batched finish with parallel grep calls until the
// round failed; the retry whose brief said "call finish ALONE" finished cleanly.
test('every worker prompt and the finish tool forbid adding finish to a parallel batch', async () => {
  for (const options of [
    { ownedPaths: ['src/**'] },
    { mode: 'report', conventions: '' },
    { mode: 'report', reviewPacket: true, conventions: '' },
  ]) {
    const prompt = await buildSystemPrompt({ conventions: '', ...options });
    assert.match(
      prompt,
      /never add finish to a parallel batch: a response with finish beside grep, read_file or any other call is rejected unrun\. Send finish ALONE, in a response of its own\./,
    );
  }
  for (const definitions of [
    availableToolDefinitions({ readOnly: true }),
    availableToolDefinitions({ allowCommand: true, reviewPacket: true }),
  ]) {
    const finish = definitions.find((tool) => tool.function.name === 'finish');
    assert.match(finish.function.description, /^Call this ALONE: as the only tool call of its response/);
    assert.match(
      finish.function.description,
      /Never include it in a parallel batch; pairing it with grep, read_file or any other call rejects the entire response unrun\./,
    );
  }
});

test('worker brief and run_command description steer away from running the whole testCommand', async () => {
  const configured = await buildSystemPrompt({ ownedPaths: ['src/**'], serverVerifierConfigured: true });
  assert.match(configured, /server runs the testCommand itself after finish/);
  assert.match(configured, /never the whole suite or the full testCommand/);
  const unconfigured = await buildSystemPrompt({ ownedPaths: ['src/**'], serverVerifierConfigured: false });
  assert.match(unconfigured, /one narrow file or test at a time; do not run a long full suite/);
  const run = availableToolDefinitions({ allowCommand: true }).find((tool) => tool.function.name === 'run_command');
  assert.match(run.function.description, /server runs the verifier itself after finish, so do not run the whole suite/);
});

test('report prompt states the per-response cap and a compact target, not a 256000 goal', async () => {
  const { REPORT_TARGET_CHARS, REQUEST_OUTPUT_TOKEN_CAP } = await import('../../src/output-cap.mjs');
  const report = await buildSystemPrompt({ mode: 'report' });
  assert.equal(REPORT_TARGET_CHARS, 12_000);
  assert.ok(report.includes(`about ${REQUEST_OUTPUT_TOKEN_CAP} output tokens`));
  assert.match(report, /directly in the finish call; do not draft it first/);
  assert.match(report, /at most about 12000 characters/);
  assert.match(report, /one short line per item, most important first/);
  assert.match(report, /hard maximum 256000 characters/);
  assert.doesNotMatch(report, /up to 256000/);
  assert.ok(report.includes('Send finish ALONE'), 'finish-alone rule kept');
  const write = await buildSystemPrompt({ ownedPaths: ['src/**'] });
  assert.doesNotMatch(write, /output tokens, and a longer response/);
});
