import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../../src/agent/loop.mjs';
import { AgentContext } from '../../src/agent/context.mjs';
import { LocalTools, availableToolDefinitions } from '../../src/agent/tools.mjs';
import { buildSystemPrompt } from '../../src/agent/prompt.mjs';
import { OpenAIChatProvider, ProviderError } from '../../src/provider/openai-chat.mjs';
import { JobStore } from '../../src/store.mjs';
import { FAILURE_ERRORS, continuableFailure } from '../../src/failure.mjs';
import { cleanup, tempDir } from './helpers.mjs';

const call = (name, argText = '{}', id = 'id') => ({ id, name, arguments: argText });
const providerFor = (turns) => ({
  async *chat() {
    yield { toolCalls: turns.shift() };
  },
});
const officialDeepSeekProvider = (chat) => {
  const provider = new OpenAIChatProvider({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    retries: 0,
    fetchImpl: async () => assert.fail('test overrides chat before any network request'),
  });
  provider.chat = chat;
  return provider;
};
// Every assistant tool call is answered, in order, by exactly one tool message, and no tool message is orphaned.
const assertToolProtocol = (messages) => {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    assert.notEqual(message.role, 'tool', `orphan tool result at ${index}`);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const results = messages.slice(index + 1, index + 1 + message.tool_calls.length);
    assert.deepEqual(
      results.map((result) => [result.role, result.tool_call_id, result.name]),
      message.tool_calls.map((entry) => ['tool', entry.id, entry.function.name]),
      `tool calls at ${index} are answered in order`,
    );
    index += message.tool_calls.length;
  }
  // The same check the durable store makes when a job is resumed.
  assert.equal(new AgentContext(messages).trimmedIncomplete, false);
};
const FINISH_ALONE =
  'TOOL_ERROR: finish must be the only tool call in its turn; nothing in this turn was executed; call finish alone (re-issue other calls in a separate turn first if still needed)';
