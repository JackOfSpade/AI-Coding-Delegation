// offload complete: the optional host-declared tool loop. Offload never runs a
// tool; it returns the calls, bounds the loop from the history and the ledger,
// and keeps tool text and reasoning off disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { __test, complete, completeDryRun, completeExitCode, toolLoopSpend, validateCompleteRequest } from '../../src/complete.mjs';
import { runCli } from '../../src/cli.mjs';
import { cleanup, tempDir } from './helpers.mjs';

const OFF_PEAK = Date.parse('2026-10-05T12:00:00Z');
const CONFIG = {
  providers: {
    deepseek: { type: 'openai-chat', baseUrl: 'https://api.deepseek.com', keyRef: 'env:TEST_DEEPSEEK', pricing: 'deepseek-2026-10-01' },
  },
  profiles: {},
};
const enc = new TextEncoder();
const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600, completion_tokens: 500 };
const CALL_COST = (400 * 0.003 + 600 * 0.15 + 500 * 0.6) / 1e6;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`);

const sseResponse = (events) => {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= events.length) return controller.close();
      const event = events[index++];
      controller.enqueue(enc.encode(event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A streamed reply: reasoning, optional text, tool calls split into fragments, finish, usage. */
function reply({ reasoning = 'THINK-SECRET', text = '', calls = [], finish, reasoningNull = false, noReasoning = false } = {}) {
  const events = [
    {
      id: 'cmpl-t',
      model: 'deepseek-v4-flash',
      choices: [
        {
          delta: noReasoning
            ? { role: 'assistant' }
            : { role: 'assistant', reasoning_content: reasoningNull ? null : reasoning.slice(0, 5) },
        },
      ],
    },
  ];
  if (!reasoningNull && !noReasoning) events.push({ id: 'cmpl-t', choices: [{ delta: { reasoning_content: reasoning.slice(5) } }] });
  if (text) events.push({ id: 'cmpl-t', choices: [{ delta: { content: text } }] });
  calls.forEach((call, index) => {
    const half = Math.floor(call.arguments.length / 2);
    events.push({
      id: 'cmpl-t',
      choices: [
        {
          delta: {
            content: null,
            tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments.slice(0, half) } }],
          },
        },
      ],
    });
    events.push({ id: 'cmpl-t', choices: [{ delta: { tool_calls: [{ index, function: { arguments: call.arguments.slice(half) } }] } }] });
  });
  events.push({ id: 'cmpl-t', choices: [{ delta: {}, finish_reason: finish ?? (calls.length ? 'tool_calls' : 'stop') }] });
  events.push({ id: 'cmpl-t', choices: [], usage }, '[DONE]');
  return sseResponse(events);
}

function harness({ replies = [], config = CONFIG, models } = {}) {
  const dir = tempDir('offload-complete-tools-');
  const ledgerPath = join(dir, 'state', 'offload', 'complete-ledger.jsonl');
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body });
    if (path === '/models' && models) return models();
    if (path === '/models') return jsonResponse({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] });
    if (path === '/chat/completions') {
      const next = replies.shift();
      if (!next) throw new Error('no scripted reply left');
      return next(JSON.parse(init.body));
    }
    throw new Error(`unexpected request ${path}`);
  };
  const options = {
    config,
    fetchImpl,
    readKey: () => 'sk-test-key',
    ledgerPath,
    now: () => OFF_PEAK,
    env: { XDG_STATE_HOME: join(dir, 'state') },
  };
  const ledgerText = () => {
    try {
      return readFileSync(ledgerPath, 'utf8');
    } catch {
      return '';
    }
  };
  const ledger = () =>
    ledgerText()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const chats = () => calls.filter((call) => call.path === '/chat/completions');
  return { dir, ledgerPath, options, ledger, ledgerText, chats, done: () => cleanup(dir) };
}

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  { name: 'web_fetch', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
];
const search = (id, query) => ({ id, name: 'web_search', arguments: JSON.stringify({ query }) });
const request = (overrides = {}) => ({
  route: 'deepseek-flash',
  messages: [
    { role: 'system', content: 'Research carefully.' },
    { role: 'user', content: 'What does ACME pay a staff engineer?' },
  ],
  maxTokens: 1000,
  reasoning: { enabled: true, effort: 'high' },
  timeoutMs: 5000,
  caller: 'canvas',
  tag: 'job-compensation-research-batch',
  tools: TOOLS,
  toolLoop: { id: 'loop-1', maxTurns: 4, maxToolCallsPerTurn: 3, maxToolCalls: 6 },
  ...overrides,
});
/** Next request: the history plus the returned assistant message and one tool result per call. */
const followUp = (base, result, results = {}) => ({
  ...base,
  messages: [
    ...base.messages,
    result.assistantMessage,
    ...result.toolCalls.map((call) => ({ role: 'tool', toolCallId: call.id, content: results[call.id] ?? `RESULT-${call.id}` })),
  ],
});

test.beforeEach(() => __test.clearModelCache());

test('a tool-calling reply returns the calls, the assistant message to replay and the loop position', async () => {
  const h = harness({
    replies: [() => reply({ text: 'Let me look.', calls: [search('call_1', 'ACME staff salary'), search('call_2', 'ACME levels')] })],
  });
  try {
    const result = await complete(request(), h.options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(completeExitCode(result), 0);
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.text, 'Let me look.');
    assert.deepEqual(result.toolCalls, [search('call_1', 'ACME staff salary'), search('call_2', 'ACME levels')]);
    assert.deepEqual(result.assistantMessage, {
      role: 'assistant',
      content: 'Let me look.',
      toolCalls: result.toolCalls,
      reasoningContent: 'THINK-SECRET',
    });
    near(result.costUsd, CALL_COST);
    assert.deepEqual(
      { ...result.toolLoop, costUsd: 0 },
      {
        id: 'loop-1',
        turn: 1,
        maxTurns: 4,
        final: false,
        toolCalls: 2,
        maxToolCalls: 6,
        costUsd: 0,
      },
    );
    near(result.toolLoop.costUsd, CALL_COST);
    // The wire request declares function tools and leaves tool_choice at the provider default.
    const payload = JSON.parse(h.chats()[0].body);
    assert.deepEqual(payload.tools[0], { type: 'function', function: TOOLS[0] });
    assert.deepEqual(payload.tools[1], { type: 'function', function: TOOLS[1] });
    assert.equal('tool_choice' in payload, false);
    assert.deepEqual(payload.messages, request().messages, 'plain messages stay { role, content }');
    // The ledger counts calls and keys the loop but holds no tool text or reasoning.
    const [entry] = h.ledger();
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['caller', 'costUsd', 'error', 'latencyMs', 'loopId', 'model', 'route', 'tag', 'toolCalls', 'ts', 'turn', 'usage'].sort(),
    );
    assert.equal(entry.loopId, 'loop-1');
    assert.equal(entry.turn, 1);
    assert.equal(entry.toolCalls, 2);
    for (const secret of ['THINK-SECRET', 'ACME', 'Let me look', 'web_search', 'call_1'])
      assert.ok(!h.ledgerText().includes(secret), secret);
  } finally {
    h.done();
  }
});

test('the next turn replays reasoning, tool calls and tool results byte-stably and accumulates loop cost', async () => {
  const h = harness({
    replies: [() => reply({ calls: [search('call_1', 'ACME pay')] }), () => reply({ reasoning: 'SECOND-THOUGHT', text: '$250k base' })],
  });
  try {
    const first = await complete(request(), h.options);
    const nextRequest = followUp(request(), first, { call_1: 'levels.fyi says $250k' });
    const second = await complete(nextRequest, h.options);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.finishReason, 'stop');
    assert.equal(second.text, '$250k base');
    assert.equal(second.toolCalls, undefined);
    assert.deepEqual(second.assistantMessage, { role: 'assistant', content: '$250k base', reasoningContent: 'SECOND-THOUGHT' });
    assert.equal(second.toolLoop.turn, 2);
    assert.equal(second.toolLoop.toolCalls, 1);
    near(second.toolLoop.costUsd, 2 * CALL_COST);
    const raw = h.chats()[1].body;
    const wire = JSON.parse(raw).messages;
    assert.deepEqual(wire.slice(2), [
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'THINK-SECRET',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"ACME pay"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'levels.fyi says $250k' },
    ]);
    // The prefix sent on turn 1 is a byte-for-byte prefix of turn 2's messages.
    const firstMessages = JSON.stringify(JSON.parse(h.chats()[0].body).messages);
    assert.ok(JSON.stringify(wire).startsWith(firstMessages.slice(0, -1)));
    assert.equal(await toolLoopSpend(h.ledgerPath, 'canvas', 'loop-1'), h.ledger()[0].costUsd + h.ledger()[1].costUsd);
    assert.ok(!h.ledgerText().includes('levels.fyi'));
  } finally {
    h.done();
  }
});

test('the last allowed turn sends tool_choice none, and a tool call there is a retryable provider_error', async () => {
  const lastTurn = (base) => ({
    ...base,
    toolLoop: { ...base.toolLoop, maxTurns: 2 },
    messages: [
      ...base.messages,
      { role: 'assistant', content: '', toolCalls: [search('c1', 'q')], reasoningContent: 'r' },
      { role: 'tool', toolCallId: 'c1', content: 'found' },
    ],
  });
  const h = harness({ replies: [() => reply({ text: 'final answer' }), () => reply({ calls: [search('c2', 'again')] })] });
  try {
    const ok = await complete(lastTurn(request()), h.options);
    assert.equal(ok.ok, true);
    assert.equal(ok.toolLoop.final, true);
    assert.equal(JSON.parse(h.chats()[0].body).tool_choice, 'none');
    assert.ok(Array.isArray(JSON.parse(h.chats()[0].body).tools), 'tools stay declared so the history stays valid');
    const bad = await complete(lastTurn(request({ toolLoop: { id: 'loop-2' } })), h.options);
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'provider_error');
    assert.equal(bad.error.retryable, true);
    near(bad.costUsd, CALL_COST);
    assert.equal(bad.toolLoop.final, true);
    assert.equal(h.ledger()[1].error, 'provider_error');
    near(h.ledger()[1].costUsd, CALL_COST);
  } finally {
    h.done();
  }
});

test('a spent tool-call budget makes the turn final even before maxTurns', async () => {
  const h = harness({ replies: [() => reply({ text: 'done' })] });
  try {
    const base = request({ toolLoop: { id: 'loop-3', maxTurns: 8, maxToolCalls: 2 } });
    const result = await complete(
      {
        ...base,
        messages: [
          ...base.messages,
          { role: 'assistant', content: '', toolCalls: [search('a', '1'), search('b', '2')] },
          { role: 'tool', toolCallId: 'a', content: 'x' },
          { role: 'tool', toolCallId: 'b', content: 'y' },
        ],
      },
      h.options,
    );
    assert.equal(result.ok, true);
    assert.equal(result.toolLoop.final, true);
    assert.equal(result.toolLoop.turn, 2);
    assert.equal(JSON.parse(h.chats()[0].body).tool_choice, 'none');
  } finally {
    h.done();
  }
});

test('calls beyond the per-turn or remaining loop cap are dropped and reported', async () => {
  const four = [search('k1', 'a'), search('k2', 'b'), search('k3', 'c'), search('k4', 'd')];
  const h = harness({ replies: [() => reply({ calls: four }), () => reply({ calls: four })] });
  try {
    const perTurn = await complete(request(), h.options);
    assert.equal(perTurn.ok, true);
    assert.deepEqual(perTurn.toolCalls, four.slice(0, 3));
    assert.deepEqual(perTurn.assistantMessage.toolCalls, four.slice(0, 3));
    assert.equal(perTurn.toolLoop.toolCallsDropped, 1);
    assert.equal(h.ledger()[0].toolCalls, 3);
    // Two calls left of maxToolCalls 6 after one earlier turn of four.
    const base = request({ toolLoop: { id: 'loop-r', maxTurns: 4, maxToolCallsPerTurn: 8, maxToolCalls: 6 } });
    const remaining = await complete(
      {
        ...base,
        messages: [
          ...base.messages,
          { role: 'assistant', content: '', toolCalls: [search('e1', '1'), search('e2', '2'), search('e3', '3'), search('e4', '4')] },
          ...['e1', 'e2', 'e3', 'e4'].map((id) => ({ role: 'tool', toolCallId: id, content: 'r' })),
        ],
      },
      h.options,
    );
    assert.equal(remaining.ok, true, JSON.stringify(remaining));
    assert.equal(remaining.toolCalls.length, 2);
    assert.equal(remaining.toolLoop.toolCalls, 6);
    assert.equal(remaining.toolLoop.toolCallsDropped, 2);
  } finally {
    h.done();
  }
});

test('toolLoop.maxUsd refuses a turn as budget_cap before sending, from the ledger spend of that loop', async () => {
  const h = harness({ replies: [() => reply({ text: 'ok' })] });
  try {
    mkdirSync(join(h.dir, 'state', 'offload'), { recursive: true });
    const line = (loopId, caller, costUsd) =>
      JSON.stringify({
        ts: '2026-10-04T10:00:00.000Z',
        caller,
        tag: 't',
        route: 'deepseek-flash',
        model: 'm',
        usage: null,
        costUsd,
        latencyMs: 1,
        error: null,
        loopId,
        turn: 1,
        toolCalls: 1,
      });
    writeFileSync(
      h.ledgerPath,
      [line('loop-cap', 'canvas', 0.0499), line('loop-cap', 'someone-else', 9), line('loop-other', 'canvas', 9)].join('\n') + '\n',
    );
    near(await toolLoopSpend(h.ledgerPath, 'canvas', 'loop-cap'), 0.0499);
    const capped = await complete(request({ toolLoop: { id: 'loop-cap', maxUsd: 0.05 } }), h.options);
    assert.equal(capped.ok, false);
    assert.equal(capped.error.code, 'budget_cap');
    assert.equal(completeExitCode(capped), 18);
    near(capped.toolLoop.costUsd, 0.0499);
    assert.equal(capped.toolLoop.maxUsd, 0.05);
    assert.equal(h.chats().length, 0);
    assert.equal(h.ledger().at(-1).error, 'budget_cap');
    assert.equal(h.ledger().at(-1).loopId, 'loop-cap');
    const roomy = await complete(request({ toolLoop: { id: 'loop-cap', maxUsd: 1 } }), h.options);
    assert.equal(roomy.ok, true);
    near(roomy.toolLoop.costUsd, 0.0499 + CALL_COST);
  } finally {
    h.done();
  }
});

test('the daily caller cap still applies to tool-loop turns', async () => {
  const h = harness({ config: { ...CONFIG, complete: { dailyUsdByCaller: { canvas: 0.000001 } } } });
  try {
    const result = await complete(request(), h.options);
    assert.equal(result.error.code, 'budget_cap');
    assert.equal(result.toolLoop.turn, 1);
    assert.equal(h.chats().length, 0);
  } finally {
    h.done();
  }
});

test('malformed tool calls from the model are retryable provider_errors that keep billed usage', async () => {
  const cases = [
    () => reply({ calls: [{ id: 'x1', name: 'shell', arguments: '{}' }] }),
    () => reply({ calls: [{ id: 'x2', name: 'web_search', arguments: '{"query":' }] }),
    () => reply({ calls: [{ id: 'x3', name: 'web_search', arguments: '["not","object"]' }] }),
    () => reply({ calls: [{ id: '', name: 'web_search', arguments: '{}' }] }),
    () => reply({ calls: [search('dup', 'a'), search('dup', 'b')] }),
    () => reply({ finish: 'tool_calls' }),
  ];
  const h = harness({ replies: [...cases] });
  try {
    for (let index = 0; index < cases.length; index++) {
      const result = await complete(request({ toolLoop: { id: `bad-${index}` } }), h.options);
      assert.equal(result.ok, false, `case ${index}`);
      assert.equal(result.error.code, 'provider_error', `case ${index}`);
      assert.equal(result.error.retryable, true, `case ${index}`);
      near(result.costUsd, CALL_COST);
      assert.equal(result.toolLoop.id, `bad-${index}`);
    }
    assert.equal(h.ledger().length, cases.length);
  } finally {
    h.done();
  }
});

test('a tool call id reused from the history is rejected', async () => {
  const h = harness({ replies: [() => reply({ calls: [search('c1', 'again')] })] });
  try {
    const base = request();
    const result = await complete(
      {
        ...base,
        messages: [
          ...base.messages,
          { role: 'assistant', content: '', toolCalls: [search('c1', 'q')] },
          { role: 'tool', toolCallId: 'c1', content: 'r' },
        ],
      },
      h.options,
    );
    assert.equal(result.error.code, 'provider_error');
  } finally {
    h.done();
  }
});

test('a tool loop with thinking disabled replays the explicit null reasoning_content', async () => {
  const h = harness({
    replies: [() => reply({ reasoningNull: true, calls: [search('n1', 'q')] }), () => reply({ reasoningNull: true, text: 'answer' })],
  });
  try {
    const base = request({ reasoning: { enabled: false } });
    const first = await complete(base, h.options);
    assert.equal(first.assistantMessage.reasoningContent, null);
    await complete(followUp(base, first), h.options);
    const wire = JSON.parse(h.chats()[1].body);
    assert.equal(wire.messages[2].reasoning_content, null);
    assert.deepEqual(wire.thinking, { type: 'disabled' });
  } finally {
    h.done();
  }
});

test('a truncated tool-loop turn keeps the partial text and the loop summary', async () => {
  const h = harness({ replies: [() => reply({ text: 'partial', finish: 'length' })] });
  try {
    const truncated = await complete(request(), h.options);
    assert.equal(truncated.error.code, 'truncated');
    assert.equal(truncated.text, 'partial');
    assert.equal(truncated.toolLoop.turn, 1);
    near(truncated.toolLoop.costUsd, CALL_COST);
  } finally {
    h.done();
  }
});

test('invalid tool requests are rejected before any network call', async () => {
  const h = harness();
  const withHistory = (extra, overrides = {}) => {
    const base = request(overrides);
    return { ...base, messages: [...base.messages, ...extra] };
  };
  try {
    const bad = [
      request({ tools: undefined }), // toolLoop without tools
      request({ toolLoop: undefined }),
      request({ toolLoop: { maxTurns: 2 } }), // no id
      request({ toolLoop: { id: 'bad id' } }),
      request({ toolLoop: { id: 'l', maxTurns: 0 } }),
      request({ toolLoop: { id: 'l', maxTurns: 33 } }),
      request({ toolLoop: { id: 'l', maxToolCallsPerTurn: 1.5 } }),
      request({ toolLoop: { id: 'l', maxToolCalls: 257 } }),
      request({ toolLoop: { id: 'l', maxUsd: 0 } }),
      request({ toolLoop: { id: 'l', maxUsd: '1' } }),
      request({ toolLoop: { id: 'l', extra: 1 } }),
      request({ tools: [] }),
      request({ tools: [{ name: 'has space', parameters: { type: 'object' } }] }),
      request({ tools: [TOOLS[0], TOOLS[0]] }),
      request({ tools: [{ name: 't', parameters: { type: 'string' } }] }),
      request({ tools: [{ name: 't' }] }),
      request({ tools: [{ name: 't', parameters: { type: 'object' }, strict: true }] }),
      request({ tools: [{ name: 't', description: 5, parameters: { type: 'object' } }] }),
      request({ tools: Array.from({ length: 33 }, (_, i) => ({ name: `t${i}`, parameters: { type: 'object' } })) }),
      withHistory([{ role: 'tool', toolCallId: 'nope', content: 'x' }]),
      withHistory([{ role: 'assistant', content: '', toolCalls: [search('a', 'q')] }]), // unanswered, last is assistant
      withHistory([
        { role: 'assistant', content: '', toolCalls: [search('a', 'q'), search('b', 'q')] },
        { role: 'tool', toolCallId: 'a', content: 'x' },
      ]),
      withHistory([
        { role: 'assistant', content: '', toolCalls: [search('a', 'q')] },
        { role: 'user', content: 'interrupt' },
        { role: 'tool', toolCallId: 'a', content: 'x' },
      ]),
      withHistory([
        { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'undeclared', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'a', content: 'x' },
      ]),
      withHistory([
        { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'web_search', arguments: {} }] },
        { role: 'tool', toolCallId: 'a', content: 'x' },
      ]),
      withHistory([
        { role: 'assistant', content: '', toolCalls: [] },
        { role: 'user', content: 'x' },
      ]),
      withHistory([
        { role: 'assistant', content: '', reasoningContent: 5 },
        { role: 'user', content: 'x' },
      ]),
      withHistory([{ role: 'tool', toolCallId: 'a', content: 'x', name: 'web_search' }]),
      withHistory([{ role: 'user', content: 'x', toolCallId: 'a' }]),
      withHistory([
        { role: 'assistant', content: '', toolCalls: [search('a', 'q')] },
        { role: 'tool', toolCallId: 'a', content: 'x' },
        { role: 'assistant', content: '', toolCalls: [search('a', 'q')] }, // duplicate id
        { role: 'tool', toolCallId: 'a', content: 'x' },
      ]),
      // Already used both turns of maxTurns 2.
      withHistory(
        [
          { role: 'assistant', content: '', toolCalls: [search('a', 'q')] },
          { role: 'tool', toolCallId: 'a', content: 'x' },
          { role: 'assistant', content: '', toolCalls: [search('b', 'q')] },
          { role: 'tool', toolCallId: 'b', content: 'x' },
        ],
        { toolLoop: { id: 'l', maxTurns: 2 } },
      ),
      // More calls in the history than maxToolCalls.
      withHistory(
        [
          { role: 'assistant', content: '', toolCalls: [search('a', 'q'), search('b', 'q')] },
          ...['a', 'b'].map((id) => ({ role: 'tool', toolCallId: id, content: 'x' })),
        ],
        { toolLoop: { id: 'l', maxToolCalls: 1 } },
      ),
      // Tool messages and tool fields need declared tools.
      {
        ...withHistory([
          { role: 'assistant', content: '', toolCalls: [search('a', 'q')] },
          { role: 'tool', toolCallId: 'a', content: 'x' },
        ]),
        tools: undefined,
        toolLoop: undefined,
      },
    ];
    for (const value of bad) {
      const result = await complete(value, h.options);
      assert.equal(result.ok, false, JSON.stringify(value));
      assert.equal(result.error.code, 'invalid_request', JSON.stringify(value));
      assert.equal(result.toolLoop, undefined);
    }
    assert.equal(h.chats().length, 0);
    assert.equal(h.ledger().length, 0);
    const normalized = validateCompleteRequest(request({ toolLoop: { id: 'defaults' } }));
    assert.deepEqual(normalized.toolLoop, { id: 'defaults', maxTurns: 8, maxToolCallsPerTurn: 8, maxToolCalls: 32 });
  } finally {
    h.done();
  }
});

test('validation copies tool schemas, so later caller mutation cannot change what is sent', async () => {
  const h = harness({ replies: [() => reply({ text: 'x' })] });
  try {
    const parameters = { type: 'object', properties: { q: { type: 'string' } } };
    const tools = [{ name: 'lookup', parameters }];
    const pending = complete(request({ tools }), h.options);
    parameters.properties.q.type = 'number';
    assert.equal((await pending).ok, true);
    assert.equal(JSON.parse(h.chats()[0].body).tools[0].function.parameters.properties.q.type, 'string');
  } finally {
    h.done();
  }
});

test('the worst-case estimate counts tool schemas, reasoning and arguments', async () => {
  const h = harness();
  try {
    const plain = await completeDryRun({ route: 'deepseek-flash', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }, h.options);
    const withTools = await completeDryRun(
      {
        route: 'deepseek-flash',
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            content: '',
            reasoningContent: 'r'.repeat(5000),
            toolCalls: [{ id: 'a', name: 'web_search', arguments: 'z'.repeat(5000) }],
          },
          { role: 'tool', toolCallId: 'a', content: 'y' },
        ],
        maxTokens: 10,
        caller: 'canvas',
        tools: TOOLS,
        toolLoop: { id: 'dry', maxTurns: 3 },
      },
      h.options,
    );
    assert.equal(withTools.ok, true, JSON.stringify(withTools));
    assert.ok(withTools.maxCostUsd > plain.maxCostUsd + 10_000 * 0.15e-6);
    assert.deepEqual(plain.capabilities, { tools: true });
    assert.deepEqual(withTools.toolLoop, { id: 'dry', turn: 2, maxTurns: 3, final: false, toolCalls: 1, maxToolCalls: 32, costUsd: 0 });
    assert.equal(h.chats().length, 0);
    assert.equal(h.ledger().length, 0);
  } finally {
    h.done();
  }
});

test('cli complete runs a two-turn tool loop through stdin and stdout', async () => {
  const h = harness({ replies: [() => reply({ calls: [search('cli1', 'q')] }), () => reply({ text: 'cli answer' })] });
  const run = async (body) => {
    const out = [];
    const status = await runCli(['complete'], {
      stdin: Readable.from([Buffer.from(JSON.stringify(body))]),
      stdout: { write: (text) => out.push(text) },
      stderr: { write: () => {} },
      createCore: () => {
        throw new Error('core must not be created');
      },
      signalSource: new EventEmitter(),
      completeOptions: h.options,
    });
    return { status, result: JSON.parse(out.join('')) };
  };
  try {
    const first = await run(request());
    assert.equal(first.status, 0);
    assert.equal(first.result.finishReason, 'tool_calls');
    const second = await run(followUp(request(), first.result));
    assert.equal(second.status, 0);
    assert.equal(second.result.text, 'cli answer');
    assert.equal(second.result.toolLoop.turn, 2);
  } finally {
    h.done();
  }
});

test('without tools, reasoning is still dropped and no tool fields appear', async () => {
  const h = harness({ replies: [() => reply({ text: 'plain' })] });
  try {
    const result = await complete(request({ tools: undefined, toolLoop: undefined }), h.options);
    assert.equal(result.ok, true);
    assert.ok(!JSON.stringify(result).includes('THINK-SECRET'));
    for (const key of ['toolCalls', 'assistantMessage', 'toolLoop']) assert.equal(result[key], undefined, key);
    const payload = JSON.parse(h.chats()[0].body);
    assert.equal('tools' in payload, false);
    assert.equal('tool_choice' in payload, false);
    assert.deepEqual(Object.keys(h.ledger()[0]).sort(), [
      'caller',
      'costUsd',
      'error',
      'latencyMs',
      'model',
      'route',
      'tag',
      'ts',
      'usage',
    ]);
  } finally {
    h.done();
  }
});

test('review fixes: prototype role names are invalid_request, not a crash', async () => {
  const h = harness();
  try {
    for (const role of ['toString', 'constructor', '__proto__']) {
      const base = request();
      const result = await complete({ ...base, messages: [...base.messages, { role, content: 'x' }] }, h.options);
      assert.equal(result.error.code, 'invalid_request', role);
    }
    assert.equal(h.chats().length, 0);
  } finally {
    h.done();
  }
});

test('review fixes: a parameterless call with no argument text is returned and replayed as "{}"', async () => {
  const h = harness({ replies: [() => reply({ calls: [{ id: 'p1', name: 'web_fetch', arguments: '' }] }), () => reply({ text: 'ok' })] });
  try {
    const first = await complete(request(), h.options);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.toolCalls[0].arguments, '{}');
    assert.equal(first.assistantMessage.toolCalls[0].arguments, '{}');
    await complete(followUp(request(), first), h.options);
    assert.equal(JSON.parse(h.chats()[1].body).messages[2].tool_calls[0].function.arguments, '{}');
  } finally {
    h.done();
  }
});

test('review fixes: a malformed call past the per-turn cap is dropped, not fatal', async () => {
  const h = harness({ replies: [() => reply({ calls: [search('ok1', 'a'), { id: 'bad', name: 'undeclared', arguments: '{' }] })] });
  try {
    const result = await complete(request({ toolLoop: { id: 'cap1', maxToolCallsPerTurn: 1 } }), h.options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.toolCalls, [search('ok1', 'a')]);
    assert.equal(result.toolLoop.toolCallsDropped, 1);
  } finally {
    h.done();
  }
});

test('review fixes: a failure before the model list resolves still reports the loop spend so far', async () => {
  const h = harness({ models: () => jsonResponse({ error: { message: 'slow down' } }, 429) });
  try {
    mkdirSync(join(h.dir, 'state', 'offload'), { recursive: true });
    writeFileSync(
      h.ledgerPath,
      JSON.stringify({
        ts: '2026-10-05T10:00:00.000Z',
        caller: 'canvas',
        tag: 't',
        route: 'deepseek-flash',
        model: 'm',
        usage: null,
        costUsd: 0.4,
        latencyMs: 1,
        error: null,
        loopId: 'spent',
        turn: 1,
        toolCalls: 1,
      }) + '\n',
    );
    const result = await complete(request({ toolLoop: { id: 'spent' } }), h.options);
    assert.equal(result.error.code, 'rate_limited');
    near(result.toolLoop.costUsd, 0.4);
  } finally {
    h.done();
  }
});

test('review fixes: maxUsd refuses before any traffic when the ledger cannot be written', async () => {
  const h = harness({ replies: [() => reply({ text: 'x' })] });
  try {
    writeFileSync(join(h.dir, 'not-a-dir'), '');
    const options = { ...h.options, ledgerPath: join(h.dir, 'not-a-dir', 'ledger.jsonl') };
    const capped = await complete(request({ toolLoop: { id: 'w', maxUsd: 1 } }), options);
    assert.equal(capped.error.code, 'invalid_request');
    assert.equal(h.chats().length, 0);
    // Without maxUsd the loop runs and only flags the ledger failure, as plain calls do.
    const uncapped = await complete(request({ toolLoop: { id: 'w' } }), options);
    assert.equal(uncapped.ok, true);
    assert.equal(uncapped.ledgerWriteFailed, true);
  } finally {
    h.done();
  }
});

test('review fixes: the worst case includes the declared tool schemas', async () => {
  const h = harness();
  try {
    const messages = [{ role: 'user', content: 'x' }];
    const plain = await completeDryRun({ route: 'deepseek-flash', messages, maxTokens: 10 }, h.options);
    const tools = await completeDryRun(
      { route: 'deepseek-flash', messages, maxTokens: 10, tools: TOOLS, toolLoop: { id: 'd' } },
      h.options,
    );
    near(tools.maxCostUsd - plain.maxCostUsd, JSON.stringify(TOOLS).length * 0.15e-6);
  } finally {
    h.done();
  }
});

test('review fixes: a reply with no reasoning_content field carries no reasoningContent to replay', async () => {
  const h = harness({ replies: [() => reply({ noReasoning: true, calls: [search('nr', 'q')] })] });
  try {
    const result = await complete(request(), h.options);
    assert.equal(result.ok, true);
    assert.equal('reasoningContent' in result.assistantMessage, false);
  } finally {
    h.done();
  }
});
