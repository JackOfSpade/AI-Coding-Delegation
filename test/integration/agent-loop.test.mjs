import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
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