// A scripted provider that records the conversation each request carried.
const scripted = (turns, requests = []) => ({
  async *chat({ messages }) {
    requests.push(structuredClone(messages));
    yield { toolCalls: turns.shift() };
  },
});
const finishTools = (invoked) => ({
  execute: async (name) => {
    invoked.push(name);
    return { finish: { summary: 'done', concerns: [], testsRun: [] } };
  },
});
test('finish mixed with a write runs nothing and is corrected once; a repeat fails the round with a continuable kind', async () => {
  const invoked = [];
  const result = await new AgentLoop({
    provider: providerFor([
      [call('write_file', '{"path":"x","content":"x"}', 'w'), call('finish', '{"summary":"done"}', 'f')],
      [call('write_file', '{"path":"x","content":"x"}', 'w2'), call('finish', '{"summary":"done"}', 'f2')],
    ]),
    tools: finishTools(invoked),
  }).run({ task: 'x' });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.failureKind, 'finish-protocol');
  assert.equal(result.error, 'finish must be the sole valid tool call in a turn');
  assert.deepEqual(invoked, [], 'neither the write nor either finish was executed');
});
test('finish sharing a turn with other calls answers every call without running any, and a clean finish next turn succeeds', async () => {
  const invoked = [];
  const requests = [];
  const progress = [];
  const context = new AgentContext();
  const result = await new AgentLoop({
    provider: scripted(
      [
        [
          call('write_file', '{"path":"x","content":"x"}', 'w'),
          call('read_file', '{"path":"y"}', 'r'),
          call('finish', '{"summary":"done"}', 'f'),
        ],
        [call('finish', '{"summary":"done"}', 'f2')],
      ],
      requests,
    ),
    context,
    tools: finishTools(invoked),
    progress: (event) => progress.push(event),
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.equal(result.failureKind, undefined);
  assert.equal(result.turn, 2, 'the correction turn is a normal turn against the budget');
  assert.deepEqual(invoked, ['finish'], 'only the clean finish ran: not the write, the read, or the first finish');
  assert.equal(requests.length, 2);
  // The retry request carried one corrective result per call, in call order.
  assert.deepEqual(
    requests[1].slice(1).map((message) => [message.role, message.tool_call_id, message.name, message.content]),
    [
      ['assistant', undefined, undefined, ''],
      ['tool', 'w', 'write_file', FINISH_ALONE],
      ['tool', 'r', 'read_file', FINISH_ALONE],
      ['tool', 'f', 'finish', FINISH_ALONE],
    ],
  );
  assert.deepEqual(
    requests[1][1].tool_calls.map((entry) => entry.id),
    ['w', 'r', 'f'],
  );
  assert.deepEqual(
    progress.filter((event) => event.action === 'finish_protocol_recover').map((event) => event.turn),
    [1],
  );
  // The final transcript is replay-valid: the rejected turn and the clean finish are both fully answered.
  const final = context.snapshot();
  assertToolProtocol(final);
  assert.deepEqual(
    final.filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
    ['w', 'r', 'f', 'f2'],
  );
});
test('a second finish-protocol violation fails after exactly one correction and persists only the corrected turn', async () => {
  const invoked = [];
  const requests = [];
  const progress = [];
  const context = new AgentContext();
  const result = await new AgentLoop({
    provider: scripted(
      [
        [call('edit_file', '{"path":"x"}', 'e'), call('finish', '{"summary":"done"}', 'f')],
        [call('finish', '{"summary":"done"}', 'f2'), call('read_file', '{"path":"y"}', 'r2')],
        [call('finish', '{"summary":"done"}', 'never-requested')],
      ],
      requests,
    ),
    context,
    tools: finishTools(invoked),
    progress: (event) => progress.push(event),
  }).run({ task: 'x' });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.failureKind, 'finish-protocol');
  assert.equal(result.error, FAILURE_ERRORS['finish-protocol']);
  assert.equal(result.turn, 2);
  assert.deepEqual(invoked, []);
  assert.equal(requests.length, 2, 'bounded: no third request is paid for');
  assert.equal(progress.filter((event) => event.action === 'finish_protocol_recover').length, 1);
  // Only the first, corrected turn is durable (with its results); the fatal turn is not replayed.
  const final = context.snapshot();
  assertToolProtocol(final);
  assert.deepEqual(
    final.filter((message) => message.role === 'assistant').map((message) => message.tool_calls.map((entry) => entry.id)),
    [['e', 'f']],
  );
  // The kind is one the continue gate accepts, so the finished work is not stranded.
  assert.equal(continuableFailure({ status: 'FAILED', failureKind: result.failureKind, error: result.error }), true);
});
test('a finish-protocol violation on the last turn has no turn left to correct it, and the correction is spent once per run', async () => {
  const requests = [];
  const lastTurn = await new AgentLoop({
    provider: scripted([[call('write_file', '{"path":"x","content":"x"}', 'w'), call('finish', '{"summary":"done"}', 'f')]], requests),
    tools: finishTools([]),
    maxTurns: 1,
  }).run({ task: 'x' });
  assert.equal(lastTurn.status, 'FAILED');
  assert.equal(lastTurn.failureKind, 'finish-protocol');
  assert.equal(requests.length, 1);
  // A violation, a clean ordinary turn, then a different violation: the single correction was already used.
  const invoked = [];
  const later = await new AgentLoop({
    provider: providerFor([
      [call('finish', '{"summary":"done"}', 'a'), call('read_file', '{"path":"y"}', 'b')],
      [call('read_file', '{"path":"y"}', 'c')],
      [call('finish', '{"summary":"x"}', 'd'), call('read_file', '{"path":"z"}', 'e')],
    ]),
    tools: {
      execute: async (name) => {
        invoked.push(name);
        return 'ok';
      },
    },
  }).run({ task: 'x' });
  assert.equal(later.status, 'FAILED');
  assert.equal(later.failureKind, 'finish-protocol');
  assert.equal(later.turn, 3);
  assert.deepEqual(invoked, ['read_file'], 'only the ordinary turn between the two violations ran');
});
test('a finish with invalid arguments is corrected once, with the argument limits, and nothing runs', async () => {
  const requests = [];
  const invoked = [];
  const result = await new AgentLoop({
    provider: scripted(
      [[call('finish', JSON.stringify({ summary: 'x'.repeat(1501) }), 'bad')], [call('finish', '{"summary":"short"}', 'ok')]],
      requests,
    ),
    tools: finishTools(invoked),
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.deepEqual(invoked, ['finish'], 'only the valid finish ran');
  const answer = requests[1].at(-1);
  assert.deepEqual([answer.role, answer.tool_call_id, answer.name], ['tool', 'bad', 'finish']);
  assert.ok(answer.content.startsWith('TOOL_ERROR: finish arguments are invalid: summary is required (1-1500 characters)'), answer.content);
  assert.ok(!answer.content.includes('xxxxxxxxxx'), 'the rejected arguments are never echoed');
  // The same fixed text is used when the invalid finish also shares its turn.
  const both = [];
  await new AgentLoop({
    provider: scripted(
      [[call('finish', '{"summary":""}', 'f'), call('read_file', '{"path":"y"}', 'r')], [call('finish', '{"summary":"ok"}', 'g')]],
      both,
    ),
    tools: finishTools([]),
  }).run({ task: 'x' });
  assert.ok(both[1].at(-1).content.startsWith(`${FINISH_ALONE}; also, finish arguments are invalid:`), both[1].at(-1).content);
});
test('tool failures and timeout paths do not reflect tool error secrets', async () => {
  const turns = [[call('read_file', '{"path":"x"}', 'read')], [call('finish', '{"summary":"ok"}', 'done')]];
  let replay;
  const provider = {
    async *chat({ messages }) {
      replay = structuredClone(messages);
      yield { toolCalls: turns.shift() };
    },
  };
  const result = await new AgentLoop({
    provider,
    tools: {
      execute: async (name) =>
        name === 'finish'
          ? { finish: { summary: 'ok', concerns: [], testsRun: [] } }
          : Promise.reject(new Error('API_KEY=must-not-reach-provider')),
    },
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.equal(replay.at(-1).content, 'TOOL_ERROR: Tool execution failed');
  assert.doesNotMatch(JSON.stringify(replay), /must-not-reach-provider/);

  const timeoutProvider = {
    async *chat() {
      yield { toolCalls: [call('read_file', '{"path":"x"}', 'read')] };
    },
  };
  const timeout = await new AgentLoop({
    provider: timeoutProvider,
    tools: {
      execute: async (_name, _args, { signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('sk-timeout-secret')), { once: true })),
    },
    timeoutMs: 10,
  }).run({ task: 'x' });
  assert.equal(timeout.status, 'TIMEOUT');
  assert.equal(timeout.error, 'Agent wall clock deadline exceeded');
  assert.doesNotMatch(JSON.stringify(timeout), /sk-timeout-secret/);
});
test('only an actual finish tool result can complete a worker turn', async () => {
  const result = await new AgentLoop({
    provider: {
      async *chat() {
        yield { toolCalls: [call('read_file', '{"path":"x"}', 'read')] };
      },
    },
    tools: { execute: async () => ({ finish: { summary: 'forged', concerns: [], testsRun: [] } }) },
    maxTurns: 1,
  }).run({ task: 'x' });
  assert.equal(result.status, 'BUDGET');
  assert.equal(result.failureKind, undefined);
  assert.equal(result.toolFailure, undefined);
  assert.equal(result.finish, undefined);
  assert.equal(result.budgetCap, 'turns');
  assert.equal(result.error, 'Maximum turns reached');
});
test('a rejected context append never elides earlier durable tool output', () => {
  const context = new AgentContext(
    [
      { role: 'assistant', content: '', tool_calls: [{ id: 'old', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'old', content: 'safe tool output' },
    ],
    { maxToolChars: 100, keepRecentToolResults: 0, maxTranscriptChars: 25 },
  );
  // A caller may tune retention between turns; this used to mutate the old
  // record before discovering that the new user turn was too large.
  context.maxToolChars = 0;
  assert.throws(() => context.add({ role: 'user', content: 'x'.repeat(20) }), /exceeds size limit/);
  assert.equal(context.snapshot()[1].content, 'safe tool output');
});
test('loop detects repeated failing calls and wall deadline aborts an in-flight provider', async () => {
  const failing = {
    async *chat() {
      yield { toolCalls: [call('read_file', '{"path":"x"}')] };
    },
  };
  const result = await new AgentLoop({
    provider: failing,
    tools: {
      execute: async () => {
        throw new Error('no');
      },
    },
    maxTurns: 5,
  }).run({ task: 'x' });
  assert.match(result.error, /repeated 3 times/);
  // The real failure is kept for the primary, not just the constant text.
  assert.equal(result.failureKind, 'tool-loop');
  assert.equal(result.error, 'Loop detected: identical failing tool calls repeated 3 times');
  assert.deepEqual(
    { ...result.toolFailure, signature: undefined },
    { tool: 'read_file', args: '{"path":"x"}', error: 'no', turn: 3, repeats: 3, signature: undefined },
  );
  assert.match(result.toolFailure.signature, /^[0-9a-f]{16}$/);
  const stalled = {
    async *chat({ signal }) {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  };
  const timed = await new AgentLoop({ provider: stalled, tools: { execute: async () => '' }, timeoutMs: 10 }).run({ task: 'x' });
  assert.equal(timed.status, 'TIMEOUT');
});
test('the worker still sees only a generic tool error, the server keeps the real one with paths aliased', async () => {
  const replays = [];
  const provider = {
    async *chat({ messages }) {
      replays.push(structuredClone(messages));
      yield { toolCalls: [call('read_file', '{"path":"a.js"}', `r${replays.length}`)] };
    },
  };
  const result = await new AgentLoop({
    provider,
    tools: {
      execute: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, open '/private/tmp/wt-1/a.js' API_KEY=sk-secretsecret"), {
          code: 'ENOENT',
        });
      },
    },
    pathAliases: [['/private/tmp/wt-1', '<worktree>']],
    maxTurns: 5,
  }).run({ task: 'x' });
  assert.equal(result.failureKind, 'tool-loop');
  assert.equal(result.toolFailure.error, "ENOENT: no such file or directory, open '<worktree>/a.js' API_KEY=[REDACTED]");
  // A missing path gets no hint (it would tell "missing" from "denied"); none of the message reaches the worker.
  const toolMessage = replays.at(-1).findLast((message) => message.role === 'tool');
  assert.equal(toolMessage.content, 'TOOL_ERROR: Tool execution failed');
  assert.doesNotMatch(JSON.stringify(replays), /wt-1|sk-secretsecret/);
  assert.throws(() => new AgentLoop({ provider, tools: { execute() {} }, pathAliases: [['only-one']] }), /pathAliases/);
  assert.throws(() => new AgentLoop({ provider, tools: { execute() {} }, pathAliases: 'x' }), /pathAliases/);
});

test('a failure that is followed by a success resets the loop counter and records no loop', async () => {
  let turn = 0;
  const outcomes = ['fail', 'fail', 'ok', 'fail', 'fail'];
  const provider = {
    async *chat() {
      turn++;
      yield { toolCalls: [call('read_file', '{"path":"x"}', `c${turn}`)] };
    },
  };
  const result = await new AgentLoop({
    provider,
    tools: {
      execute: async () => {
        if (outcomes[turn - 1] === 'ok') return 'fine';
        throw new Error('no');
      },
    },
    maxTurns: 5,
  }).run({ task: 'x' });
  assert.equal(result.status, 'BUDGET');
  assert.equal(result.failureKind, undefined);
  assert.equal(result.toolFailure, undefined);
});

test('a real tool refusal is reported with a relative path and the worker gets a fixed hint', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-loop-refusal-'));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'existing.txt'), 'old\n');
  const replays = [];
  let turn = 0;
  const provider = {
    async *chat({ messages }) {
      replays.push(structuredClone(messages));
      turn++;
      yield { toolCalls: [call('write_file', '{"path":"existing.txt","content":"new\\n"}', `w${turn}`)] };
    },
  };
  const result = await new AgentLoop({
    provider,
    tools: new LocalTools({ repoPath: dir, ownedPaths: ['**'], gitExec: () => ({ status: 1, stdout: '' }) }),
    pathAliases: [[dir, '<worktree>']],
    maxTurns: 6,
  }).run({ task: 'x' });
  assert.equal(result.failureKind, 'tool-loop');
  assert.equal(result.toolFailure.tool, 'write_file');
  assert.equal(result.toolFailure.args, '{"path":"existing.txt","content":"<4 chars>"}');
  assert.equal(result.toolFailure.error, 'Refusing overwrite without prior complete read: existing.txt');
  assert.equal(
    replays.at(-1).findLast((message) => message.role === 'tool').content,
    'TOOL_ERROR: Tool execution failed (hint: read_file the existing file first, or use edit_file for a small change)',
  );
});

test('a worker that over-asks read_file limit three times is told the byte cap and can self-correct', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-loop-read-limit-'));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'a.txt'), 'hello\n');
  const replays = [];
  let turn = 0;
  const provider = {
    async *chat({ messages }) {
      replays.push(structuredClone(messages));
      turn++;
      yield { toolCalls: [call('read_file', '{"path":"a.txt","limit":256000}', `r${turn}`)] };
    },
  };
  const result = await new AgentLoop({
    provider,
    tools: new LocalTools({ repoPath: dir, ownedPaths: ['**'], gitExec: () => ({ status: 1, stdout: '' }) }),
    maxTurns: 6,
  }).run({ task: 'x' });
  assert.equal(result.failureKind, 'tool-loop');
  assert.equal(result.toolFailure.error, 'limit must be an integer between 0 and 64000');
  const seen = replays.at(-1).findLast((message) => message.role === 'tool').content;
  assert.equal(
    seen,
    'TOOL_ERROR: Tool execution failed (hint: read_file limit is at most 64000 bytes per call; omit limit or pass a smaller one, then continue from the next offset)',
  );
  assert.ok(!/secret|a\.txt|256000/.test(seen), 'the hint carries the cap, not the refused call');
});

test('after a loop FAILED the abandoned tool call is dropped from the durable transcript and a continuation is valid', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    const persist = { onAppend: (m) => store.messages(job.id, m), onAppendBatch: (m) => store.messagesBatch(job.id, m) };
    const failing = {
      async *chat() {
        yield { toolCalls: [call('read_file', '{"path":"x"}', `c${Math.random()}`)] };
      },
    };
    const first = await new AgentLoop({
      provider: failing,
      tools: { execute: async () => Promise.reject(new Error('no')) },
      context: new AgentContext([], persist),
      maxTurns: 6,
    }).run({ system: 'sys', task: 'do it' });
    assert.equal(first.failureKind, 'tool-loop');
    const durable = await store.readMessages(job.id);
    assert.equal(durable.at(-1).role, 'assistant', 'the loop returns before the final call has a result');
    assert.ok(durable.at(-1).tool_calls);

    let seen;
    const resumed = await new AgentLoop({
      provider: {
        async *chat({ messages }) {
          seen = structuredClone(messages);
          yield { toolCalls: [call('finish', '{"summary":"done"}', 'fin')] };
        },
      },
      tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
      context: new AgentContext(await store.readMessages(job.id), persist),
    }).run({ task: 'continue differently' });
    assert.equal(resumed.status, 'DONE');
    // The orphaned call is gone, and what remains is a replay-valid conversation.
    assert.equal(seen.at(-1).content, 'continue differently');
    const replayable = (messages) => {
      for (const [index, message] of messages.entries())
        if (message.role === 'assistant' && message.tool_calls)
          assert.deepEqual(
            messages.slice(index + 1, index + 1 + message.tool_calls.length).map((m) => m.tool_call_id),
            message.tool_calls.map((c) => c.id),
            'every assistant tool call has its results directly after it',
          );
    };
    replayable(seen);
    replayable(await store.readMessages(job.id));
    assert.equal(
      (await store.readMessages(job.id)).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length,
      3,
      'two failed rounds plus the finish call survive; the abandoned third failing call does not',
    );
  } finally {
    cleanup(gitDir);
  }
});
test('wall-clock deadline reaches LocalTools and aborts an in-flight command runner', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-loop-command-'));
  let runnerSignal;
  const tools = new LocalTools({
    repoPath: dir,
    ownedPaths: ['**'],
    runCommand: ({ signal }) =>
      new Promise((resolve, reject) => {
        runnerSignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  });
  const provider = {
    async *chat() {
      yield { toolCalls: [call('run_command', '{"command":"sleep 60"}', 'cmd')] };
    },
  };
  const result = await new AgentLoop({ provider, tools, timeoutMs: 15 }).run({ task: 'x' });
  assert.equal(result.status, 'TIMEOUT');
  assert.ok(runnerSignal?.aborted, 'the runner receives the loop deadline signal');
});
test('a preloaded context gets only the new repair turn, never historical duplicates', async () => {
  const prior = [
    { role: 'system', content: 'old system' },
    { role: 'user', content: 'original task' },
  ];
  const context = new AgentContext(prior);
  let request;
  const provider = {
    async *chat({ messages }) {
      request = structuredClone(messages);
      yield { toolCalls: [call('finish', '{"summary":"repaired"}', 'done')] };
    },
  };
  const result = await new AgentLoop({
    provider,
    context,
    tools: { execute: async () => ({ finish: { summary: 'repaired', concerns: [], testsRun: [] } }) },
  }).run({ task: 'Repair these concrete defects:\n- mismatch' });
  assert.equal(result.status, 'DONE');
  assert.deepEqual(request, [...prior, { role: 'user', content: 'Repair these concrete defects:\n- mismatch' }]);
  assert.equal(context.snapshot().filter((m) => m.content === 'original task').length, 1);
  assert.equal(context.snapshot().filter((m) => m.content?.includes('mismatch')).length, 1);
});
test('an overspent finite budget names the USD cap, distinct from the turn cap and unpriced responses', async () => {
  const overspend = await new AgentLoop({
    provider: {
      async *chat() {
        yield { usage: { inputTokens: 10, outputTokens: 20_000 }, toolCalls: [call('read_file', '{"path":"x"}', 'read')] };
      },
    },
    tools: { execute: async () => assert.fail('no tool may run after the cap is exceeded') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 0.01,
    maxTurns: 5,
  }).run({ task: 'x' });
  assert.equal(overspend.status, 'BUDGET');
  assert.equal(overspend.budgetCap, 'usd');
  assert.ok(overspend.costUsd > 0.01);
  assert.equal(overspend.turn, 1, 'stopped by money long before the turn cap');
});
test('a finite zero or unknown-price budget makes no provider request', async () => {
  let calls = 0;
  const provider = {
    async *chat() {
      calls++;
      yield { toolCalls: [call('finish', '{"summary":"unexpected"}')] };
    },
  };
  const tools = { execute: async () => ({ finish: { summary: 'unexpected', concerns: [], testsRun: [] } }) };
  const zero = await new AgentLoop({ provider, tools, maxUsd: 0 }).run({ task: 'x' });
  assert.equal(zero.status, 'BUDGET');
  assert.equal(zero.budgetCap, 'other');
  assert.equal(calls, 0);
  const unknown = await new AgentLoop({ provider, tools, maxUsd: 1 }).run({ task: 'x' });
  assert.equal(unknown.status, 'BUDGET');
  assert.equal(unknown.budgetCap, 'other');
  assert.equal(calls, 0);
});
const priceTable = (names) => ({
  models: Object.fromEntries(
    names.map((name) => [
      name,
      {
        usd_per_1m: {
          input_cache_hit: { off_peak: 0, peak: 0 },
          input_cache_miss: { off_peak: 1, peak: 1 },
          output: { off_peak: 1, peak: 1 },
        },
      },
    ]),
  ),
});
const toolTranscript = ({ results = 9, firstContent = 'x'.repeat(70_000) } = {}) =>
  Array.from({ length: results }, (_, index) => [
    {
      role: 'assistant',
      content: `assistant-${index}`,
      reasoning_content: `reasoning-${index}`,
      tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: `call-${index}`, name: 'read_file', content: index === 0 ? firstContent : `result-${index}` },
  ]).flat();
const conservativeRequestUsd = (messages, tools, maxTokens) =>
  (Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') + 256 + messages.length * 16 + tools.length * 64 + maxTokens) / 1_000_000;
const multiResultBudgetTranscript = () => {
  const prior = Array.from({ length: 8 }, (_, index) => [
    {
      role: 'assistant',
      content: `assistant-${index}`,
      reasoning_content: `reasoning-${index}`,
      tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    {
      role: 'tool',
      tool_call_id: `call-${index}`,
      name: 'read_file',
      content: index === 0 ? 'a'.repeat(70_000) : index === 2 ? 'b'.repeat(24_024) : `result-${index}`,
    },
  ]).flat();
  return [
    ...prior,
    {
      role: 'assistant',
      content: 'latest assistant',
      reasoning_content: 'latest reasoning',
      tool_calls: [
        { id: 'latest-a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        { id: 'latest-b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'latest-a', name: 'read_file', content: 'latest result a' },
    { role: 'tool', tool_call_id: 'latest-b', name: 'read_file', content: 'latest result b' },
  ];
};
test('records every echoed model, prices usage by it, and flags a model change', async () => {
  let turn = 0;
  const provider = {
    async *chat() {
      turn++;
      if (turn === 1)
        yield { model: 'actual-a', usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [call('read_file', '{"path":"a"}', 'read')] };
      else
        yield {
          model: 'actual-b',
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [call('finish', '{"summary":"done"}', 'finish')],
        };
    },
  };
  const tools = { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'read') };
  const result = await new AgentLoop({
    provider,
    tools,
    model: 'requested',
    pricing: priceTable(['requested', 'actual-a', 'actual-b']),
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.deepEqual(result.responseModels, ['actual-a', 'actual-b']);
  assert.equal(result.requestedModel, 'requested');
  assert.equal(result.modelMismatch, true);
  const unknownProvider = {
    async *chat() {
      yield { model: 'unpriced', usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [call('finish', '{"summary":"bad"}')] };
    },
  };
  const blocked = await new AgentLoop({
    provider: unknownProvider,
    tools,
    model: 'requested',
    pricing: priceTable(['requested']),
    maxUsd: 1,
  }).run({ task: 'x' });
  assert.equal(blocked.status, 'BUDGET');
  assert.equal(blocked.pricingKnown, false);
});
test('finite budgets reject substituted models before tools but allow declared aliases and absent metadata', async () => {
  const rates = (value) => ({ off_peak: value, peak: value });
  const pricing = {
    models: {
      requested: { usd_per_1m: { input_cache_hit: rates(0), input_cache_miss: rates(0), output: rates(0) } },
      expensive: { usd_per_1m: { input_cache_hit: rates(1), input_cache_miss: rates(1), output: rates(1_000_000) } },
    },
  };
  let executed = 0;
  const substituted = {
    async *chat() {
      yield { model: 'expensive', toolCalls: [call('finish', '{"summary":"should not run"}')] };
      yield { usage: { inputTokens: 0, outputTokens: 1 } };
    },
  };
  const rejected = await new AgentLoop({
    provider: substituted,
    tools: {
      execute: async () => {
        executed += 1;
        return { finish: { summary: 'wrong', concerns: [], testsRun: [] } };
      },
    },
    model: 'requested',
    pricing,
    maxUsd: 1,
  }).run({ task: 'x' });
  assert.equal(rejected.status, 'BUDGET');
  assert.equal(rejected.budgetCap, 'other');
  assert.match(rejected.error, /not authorized/);
  assert.equal(rejected.costUsd, 1);
  assert.equal(executed, 0);
  assert.deepEqual(rejected.responseModels, ['expensive']);

  const aliasedPricing = { ...priceTable(['canonical']), legacy_aliases: { legacy: 'canonical' } };
  const aliasProvider = {
    async *chat() {
      yield { model: 'canonical', usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [call('finish', '{"summary":"ok"}')] };
    },
  };
  const alias = await new AgentLoop({
    provider: aliasProvider,
    tools: { execute: async () => ({ finish: { summary: 'ok', concerns: [], testsRun: [] } }) },
    model: 'legacy',
    pricing: aliasedPricing,
    maxUsd: 1,
  }).run({ task: 'x' });
  assert.equal(alias.status, 'DONE');
  assert.equal(alias.costUsd > 0, true);

  const noModelProvider = {
    async *chat() {
      yield { usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [call('finish', '{"summary":"ok"}')] };
    },
  };
  const noModel = await new AgentLoop({
    provider: noModelProvider,
    tools: { execute: async () => ({ finish: { summary: 'ok', concerns: [], testsRun: [] } }) },
    model: 'requested',
    pricing,
    maxUsd: 1,
  }).run({ task: 'x' });
  assert.equal(noModel.status, 'DONE');
  assert.equal(noModel.costUsd, 0);
  assert.deepEqual(noModel.responseModels, []);
});
test('prices a terminal usage record with the prior echoed model and rejects unadvertised tools', async () => {
  const rates = (value) => ({ off_peak: value, peak: value });
  const pricing = {
    models: {
      requested: { usd_per_1m: { input_cache_hit: rates(0), input_cache_miss: rates(0), output: rates(100) } },
      actual: { usd_per_1m: { input_cache_hit: rates(0), input_cache_miss: rates(0), output: rates(1) } },
    },
  };
  const provider = {
    async *chat() {
      yield { model: 'actual' };
      yield { usage: { inputTokens: 0, outputTokens: 1_000_000 }, toolCalls: [call('finish', '{"summary":"ok"}')] };
    },
  };
  const done = await new AgentLoop({
    provider,
    tools: { execute: async () => ({ finish: { summary: 'ok', concerns: [], testsRun: [] } }) },
    model: 'requested',
    pricing,
  }).run({ task: 'x' });
  assert.equal(done.status, 'DONE');
  assert.equal(done.costUsd, 1);
  let executed = false;
  const hostile = {
    async *chat() {
      yield { toolCalls: [call('not_advertised', '{}')] };
    },
  };
  const rejected = await new AgentLoop({
    provider: hostile,
    tools: {
      execute: async () => {
        executed = true;
        return '';
      },
    },
  }).run({ task: 'x' });
  assert.equal(rejected.status, 'FAILED');
  assert.match(rejected.error, /unadvertised/);
  assert.equal(executed, false);
});
test('conflicting provider model metadata is metered then rejected before tools run', async () => {
  let executed = 0;
  const provider = {
    async *chat() {
      yield { model: 'first', toolCalls: [call('finish', '{"summary":"must not run"}')] };
      yield { model: 'second', usage: { inputTokens: 0, outputTokens: 1 } };
    },
  };
  const result = await new AgentLoop({
    provider,
    tools: {
      execute: async () => {
        executed++;
        return { finish: { summary: 'wrong', concerns: [], testsRun: [] } };
      },
    },
    model: 'requested',
    pricing: priceTable(['requested', 'first', 'second']),
  }).run({ task: 'x' });
  assert.equal(result.status, 'FAILED');
  assert.match(result.error, /conflicting model metadata/);
  assert.equal(result.costUsd > 0, true);
  assert.equal(executed, 0);
});
test('a late metadata-only adapter conflict still blocks an accumulated tool call', async () => {
  let executed = 0;
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'requested',
    retries: 0,
    fetchImpl: async () =>
      new Response(
        'data: {"model":"first","choices":[{"delta":{"tool_calls":[{"index":0,"id":"done","type":"function","function":{"name":"finish","arguments":"{\\"summary\\":\\"must not run\\"}"}}]}}]}\n\ndata: {"model":"first","choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\ndata: {"model":"second","choices":[]}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ),
  });
  const result = await new AgentLoop({
    provider,
    tools: {
      execute: async () => {
        executed++;
        return { finish: { summary: 'wrong', concerns: [], testsRun: [] } };
      },
    },
  }).run({ task: 'x' });
  assert.equal(result.status, 'FAILED');
  assert.match(result.error, /conflicting model metadata/);
  assert.equal(executed, 0);
});
test('usage before late model metadata is repriced before a finite-budget tool decision', async () => {
  const rates = (value) => ({ off_peak: value, peak: value });
  const pricing = {
    models: {
      requested: { usd_per_1m: { input_cache_hit: rates(0), input_cache_miss: rates(0), output: rates(100) } },
      actual: { usd_per_1m: { input_cache_hit: rates(0), input_cache_miss: rates(0), output: rates(1) } },
    },
  };
  const progress = [];
  let executed = 0;
  const provider = {
    async *chat() {
      yield { usage: { inputTokens: 0, outputTokens: 1_000_000 }, toolCalls: [call('finish', '{"summary":"must not run"}')] };
      yield { model: 'actual' };
    },
  };
  const result = await new AgentLoop({
    provider,
    tools: {
      execute: async () => {
        executed++;
        return { finish: { summary: 'wrong', concerns: [], testsRun: [] } };
      },
    },
    model: 'requested',
    pricing,
    maxUsd: 200,
    progress: (event) => progress.push(event),
  }).run({ task: 'x' });
  assert.equal(result.status, 'BUDGET');
  assert.equal(result.costUsd, 1);
  assert.equal(executed, 0);
  assert.deepEqual(
    progress.filter((event) => event.costUsd !== undefined).map((event) => event.costUsd),
    [100, 1],
  );
});
test('late model repricing remains durable when the provider fails after usage', async () => {
  const rates = (value) => ({ off_peak: value, peak: value });
  const pricing = {
    models: {
      requested: { usd_per_1m: { input_cache_hit: rates(0), input_cache_miss: rates(0), output: rates(100) } },
      actual: { usd_per_1m: { input_cache_hit: rates(0), input_cache_miss: rates(0), output: rates(1) } },
    },
  };
  const progress = [];
  const provider = {
    async *chat() {
      yield { usage: { inputTokens: 0, outputTokens: 1_000_000 } };
      yield { model: 'actual' };
      throw new Error('stream stopped');
    },
  };
  const loop = new AgentLoop({
    provider,
    tools: { execute: async () => '' },
    model: 'requested',
    pricing,
    progress: (event) => progress.push(event),
  });
  await assert.rejects(() => loop.run({ task: 'x' }), /stream stopped/);
  assert.equal(loop.meter.usd, 1);
  assert.deepEqual(
    progress.filter((event) => event.costUsd !== undefined).map((event) => event.costUsd),
    [100, 1],
  );
});
test('invalid or duplicate tool calls are not persisted into a repair transcript', async () => {
  const context = new AgentContext([
    { role: 'system', content: 's' },
    { role: 'user', content: 'old' },
  ]);
  const invalid = {
    async *chat() {
      yield { toolCalls: [call('finish', JSON.stringify({ summary: 'x'.repeat(1501) }), 'bad')] };
    },
  };
  const failed = await new AgentLoop({ provider: invalid, context, tools: { execute: async () => '' } }).run({ task: 'first' });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failureKind, 'finish-protocol');
  // The first invalid finish was corrected and is durable only together with its result; the fatal repeat is not persisted.
  assert.deepEqual(
    context.snapshot().map((m) => [m.role, m.tool_call_id ?? m.tool_calls?.[0].id]),
    [
      ['system', undefined],
      ['user', undefined],
      ['user', undefined],
      ['assistant', 'bad'],
      ['tool', 'bad'],
    ],
  );
  let replay;
  const repaired = {
    async *chat({ messages }) {
      replay = structuredClone(messages);
      yield { toolCalls: [call('finish', '{"summary":"ok"}', 'done')] };
    },
  };
  await new AgentLoop({
    provider: repaired,
    context,
    tools: { execute: async () => ({ finish: { summary: 'ok', concerns: [], testsRun: [] } }) },
  }).run({ task: 'repair' });
  assert.deepEqual(
    replay.map((m) => m.role),
    ['system', 'user', 'user', 'assistant', 'tool', 'user'],
  );
  assert.equal(replay.at(-1).content, 'repair');
  const duplicate = {
    async *chat() {
      yield { toolCalls: [call('read_file', '{"path":"a"}', 'same'), call('read_file', '{"path":"b"}', 'same')] };
    },
  };
  const duplicateResult = await new AgentLoop({ provider: duplicate, tools: { execute: async () => '' } }).run({ task: 'x' });
  assert.match(duplicateResult.error, /Duplicate/);
  const hostile = {
    async *chat() {
      yield { toolCalls: [call('read_file', '{"path":"secret-value-that-must-not-echo"')] };
    },
  };
  const hostileResult = await new AgentLoop({ provider: hostile, tools: { execute: async () => '' } }).run({ task: 'x' });
  assert.equal(hostileResult.error, 'Invalid tool arguments');
  assert.equal(hostileResult.failureKind, undefined, 'a provider protocol fault is never a continuable worker failure');
  assert.doesNotMatch(hostileResult.error, /secret-value/);
});
test('incoming transcript messages precede the one new task and reject a reordered system turn', async () => {
  const seen = [];
  const provider = {
    async *chat({ messages }) {
      seen.push(...messages);
      yield { toolCalls: [call('finish', '{"summary":"ok"}')] };
    },
  };
  await new AgentLoop({ provider, tools: { execute: async () => ({ finish: { summary: 'ok', concerns: [], testsRun: [] } }) } }).run({
    messages: [{ role: 'user', content: 'old' }],
    task: 'new',
  });
  assert.deepEqual(
    seen.map((m) => m.content),
    ['old', 'new'],
  );
  await assert.rejects(
    () =>
      new AgentLoop({ provider, context: new AgentContext([{ role: 'user', content: 'old' }]), tools: { execute: async () => '' } }).run({
        system: 'late',
        task: 'new',
      }),
    /existing transcript/,
  );
});
test('invalid initial transcript input is rejected atomically before durable append', async () => {
  const appended = [];
  const context = new AgentContext([], {
    onAppend: async (message) => appended.push(message.content),
    onAppendBatch: async (messages) => appended.push(...messages.map((message) => message.content)),
  });
  let seen;
  const provider = {
    async *chat({ messages }) {
      seen = structuredClone(messages);
      yield { toolCalls: [call('finish', '{"summary":"ok"}')], model: 'm' };
    },
  };
  const loop = new AgentLoop({
    provider,
    context,
    tools: { execute: async () => ({ finish: { summary: 'ok', concerns: [], testsRun: [] } }) },
  });
  await assert.rejects(
    () =>
      loop.run({
        messages: [
          { role: 'user', content: 'must-not-stick' },
          { role: 'user', content: 42 },
        ],
      }),
    /invalid content/,
  );
  assert.deepEqual(context.snapshot(), []);
  assert.deepEqual(appended, []);
  await loop.run({ system: 'system', task: 'retry' });
  assert.deepEqual(
    seen.map((message) => message.content),
    ['system', 'retry'],
  );
  assert.deepEqual(
    context.snapshot().map((message) => message.content),
    ['system', 'retry', '', '{"summary":"ok","concerns":[],"testsRun":[]}'],
  );
});
test('initial system and task use one batch callback and leave no in-memory prefix on failure', async () => {
  const persisted = [];
  let providerCalls = 0,
    fail = true;
  const context = new AgentContext([], {
    onAppendBatch: async (messages) => {
      persisted.push(messages.map((message) => message.content));
      if (fail) throw new Error('disk full');
    },
  });
  const provider = {
    async *chat() {
      providerCalls++;
    },
  };
  await assert.rejects(
    () => new AgentLoop({ provider, context, tools: { execute: async () => '' } }).run({ system: 'system', task: 'task' }),
    /disk full/,
  );
  assert.deepEqual(persisted, [['system', 'task']]);
  assert.deepEqual(context.snapshot(), []);
  assert.equal(providerCalls, 0);
  fail = false;
  await context.addBatch([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'task' },
  ]);
  assert.deepEqual(
    context.snapshot().map((message) => message.content),
    ['system', 'task'],
  );
});
test('a failed single-record durability callback leaves no in-memory transcript residue', async () => {
  let fail = true;
  const context = new AgentContext([], {
    onAppend: async () => {
      if (fail) throw new Error('disk full');
    },
  });
  context.add({ role: 'user', content: 'must not stick' });
  await assert.rejects(() => context.flush(), /disk full/);
  assert.deepEqual(context.snapshot(), []);
  fail = false;
  context.add({ role: 'user', content: 'retry' });
  await context.flush();
  assert.deepEqual(
    context.snapshot().map((message) => message.content),
    ['retry'],
  );
});
test('a trailing incomplete initial tool transaction is rejected before append or provider use', async () => {
  const appended = [];
  let providerCalls = 0;
  const context = new AgentContext([], { onAppend: async (message) => appended.push(message) });
  const provider = {
    async *chat() {
      providerCalls++;
    },
  };
  const incomplete = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
  };
  await assert.rejects(
    () => new AgentLoop({ provider, context, tools: { execute: async () => '' } }).run({ messages: [incomplete] }),
    /incomplete tool-call transaction/,
  );
  assert.deepEqual(context.snapshot(), []);
  assert.deepEqual(appended, []);
  assert.equal(providerCalls, 0);
});
test('a finite budget refuses missing or duplicate usage before tool execution', async () => {
  let executed = 0;
  const tools = {
    execute: async () => {
      executed++;
      return { finish: { summary: 'bad', concerns: [], testsRun: [] } };
    },
  };
  const missing = {
    async *chat() {
      yield { toolCalls: [call('finish', '{"summary":"x"}')] };
    },
  };
  const table = priceTable(['m']);
  const first = await new AgentLoop({ provider: missing, tools, model: 'm', pricing: table, maxUsd: 1 }).run({ task: 'x' });
  assert.match(first.error, /exactly one usage/);
  assert.equal(executed, 0);
  const duplicate = {
    async *chat() {
      yield { usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [call('finish', '{"summary":"x"}')] };
      yield { usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const second = await new AgentLoop({ provider: duplicate, tools, model: 'm', pricing: table, maxUsd: 1 }).run({ task: 'x' });
  assert.match(second.error, /received 2/);
  assert.equal(executed, 0);
});
test('provider turns reject replacement tool-call events and duplicate usage without reflecting arguments', async () => {
  let executed = 0;
  const tools = {
    execute: async () => {
      executed++;
      return { finish: { summary: 'bad', concerns: [], testsRun: [] } };
    },
  };
  const replacement = {
    async *chat() {
      yield { toolCalls: [call('read_file', '{"path":"first"}', 'first')] };
      yield { toolCalls: [call('finish', '{"summary":"secret-value-that-must-not-echo"}', 'last')] };
    },
  };
  const replaced = await new AgentLoop({ provider: replacement, tools }).run({ task: 'x' });
  assert.equal(replaced.status, 'FAILED');
  assert.match(replaced.error, /multiple tool-call events/);
  assert.equal(executed, 0);
  assert.doesNotMatch(JSON.stringify(replaced), /secret-value/);

  const duplicateUsage = {
    async *chat() {
      yield { usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [call('finish', '{"summary":"ok"}')] };
      yield { usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const chargedTwice = await new AgentLoop({ provider: duplicateUsage, tools }).run({ task: 'x' });
  assert.equal(chargedTwice.status, 'FAILED');
  assert.match(chargedTwice.error, /received 2/);
  assert.equal(executed, 0);
});
test('a finite budget rejects malformed normalized usage before tool execution', async () => {
  let executed = 0;
  const provider = {
    async *chat() {
      yield { usage: {}, toolCalls: [call('finish', '{"summary":"x"}')] };
    },
  };
  await assert.rejects(
    () =>
      new AgentLoop({
        provider,
        tools: {
          execute: async () => {
            executed++;
            return { finish: { summary: 'bad', concerns: [], testsRun: [] } };
          },
        },
        model: 'm',
        pricing: priceTable(['m']),
        maxUsd: 1,
      }).run({ task: 'x' }),
    /invalid usage/,
  );
  assert.equal(executed, 0);
});
test('provider cache usage must be internally consistent before accounting or tool execution', async () => {
  let executed = 0;
  const provider = {
    async *chat() {
      yield {
        usage: { inputTokens: 10, outputTokens: 1, cacheHitTokens: 7, cacheMissTokens: 2 },
        toolCalls: [call('finish', '{"summary":"x"}')],
      };
    },
  };
  await assert.rejects(
    () =>
      new AgentLoop({
        provider,
        tools: {
          execute: async () => {
            executed++;
            return { finish: { summary: 'bad', concerns: [], testsRun: [] } };
          },
        },
      }).run({ task: 'x' }),
    /invalid usage/,
  );
  assert.equal(executed, 0);
});
test('context append and progress callbacks expose durable incremental state', async () => {
  const appended = [],
    progress = [];
  const context = new AgentContext([], {
    onAppend: async (message) => {
      appended.push(message.role);
    },
  });
  const provider = {
    async *chat() {
      yield { usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [call('finish', '{"summary":"ok"}')] };
    },
  };
  const result = await new AgentLoop({
    provider,
    context,
    tools: { execute: async () => ({ finish: { summary: 'ok', concerns: [], testsRun: [] } }) },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    progress: (event) => progress.push(event),
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.deepEqual(appended, ['user', 'assistant', 'tool']);
  assert.ok(progress.some((event) => event.action === 'provider_usage'));
  assert.ok(progress.some((event) => event.actions?.includes('finish')));
});
test('finish reason is reported safely and resets before the next turn result', async () => {
  const progress = [];
  let request = 0;
  const result = await new AgentLoop({
    provider: {
      async *chat() {
        request++;
        if (request === 1) {
          yield { providerFinishReason: 'length' };
          yield { toolCalls: [call('read_file', '{"path":"x"}', 'read')] };
        } else yield { toolCalls: [call('finish', '{"summary":"ok"}', 'done')] };
      },
    },
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'ok', concerns: [], testsRun: [] } } : 'read result') },
    maxTurns: 2,
    progress: async (event) => progress.push(event),
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.equal(result.providerFinishReason, undefined);
  assert.deepEqual(
    progress.filter((event) => event.providerFinishReason).map((event) => event.providerFinishReason),
    ['length'],
  );
  assert.deepEqual(
    progress.filter((event) => event.action === 'provider_request_pending').map((event) => event.providerFinishReason),
    [null, null],
  );
});
test('repair contexts elide loaded tool output and reject oversized transcripts', () => {
  const context = new AgentContext(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'old-call', content: 'x'.repeat(200) },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'current-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'current-call', content: 'current output' },
    ],
    { maxToolChars: 20, keepRecentToolResults: 0, maxTranscriptChars: 500 },
  );
  assert.match(context.snapshot()[1].content, /elided/);
  assert.equal(
    context.snapshot()[3].content,
    'current output',
    'current transaction output stays durable even above the configured aggregate cap',
  );
  assert.throws(
    () => new AgentContext([{ role: 'assistant', content: 'x'.repeat(501) }], { maxTranscriptChars: 500 }),
    /exceeds size limit/,
  );
});

test('context owns inbound messages and snapshots/onAppend cannot mutate durable state', async () => {
  const original = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    },
    { role: 'tool', tool_call_id: 'call', name: 'read_file', content: 'safe result' },
  ];
  const context = new AgentContext(original, {
    onAppend: async (message) => {
      message.content = 'callback mutation';
    },
  });
  original[0].tool_calls[0].function.arguments = '{"path":"tampered"}';
  original[1].content = 'tampered';
  const callerOwned = { role: 'user', content: 'safe user' };
  context.add(callerOwned);
  callerOwned.content = 'caller mutation';
  await context.flush();
  const exposed = context.snapshot();
  exposed.push({ role: 'user', content: 'injected' });
  exposed[0].tool_calls[0].function.arguments = '{"path":"snapshot mutation"}';
  exposed[1].content = 'snapshot mutation';
  exposed[2].content = 'snapshot mutation';
  const stable = context.snapshot();
  assert.deepEqual(
    stable.map((message) => message.content),
    ['', 'safe result', 'safe user'],
  );
  assert.equal(stable[0].tool_calls[0].function.arguments, '{"path":"a"}');

  const provider = {
    async *chat({ messages }) {
      messages[0].content = 'provider mutation';
      messages.push({ role: 'user', content: 'provider injected' });
      yield { toolCalls: [call('finish', '{"summary":"ok"}')] };
    },
  };
  const loopContext = new AgentContext();
  await new AgentLoop({
    provider,
    context: loopContext,
    tools: { execute: async () => ({ finish: { summary: 'ok', concerns: [], testsRun: [] } }) },
  }).run({ system: 'system', task: 'task' });
  assert.deepEqual(
    loopContext
      .snapshot()
      .slice(0, 2)
      .map((message) => message.content),
    ['system', 'task'],
  );
});

test('policy-only jobs do not advertise a shell they cannot execute', async () => {
  let advertised;
  const provider = {
    async *chat({ tools }) {
      advertised = tools.map((tool) => tool.function.name);
      yield { toolCalls: [call('finish', '{"summary":"edited"}', 'done')] };
    },
  };
  const result = await new AgentLoop({
    provider,
    tools: { execute: async () => ({ finish: { summary: 'edited', concerns: [], testsRun: [] } }) },
    toolDefinitions: availableToolDefinitions({ allowCommand: false }),
  }).run({ task: 'edit files only' });
  assert.equal(result.status, 'DONE');
  assert.ok(!advertised.includes('run_command'));
  assert.match(await buildSystemPrompt({ ownedPaths: ['src/**'], allowCommand: false }), /Shell commands are unavailable/);
});

test('finite write jobs persist one implementation checkpoint after durable discovery results', async () => {
  const turns = [
    [call('read_file', '{"path":"README.md"}', 'read-1')],
    [call('list_dir', '{"path":"src"}', 'list-1')],
    [call('write_file', '{"path":"src/implementation.mjs","content":"export default 1;"}', 'write')],
    [call('list_dir', '{"path":"test"}', 'list-2')],
    [call('finish', '{"summary":"done"}', 'done')],
  ];
  const requests = [];
  const persisted = [];
  const progress = [];
  const context = new AgentContext([], { onAppend: async (message) => persisted.push(structuredClone(message)) });
  const provider = {
    async *chat(request) {
      const options = {};
      for (const name of ['thinking', 'reasoning_effort', 'tool_choice']) if (Object.hasOwn(request, name)) options[name] = request[name];
      requests.push({ messages: structuredClone(request.messages), tools: structuredClone(request.tools), options });
      yield { usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: turns.shift() };
    },
  };
  const result = await new AgentLoop({
    provider,
    context,
    maxTurns: 6,
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    progress: async (event) => progress.push({ ...event, messages: context.snapshot() }),
    tools: {
      execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : `${name} result`),
    },
  }).run({ task: 'implement x' });
  assert.equal(result.status, 'DONE');
  const checkpoint = 'Implementation checkpoint: 4 model turns remain.';
  assert.equal(
    requests[2].messages.at(-1).content,
    checkpoint +
      ' The next response must make an allowed tool call. If necessary information remains unread, read or list it now; otherwise make a mutation immediately. Put source only in write_file.content. To avoid output caps, write one complete file per response when multiple files are material. Finish when complete.',
  );
  assert.deepEqual(requests[2].tools, requests[0].tools, 'the generic checkpoint keeps the complete job-authorized schema');
  assert.ok(!Object.hasOwn(requests[2].options, 'thinking'), 'generic providers retain the advisory focus request');
  assert.ok(!Object.hasOwn(requests[2].options, 'reasoning_effort'));
  assert.ok(!Object.hasOwn(requests[2].options, 'tool_choice'));
  assert.ok(
    requests[3].tools.some((request) => request.function.name === 'list_dir'),
    'the complete schema remains available after the focus response',
  );
  assert.equal(
    persisted.findIndex((message) => message.content.startsWith('Implementation checkpoint:')),
    persisted.findIndex((message) => message.content === 'list_dir result') + 1,
    'the checkpoint is appended only after the second transaction result is durable',
  );
  const checkpoints = progress.filter((event) => event.action === 'implementation_checkpoint');
  assert.equal(checkpoints.length, 1, 'continued discovery must not append a second checkpoint');
  assert.equal(
    checkpoints[0].messages.at(-1).content,
    requests[2].messages.at(-1).content,
    'progress follows durable checkpoint persistence',
  );
  assert.equal(progress.filter((event) => event.action === 'implementation_focus').length, 1);
});

test('official DeepSeek focus requires a tool call without narrowing the job schema', async () => {
  const turns = [
    [call('read_file', '{"path":"README.md"}', 'read')],
    [call('list_dir', '{"path":"src"}', 'list')],
    [call('write_file', '{"path":"src/implementation.mjs","content":"export default 1;"}', 'write')],
    [call('finish', '{"summary":"done"}', 'done')],
  ];
  const requests = [];
  let request = 0;
  const result = await new AgentLoop({
    provider: officialDeepSeekProvider(async function* (options) {
      requests.push(structuredClone(options));
      request++;
      yield {
        ...(request === 3 ? { reasoning: '' } : {}),
        usage: { inputTokens: 0, outputTokens: 0 },
        toolCalls: turns.shift(),
      };
    }),
    maxTurns: 6,
    model: 'deepseek-flash',
    pricing: priceTable(['deepseek-flash']),
    maxUsd: 1,
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'ok') },
  }).run({ task: 'implement x' });
  assert.equal(result.status, 'DONE');
  assert.ok(!Object.hasOwn(requests[0], 'thinking'), 'the discovery request retains the normal thinking-capable contract');
  assert.ok(!Object.hasOwn(requests[0], 'reasoning_effort'));
  assert.ok(!Object.hasOwn(requests[0], 'tool_choice'));
  assert.deepEqual(requests[2].tools, requests[0].tools, 'focus retains every job-authorized tool');
  assert.match(requests[2].messages.at(-1).content, /If necessary information remains unread, read or list it now/);
  assert.deepEqual(
    {
      thinking: requests[2].thinking,
      reasoning_effort: requests[2].reasoning_effort,
      tool_choice: requests[2].tool_choice,
    },
    {
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
      tool_choice: 'required',
    },
  );
  assert.ok(
    requests[3].tools.some((tool) => tool.function.name === 'finish'),
    'the complete schema remains available after a focused mutation',
  );
  assert.deepEqual(
    {
      thinking: requests[3].thinking,
      reasoning_effort: requests[3].reasoning_effort,
    },
    {
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
    },
    'the normal post-write request retains non-thinking replay without inventing reasoning_content',
  );
  assert.ok(!Object.hasOwn(requests[3], 'tool_choice'));
  assert.equal(
    requests[3].messages.find((message) => message.tool_calls?.[0]?.id === 'write').reasoning_content,
    '',
    'the exact empty focused-write reasoning response is replayed on the normal follow-up request',
  );
});

test('null reasoning placeholders around an empty fragment replay the exact string', async () => {
  const requests = [];
  let turn = 0;
  const result = await new AgentLoop({
    provider: {
      async *chat({ messages }) {
        requests.push(structuredClone(messages));
        turn++;
        if (turn === 1) {
          yield { reasoning: null };
          yield { reasoning: '' };
          yield { reasoning: null };
          yield { toolCalls: [call('read_file', '{"path":"README.md"}', 'read')] };
        } else yield { toolCalls: [call('finish', '{"summary":"done"}', 'done')] };
      },
    },
    tools: {
      execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'README'),
    },
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.equal(requests[1].find((message) => message.tool_calls?.[0]?.id === 'read').reasoning_content, '');
});

test('a nonempty reasoning fragment wins over a later null placeholder for tool replay', async () => {
  const requests = [];
  let turn = 0;
  const result = await new AgentLoop({
    provider: {
      async *chat({ messages }) {
        requests.push(structuredClone(messages));
        turn++;
        if (turn === 1) {
          yield { reasoning: 'inspect first' };
          yield { reasoning: null };
          yield { toolCalls: [call('read_file', '{"path":"README.md"}', 'read')] };
        } else yield { toolCalls: [call('finish', '{"summary":"done"}', 'done')] };
      },
    },
    tools: {
      execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'README'),
    },
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.equal(requests[1].find((message) => message.tool_calls?.[0]?.id === 'read').reasoning_content, 'inspect first');
});

test('raw OpenAI SSE replays reasoning text when a later tool delta carries a null placeholder', async () => {
  const requests = [];
  const stream = (chunks) =>
    new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  const scripts = [
    [
      { choices: [{ delta: { reasoning_content: 'inspect first' } }] },
      {
        choices: [
          {
            delta: {
              reasoning_content: null,
              tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
            },
          },
        ],
      },
    ],
    [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'done', type: 'function', function: { name: 'finish', arguments: '{"summary":"done"}' } }],
            },
          },
        ],
      },
    ],
  ];
  const provider = new OpenAIChatProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test',
    model: 'deepseek-flash',
    retries: 0,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return stream(scripts.shift());
    },
  });
  const result = await new AgentLoop({
    provider,
    model: 'deepseek-flash',
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'README') },
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.equal(requests[1].messages.find((message) => message.tool_calls?.[0]?.id === 'read').reasoning_content, 'inspect first');
});

