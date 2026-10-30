import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenAIChatProvider } from '../../src/provider/openai-chat.mjs';
import { createMockOpenAIServer } from '../mock-openai-server.mjs';
import { LocalTools } from '../../src/agent/tools.mjs';
import { AgentLoop } from '../../src/agent/loop.mjs';

const tool = (index, id, name, args) => ({
  choices: [
    {
      delta: { tool_calls: [{ index, ...(id ? { id, type: 'function' } : {}), function: { ...(name ? { name } : {}), arguments: args } }] },
    },
  ],
});
async function mockOrSkip(t, scripts) {
  try {
    return await createMockOpenAIServer(scripts);
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('loopback networking is unavailable in this sandbox');
      return null;
    }
    throw error;
  }
}
test('streaming fragmented calls, reasoning passback, tools, and mandatory finish', async (t) => {
  const server = await mockOrSkip(t, [
    {
      comments: ['keep alive'],
      chunks: [
        { model: 'mock', choices: [{ delta: { reasoning_content: 'inspect first' } }] },
        tool(0, 'read1', 'write_file', '{"path":"out.txt",'),
        tool(0, null, null, '"content":"hello"}'),
        {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 9, completion_tokens: 2, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 6 },
        },
      ],
    },
    {
      chunks: [
        tool(0, 'end1', 'finish', '{"summary":"done","concerns":[],"testsRun":[]}'),
        { model: 'mock', choices: [{ delta: {} }], usage: { prompt_tokens: 2, completion_tokens: 1 } },
      ],
    },
  ]);
  if (!server) return;
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-loop-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const loop = new AgentLoop({
      provider: new OpenAIChatProvider({ baseUrl: server.baseUrl, apiKey: 'x', model: 'mock' }),
      tools: new LocalTools({ repoPath: dir, ownedPaths: ['*.txt'] }),
      model: 'mock',
    });
    const result = await loop.run({ system: 'system', task: 'write it' });
    assert.equal(result.status, 'DONE');
    assert.equal(await readFile(path.join(dir, 'out.txt'), 'utf8'), 'hello');
    assert.equal(result.usage.cacheHitTokens, 3);
    assert.equal(server.requests.length, 2);
    const history = server.requests[1].body.messages;
    const assistant = history.find((m) => m.role === 'assistant');
    assert.equal(assistant.reasoning_content, 'inspect first');
    assert.equal(assistant.content, '');
  } finally {
    await server.close();
  }
});
test('provider retries 5xx and loop rejects a final answer without finish', async (t) => {
  const server = await mockOrSkip(t, [
    { status: 500 },
    {
      chunks: [
        { choices: [{ delta: { content: 'I am done' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ],
    },
  ]);
  if (!server) return;
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'offload-loop-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const result = await new AgentLoop({
      provider: new OpenAIChatProvider({ baseUrl: server.baseUrl, model: 'mock', retries: 1 }),
      tools: new LocalTools({ repoPath: dir, ownedPaths: ['**'] }),
      model: 'mock',
    }).run({ task: 'x' });
    assert.equal(result.status, 'FAILED');
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});
test('provider treats auth failures as fatal', async (t) => {
  const server = await mockOrSkip(t, [{ status: 401 }, { chunks: [] }]);
  if (!server) return;
  try {
    const provider = new OpenAIChatProvider({ baseUrl: server.baseUrl, model: 'mock', retries: 2 });
    await assert.rejects(async () => {
      for await (const _ of provider.chat({ messages: [], tools: [] })) {
      }
    }, /401/);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});
test('provider retries 429, times out mid-stream, and rejects incompatible thinking tool choice', async (t) => {
  const server = await mockOrSkip(t, [
    { status: 429 },
    { chunks: [{ choices: [{ delta: { content: 'x' } }] }] },
    { chunks: [{ choices: [{ delta: { content: 'partial' } }] }], stallAfterChunks: 1, stallMs: 100 },
  ]);
  if (!server) return;
  try {
    const provider = new OpenAIChatProvider({ baseUrl: server.baseUrl, model: 'mock', retries: 1 });
    for await (const _ of provider.chat({ messages: [], tools: [] })) {
    }
    assert.equal(server.requests.length, 2);
    await assert.rejects(async () => {
      for await (const _ of new OpenAIChatProvider({ baseUrl: server.baseUrl, model: 'mock', timeoutMs: 5, retries: 0 }).chat({
        messages: [],
        tools: [],
      })) {
      }
    }, /timed out|failed/i);
    await assert.rejects(async () => {
      for await (const _ of provider.chat({ messages: [], tools: [], thinking: { type: 'enabled' }, tool_choice: 'required' })) {
      }
    }, /does not support/);
  } finally {
    await server.close();
  }
});
test('provider honours cancellation during a mid-stream stall', async (t) => {
  const server = await mockOrSkip(t, [
    { chunks: [{ choices: [{ delta: { content: 'partial' } }] }], stallAfterChunks: 1, stallMs: 60_000 },
  ]);
  if (!server) return;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('cancelled by test')), 10);
    const provider = new OpenAIChatProvider({ baseUrl: server.baseUrl, model: 'mock', retries: 0, timeoutMs: 60_000 });
    await assert.rejects(async () => {
      for await (const _ of provider.chat({ messages: [], tools: [], signal: controller.signal })) {
      }
    }, /cancelled by test/);
  } finally {
    await server.close();
  }
});

