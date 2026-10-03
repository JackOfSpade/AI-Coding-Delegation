import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../../src/agent/loop.mjs';
import { AgentContext } from '../../src/agent/context.mjs';
import { LocalTools, availableToolDefinitions } from '../../src/agent/tools.mjs';
import { buildSystemPrompt } from '../../src/agent/prompt.mjs';
import { OpenAIChatProvider } from '../../src/provider/openai-chat.mjs';

const call = (name, argText = '{}', id = 'id') => ({ id, name, arguments: argText });
const providerFor = (turns) => ({
  async *chat() {
    yield { toolCalls: turns.shift() };
  },
});
test('finish mixed with a write is rejected before anything executes', async () => {
  const invoked = [];
  const result = await new AgentLoop({
    provider: providerFor([[call('write_file', '{"path":"x","content":"x"}', 'w'), call('finish', '{"summary":"done"}', 'f')]]),
    tools: {
      execute: async (name) => {
        invoked.push(name);
      },
    },
  }).run({ task: 'x' });
  assert.equal(result.status, 'FAILED');
  assert.deepEqual(invoked, []);
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
  assert.equal(result.finish, undefined);
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
  const stalled = {
    async *chat({ signal }) {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  };
  const timed = await new AgentLoop({ provider: stalled, tools: { execute: async () => '' }, timeoutMs: 10 }).run({ task: 'x' });
  assert.equal(timed.status, 'TIMEOUT');
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
  assert.equal(calls, 0);
  const unknown = await new AgentLoop({ provider, tools, maxUsd: 1 }).run({ task: 'x' });
  assert.equal(unknown.status, 'BUDGET');
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
    progress.map((event) => event.costUsd),
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
    progress.map((event) => event.costUsd),
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
  assert.equal(
    context.snapshot().some((m) => m.role === 'assistant'),
    false,
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
    replay.map((m) => m.content),
    ['s', 'old', 'first', 'repair'],
  );
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
test('repair contexts elide loaded tool output and reject oversized transcripts', () => {
  const context = new AgentContext(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'old-call', content: 'x'.repeat(200) },
    ],
    { maxToolChars: 20, keepRecentToolResults: 0, maxTranscriptChars: 500 },
  );
  assert.match(context.snapshot()[1].content, /elided/);
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

test('loop rejects tool schemas it cannot execute or finish without', () => {
  const provider = { async *chat() {} },
    tools = { execute: async () => '' };
  assert.throws(() => new AgentLoop({ provider, tools, toolDefinitions: [] }), /containing finish/);
  assert.throws(
    () => new AgentLoop({ provider, tools, toolDefinitions: [{ function: { name: 'constructor' } }, { function: { name: 'finish' } }] }),
    /executable subset/,
  );
});

test('finite budgets reserve a pessimistic prompt cost and bound provider output', async () => {
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
  assert.ok(maxTokens >= 16 && maxTokens <= 16_384);
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
  await assert.rejects(() => loop.run({ task: 'x' }), /Chat request failed/);
  assert.equal(attempts, 1, 'a failed stream may have been billed, so a capped job must not replay it');
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