test('official DeepSeek implementation focus overrides enabled constructor thinking on the provider wire', async () => {
  const requests = [];
  const stream = (chunks) =>
    new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  const toolChunk = (id, name, argumentsText) => ({
    choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: argumentsText } }] } }],
  });
  const usageChunk = { usage: { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1 } };
  const scripts = [
    [{ choices: [{ delta: { reasoning_content: 'inspect first' } }] }, toolChunk('read', 'read_file', '{"path":"README.md"}'), usageChunk],
    [toolChunk('list', 'list_dir', '{"path":"src"}'), usageChunk],
    [
      { choices: [{ delta: { reasoning_content: null } }] },
      toolChunk('write', 'write_file', '{"path":"src/a.mjs","content":"export default 1;"}'),
      usageChunk,
    ],
    [toolChunk('done', 'finish', '{"summary":"done"}'), usageChunk],
  ];
  const provider = new OpenAIChatProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test',
    model: 'deepseek-flash',
    thinking: { type: 'enabled' },
    reasoningEffort: 'high',
    retries: 0,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return stream(scripts.shift());
    },
  });
  const result = await new AgentLoop({
    provider,
    model: 'deepseek-flash',
    pricing: priceTable(['deepseek-flash']),
    maxUsd: 1,
    maxTurns: 6,
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'ok') },
  }).run({ task: 'implement x' });

  assert.equal(result.status, 'DONE');
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[0].thinking, { type: 'enabled' });
  assert.equal(requests[0].reasoning_effort, 'high');
  assert.equal(Object.hasOwn(requests[0], 'tool_choice'), false);
  assert.deepEqual(requests[2].thinking, { type: 'disabled' });
  assert.equal(requests[2].reasoning_effort, 'none');
  assert.deepEqual(requests[2].tools, requests[0].tools);
  assert.equal(requests[2].tool_choice, 'required');
  assert.deepEqual(requests[3].thinking, { type: 'disabled' });
  assert.equal(requests[3].reasoning_effort, 'none');
  assert.equal(Object.hasOwn(requests[3], 'tool_choice'), false);
  assert.equal(requests[3].messages.find((message) => message.tool_calls?.[0]?.id === 'write').reasoning_content, null);
});