test('a provider body that hangs mid-stream ends at attemptTimeoutMs, and a cancel ends it at once', async (t) => {
  const script = { chunks: [{ choices: [{ delta: { content: 'partial' } }] }, { choices: [{ delta: {} }] }], hangAfterChunks: 1 };
  const server = await mockOrSkip(t, [script, script]);
  if (!server) return;
  try {
    const timeoutMs = 300;
    const timedOut = await new AgentLoop({
      provider: new OpenAIChatProvider({ baseUrl: server.baseUrl, model: 'mock', timeoutMs, retries: 0 }),
      tools: { execute: async () => '' },
      maxUsd: Infinity,
    }).run({ task: 'x' });
    assert.equal(timedOut.status, 'TIMEOUT');
    assert.equal(timedOut.providerFailure?.kind, 'attempt_timeout');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const cancelled = await new AgentLoop({
      provider: new OpenAIChatProvider({ baseUrl: server.baseUrl, model: 'mock', timeoutMs: 60_000, retries: 0 }),
      tools: { execute: async () => '' },
      signal: controller.signal,
    }).run({ task: 'x' });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.ok(Date.now() - started < 3_000, 'the in-flight request was aborted, not waited out');
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});

test('mock server releases a header-stall timer without starting another stall after cancellation', async (t) => {
  const timers = new Set();
  const schedule = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const timer = schedule(callback, ms, ...args);
    if (ms === 60_000) timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    timers.delete(timer);
    return clear(timer);
  });
  const server = await mockOrSkip(t, [{ stallMs: 60_000, stallAfterChunks: 1, chunks: [{ choices: [{ delta: { content: 'closed' } }] }] }]);
  if (!server) return;
  const controller = new AbortController();
  const pending = new OpenAIChatProvider({ baseUrl: server.baseUrl, model: 'mock', retries: 0 })
    .chat({ messages: [], tools: [], signal: controller.signal })
    .next();
  // Observe a failure immediately, even if an assertion below fails first.
  pending.catch(() => {});
  try {
    for (let i = 0; server.requests.length === 0 && i < 200; i++) await new Promise((resolve) => schedule(resolve, 5));
    assert.equal(server.requests.length, 1);
    assert.equal(timers.size, 1, 'the request is waiting for its headers');
    controller.abort(new Error('cancel fixture request'));
    await assert.rejects(pending, /cancel fixture request/);
    await server.close();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers.size, 0, 'a closed response cannot start the body stall or retain a timer');
  } finally {
    controller.abort();
    await server.close();
    for (const timer of timers) clear(timer);
  }
});