test('official DeepSeek resumes an unreasoned tool transcript in normal non-thinking mode', async () => {
  const requests = [];
  const persisted = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'prior-write',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"src/a.mjs","content":"export default 1;"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'prior-write', content: 'WROTE: src/a.mjs' },
  ];
  const result = await new AgentLoop({
    provider: officialDeepSeekProvider(async function* (options) {
      requests.push(structuredClone(options));
      yield {
        usage: { inputTokens: 0, outputTokens: 0 },
        toolCalls: [call('finish', '{"summary":"done"}', 'done')],
      };
    }),
    context: new AgentContext(persisted),
    maxTurns: 2,
    model: 'deepseek-flash',
    pricing: priceTable(['deepseek-flash']),
    maxUsd: 1,
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
  }).run({ task: 'complete the existing implementation' });
  assert.equal(result.status, 'DONE');
  assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  assert.equal(requests[0].reasoning_effort, 'none');
  assert.ok(!Object.hasOwn(requests[0], 'tool_choice'), 'resume restores the normal tool-selection policy');
  assert.ok(requests[0].tools.some((tool) => tool.function.name === 'finish'));
});

test('official DeepSeek preserves configured thinking after replayable reasoning tool calls', async () => {
  const requests = [];
  const persisted = [
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'I wrote the requested file.',
      tool_calls: [
        {
          id: 'prior-write',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"src/a.mjs","content":"export default 1;"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'prior-write', content: 'WROTE: src/a.mjs' },
  ];
  const result = await new AgentLoop({
    provider: officialDeepSeekProvider(async function* (options) {
      requests.push(structuredClone(options));
      yield {
        reasoning: 'The implementation is complete.',
        usage: { inputTokens: 0, outputTokens: 0 },
        toolCalls: [call('finish', '{"summary":"done"}', 'done')],
      };
    }),
    context: new AgentContext(persisted),
    maxTurns: 2,
    model: 'deepseek-flash',
    pricing: priceTable(['deepseek-flash']),
    maxUsd: 1,
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
  }).run({ task: 'complete the existing implementation' });
  assert.equal(result.status, 'DONE');
  assert.ok(!Object.hasOwn(requests[0], 'thinking'));
  assert.ok(!Object.hasOwn(requests[0], 'reasoning_effort'));
  assert.ok(!Object.hasOwn(requests[0], 'tool_choice'));
});

test('official DeepSeek focus permits a late required read before implementation', async () => {
  const turns = [
    [call('read_file', '{"path":"README.md"}', 'read')],
    [call('list_dir', '{"path":"src"}', 'list')],
    [call('read_file', '{"path":"acceptance/resolver.test.mjs"}', 'late-read')],
    [call('write_file', '{"path":"src/a.mjs","content":"export default 1;"}', 'write')],
    [call('finish', '{"summary":"done"}', 'done')],
  ];
  const executed = [];
  const requests = [];
  const result = await new AgentLoop({
    provider: officialDeepSeekProvider(async function* (request) {
      requests.push(structuredClone(request));
      yield { usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: turns.shift() };
    }),
    maxTurns: 6,
    model: 'deepseek-flash',
    pricing: priceTable(['deepseek-flash']),
    maxUsd: 1,
    tools: {
      execute: async (name) => (
        executed.push(name),
        name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'ok'
      ),
    },
  }).run({ task: 'implement x' });
  assert.equal(result.status, 'DONE');
  assert.deepEqual(executed, ['read_file', 'list_dir', 'read_file', 'write_file', 'finish']);
  assert.deepEqual(requests[2].tools, requests[0].tools);
  assert.equal(requests[2].tool_choice, 'required');
});

test('a capped official DeepSeek focus retains its required complete schema for only its existing continuation', async () => {
  const requests = [];
  let request = 0;
  const result = await new AgentLoop({
    provider: officialDeepSeekProvider(async function* (options) {
      requests.push(structuredClone(options));
      request++;
      if (request === 1)
        yield { usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [call('read_file', '{"path":"README.md"}', 'read')] };
      else if (request === 2)
        yield {
          reasoning: 'read reasoning exact',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolCalls: [call('list_dir', '{"path":"src"}', 'list')],
        };
      else if (request === 3)
        yield { text: 'partial source plan', providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
      else if (request === 4)
        yield {
          usage: { inputTokens: 0, outputTokens: 0 },
          toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
        };
      else yield { usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [call('finish', '{"summary":"done"}', 'done')] };
    }),
    maxTurns: 6,
    model: 'deepseek-flash',
    pricing: priceTable(['deepseek-flash']),
    maxUsd: 1,
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'ok') },
  }).run({ task: 'implement x' });
  assert.equal(result.status, 'DONE');
  assert.equal(requests.length, 5, 'only the existing capped-response continuation is added');
  for (const index of [2, 3]) {
    assert.deepEqual(requests[index].tools, requests[0].tools);
    assert.deepEqual(requests[index].thinking, { type: 'disabled' });
    assert.equal(requests[index].reasoning_effort, 'none');
    assert.equal(requests[index].tool_choice, 'required');
  }
  assert.deepEqual(
    requests[3].messages.slice(-2),
    [
      { role: 'assistant', content: 'partial source plan' },
      { role: 'user', content: 'Continue using a required allowed tool call. Read needed input, or make the next mutation.' },
    ],
    'the capped response is durable before its sole required-tool continuation',
  );
  assert.equal(
    requests[3].messages.find((message) => message.tool_calls?.[0]?.id === 'list').reasoning_content,
    'read reasoning exact',
    'the forced non-thinking turn preserves prior DeepSeek reasoning replay verbatim',
  );
  assert.ok(requests[4].tools.some((tool) => tool.function.name === 'finish'));
  assert.ok(!Object.hasOwn(requests[4], 'tool_choice'));
});

test('a long finite DeepSeek write job focuses after two reads and recovers one capped focused response', async () => {
  const requests = [];
  let request = 0;
  const result = await new AgentLoop({
    provider: officialDeepSeekProvider(async function* (options) {
      requests.push(structuredClone(options));
      request++;
      if (request === 1)
        yield { toolCalls: [call('read_file', '{"path":"README.md"}', 'read')], usage: { inputTokens: 0, outputTokens: 1 } };
      else if (request === 2)
        yield { toolCalls: [call('list_dir', '{"path":"acceptance"}', 'list')], usage: { inputTokens: 0, outputTokens: 1 } };
      else if (request === 3)
        yield {
          text: 'I will now write the implementation.',
          providerFinishReason: 'length',
          usage: { inputTokens: 0, outputTokens: 4_096 },
        };
      else if (request === 4)
        yield {
          toolCalls: [call('write_file', '{"path":"src/implementation.mjs","content":"export default 1;"}', 'write')],
          usage: { inputTokens: 0, outputTokens: 1 },
        };
      else yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], usage: { inputTokens: 0, outputTokens: 1 } };
    }),
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'ok') },
    model: 'deepseek-flash',
    pricing: priceTable(['deepseek-flash']),
    maxUsd: 1,
    maxTurns: 18,
  }).run({ task: 'implement x' });

  assert.equal(result.status, 'DONE');
  assert.equal(requests.length, 5);
  for (const index of [2, 3]) {
    assert.deepEqual(requests[index].tools, requests[0].tools);
    assert.equal(requests[index].tool_choice, 'required');
    assert.deepEqual(requests[index].thinking, { type: 'disabled' });
    assert.equal(requests[index].reasoning_effort, 'none');
  }
  assert.ok(
    requests[2].messages.at(-1).content.startsWith('Implementation checkpoint: 16 model turns remain.'),
    'the required-tool focus is scheduled immediately after the second completed non-write transaction',
  );
  assert.equal(
    requests[3].messages.at(-1).content,
    'Continue using a required allowed tool call. Read needed input, or make the next mutation.',
    'the capped focused response receives one required-tool continuation',
  );
  assert.ok(requests[4].tools.some((tool) => tool.function.name === 'finish'));
  assert.ok(!Object.hasOwn(requests[4], 'tool_choice'), 'after the direct write, normal completion selection is restored');
});

test('a long finite generic-provider write job retains the gradual checkpoint cadence', async () => {
  const requests = [];
  const turns = [
    [call('read_file', '{"path":"README.md"}', 'read-1')],
    [call('list_dir', '{"path":"src"}', 'list-1')],
    [call('read_file', '{"path":"package.json"}', 'read-2')],
    [call('list_dir', '{"path":"test"}', 'list-2')],
    [call('write_file', '{"path":"src/implementation.mjs","content":"export default 1;"}', 'write')],
    [call('finish', '{"summary":"done"}', 'finish')],
  ];
  const result = await new AgentLoop({
    provider: {
      async *chat(options) {
        requests.push(structuredClone(options));
        yield { toolCalls: turns.shift(), usage: { inputTokens: 0, outputTokens: 1 } };
      },
    },
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'ok') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 18,
  }).run({ task: 'implement x' });

  assert.equal(result.status, 'DONE');
  for (const index of [1, 2, 3])
    assert.ok(
      requests[index].tools.some((tool) => tool.function.name === 'read_file'),
      'generic route remains unrestricted before turn four',
    );
  assert.ok(
    requests[4].messages.at(-1).content.startsWith('Implementation checkpoint: 14 model turns remain.'),
    'the generic finite route reaches its advisory checkpoint only after four non-write transactions',
  );
});

test('a successful direct write suppresses the implementation checkpoint for the active loop', async () => {
  const turns = [
    [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
    [call('read_file', '{"path":"src/a.mjs"}', 'read-1')],
    [call('list_dir', '{"path":"src"}', 'list-1')],
    [call('finish', '{"summary":"done"}', 'done')],
  ];
  const requests = [];
  const progress = [];
  const result = await new AgentLoop({
    provider: {
      async *chat({ messages }) {
        requests.push(structuredClone(messages));
        yield { toolCalls: turns.shift() };
      },
    },
    maxTurns: 6,
    progress: async (event) => progress.push(event),
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'ok') },
  }).run({ task: 'implement x' });
  assert.equal(result.status, 'DONE');
  assert.ok(requests.every((messages) => !messages.some((message) => message.content?.startsWith('Implementation checkpoint:'))));
  assert.ok(!progress.some((event) => event.action === 'implementation_checkpoint'));
});

test('a configured server verifier gives one post-write completion checkpoint instead of letting a write job keep exploring', async () => {
  const turns = [
    [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
    [call('list_dir', '{"path":"src"}', 'last-essential-check')],
    [call('finish', '{"summary":"done"}', 'done')],
  ];
  const requests = [];
  const progress = [];
  const result = await new AgentLoop({
    provider: {
      async *chat({ messages, tools }) {
        requests.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
        yield { toolCalls: turns.shift() };
      },
    },
    maxTurns: 4,
    serverVerifierConfigured: true,
    progress: async (event) => progress.push(event),
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'ok') },
  }).run({ task: 'implement x' });

  assert.equal(result.status, 'DONE');
  assert.equal(
    requests[1].messages.at(-1).content,
    'Completion checkpoint: 3 model turns remain. A focused server verifier will run after finish. Do not continue exploring or rerun the verifier. If the required in-scope changes are complete, call finish now as the sole tool call. Use another tool only for an essential remaining edit or diagnosis.',
  );
  assert.ok(
    requests[1].tools.some((tool) => tool.function.name === 'finish'),
    'the checkpoint never removes a necessary finish call',
  );
  assert.equal(progress.filter((event) => event.action === 'verifier_completion_checkpoint').length, 1);
  assert.ok(
    !progress.some((event) => event.action === 'implementation_checkpoint'),
    'a successful write still suppresses the discovery checkpoint',
  );
});

test('implementation checkpoint requires write capability and at least four turns', async () => {
  const run = async ({ maxTurns, toolDefinitions }) => {
    const turns = [
      [call('read_file', '{"path":"x"}', 'read-1')],
      [call('list_dir', '{}', 'list-1')],
      [call('finish', '{"summary":"done"}', 'done')],
    ];
    const progress = [];
    const result = await new AgentLoop({
      provider: providerFor(turns),
      tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'ok') },
      maxTurns,
      toolDefinitions,
      progress: async (event) => progress.push(event),
    }).run({ task: 'inspect x' });
    assert.equal(result.status, 'DONE');
    assert.ok(!progress.some((event) => event.action === 'implementation_checkpoint'));
  };
  await run({ maxTurns: 6, toolDefinitions: availableToolDefinitions({ readOnly: true }) });
  await run({ maxTurns: 3, toolDefinitions: availableToolDefinitions() });
});

test('implementation focus rejects a genuinely unadvertised tool without persisting provider-controlled metadata', async () => {
  const maliciousName = 'unexpected_TOOL_NAME_DO_NOT_PERSIST';
  const maliciousArguments = '{"token":"UNTRUSTED_TOOL_ARGUMENT_DO_NOT_PERSIST"}';
  const turns = [
    [call('read_file', '{"path":"README.md"}', 'read')],
    [call('list_dir', '{"path":"src"}', 'list')],
    [call(maliciousName, maliciousArguments, 'forbidden')],
    [call(maliciousName, maliciousArguments, 'forbidden-again')],
  ];
  const executed = [];
  const progress = [];
  const context = new AgentContext();
  const result = await new AgentLoop({
    provider: {
      async *chat() {
        yield { usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: turns.shift() };
      },
    },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 5,
    context,
    progress: async (event) => progress.push(event),
    tools: { execute: async (name) => (executed.push(name), 'ok') },
  }).run({ task: 'implement x' });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error, 'Provider requested an unadvertised tool');
  assert.equal(result.failureKind, undefined);
  assert.deepEqual(executed, ['read_file', 'list_dir']);
  assert.ok(progress.some((event) => event.action === 'implementation_focus'));
  assert.ok(progress.some((event) => event.action === 'provider_unadvertised_tool_recover:unknown'));
  assert.ok(progress.some((event) => event.action === 'provider_unadvertised_tool:unknown'));
  const durable = JSON.stringify({ result, progress, transcript: context.snapshot() });
  assert.doesNotMatch(durable, /TOOL_NAME_DO_NOT_PERSIST|TOOL_ARGUMENT_DO_NOT_PERSIST/);
});

test('one unadvertised tool response gets a single execute-nothing correction with a trusted near-miss hint', async () => {
  const turns = [
    [call('functions.Write_File', '{"path":"src/a.mjs","content":"SECRET_BODY_DO_NOT_PERSIST"}', 'wrapped')],
    [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
    [call('finish', '{"summary":"ok","concerns":[],"testsRun":[]}', 'finish')],
  ];
  const executed = [];
  const progress = [];
  const context = new AgentContext();
  const result = await new AgentLoop({
    provider: {
      async *chat() {
        yield { usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: turns.shift() };
      },
    },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 5,
    context,
    progress: async (event) => progress.push(event),
    tools: {
      execute: async (name) => (executed.push(name), name === 'finish' ? { finish: { summary: 'ok', concerns: [], testsRun: [] } } : 'ok'),
    },
  }).run({ task: 'implement x' });
  assert.equal(result.status, 'DONE');
  assert.deepEqual(executed, ['write_file', 'finish']);
  assert.ok(progress.some((event) => event.action === 'provider_unadvertised_tool_recover:near_miss:write_file'));
  const durable = JSON.stringify({ progress, transcript: context.snapshot() });
  assert.doesNotMatch(durable, /Write_File|SECRET_BODY_DO_NOT_PERSIST/);
  assert.match(durable, /not available and was not run/);
});

test('unlimited and read-only jobs never activate implementation focus', async () => {
  const run = async ({ toolDefinitions }) => {
    const progress = [];
    const result = await new AgentLoop({
      provider: providerFor([
        [call('read_file', '{"path":"x"}', 'one')],
        [call('list_dir', '{}', 'two')],
        [call('read_file', '{"path":"x"}', 'three')],
        [call('finish', '{"summary":"done"}', 'done')],
      ]),
      toolDefinitions,
      maxTurns: 6,
      progress: async (event) => progress.push(event),
      tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'ok') },
    }).run({ task: 'x' });
    assert.equal(result.status, 'DONE');
    assert.ok(!progress.some((event) => event.action === 'implementation_focus'));
  };
  await run({ toolDefinitions: availableToolDefinitions() });
  await run({ toolDefinitions: availableToolDefinitions({ readOnly: true }) });
});

test('a failed direct write still counts as no successful mutation for the implementation checkpoint', async () => {
  const turns = [
    [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
    [call('read_file', '{"path":"src/a.mjs"}', 'read')],
    [call('finish', '{"summary":"done"}', 'done')],
  ];
  const progress = [];
  const result = await new AgentLoop({
    provider: providerFor(turns),
    maxTurns: 6,
    progress: async (event) => progress.push(event),
    tools: {
      execute: async (name) => {
        if (name === 'write_file') throw new Error('write failed');
        return name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'read result';
      },
    },
  }).run({ task: 'implement x' });
  assert.equal(result.status, 'DONE');
  assert.equal(progress.filter((event) => event.action === 'implementation_checkpoint').length, 1);
});

test('checkpoint persistence failure prevents the next provider request', async () => {
  const turns = [[call('read_file', '{"path":"x"}', 'read')], [call('list_dir', '{}', 'list')]];
  let providerCalls = 0;
  const context = new AgentContext([], {
    onAppend: async (message) => {
      if (message.content.startsWith('Implementation checkpoint:')) throw new Error('checkpoint disk full');
    },
  });
  const loop = new AgentLoop({
    provider: {
      async *chat() {
        providerCalls++;
        yield { toolCalls: turns.shift() };
      },
    },
    context,
    maxTurns: 6,
    tools: { execute: async () => 'ok' },
  });
  await assert.rejects(() => loop.run({ task: 'implement x' }), /checkpoint disk full/);
  assert.equal(providerCalls, 2, 'the failed durable checkpoint must prevent the third paid request');
  assert.ok(!context.snapshot().some((message) => message.content?.startsWith('Implementation checkpoint:')));
});

test('loop rejects tool schemas it cannot execute or finish without', () => {
  const provider = { async *chat() {} },
    tools = { execute: async () => '' };
  assert.throws(() => new AgentLoop({ provider, tools, toolDefinitions: [] }), /containing finish/);
  assert.throws(
    () => new AgentLoop({ provider, tools, toolDefinitions: [{ function: { name: 'constructor' } }, { function: { name: 'finish' } }] }),
    /executable subset/,
  );
});

test('finite budgets reserve a pessimistic prompt cost without reducing ordinary provider output', async () => {
  const expensive = {
    models: {
      m: {
        usd_per_1m: {
          input_cache_hit: { off_peak: 1000, peak: 1000 },
          input_cache_miss: { off_peak: 1000, peak: 1000 },
          output: { off_peak: 1000, peak: 1000 },
        },
      },
    },
  };
  let calls = 0;
  const noCall = {
    async *chat() {
      calls++;
      yield { usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [call('finish', '{"summary":"unexpected"}')] };
    },
  };
  const tools = { execute: async () => ({ finish: { summary: 'ok', concerns: [], testsRun: [] } }) };
  const blocked = await new AgentLoop({
    provider: noCall,
    tools,
    model: 'm',
    pricing: expensive,
    maxUsd: 0.01,
    toolDefinitions: availableToolDefinitions({ allowCommand: false }),
  }).run({ task: 'x' });
  assert.equal(blocked.status, 'BUDGET');
  assert.equal(calls, 0);
  let maxTokens;
  const bounded = {
    async *chat(options) {
      maxTokens = options.max_tokens;
      yield { usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [call('finish', '{"summary":"ok"}')] };
    },
  };
  const result = await new AgentLoop({
    provider: bounded,
    tools,
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    toolDefinitions: availableToolDefinitions({ allowCommand: false }),
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.equal(maxTokens, 16_384, 'ordinary finite requests retain their full affordable output allocation');

  let reportLikeMaxTokens;
  const reportLike = await new AgentLoop({
    provider: {
      async *chat(options) {
        reportLikeMaxTokens = options.max_tokens;
        yield { usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [call('finish', '{"summary":"ok"}', 'finish')] };
      },
    },
    tools,
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    toolDefinitions: availableToolDefinitions({ readOnly: true }),
  }).run({ task: 'report x' });
  assert.equal(reportLike.status, 'DONE');
  assert.equal(reportLikeMaxTokens, 16_384, 'read-only/report-like finite requests also retain their full affordable output allocation');
});

test('finite budgets elide only old provider tool results when the raw reservation cannot fit', async () => {
  const context = new AgentContext(toolTranscript({ results: 10 }));
  const original = context.snapshot();
  const variants = [...context.providerBudgetElisionSnapshots()];
  assert.equal(
    variants.length,
    1,
    'only the ninth-oldest older result is eligible when eight older results and the current transaction are protected',
  );
  assert.match(variants[0].messages[1].content, /^\[tool output elided: 70000 chars;/);
  assert.equal(variants[0].messages[1].elided, undefined, 'the provider projection changes only content, not durable metadata');
  for (let index = 1; index < 10; index++) {
    const toolIndex = index * 2 + 1;
    assert.equal(variants[0].messages[toolIndex].content, `result-${index}`, 'the newest eight results stay intact');
    assert.deepEqual(variants[0].messages[toolIndex - 1], original[toolIndex - 1], 'assistant reasoning and calls stay intact');
  }
  assert.deepEqual(context.snapshot(), original, 'deriving provider candidates cannot mutate the durable context');
  assert.deepEqual(
    [...new AgentContext(original).providerBudgetElisionSnapshots()],
    variants,
    'a fresh durable transcript deterministically derives the same provider projection',
  );

  const budget = 0.02;
  assert.ok(
    conservativeRequestUsd(original, availableToolDefinitions({ allowCommand: true }), 16) > budget,
    'the raw request cannot fund a minimum response',
  );
  let request;
  const progress = [];
  const provider = {
    async *chat(options) {
      request = structuredClone(options);
      yield { usage: { inputTokens: 0, outputTokens: 1 }, toolCalls: [call('finish', '{"summary":"done"}', 'done')] };
    },
  };
  const result = await new AgentLoop({
    provider,
    context,
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: budget,
    progress: async (event) => progress.push(event),
  }).run({ task: 'finish the task' });
  assert.equal(result.status, 'DONE');
  assert.match(request.messages[1].content, /^\[tool output elided: 70000 chars;/);
  assert.equal(context.snapshot()[1].content, 'x'.repeat(70_000), 'the provider-only projection is never persisted');
  assert.ok(progress.some((event) => event.action === 'provider_context_budget_elided'));
  assert.ok(
    conservativeRequestUsd(request.messages, request.tools, request.max_tokens) <= budget,
    'the submitted payload plus requested output stays inside the hard reservation cap',
  );
});

test('provider budget elision honors the context configured recent-tool retention', () => {
  const context = new AgentContext(toolTranscript({ results: 5 }), { keepRecentToolResults: 2 });
  const variants = [...context.providerBudgetElisionSnapshots()];
  assert.equal(variants.length, 2);
  assert.match(variants[0].messages[1].content, /^\[tool output elided: 70000 chars;/);
  assert.equal(variants[0].messages[3].content, 'result-1', 'the second eligible result is elided only in the next projection');
  assert.match(variants[1].messages[3].content, /^\[tool output elided: 8 chars;/);
  for (const index of [2, 3, 4]) assert.equal(variants[1].messages[index * 2 + 1].content, `result-${index}`);
});

test('tier-one provider elision never splits a newest transaction larger than configured retention', () => {
  const calls = Array.from({ length: 9 }, (_, index) => ({
    id: `current-${index}`,
    type: 'function',
    function: { name: 'read_file', arguments: '{}' },
  }));
  const context = new AgentContext([
    { role: 'assistant', content: '', reasoning_content: 'current batch', tool_calls: calls },
    ...calls.map((entry, index) => ({ role: 'tool', tool_call_id: entry.id, name: 'read_file', content: `current-${index}` })),
  ]);
  assert.equal(
    [...context.providerBudgetElisionSnapshots()].length,
    0,
    'all nine current results remain protected despite the default retention of eight',
  );
});

test('durable default-context elision never splits an oversized newest multi-result transaction', () => {
  const calls = Array.from({ length: 9 }, (_, index) => ({
    id: `current-large-${index}`,
    type: 'function',
    function: { name: 'read_file', arguments: '{}' },
  }));
  const context = new AgentContext([
    { role: 'assistant', content: '', reasoning_content: 'current large batch', tool_calls: calls },
    ...calls.map((entry) => ({ role: 'tool', tool_call_id: entry.id, name: 'read_file', content: 'x'.repeat(20_000) })),
  ]);
  const snapshot = context.snapshot();
  for (const message of snapshot.slice(1)) {
    assert.equal(message.content.length, 20_000);
    assert.equal(message.elided, undefined);
  }
  assert.equal([...context.providerBudgetElisionSnapshots()].length, 0, 'provider projections retain every oversized current result too');
});

test('keepRecentToolResults zero still sends the newest complete multi-result transaction intact', async () => {
  const source = multiResultBudgetTranscript();
  const context = new AgentContext(source, { keepRecentToolResults: 0 });
  const original = context.snapshot();
  const variants = [...context.providerBudgetElisionSnapshots()];
  assert.equal(variants.length, 8, 'only the eight older results may be tier-one candidates');
  assert.deepEqual(
    variants.at(-1).messages.slice(-3),
    original.slice(-3),
    'the safe final tier-one projection retains every current result',
  );
  const definitions = availableToolDefinitions({ allowCommand: true });
  const beforeLargeOldResult = conservativeRequestUsd(variants[1].messages, definitions, 16);
  const fullyElidedOlderResults = conservativeRequestUsd(variants.at(-1).messages, definitions, 16);
  assert.ok(beforeLargeOldResult > fullyElidedOlderResults);
  const budget = (beforeLargeOldResult + fullyElidedOlderResults) / 2;
  assert.ok(conservativeRequestUsd(original, definitions, 16) > budget, 'the raw request cannot fit');
  const expected = variants.find((candidate) => conservativeRequestUsd(candidate.messages, definitions, 16) <= budget);
  let request;
  const result = await new AgentLoop({
    provider: {
      async *chat(options) {
        request = structuredClone(options);
        yield { usage: { inputTokens: 0, outputTokens: 1 }, toolCalls: [call('finish', '{"summary":"done"}', 'done')] };
      },
    },
    context,
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: budget,
  }).run();
  assert.equal(result.status, 'DONE');
  assert.deepEqual(request.messages, expected.messages, 'the loop selects the first safe affordable tier-one projection');
  assert.deepEqual(request.messages.slice(-3), original.slice(-3), 'the provider never receives an elided current transaction result');
});

test('finite budgets progressively elide older provider results only after tier one fails, retaining the latest multi-result transaction', async () => {
  const source = multiResultBudgetTranscript();
  const context = new AgentContext(source);
  const original = context.snapshot();
  const tierOne = [...context.providerBudgetElisionSnapshots()];
  const deep = [...context.providerBudgetDeepElisionSnapshots()];
  assert.equal(tierOne.length, 0, 'the configured retention keeps all eight older results as well as the latest multi-result transaction');
  assert.equal(deep.length, 8, 'deep fallback progressively relaxes only the eight older results');
  assert.match(deep[2].messages[5].content, /^\[tool output elided: 24024 chars;/, 'deep fallback next elides that old large result');
  assert.deepEqual(
    deep[2].messages.slice(-3),
    original.slice(-3),
    'every result of the newest complete multi-call transaction remains raw',
  );
  const zeroRetention = new AgentContext(source, { keepRecentToolResults: 0 });
  const tierOneWithNoOrdinaryRetention = [...zeroRetention.providerBudgetElisionSnapshots()];
  const deepWithNoOrdinaryRetention = [...zeroRetention.providerBudgetDeepElisionSnapshots()];
  assert.equal(tierOneWithNoOrdinaryRetention.length, 8, 'tier one may elide every old result but not the current transaction');
  assert.equal(deepWithNoOrdinaryRetention.length, 0, 'deep fallback skips the tier-one projection it already knows was tried');
  assert.deepEqual(
    tierOneWithNoOrdinaryRetention.at(-1).messages.slice(-3),
    original.slice(-3),
    'the keep-zero safe base still retains every newest-transaction result',
  );
  assert.deepEqual(
    deep[0].messages.filter((message) => message.role === 'assistant'),
    original.filter((message) => message.role === 'assistant'),
    'assistant content, reasoning, calls, IDs, and ordering are unchanged',
  );
  assert.deepEqual(context.snapshot(), original, 'provider projections never mutate the durable context');

  const definitions = availableToolDefinitions({ allowCommand: true });
  const tierOneMinimum = conservativeRequestUsd(source, definitions, 16);
  const preSuccessMinimum = conservativeRequestUsd(deep[1].messages, definitions, 16);
  const deepMinimum = conservativeRequestUsd(deep[2].messages, definitions, 16);
  assert.ok(tierOneMinimum > preSuccessMinimum && preSuccessMinimum > deepMinimum);
  const budget = (preSuccessMinimum + deepMinimum) / 2;
  let request;
  const progress = [];
  const result = await new AgentLoop({
    provider: {
      async *chat(options) {
        request = structuredClone(options);
        yield { usage: { inputTokens: 0, outputTokens: 1 }, toolCalls: [call('finish', '{"summary":"done"}', 'done')] };
      },
    },
    context,
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: budget,
    progress: async (event) => progress.push(event),
  }).run();
  assert.equal(result.status, 'DONE');
  assert.deepEqual(request.messages, deep[2].messages, 'the first affordable deep projection is the only provider payload');
  assert.deepEqual(context.snapshot().slice(0, original.length), original, 'the raw transcript remains replayable after the provider call');
  assert.equal(progress.filter((event) => event.action === 'provider_context_budget_elided').length, 1);
});

test('finite budgets make no provider call when even deep provider-only elision cannot fund a minimum response', async () => {
  const context = new AgentContext(multiResultBudgetTranscript());
  const deep = [...context.providerBudgetDeepElisionSnapshots()];
  const definitions = availableToolDefinitions({ allowCommand: true });
  const budget = Math.min(...deep.map((candidate) => conservativeRequestUsd(candidate.messages, definitions, 16))) - 0.000001;
  let providerCalls = 0;
  const result = await new AgentLoop({
    provider: {
      async *chat() {
        providerCalls++;
        yield { toolCalls: [call('finish', '{"summary":"unexpected"}')] };
      },
    },
    context,
    tools: { execute: async () => assert.fail('tool execution is not allowed') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: budget,
  }).run();
  assert.equal(result.status, 'BUDGET');
  assert.equal(providerCalls, 0);
});

test('finite reservation exhaustion exposes only the cheapest numeric projection and makes no provider call', async () => {
  const context = new AgentContext(toolTranscript({ results: 10 }), { keepRecentToolResults: 0 });
  const definitions = availableToolDefinitions({ allowCommand: true });
  const candidates = [
    { messages: context.snapshot(), projection: 'raw', elidedToolResults: 0 },
    ...[...context.providerBudgetElisionSnapshots()].map((candidate) => ({ ...candidate, projection: 'tool-elision' })),
    ...[...context.providerBudgetDeepElisionSnapshots()].map((candidate) => ({ ...candidate, projection: 'deep-tool-elision' })),
  ];
  const required = candidates.map((candidate) => conservativeRequestUsd(candidate.messages, definitions, 16));
  const budget = Math.min(...required) - 0.000001;
  const progress = [];
  let providerCalls = 0;
  const result = await new AgentLoop({
    provider: {
      async *chat() {
        providerCalls++;
      },
    },
    context,
    tools: { execute: async () => assert.fail('no tool may execute') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: budget,
    progress: async (event) => progress.push(event),
  }).run();
  assert.equal(result.status, 'BUDGET');
  assert.equal(providerCalls, 0);
  assert.deepEqual(
    progress.filter((event) => event.action === 'budget_reservation_exhausted').map((event) => event.budgetReservation),
    [result.budgetReservation],
  );
  assert.equal(result.budgetCap, 'reservation');
  assert.equal(result.budgetReservation.minOutputTokens, 16);
  assert.ok(Math.abs(result.budgetReservation.requiredUsd - Math.min(...required)) < 1e-12);
  assert.ok(Math.abs(result.budgetReservation.shortfallUsd - 0.000001) < 1e-12);
  assert.ok(['raw', 'tool-elision', 'deep-tool-elision'].includes(result.budgetReservation.projection));
  assert.equal(typeof result.budgetReservation.conservativeInputTokens, 'number');
});

test('legacy custom contexts remain usable without optional budget-elision helpers', async () => {
  const legacyContext = (backing) =>
    Object.fromEntries(
      ['add', 'addBatch', 'addToolResult', 'snapshot', 'flush', 'preflightAppend'].map((method) => [method, backing[method].bind(backing)]),
    );
  const unlimitedBacking = new AgentContext();
  let unlimitedCalls = 0;
  const unlimited = await new AgentLoop({
    provider: {
      async *chat() {
        unlimitedCalls++;
        yield { toolCalls: [call('finish', '{"summary":"done"}', 'done')] };
      },
    },
    context: legacyContext(unlimitedBacking),
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
  }).run({ task: 'x' });
  assert.equal(unlimited.status, 'DONE');
  assert.equal(unlimitedCalls, 1, 'unlimited-budget callers need no optional projection helpers');

  const finiteBacking = new AgentContext(toolTranscript({ results: 1 }));
  let finiteCalls = 0;
  const finite = await new AgentLoop({
    provider: {
      async *chat() {
        finiteCalls++;
        yield { toolCalls: [call('finish', '{"summary":"unexpected"}')] };
      },
    },
    context: legacyContext(finiteBacking),
    tools: { execute: async () => assert.fail('no tool may execute') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 0.01,
  }).run();
  assert.equal(finite.status, 'BUDGET');
  assert.equal(finiteCalls, 0, 'a finite legacy context safely keeps BUDGET when raw reservation cannot fit');
});

test('finite budgets keep an eligible old tool result raw when its full reservation fits', async () => {
  const context = new AgentContext(toolTranscript());
  let request, expected;
  const progress = [];
  const result = await new AgentLoop({
    provider: {
      async *chat(options) {
        expected = context.snapshot();
        request = structuredClone(options);
        yield { usage: { inputTokens: 0, outputTokens: 1 }, toolCalls: [call('finish', '{"summary":"done"}', 'done')] };
      },
    },
    context,
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 0.1,
    progress: async (event) => progress.push(event),
  }).run({ task: 'finish the task' });
  assert.equal(result.status, 'DONE');
  assert.deepEqual(request.messages, expected, 'a fitting raw transcript is sent unchanged');
  assert.equal(request.messages[1].content, 'x'.repeat(70_000));
  assert.ok(!progress.some((event) => event.action === 'provider_context_budget_elided'));
});

test('finite budgets retain BUDGET without a provider call when one newest complete multi-result transaction contains all huge results', async () => {
  const calls = Array.from({ length: 8 }, (_, index) => ({
    id: `protected-${index}`,
    type: 'function',
    function: { name: 'read_file', arguments: '{}' },
  }));
  const context = new AgentContext([
    { role: 'assistant', content: '', reasoning_content: 'keep all latest results', tool_calls: calls },
    ...calls.map((entry) => ({ role: 'tool', tool_call_id: entry.id, name: 'read_file', content: 'x'.repeat(70_000) })),
  ]);
  let providerCalls = 0;
  let toolCalls = 0;
  const progress = [];
  const result = await new AgentLoop({
    provider: {
      async *chat() {
        providerCalls++;
        yield { toolCalls: [call('finish', '{"summary":"unexpected"}')] };
      },
    },
    context,
    tools: {
      execute: async () => {
        toolCalls++;
        return { finish: { summary: 'unexpected', concerns: [], testsRun: [] } };
      },
    },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 0.02,
    progress: async (event) => progress.push(event),
  }).run({ task: 'x' });
  assert.equal(result.status, 'BUDGET');
  assert.equal(providerCalls, 0);
  assert.equal(toolCalls, 0);
  assert.equal([...context.providerBudgetElisionSnapshots()].length, 0);
  assert.equal([...context.providerBudgetDeepElisionSnapshots()].length, 0);
  assert.ok(!progress.some((event) => event.action === 'provider_context_budget_elided'));
});

test('a single capped reasoning-only response continues durably to an allowed finish', async () => {
  const requests = [];
  let calls = 0;
  const provider = {
    async *chat(options) {
      requests.push(structuredClone(options.messages));
      calls++;
      if (calls === 1) {
        assert.equal(options.max_tokens, 16_384);
        yield {
          reasoning: 'complete the implementation with tools',
          providerFinishReason: 'length',
          usage: { inputTokens: 0, outputTokens: 4_096 },
        };
      } else yield { usage: { inputTokens: 0, outputTokens: 1 }, toolCalls: [call('finish', '{"summary":"done"}', 'done')] };
    },
  };
  const progress = [];
  const durableBatches = [];
  const context = new AgentContext([], { onAppendBatch: async (messages) => durableBatches.push(structuredClone(messages)) });
  const result = await new AgentLoop({
    provider,
    context,
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 2,
    progress: async (event) => progress.push(event),
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.equal(calls, 2);
  assert.deepEqual(requests[1].slice(-2), [
    { role: 'assistant', content: '', reasoning_content: 'complete the implementation with tools' },
    { role: 'user', content: 'Continue using an allowed tool call. When complete, call finish as the sole tool call.' },
  ]);
  assert.deepEqual(durableBatches[1], requests[1].slice(-2), 'the reasoning and reminder share one durable batch');
  assert.ok(progress.some((event) => event.action === 'provider_output_capped_continue'));
});

test('a provider-length-capped planning response continues once to source writes and finish', async () => {
  const requests = [];
  const durableBatches = [];
  let calls = 0;
  const context = new AgentContext([], { onAppendBatch: async (messages) => durableBatches.push(structuredClone(messages)) });
  const result = await new AgentLoop({
    provider: {
      async *chat(options) {
        requests.push(structuredClone(options));
        calls++;
        if (calls === 1)
          yield {
            text: 'I will now implement the requested source files after checking the contract.',
            providerFinishReason: 'length',
            usage: { inputTokens: 0, outputTokens: 4_096 },
          };
        else if (calls === 2)
          yield {
            usage: { inputTokens: 0, outputTokens: 1 },
            toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"export default 1;"}', 'write')],
          };
        else yield { usage: { inputTokens: 0, outputTokens: 1 }, toolCalls: [call('finish', '{"summary":"done"}', 'done')] };
      },
    },
    context,
    tools: {
      execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'written'),
    },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
  }).run({ task: 'implement x' });

  assert.equal(result.status, 'DONE');
  assert.equal(calls, 3);
  assert.ok(
    requests[1].tools.some((tool) => tool.function.name === 'write_file'),
    'ordinary continuation retains write capability',
  );
  assert.deepEqual(requests[1].messages.slice(-2), [
    { role: 'assistant', content: 'I will now implement the requested source files after checking the contract.' },
    { role: 'user', content: 'Continue using an allowed tool call. When complete, call finish as the sole tool call.' },
  ]);
  assert.deepEqual(
    durableBatches[1],
    requests[1].messages.slice(-2),
    'the capped text and reminder are durably appended before the next request',
  );
});

test('a capped continuation gets one durable missing-tool recovery before an allowed finish', async () => {
  const requests = [];
  let requestsMade = 0;
  const progress = [];
  const durableBatches = [];
  const context = new AgentContext([], { onAppendBatch: async (messages) => durableBatches.push(structuredClone(messages)) });
  const result = await new AgentLoop({
    provider: {
      async *chat(options) {
        requests.push(structuredClone(options.messages));
        requestsMade++;
        if (requestsMade === 1)
          yield { reasoning: 'plan the implementation', providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
        else if (requestsMade === 2)
          yield { text: 'I am ready to act.', reasoning: 'use a tool now', usage: { inputTokens: 0, outputTokens: 7 } };
        else yield { usage: { inputTokens: 0, outputTokens: 1 }, toolCalls: [call('finish', '{"summary":"done"}', 'done')] };
      },
    },
    context,
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
    progress: async (event) => progress.push(event),
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  assert.equal(requestsMade, 3);
  const cappedReminder = 'Continue using an allowed tool call. When complete, call finish as the sole tool call.';
  const recoveryReminder =
    'Do not reply with prose only. Invoke one or more allowed non-finish tools to continue, or call finish as the sole tool call if complete.';
  assert.deepEqual(requests[1].slice(-2), [
    { role: 'assistant', content: '', reasoning_content: 'plan the implementation' },
    { role: 'user', content: cappedReminder },
  ]);
  assert.deepEqual(requests[2].slice(-4), [
    { role: 'assistant', content: '', reasoning_content: 'plan the implementation' },
    { role: 'user', content: cappedReminder },
    { role: 'assistant', content: 'I am ready to act.', reasoning_content: 'use a tool now' },
    { role: 'user', content: recoveryReminder },
  ]);
  assert.deepEqual(durableBatches[1], requests[1].slice(-2));
  assert.deepEqual(durableBatches[2], requests[2].slice(-2));
  assert.deepEqual(
    progress
      .filter((event) => ['provider_output_capped_continue', 'provider_missing_tool_recover'].includes(event.action))
      .map((event) => event.action),
    ['provider_output_capped_continue', 'provider_missing_tool_recover'],
  );
});

test('a production-shaped reasoning-only continuation is persisted before it enables missing-tool recovery', async () => {
  const requests = [];
  const durableBatches = [];
  let requestsMade = 0;
  const responses = [
    { reasoning: 'plan the implementation', providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } },
    { reasoning: 'the next response must use a tool', usage: { inputTokens: 0, outputTokens: 7 } },
    { usage: { inputTokens: 0, outputTokens: 1 }, toolCalls: [call('finish', '{"summary":"done"}', 'done')] },
  ];
  const context = new AgentContext([], {
    onAppendBatch: async (messages) => durableBatches.push(structuredClone(messages)),
  });
  const result = await new AgentLoop({
    provider: {
      async *chat(options) {
        requests.push(structuredClone(options.messages));
        yield responses[requestsMade++];
      },
    },
    context,
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
  }).run({ task: 'x' });

  assert.equal(result.status, 'DONE');
  assert.equal(requestsMade, 3);
  const cappedReminder = 'Continue using an allowed tool call. When complete, call finish as the sole tool call.';
  const recoveryReminder =
    'Do not reply with prose only. Invoke one or more allowed non-finish tools to continue, or call finish as the sole tool call if complete.';
  assert.deepEqual(requests[2].slice(-4), [
    { role: 'assistant', content: '', reasoning_content: 'plan the implementation' },
    { role: 'user', content: cappedReminder },
    { role: 'assistant', content: '', reasoning_content: 'the next response must use a tool' },
    { role: 'user', content: recoveryReminder },
  ]);
  assert.deepEqual(durableBatches[2], requests[2].slice(-2), 'the no-text response and recovery reminder are atomic');
});

test('missing-tool recovery keeps ordinary provider settings without forcing a tool or changing thinking', async () => {
  const optionsByRequest = [];
  let requestsMade = 0;
  const result = await new AgentLoop({
    provider: {
      async *chat(options) {
        optionsByRequest.push(options);
        requestsMade++;
        if (requestsMade === 1) yield { reasoning: 'plan', providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
        else if (requestsMade === 2) yield { reasoning: 'use a tool next', usage: { inputTokens: 0, outputTokens: 1 } };
        else yield { usage: { inputTokens: 0, outputTokens: 1 }, toolCalls: [call('finish', '{"summary":"done"}', 'done')] };
      },
    },
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
  }).run({ task: 'x' });

  assert.equal(result.status, 'DONE');
  assert.equal(optionsByRequest.length, 3);
  for (const options of optionsByRequest) {
    assert.equal(options.model, 'm');
    assert.equal(options.max_tokens, 16_384);
    assert.equal(options.retryLimit, 0);
    assert.ok(Array.isArray(options.tools));
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!Object.hasOwn(options, 'tool_choice'));
    assert.ok(!Object.hasOwn(options, 'thinking'));
  }
  assert.strictEqual(optionsByRequest[2].tools, optionsByRequest[1].tools, 'recovery retains the advertised tool contract');
});

test('a recovery durability failure prevents a third provider request', async () => {
  let requestsMade = 0;
  let durableBatches = 0;
  const context = new AgentContext([], {
    onAppendBatch: async () => {
      durableBatches++;
      if (durableBatches === 3) throw new Error('recovery durability unavailable');
    },
  });
  const loop = new AgentLoop({
    provider: {
      async *chat() {
        requestsMade++;
        if (requestsMade === 1) yield { reasoning: 'plan', providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
        else yield { reasoning: 'use a tool next', usage: { inputTokens: 0, outputTokens: 1 } };
      },
    },
    context,
    tools: { execute: async () => assert.fail('no tool may execute') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
  });

  await assert.rejects(loop.run({ task: 'x' }), /recovery durability unavailable/);
  assert.equal(requestsMade, 2);
  assert.equal(context.snapshot().length, 3, 'the failed recovery batch is not visible to a later request');
});

test('a content-filter stop with no tool call is FAILED without a continuable kind', async () => {
  const result = await new AgentLoop({
    provider: {
      async *chat() {
        yield { text: 'I cannot help with that', providerFinishReason: 'content_filter', usage: { inputTokens: 0, outputTokens: 1 } };
      },
    },
    tools: { execute: async () => assert.fail('no tool may execute') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
  }).run({ task: 'x' });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.providerFinishReason, 'content_filter');
  assert.equal(result.failureKind, undefined, 're-sending the same conversation would hit the same filter');
});

test('a missing-tool recovery is one-shot and final turns do not receive it', async () => {
  const run = async ({ maxTurns = 3 } = {}) => {
    let requests = 0;
    const progress = [];
    const result = await new AgentLoop({
      provider: {
        async *chat() {
          requests++;
          if (requests === 1) yield { reasoning: 'plan', providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
          else yield { reasoning: 'still no tool', usage: { inputTokens: 0, outputTokens: 1 } };
        },
      },
      tools: { execute: async () => assert.fail('no tool may execute') },
      model: 'm',
      pricing: priceTable(['m']),
      maxUsd: 1,
      maxTurns,
      progress: async (event) => progress.push(event),
    }).run({ task: 'x' });
    return { result, requests, progress };
  };

  const once = await run();
  assert.equal(once.result.status, 'FAILED');
  assert.equal(once.result.error, 'Worker ended without mandatory finish call');
  assert.equal(once.result.failureKind, 'no-finish');
  assert.equal(once.requests, 3);
  assert.deepEqual(
    once.progress.filter((event) => event.action === 'provider_missing_tool_recover').map((event) => event.action),
    ['provider_missing_tool_recover'],
  );

  const finalTurn = await run({ maxTurns: 2 });
  assert.equal(finalTurn.result.status, 'FAILED');
  assert.equal(finalTurn.result.error, 'Worker ended without mandatory finish call');
  assert.equal(finalTurn.requests, 2, 'the final turn cannot create a recovery request');
  assert.ok(!finalTurn.progress.some((event) => event.action === 'provider_missing_tool_recover'));
});

test('an ordinary uncapped no-tool response still fails without recovery', async () => {
  let requests = 0;
  const progress = [];
  const result = await new AgentLoop({
    provider: {
      async *chat() {
        requests++;
        yield { text: 'plain answer', usage: { inputTokens: 0, outputTokens: 1 } };
      },
    },
    tools: { execute: async () => assert.fail('no tool may execute') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 2,
    progress: async (event) => progress.push(event),
  }).run({ task: 'x' });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error, 'Worker ended without mandatory finish call');
  assert.equal(requests, 1);
  assert.ok(!progress.some((event) => event.action === 'provider_missing_tool_recover'));
});

test('missing-tool recovery reuses normal budget and provider-failure boundaries', async () => {
  const pricing = {
    models: {
      m: {
        usd_per_1m: {
          input_cache_hit: { off_peak: 0, peak: 0 },
          input_cache_miss: { off_peak: 0, peak: 0 },
          output: { off_peak: 1, peak: 1 },
        },
      },
    },
  };
  let budgetCalls = 0;
  const budgetResult = await new AgentLoop({
    provider: {
      async *chat() {
        budgetCalls++;
        if (budgetCalls === 1) yield { reasoning: 'plan', providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
        else yield { reasoning: 'tool next', usage: { inputTokens: 0, outputTokens: 100 } };
      },
    },
    tools: { execute: async () => assert.fail('no tool may execute') },
    model: 'm',
    pricing,
    maxUsd: 0.0042,
    maxTurns: 3,
  }).run({ task: 'x' });
  assert.equal(budgetResult.status, 'BUDGET');
  assert.equal(budgetCalls, 2, 'the recovery turn is reserved before a third provider call');

  let failureCalls = 0;
  const failureResult = await new AgentLoop({
    provider: {
      async *chat() {
        failureCalls++;
        if (failureCalls === 1) yield { reasoning: 'plan', providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
        else if (failureCalls === 2) yield { reasoning: 'tool next', usage: { inputTokens: 0, outputTokens: 1 } };
        else throw new ProviderError('Chat request failed', { kind: 'http', status: 503, attempts: 1 });
      },
    },
    tools: { execute: async () => assert.fail('no tool may execute') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
  }).run({ task: 'x' });
  assert.equal(failureCalls, 3);
  assert.equal(failureResult.status, 'FAILED');
  assert.deepEqual(failureResult.providerFailure, { kind: 'http', attempts: 1, status: 503 });
});

test('capped reasoning continuation is one-shot and requires a conclusive provider length signal', async () => {
  const capped = async (count, { maxTurns = 3, outputTokens = 4_096, maxUsd = 1, providerFinishReason = 'length' } = {}) => {
    let calls = 0;
    const provider = {
      async *chat() {
        calls++;
        yield { reasoning: 'still planning', providerFinishReason, usage: { inputTokens: 0, outputTokens } };
      },
    };
    const result = await new AgentLoop({
      provider,
      tools: { execute: async () => assert.fail('no tool may execute') },
      model: 'm',
      pricing: priceTable(['m']),
      maxUsd,
      maxTurns,
    }).run({ task: 'x' });
    assert.equal(calls, count);
    return result;
  };

  const twice = await capped(2);
  assert.equal(twice.status, 'FAILED');
  assert.equal(twice.error, 'Worker exhausted output-cap recovery without an allowed tool call');
  assert.equal(twice.failureKind, 'output-cap');

  const absentReason = await capped(1, { providerFinishReason: 'stop' });
  assert.equal(absentReason.status, 'FAILED');
  assert.equal(absentReason.error, 'Worker ended without mandatory finish call');
  assert.equal(absentReason.failureKind, 'no-finish');

  const finalTurn = await capped(1, { maxTurns: 1 });
  assert.equal(finalTurn.status, 'FAILED');
  assert.equal(finalTurn.error, 'Worker ended without mandatory finish call');
});

test('a direct DeepSeek write followed by a capped response gets one durable full-schema implementation continuation', async () => {
  const requests = [];
  const progress = [];
  let requestCount = 0;
  const result = await new AgentLoop({
    provider: officialDeepSeekProvider(async function* (options) {
      requests.push(structuredClone(options));
      requestCount++;
      if (requestCount === 1)
        yield {
          toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"export default 1;"}', 'write')],
          usage: { inputTokens: 0, outputTokens: 1 },
        };
      else if (requestCount === 2)
        yield {
          text: 'I wrote the files but need to close out.',
          providerFinishReason: 'length',
          usage: { inputTokens: 0, outputTokens: 4_096 },
        };
      else if (requestCount === 3)
        yield {
          toolCalls: [call('write_file', '{"path":"src/b.mjs","content":"export default 2;"}', 'write-2')],
          usage: { inputTokens: 0, outputTokens: 1 },
        };
      else yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], usage: { inputTokens: 0, outputTokens: 1 } };
    }),
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'written') },
    model: 'deepseek-flash',
    pricing: priceTable(['deepseek-flash']),
    maxUsd: 1,
    maxTurns: 4,
    progress: async (event) => progress.push(event),
    persistCappedFinishRecovery: async (event) => progress.push(event),
  }).run({ task: 'implement x' });

  assert.equal(result.status, 'DONE');
  assert.equal(requestCount, 4);
  assert.ok(requests[2].tools.some((tool) => tool.function.name === 'write_file'));
  assert.ok(requests[2].tools.some((tool) => tool.function.name === 'run_command'));
  assert.ok(requests[2].tools.some((tool) => tool.function.name === 'finish'));
  assert.ok(!Object.hasOwn(requests[2], 'tool_choice'), 'post-write recovery must not force finish');
  assert.deepEqual(requests[2].thinking, { type: 'disabled' });
  assert.equal(requests[2].reasoning_effort, 'none');
  assert.ok(!Object.hasOwn(requests[1], 'tool_choice'), 'the sticky non-thinking replay is not itself a named choice');
  assert.deepEqual(requests[1].thinking, { type: 'disabled' });
  assert.ok(progress.some((event) => event.action === 'provider_capped_finish_recovery_queued'));
  assert.ok(progress.some((event) => event.action === 'provider_capped_finish_recover'));
  assert.ok(progress.some((event) => event.action === 'provider_capped_implementation_recovery_settled'));
});

test('a finish returned by the capped implementation continuation settles only after its durable tool result', async () => {
  const transitions = [];
  const ordering = [];
  let requests = 0;
  const context = new AgentContext([], {
    onAppendBatch: async (messages) => {
      if (messages.some((message) => message.content === 'Continue implementation using an allowed tool call.')) ordering.push('tail');
    },
    onAppend: async (message) => {
      if (message.role === 'tool' && message.name === 'finish') ordering.push('finish-result');
    },
  });
  const result = await new AgentLoop({
    provider: {
      async *chat() {
        requests++;
        if (requests === 1)
          yield {
            toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"export default 1;"}', 'write')],
            usage: { inputTokens: 0, outputTokens: 1 },
          };
        else if (requests === 2) yield { providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
        else yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], usage: { inputTokens: 0, outputTokens: 1 } };
      },
    },
    context,
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'written') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
    persistCappedFinishRecovery: async (event) => {
      transitions.push(event.cappedFinishRecovery);
      ordering.push(event.cappedFinishRecovery);
    },
  }).run({ task: 'implement x' });

  assert.equal(result.status, 'DONE');
  assert.equal(requests, 3);
  assert.deepEqual(transitions, ['queued', 'consumed', 'settled']);
  assert.deepEqual(ordering, ['queued', 'tail', 'consumed', 'finish-result', 'settled']);
});

test('a durable queued capped implementation recovery resumes once with the full tool schema', async () => {
  const transcript = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/a.mjs","content":"x"}' } }],
    },
    { role: 'tool', tool_call_id: 'write', name: 'write_file', content: 'written' },
    { role: 'assistant', content: 'partial final answer' },
    { role: 'user', content: 'Continue implementation using an allowed tool call.' },
  ];
  const requests = [];
  const done = await new AgentLoop({
    provider: officialDeepSeekProvider(async function* (options) {
      requests.push(structuredClone(options));
      yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], usage: { inputTokens: 0, outputTokens: 1 } };
    }),
    context: new AgentContext(transcript),
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    model: 'deepseek-flash',
    pricing: priceTable(['deepseek-flash']),
    maxUsd: 1,
    maxTurns: 2,
    cappedFinishRecovery: 'queued',
    persistCappedFinishRecovery: async () => {},
  }).run();
  assert.equal(done.status, 'DONE');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].tools.some((tool) => tool.function.name === 'write_file'));
  assert.ok(requests[0].tools.some((tool) => tool.function.name === 'finish'));
  assert.ok(!Object.hasOwn(requests[0], 'tool_choice'));
  assert.deepEqual(requests[0].thinking, { type: 'disabled' });

  let failedRequests = 0;
  const failed = await new AgentLoop({
    provider: {
      async *chat() {
        failedRequests++;
        yield { providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
      },
    },
    context: new AgentContext(transcript),
    tools: { execute: async () => assert.fail('no tool may execute') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 2,
    cappedFinishRecovery: 'queued',
    persistCappedFinishRecovery: async () => {},
  }).run();
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error, 'Worker exhausted output-cap recovery without an allowed tool call');
  assert.equal(failedRequests, 1, 'the durable marker prohibits a second capped implementation recovery after resume');
});

test('capped implementation lifecycle state, not reminder prose, authorizes a resume', async () => {
  let ordinaryRequests = 0;
  const ordinary = await new AgentLoop({
    provider: {
      async *chat(request) {
        ordinaryRequests++;
        assert.ok(
          request.tools.some((tool) => tool.function.name === 'read_file'),
          'task prose must not narrow the schema',
        );
        yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], usage: { inputTokens: 0, outputTokens: 1 } };
      },
    },
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
  }).run({ task: 'Continue implementation using an allowed tool call.' });
  assert.equal(ordinary.status, 'DONE');
  assert.equal(ordinaryRequests, 1);

  const validTranscript = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/a.mjs","content":"x"}' } }],
    },
    { role: 'tool', tool_call_id: 'write', name: 'write_file', content: 'written' },
    { role: 'assistant', content: 'partial final answer' },
    { role: 'user', content: 'Continue implementation using an allowed tool call.' },
  ];
  let queuedRequests = 0;
  const queued = await new AgentLoop({
    provider: {
      async *chat(request) {
        queuedRequests++;
        assert.ok(request.tools.some((tool) => tool.function.name === 'write_file'));
        assert.ok(request.tools.some((tool) => tool.function.name === 'finish'));
        yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], usage: { inputTokens: 0, outputTokens: 1 } };
      },
    },
    context: new AgentContext(validTranscript),
    cappedFinishRecovery: 'queued',
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    persistCappedFinishRecovery: async () => {},
  }).run();
  assert.equal(queued.status, 'DONE');
  assert.equal(queuedRequests, 1, 'a valid queued state gets exactly one implementation-continuation request');

  let unavailableRequests = 0;
  const unavailable = await new AgentLoop({
    provider: {
      async *chat() {
        unavailableRequests++;
      },
    },
    context: new AgentContext(validTranscript),
    cappedFinishRecovery: 'queued',
    tools: { execute: async () => assert.fail('no recovery tool may execute') },
  }).run();
  assert.equal(unavailable.status, 'FAILED');
  assert.match(unavailable.error, /persistence is unavailable/);
  assert.equal(unavailableRequests, 0, 'a recovery cannot run without an awaited persistence callback');

  const untouchedContext = new AgentContext(validTranscript);
  let appendedTaskRequests = 0;
  const appendedTask = await new AgentLoop({
    provider: {
      async *chat() {
        appendedTaskRequests++;
      },
    },
    context: untouchedContext,
    cappedFinishRecovery: 'queued',
    persistCappedFinishRecovery: async () => {},
    tools: { execute: async () => assert.fail('no recovery tool may execute') },
  }).run({ task: 'this must not be appended' });
  assert.equal(appendedTask.status, 'FAILED');
  assert.match(appendedTask.error, /cannot append a new task/);
  assert.equal(appendedTaskRequests, 0);
  assert.deepEqual(untouchedContext.snapshot(), validTranscript, 'queued-tail validation runs before task persistence');

  for (const [state, transcript] of [
    ['queued', validTranscript.slice(0, -1)],
    ['consumed', validTranscript],
    ['invalid', validTranscript],
  ]) {
    let requests = 0;
    const result = await new AgentLoop({
      provider: {
        async *chat() {
          requests++;
        },
      },
      context: new AgentContext(transcript),
      cappedFinishRecovery: state,
      persistCappedFinishRecovery: async () => {},
      tools: { execute: async () => assert.fail('no recovery tool may execute') },
    }).run();
    assert.equal(result.status, 'FAILED');
    assert.equal(requests, 0, `${state} recovery state must fail before a provider request`);
  }
});

test('a settled capped implementation recovery permits an ordinary later task without reauthorizing recovery', async () => {
  const context = new AgentContext([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/a.mjs","content":"x"}' } }],
    },
    { role: 'tool', tool_call_id: 'write', name: 'write_file', content: 'written' },
    { role: 'assistant', content: 'partial implementation plan' },
    { role: 'user', content: 'Continue implementation using an allowed tool call.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'write-2', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/b.mjs","content":"y"}' } }],
    },
    { role: 'tool', tool_call_id: 'write-2', name: 'write_file', content: 'written' },
  ]);
  let requests = 0;
  const result = await new AgentLoop({
    provider: {
      async *chat(options) {
        requests++;
        assert.equal(options.messages.at(-1).content, 'Repair the verifier failure.');
        assert.ok(options.tools.some((tool) => tool.function.name === 'write_file'));
        yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], usage: { inputTokens: 0, outputTokens: 1 } };
      },
    },
    context,
    cappedFinishRecovery: 'settled',
    persistCappedFinishRecovery: async () => assert.fail('settled history must not queue another recovery'),
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
  }).run({ task: 'Repair the verifier failure.' });
  assert.equal(result.status, 'DONE');
  assert.equal(requests, 1);
});

test('capped implementation recovery consumes durable state before its provider request and never replays after a crash', async () => {
  const states = [];
  const ordering = [];
  const context = new AgentContext([], {
    onAppendBatch: async (messages) => {
      if (messages.some((message) => message.content === 'Continue implementation using an allowed tool call.')) ordering.push('tail');
    },
  });
  let requests = 0;
  const loop = new AgentLoop({
    provider: {
      async *chat() {
        requests++;
        if (requests === 1)
          yield {
            toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
            usage: { inputTokens: 0, outputTokens: 1 },
          };
        else if (requests === 2) yield { providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
        else assert.fail('the consumed transition must happen before this provider request');
      },
    },
    context,
    tools: { execute: async () => 'written' },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
    persistCappedFinishRecovery: async (event) => {
      if (event.cappedFinishRecovery) {
        states.push(event.cappedFinishRecovery);
        ordering.push(event.cappedFinishRecovery);
        if (event.cappedFinishRecovery === 'consumed') throw new Error('simulated crash after durable consume');
      }
    },
  });
  await assert.rejects(loop.run({ task: 'implement x' }), /simulated crash/);
  assert.deepEqual(states, ['queued', 'consumed']);
  assert.deepEqual(ordering, ['queued', 'tail', 'consumed'], 'the queue state is durable before the recovery tail or provider boundary');
  assert.equal(requests, 2, 'the crash occurs before the implementation-continuation POST');

  let resumedRequests = 0;
  const resumed = await new AgentLoop({
    provider: {
      async *chat() {
        resumedRequests++;
      },
    },
    context,
    cappedFinishRecovery: 'consumed',
    persistCappedFinishRecovery: async () => {},
    tools: { execute: async () => assert.fail('a consumed recovery cannot execute tools') },
  }).run();
  assert.equal(resumed.status, 'FAILED');
  assert.match(resumed.error, /may already have been sent/);
  assert.equal(resumedRequests, 0, 'a crash after consume cannot duplicate a possibly billed request');

  // The more dangerous boundary is after the durable consume succeeds: a
  // provider request may already be billed even when it throws before any
  // stream event reaches us. A reconstructed loop must still make zero calls.
  let persistedState;
  let postBoundaryRequests = 0;
  const postBoundaryContext = new AgentContext();
  await assert.rejects(
    new AgentLoop({
      provider: {
        async *chat() {
          postBoundaryRequests++;
          if (postBoundaryRequests === 1)
            yield {
              toolCalls: [call('write_file', '{"path":"src/b.mjs","content":"x"}', 'write-post')],
              usage: { inputTokens: 0, outputTokens: 1 },
            };
          else if (postBoundaryRequests === 2) yield { providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
          else throw new Error('simulated ambiguous provider failure after POST');
        },
      },
      context: postBoundaryContext,
      tools: { execute: async () => 'written' },
      model: 'm',
      pricing: priceTable(['m']),
      maxUsd: 1,
      maxTurns: 3,
      persistCappedFinishRecovery: async (event) => {
        persistedState = event.cappedFinishRecovery;
      },
    }).run({ task: 'implement x' }),
    /simulated ambiguous provider failure after POST/,
  );
  assert.equal(persistedState, 'consumed');
  assert.equal(postBoundaryRequests, 3, 'the implementation-continuation request was attempted after durable consumption');

  let replayedPostBoundaryRequests = 0;
  const replayedPostBoundary = await new AgentLoop({
    provider: {
      async *chat() {
        replayedPostBoundaryRequests++;
      },
    },
    context: postBoundaryContext,
    cappedFinishRecovery: persistedState,
    persistCappedFinishRecovery: async () => {},
    tools: { execute: async () => assert.fail('a consumed recovery cannot execute tools') },
  }).run();
  assert.equal(replayedPostBoundary.status, 'FAILED');
  assert.equal(replayedPostBoundaryRequests, 0, 'an ambiguous post-boundary failure cannot double bill on resume');
});

test('generic capped implementation recovery retains the normal tool schema without inferring provider settings', async () => {
  const requests = [];
  let requestCount = 0;
  const result = await new AgentLoop({
    provider: {
      async *chat(options) {
        requests.push(structuredClone(options));
        requestCount++;
        if (requestCount === 1)
          yield {
            toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
            usage: { inputTokens: 0, outputTokens: 1 },
          };
        else if (requestCount === 2) yield { providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
        else yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], usage: { inputTokens: 0, outputTokens: 1 } };
      },
    },
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'written') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
    persistCappedFinishRecovery: async () => {},
  }).run({ task: 'implement x' });

  assert.equal(result.status, 'DONE');
  assert.ok(requests[2].tools.some((tool) => tool.function.name === 'write_file'));
  assert.ok(requests[2].tools.some((tool) => tool.function.name === 'finish'));
  assert.ok(!Object.hasOwn(requests[2], 'tool_choice'));
  assert.ok(!Object.hasOwn(requests[2], 'thinking'));
  assert.ok(!Object.hasOwn(requests[2], 'reasoning_effort'));
});

test('a durable current-turn budget recovery replaces an unaffordable transcript with one trusted finish request', async () => {
  const requests = [];
  const transitions = [];
  let requestCount = 0;
  const result = await new AgentLoop({
    provider: {
      async *chat(options) {
        requests.push(structuredClone(options));
        requestCount++;
        if (requestCount === 1)
          yield {
            reasoning: 'UNTRUSTED_TRANSCRIPT_CONTENT'.repeat(4_000),
            toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"export default 1;"}', 'write')],
            usage: { inputTokens: 0, outputTokens: 1 },
          };
        else yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], usage: { inputTokens: 0, outputTokens: 1 } };
      },
    },
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'written') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 0.01,
    maxTurns: 3,
    persistBudgetFinishRecovery: async (event) => transitions.push(event),
  }).run({ task: 'UNTRUSTED_TASK_CONTENT' });

  assert.equal(result.status, 'DONE');
  assert.equal(result.turn, 2, 'the recovery reuses the unfunded current turn before the configured cap');
  assert.equal(requests.length, 2, 'the recovery consumes the current logical turn instead of adding one');
  assert.deepEqual(requests[1].messages, [{ role: 'user', content: 'Call the finish tool now.' }]);
  assert.deepEqual(
    requests[1].tools.map((tool) => tool.function.name),
    ['finish'],
  );
  assert.ok(requests[1].max_tokens <= 128);
  assert.doesNotMatch(JSON.stringify(requests[1]), /UNTRUSTED_(?:TASK|TRANSCRIPT)_CONTENT/);
  assert.deepEqual(
    transitions.map((event) => event.budgetFinishRecovery),
    ['queued', 'consumed'],
  );
});

test('budget terminal finalization requires a durable direct write and an affordable fixed request', async () => {
  let noWritePosts = 0;
  const noWrite = await new AgentLoop({
    provider: {
      async *chat() {
        noWritePosts++;
      },
    },
    context: new AgentContext([{ role: 'assistant', content: 'x'.repeat(60_000) }]),
    tools: { execute: async () => assert.fail('no tool may execute') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 0.01,
    maxTurns: 1,
    persistBudgetFinishRecovery: async () => assert.fail('a missing direct write must not queue recovery'),
  }).run();
  assert.equal(noWrite.status, 'BUDGET');
  assert.equal(noWritePosts, 0);

  let unaffordablePosts = 0;
  const unaffordablePricing = {
    models: {
      m: {
        usd_per_1m: {
          input_cache_hit: { off_peak: 0, peak: 0 },
          input_cache_miss: { off_peak: 0.01, peak: 0.01 },
          output: { off_peak: 10, peak: 10 },
        },
      },
    },
  };
  const unaffordable = await new AgentLoop({
    provider: {
      async *chat() {
        unaffordablePosts++;
        yield {
          reasoning: 'x'.repeat(60_000),
          toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
          usage: { inputTokens: 0, outputTokens: 590 },
        };
      },
    },
    tools: { execute: async () => 'written' },
    model: 'm',
    pricing: unaffordablePricing,
    maxUsd: 0.006,
    maxTurns: 2,
    persistBudgetFinishRecovery: async () => assert.fail('an unaffordable terminal request must not queue recovery'),
  }).run({ task: 'write it' });
  assert.equal(unaffordable.status, 'BUDGET');
  assert.equal(unaffordablePosts, 1, 'the fixed finish request must be reserved before POST');
});

test('queued and consumed budget-finish recoveries are one-shot and fail closed across crashes', async () => {
  const durableWriteTranscript = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/a.mjs","content":"x"}' } }],
    },
    { role: 'tool', tool_call_id: 'write', name: 'write_file', content: 'written' },
    { role: 'assistant', content: 'UNTRUSTED_RESUME_TRANSCRIPT'.repeat(3_000) },
  ];
  const queuedRequests = [];
  const queued = await new AgentLoop({
    provider: {
      async *chat(options) {
        queuedRequests.push(structuredClone(options));
        yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], usage: { inputTokens: 0, outputTokens: 1 } };
      },
    },
    context: new AgentContext(durableWriteTranscript),
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 0.01,
    maxTurns: 1,
    budgetFinishRecovery: 'queued',
    persistBudgetFinishRecovery: async () => {},
  }).run();
  assert.equal(queued.status, 'DONE');
  assert.deepEqual(queuedRequests[0].messages, [{ role: 'user', content: 'Call the finish tool now.' }]);
  assert.deepEqual(
    queuedRequests[0].tools.map((tool) => tool.function.name),
    ['finish'],
  );

  let officialRequest;
  const official = await new AgentLoop({
    provider: officialDeepSeekProvider(async function* (options) {
      officialRequest = structuredClone(options);
      yield { toolCalls: [call('finish', '{"summary":"done"}', 'finish')], usage: { inputTokens: 0, outputTokens: 1 } };
    }),
    context: new AgentContext([
      ...durableWriteTranscript.slice(0, -1),
      { role: 'assistant', content: 'UNTRUSTED_OFFICIAL_RESUME'.repeat(3_000) },
    ]),
    tools: { execute: async () => ({ finish: { summary: 'done', concerns: [], testsRun: [] } }) },
    model: 'deepseek-flash',
    pricing: priceTable(['deepseek-flash']),
    maxUsd: 0.01,
    maxTurns: 1,
    budgetFinishRecovery: 'queued',
    persistBudgetFinishRecovery: async () => {},
  }).run();
  assert.equal(official.status, 'DONE');
  assert.deepEqual(officialRequest.messages, [{ role: 'user', content: 'Call the finish tool now.' }]);
  assert.deepEqual(officialRequest.tool_choice, { type: 'function', function: { name: 'finish' } });
  assert.deepEqual(officialRequest.thinking, { type: 'disabled' });
  assert.equal(officialRequest.reasoning_effort, 'none');

  let missingWritePosts = 0;
  const missingWrite = await new AgentLoop({
    provider: {
      async *chat() {
        missingWritePosts++;
      },
    },
    context: new AgentContext([{ role: 'assistant', content: 'no durable write evidence' }]),
    tools: { execute: async () => assert.fail('an invalid queued recovery cannot execute') },
    budgetFinishRecovery: 'queued',
    persistBudgetFinishRecovery: async () => {},
  }).run();
  assert.equal(missingWrite.status, 'FAILED');
  assert.match(missingWrite.error, /queued budget finish recovery transcript is incomplete/);
  assert.equal(missingWritePosts, 0);

  const cannotPostInvalidQueuedRecovery = async (transcript, context = new AgentContext(transcript)) => {
    let posts = 0;
    const result = await new AgentLoop({
      provider: {
        async *chat() {
          posts++;
        },
      },
      context,
      tools: { execute: async () => assert.fail('an invalid queued recovery cannot execute') },
      budgetFinishRecovery: 'queued',
      persistBudgetFinishRecovery: async () => {},
    }).run();
    assert.equal(result.status, 'FAILED');
    assert.match(result.error, /queued budget finish recovery transcript is incomplete/);
    assert.equal(posts, 0);
  };
  await cannotPostInvalidQueuedRecovery([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'reused', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/a.mjs","content":"x"}' } }],
    },
    { role: 'tool', tool_call_id: 'reused', name: 'write_file', content: 'TOOL_ERROR: Tool execution failed' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'reused', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.mjs"}' } }],
    },
    { role: 'tool', tool_call_id: 'reused', name: 'read_file', content: 'successful read' },
  ]);
  const elidedWriteTranscript = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'write-elided', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/a.mjs","content":"x"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'write-elided', name: 'write_file', content: 'written', elided: true },
  ];
  // AgentContext's live elision metadata is normally created after startup;
  // keep it in this recovery snapshot to prove the evidence boundary rejects
  // an already-elided durable result before it can buy a provider request.
  const elidedWriteContext = new AgentContext();
  elidedWriteContext.snapshot = () => structuredClone(elidedWriteTranscript);
  await cannotPostInvalidQueuedRecovery(elidedWriteTranscript, elidedWriteContext);

  let consumedPosts = 0;
  const consumed = await new AgentLoop({
    provider: {
      async *chat() {
        consumedPosts++;
      },
    },
    tools: { execute: async () => assert.fail('a consumed recovery cannot execute') },
    budgetFinishRecovery: 'consumed',
    persistBudgetFinishRecovery: async () => {},
  }).run();
  assert.equal(consumed.status, 'FAILED');
  assert.match(consumed.error, /may already have been sent/);
  assert.equal(consumedPosts, 0);

  let crashPosts = 0;
  await assert.rejects(
    new AgentLoop({
      provider: {
        async *chat() {
          crashPosts++;
          if (crashPosts === 1)
            yield {
              reasoning: 'x'.repeat(60_000),
              toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
              usage: { inputTokens: 0, outputTokens: 1 },
            };
          else assert.fail('the consume transition must precede the terminal POST');
        },
      },
      tools: { execute: async () => 'written' },
      model: 'm',
      pricing: priceTable(['m']),
      maxUsd: 0.01,
      maxTurns: 2,
      persistBudgetFinishRecovery: async (event) => {
        if (event.budgetFinishRecovery === 'consumed') throw new Error('simulated budget recovery crash');
      },
    }).run({ task: 'write it' }),
    /simulated budget recovery crash/,
  );
  assert.equal(crashPosts, 1, 'a crash after durable consumption occurs before the ambiguous POST');
});

test('capped implementation recovery is strict, one-shot, and requires its exact evidence', async () => {
  const run = async ({ finishReason = 'length', outputTokens = 4_096, maxTurns = 3, secondResponse = undefined } = {}) => {
    let requests = 0;
    const result = await new AgentLoop({
      provider: {
        async *chat() {
          requests++;
          if (requests === 1)
            yield {
              toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
              usage: { inputTokens: 0, outputTokens: 1 },
            };
          else if (requests === 2)
            yield {
              ...(secondResponse ?? { providerFinishReason: finishReason, usage: { inputTokens: 0, outputTokens } }),
            };
          else yield { providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
        },
      },
      tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'done', concerns: [], testsRun: [] } } : 'written') },
      model: 'm',
      pricing: priceTable(['m']),
      maxUsd: 1,
      maxTurns,
      persistCappedFinishRecovery: async () => {},
    }).run({ task: 'implement x' });
    return { result, requests };
  };

  for (const options of [{ finishReason: 'stop' }, { maxTurns: 2 }]) {
    const runResult = await run(options);
    assert.equal(runResult.result.status, 'FAILED');
    assert.equal(runResult.result.error, 'Worker ended without mandatory finish call');
    assert.equal(runResult.requests, 2);
  }

  const once = await run();
  assert.equal(once.result.status, 'FAILED');
  assert.equal(once.result.error, 'Worker exhausted output-cap recovery without an allowed tool call');
  assert.equal(once.requests, 3, 'a second capped no-tool response gets no third recovery request');

  let noWriteRequests = 0;
  const noWrite = await new AgentLoop({
    provider: {
      async *chat() {
        noWriteRequests++;
        yield { providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
      },
    },
    tools: { execute: async () => assert.fail('no tool may execute') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 2,
  }).run({ task: 'inspect only' });
  assert.equal(noWrite.status, 'FAILED');
  assert.equal(noWrite.error, 'Worker exhausted output-cap recovery without an allowed tool call');
  assert.equal(noWrite.providerFinishReason, 'length', 'the actionable terminal error retains the provider finish diagnostic');
  assert.equal(noWriteRequests, 2, 'a capped response without a successful direct write gets only one ordinary continuation');

  let duplicateUsageRequests = 0;
  const duplicateUsage = await new AgentLoop({
    provider: {
      async *chat() {
        duplicateUsageRequests++;
        if (duplicateUsageRequests === 1)
          yield {
            toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
            usage: { inputTokens: 0, outputTokens: 1 },
          };
        else {
          yield { providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
          yield { usage: { inputTokens: 0, outputTokens: 0 } };
        }
      },
    },
    tools: { execute: async () => 'written' },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
    persistCappedFinishRecovery: async () => {},
  }).run({ task: 'implement x' });
  assert.equal(duplicateUsage.status, 'FAILED');
  assert.match(duplicateUsage.error, /Expected exactly one usage record/);
  assert.equal(duplicateUsageRequests, 2, 'duplicate usage cannot turn into a free finish-recovery request');
});

test('capped implementation recovery rejects an unadvertised tool and cannot outpace durability or budget', async () => {
  let executed = [];
  let requests = 0;
  const unadvertised = await new AgentLoop({
    provider: {
      async *chat() {
        requests++;
        if (requests === 1)
          yield {
            toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
            usage: { inputTokens: 0, outputTokens: 1 },
          };
        else if (requests === 2) yield { providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
        else yield { toolCalls: [call('delete_file', '{"path":"src/a.mjs"}', 'delete')], usage: { inputTokens: 0, outputTokens: 1 } };
      },
    },
    tools: { execute: async (name) => (executed.push(name), 'written') },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
    persistCappedFinishRecovery: async () => {},
  }).run({ task: 'implement x' });
  assert.equal(unadvertised.status, 'FAILED');
  assert.equal(unadvertised.error, 'Provider requested an unadvertised tool');
  assert.deepEqual(executed, ['write_file']);

  let durableRequests = 0;
  const context = new AgentContext([], {
    onAppendBatch: async (messages) => {
      if (messages.some((message) => message.content === 'Continue implementation using an allowed tool call.'))
        throw new Error('durable completion reminder failed');
    },
  });
  const loop = new AgentLoop({
    provider: {
      async *chat() {
        durableRequests++;
        if (durableRequests === 1)
          yield {
            toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
            usage: { inputTokens: 0, outputTokens: 1 },
          };
        else yield { providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
      },
    },
    context,
    tools: { execute: async () => 'written' },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    maxTurns: 3,
    persistCappedFinishRecovery: async () => {},
  });
  await assert.rejects(loop.run({ task: 'implement x' }), /durable completion reminder failed/);
  assert.equal(durableRequests, 2);

  let budgetRequests = 0;
  const budget = await new AgentLoop({
    provider: {
      async *chat() {
        budgetRequests++;
        if (budgetRequests === 1)
          yield {
            toolCalls: [call('write_file', '{"path":"src/a.mjs","content":"x"}', 'write')],
            usage: { inputTokens: 0, outputTokens: 1 },
          };
        else yield { providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
      },
    },
    tools: { execute: async () => 'written' },
    model: 'm',
    pricing: {
      models: {
        m: {
          usd_per_1m: {
            input_cache_hit: { off_peak: 0, peak: 0 },
            input_cache_miss: { off_peak: 0, peak: 0 },
            output: { off_peak: 1, peak: 1 },
          },
        },
      },
    },
    maxUsd: 0.0041,
    maxTurns: 3,
    persistCappedFinishRecovery: async () => {},
  }).run({ task: 'implement x' });
  assert.equal(budget.status, 'BUDGET');
  assert.equal(budgetRequests, 2, 'the queued implementation recovery is still subject to the next request reservation');
});

test('a capped reasoning continuation still honors remaining USD before a second provider call', async () => {
  let calls = 0;
  const provider = {
    async *chat() {
      calls++;
      yield { reasoning: 'planning', providerFinishReason: 'length', usage: { inputTokens: 0, outputTokens: 4_096 } };
    },
  };
  const pricing = {
    models: {
      m: {
        usd_per_1m: {
          input_cache_hit: { off_peak: 0, peak: 0 },
          input_cache_miss: { off_peak: 0, peak: 0 },
          output: { off_peak: 1, peak: 1 },
        },
      },
    },
  };
  const result = await new AgentLoop({
    provider,
    tools: { execute: async () => assert.fail('no tool may execute') },
    model: 'm',
    pricing,
    maxUsd: 0.0041,
    maxTurns: 2,
  }).run({ task: 'x' });
  assert.equal(result.status, 'BUDGET');
  assert.equal(calls, 1);
});

test('finite-budget turns disable ambiguous upstream retries', async () => {
  let attempts = 0;
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 3,
    fetchImpl: async () => {
      attempts++;
      return new Response('data: {"choices":[{"delta":{"content":"possibly billed"}}]}\n\n', { status: 200 });
    },
  });
  const loop = new AgentLoop({ provider, tools: { execute: async () => '' }, model: 'm', pricing: priceTable(['m']), maxUsd: 1 });
  const result = await loop.run({ task: 'x' });
  assert.equal(result.status, 'FAILED');
  assert.deepEqual(result.providerFailure, { kind: 'sse_protocol', attempts: 1 });
  assert.equal(result.error, 'Chat request failed');
  assert.equal(attempts, 1, 'a failed stream may have been billed, so a capped job must not replay it');
});

test('provider attempt timeout is safe, visible, and distinct from the outer deadline', async () => {
  let attempts = 0;
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    timeoutMs: 5,
    retries: 3,
    fetchImpl: async (_url, { signal }) => {
      attempts++;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('https://secret.invalid/chat?API_KEY=must-not-persist')), { once: true }),
      );
    },
  });
  const progress = [];
  const result = await new AgentLoop({
    provider,
    tools: { execute: async () => '' },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    timeoutMs: 1_000,
    progress: async (event) => progress.push(event),
  }).run({ task: 'x' });
  assert.equal(result.status, 'TIMEOUT');
  assert.equal(result.error, 'Provider request timed out');
  assert.deepEqual(result.providerFailure, { kind: 'attempt_timeout', attempts: 1 });
  assert.equal(attempts, 1, 'finite-budget jobs never replay an ambiguous timed-out POST');
  assert.ok(progress.some((event) => event.action === 'provider_request_pending' && event.turn === 1));
  assert.doesNotMatch(JSON.stringify(result), /secret\.invalid|must-not-persist/i);
});

test('outer deadline and caller cancellation take precedence over provider attempt classification', async () => {
  const stalledProvider = (onRequest) =>
    new OpenAIChatProvider({
      baseUrl: 'http://localhost',
      model: 'm',
      timeoutMs: 1_000,
      retries: 1,
      fetchImpl: async (_url, { signal }) => {
        onRequest?.();
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('https://secret.invalid/provider')), { once: true }),
        );
      },
    });
  const deadline = await new AgentLoop({
    provider: stalledProvider(),
    tools: { execute: async () => '' },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    timeoutMs: 5,
  }).run({ task: 'x' });
  assert.equal(deadline.status, 'TIMEOUT');
  assert.equal(deadline.error, 'Agent wall clock deadline exceeded');
  assert.equal(deadline.providerFailure, undefined);

  const controller = new AbortController();
  const cancelled = await new AgentLoop({
    provider: stalledProvider(() => queueMicrotask(() => controller.abort(new Error('caller cancelled')))),
    tools: { execute: async () => '' },
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    timeoutMs: 1_000,
    signal: controller.signal,
  }).run({ task: 'x' });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.providerFailure, undefined);
});

test('initial and text-only transcript appends settle before early exits', async () => {
  let appended = 0;
  const context = new AgentContext([], {
    onAppend: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      appended++;
    },
  });
  const never = {
    async *chat() {
      throw new Error('budget should preflight');
    },
  };
  const budget = await new AgentLoop({ provider: never, context, tools: { execute: async () => '' }, maxUsd: 0 }).run({
    task: 'durable first',
  });
  assert.equal(budget.status, 'BUDGET');
  assert.equal(appended, 1);
  const failingContext = new AgentContext([], {
    onAppend: async (message) => {
      if (message.role === 'assistant') throw new Error('disk full');
    },
  });
  const textOnly = {
    async *chat() {
      yield { text: 'not a finish' };
    },
  };
  await assert.rejects(
    () => new AgentLoop({ provider: textOnly, context: failingContext, tools: { execute: async () => '' } }).run({ task: 'x' }),
    /disk full/,
  );
});

test('resume trims only a trailing incomplete tool transaction and rejects interior corruption', () => {
  const call = { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } };
  const trailing = new AgentContext([
    { role: 'system', content: 's' },
    { role: 'assistant', content: '', tool_calls: [call] },
  ]);
  assert.deepEqual(
    trailing.snapshot().map((message) => message.role),
    ['system'],
  );
  assert.equal(trailing.trimmedIncomplete, true);
  assert.throws(
    () =>
      new AgentContext([
        { role: 'assistant', content: '', tool_calls: [call] },
        { role: 'user', content: 'repair' },
      ]),
    /incomplete tool-call transaction/,
  );
  assert.throws(
    () =>
      new AgentContext([{ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'read_file', arguments: '{}' } }] }]),
    /invalid assistant tool calls/,
  );
  const context = new AgentContext();
  assert.throws(() => context.add({ role: 'system', content: 42 }), /invalid content/);
  assert.throws(
    () =>
      context.add({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'bad\ncall', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      }),
    /invalid assistant tool calls/,
  );
});
test('a tool phase marker precedes execution, names the command timeout, and the batch reports per-call timings', async () => {
  const order = [];
  let clock = 1_000;
  const turns = [
    [call('read_file', '{"path":"a"}', 'r'), call('run_command', '{"command":"npm test","timeoutSec":120}', 'c')],
    [call('run_command', '{"command":"npm test"}', 'd')],
    [call('read_file', '{"path":"b"}', 'e')],
    [call('finish', '{"summary":"ok"}', 'f')],
  ];
  const provider = {
    async *chat() {
      yield { usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: turns.shift() };
    },
  };
  const spent = { read_file: 250, run_command: 4000 };
  const result = await new AgentLoop({
    provider,
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    now: () => clock,
    progress: (event) => order.push({ event }),
    tools: {
      execute: async (name) => {
        order.push({ executed: name });
        if (name === 'finish') return { finish: { summary: 'ok', concerns: [], testsRun: [] } };
        clock += spent[name];
        return 'ok';
      },
    },
  }).run({ task: 'x' });
  assert.equal(result.status, 'DONE');
  const markers = order.filter((entry) => entry.event?.phase === 'tool');
  assert.equal(markers.length, 3, 'one marker per tool batch, none for finish');
  assert.deepEqual(markers[0].event, { turn: 1, phase: 'tool', tools: ['read_file', 'run_command'], commandTimeoutSec: 120 });
  assert.deepEqual(
    markers[1].event,
    { turn: 2, phase: 'tool', tools: ['run_command'], commandTimeoutSec: 60 },
    'an absent timeout is the default',
  );
  assert.deepEqual(markers[2].event, { turn: 3, phase: 'tool', tools: ['read_file'] }, 'no command, no command timeout key');
  for (const { event } of markers)
    assert.equal('action' in event || 'actions' in event, false, 'a marker must not overwrite recent actions');
  // The marker is emitted before the first tool of its batch runs.
  const firstMarker = order.indexOf(markers[0]);
  assert.ok(firstMarker >= 0 && order.findIndex((entry) => entry.executed === 'read_file') > firstMarker);
  const finishTurn = order.find((entry) => entry.event?.actions?.includes('finish'));
  assert.ok(finishTurn, 'the finish turn reports its actions');
  assert.deepEqual(finishTurn.event.toolTimings, [], 'finish is not tool time');
  const after = order.filter((entry) => entry.event?.actions?.includes('read_file') && entry.event.toolTimings);
  assert.deepEqual(after[0].event.toolTimings, [
    { name: 'read_file', ms: 250 },
    { name: 'run_command', ms: 4000 },
  ]);
});
test('the tool marker carries the sum of every command timeout in the batch, and the cap applies to the sum', async () => {
  const markers = [];
  const turns = [
    [
      call('run_command', '{"command":"a","timeoutSec":60}', 'a'),
      call('read_file', '{"path":"x"}', 'x'),
      call('run_command', '{"command":"b","timeoutSec":600}', 'b'),
      call('run_command', '{"command":"c"}', 'c'),
    ],
    Array.from({ length: 64 }, (_, i) => call('run_command', `{"command":"n${i}","timeoutSec":900}`, `m${i}`)),
    [call('run_command', '{"command":"d","timeoutSec":99999}', 'd'), call('run_command', '{"command":"e","timeoutSec":0}', 'e')],
    [call('finish', '{"summary":"ok"}', 'f')],
  ];
  const provider = {
    async *chat() {
      yield { usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: turns.shift() };
    },
  };
  await new AgentLoop({
    provider,
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    progress: (event) => event.phase === 'tool' && markers.push(event.commandTimeoutSec),
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'ok', concerns: [], testsRun: [] } } : 'ok') },
  }).run({ task: 'x' });
  assert.deepEqual(markers, [
    60 + 600 + 60, // the default (60 s) stands in where a command names none
    57_600, // 64 x 900 s, the largest batch there can be
    900 + 1, // an oversized timeout is clamped to 900 s and a too-small one to 1 s, as the tool clamps them
  ]);
});
test('a fractional clock still yields whole-millisecond tool timings', async () => {
  let clock = 1000.25;
  const turns = [[call('run_command', '{"command":"a"}', 'a')], [call('finish', '{"summary":"ok"}', 'f')]];
  const provider = {
    async *chat() {
      yield { usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: turns.shift() };
    },
  };
  const events = [];
  await new AgentLoop({
    provider,
    model: 'm',
    pricing: priceTable(['m']),
    maxUsd: 1,
    now: () => clock,
    progress: (event) => events.push(event),
    tools: {
      execute: async (name) => {
        if (name === 'finish') return { finish: { summary: 'ok', concerns: [], testsRun: [] } };
        clock += 1500.4;
        return 'ok';
      },
    },
  }).run({ task: 'x' });
  const batch = events.find((event) => event.toolTimings?.length);
  assert.deepEqual(batch.toolTimings, [{ name: 'run_command', ms: 1500 }]);
});
test('a provider timing-free tool batch still reports one timing per call, in completion order', async () => {
  const events = [];
  const provider = providerFor([[call('list_dir', '{}', 'a')], [call('finish', '{"summary":"ok"}', 'f')]]);
  await new AgentLoop({
    provider,
    progress: (event) => events.push(event),
    tools: { execute: async (name) => (name === 'finish' ? { finish: { summary: 'ok', concerns: [], testsRun: [] } } : 'ok') },
  }).run({ task: 'x' });
  const batch = events.find((event) => event.actions?.[0] === 'list_dir');
  assert.equal(batch.toolTimings.length, 1);
  assert.equal(batch.toolTimings[0].name, 'list_dir');
  assert.ok(Number.isInteger(batch.toolTimings[0].ms) && batch.toolTimings[0].ms >= 0);
});
