import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicMessagesProvider, resolveLatestAnthropicSonnet } from '../../src/provider/anthropic-messages.mjs';
import { ProviderError } from '../../src/provider/openai-chat.mjs';
import { CreditFallbackProvider } from '../../src/provider/fallback.mjs';
import { resolveLatestDeepSeekFlash } from '../../src/core.mjs';

const sseResponse = (events) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

test('Anthropic Messages provider translates the local transcript and normalizes an SSE response', async () => {
  let endpoint, request;
  const provider = new AnthropicMessagesProvider({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-sonnet-5-5',
    retries: 0,
    fetchImpl: async (url, init) => {
      endpoint = url;
      request = { ...init, body: JSON.parse(init.body) };
      return sseResponse([
        { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 11, cache_read_input_tokens: 2 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]);
    },
  });
  const events = [];
  for await (const event of provider.chat({
    messages: [
      { role: 'system', content: 'local-only worker' },
      { role: 'user', content: 'say hello' },
    ],
    tools: [{ type: 'function', function: { name: 'finish', description: 'finish safely', parameters: { type: 'object' } } }],
  }))
    events.push(event);
  assert.equal(endpoint, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers['x-api-key'], 'test-key');
  assert.equal(request.body.model, 'claude-sonnet-5-5');
  assert.equal(request.body.max_tokens, 16_384);
  assert.deepEqual(request.body.system, [{ type: 'text', text: 'local-only worker' }]);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'say hello' }]);
  assert.deepEqual(events, [
    { text: 'hello', model: 'claude-sonnet-5-5' },
    {
      usage: { inputTokens: 11, outputTokens: 3, cacheHitTokens: 2, cacheMissTokens: 9, totalTokens: 14 },
      model: 'claude-sonnet-5-5',
    },
    { providerFinishReason: 'stop' },
  ]);
});

test('Anthropic Messages provider sends parallel tool results in one immediate user message', async () => {
  let request;
  const provider = new AnthropicMessagesProvider({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-sonnet-5-5',
    retries: 0,
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return sseResponse([
        { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 11 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]);
    },
  });
  for await (const _ of provider.chat({
    messages: [
      { role: 'user', content: 'Read both files.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'toolu_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
          { id: 'toolu_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.js"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_a', name: 'read_file', content: 'contents of a' },
      { role: 'tool', tool_call_id: 'toolu_b', name: 'read_file', content: 'contents of b' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'read a file', parameters: { type: 'object' } } }],
  })) {
  }
  assert.deepEqual(request.messages, [
    { role: 'user', content: 'Read both files.' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a.js' } },
        { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: { path: 'b.js' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: 'contents of a' },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: 'contents of b' },
      ],
    },
  ]);
});

test('Anthropic Messages provider preserves adaptive thinking blocks for the following tool-result turn', async () => {
  const requests = [];
  let turn = 0;
  const provider = new AnthropicMessagesProvider({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-sonnet-5-5',
    retries: 0,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      turn++;
      if (turn === 1)
        return sseResponse([
          { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Inspect the file first.' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'thought-signature' } },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_read', name: 'read_file' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.js"}' } },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
          { type: 'message_stop' },
        ]);
      return sseResponse([
        { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 20 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]);
    },
  });
  const first = [];
  for await (const event of provider.chat({
    messages: [{ role: 'user', content: 'Inspect a.js.' }],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'read a file', parameters: { type: 'object' } } }],
  }))
    first.push(event);
  const replay = first.find((event) => event.anthropicContent)?.anthropicContent;
  assert.deepEqual(replay, [
    { type: 'thinking', thinking: 'Inspect the file first.', signature: 'thought-signature' },
    { type: 'tool_use', id: 'toolu_read', name: 'read_file', input: '{"path":"a.js"}' },
  ]);
  for await (const _ of provider.chat({
    messages: [
      { role: 'user', content: 'Inspect a.js.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'toolu_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }],
        anthropic_content: replay,
      },
      { role: 'tool', tool_call_id: 'toolu_read', name: 'read_file', content: 'export const a = 1;' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'read a file', parameters: { type: 'object' } } }],
  })) {
  }
  assert.deepEqual(requests[1].messages, [
    { role: 'user', content: 'Inspect a.js.' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Inspect the file first.', signature: 'thought-signature' },
        { type: 'tool_use', id: 'toolu_read', name: 'read_file', input: { path: 'a.js' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'export const a = 1;' }] },
  ]);
});

test('Anthropic discovery chooses the newest listed concrete Sonnet model and refuses a credit error', async () => {
  const endpoints = [];
  const selected = await resolveLatestAnthropicSonnet({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      endpoints.push(url);
      return new Response(
        JSON.stringify({
          data: [
            { id: 'claude-sonnet-5-5', line: 'sonnet' },
            { id: 'claude-sonnet-5-4', line: 'sonnet' },
          ],
        }),
      );
    },
  });
  assert.equal(selected, 'claude-sonnet-5-5');
  assert.equal(new URL(endpoints[0]).searchParams.get('lifecycle'), 'active');
  const pagedEndpoints = [];
  const paged = await resolveLatestAnthropicSonnet({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      pagedEndpoints.push(url);
      return pagedEndpoints.length === 1
        ? new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5', line: 'opus' }], has_more: true, last_id: 'claude-opus-5-5' }))
        : new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5', line: 'sonnet' }] }));
    },
  });
  assert.equal(paged, 'claude-sonnet-5-5');
  assert.equal(new URL(pagedEndpoints[1]).searchParams.get('after_id'), 'claude-opus-5-5');
  const compatibilityEndpoints = [];
  const compatible = await resolveLatestAnthropicSonnet({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      compatibilityEndpoints.push(url);
      return compatibilityEndpoints.length === 1
        ? new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), { status: 400 })
        : new Response(
            JSON.stringify({
              data: [
                { id: 'claude-sonnet-5-4', line: 'sonnet', lifecycle: 'deprecated' },
                { id: 'claude-sonnet-5-3', line: 'sonnet', lifecycle: 'active' },
              ],
            }),
          );
    },
  });
  assert.equal(compatible, 'claude-sonnet-5-3');
  assert.equal(new URL(compatibilityEndpoints[0]).searchParams.get('lifecycle'), 'active');
  assert.equal(new URL(compatibilityEndpoints[1]).searchParams.has('lifecycle'), false);
  const provider = new AnthropicMessagesProvider({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-sonnet-5-5',
    retries: 0,
    fetchImpl: async () => new Response(JSON.stringify({ error: { type: 'credit_balance_too_low' } }), { status: 400 }),
  });
  await assert.rejects(
    async () => {
      for await (const _ of provider.chat({ messages: [], tools: [] })) {
      }
    },
    (error) => error instanceof ProviderError && error.kind === 'credit_exhausted',
  );
});

test('credit fallback switches once and keeps the concrete fallback model for the job', async () => {
  const seen = [];
  const provider = new CreditFallbackProvider({
    primary: {
      async *chat() {
        throw new ProviderError('credit exhausted', { kind: 'credit_exhausted' });
      },
    },
    fallback: {
      async *chat(request) {
        seen.push(request.model);
        yield { text: 'fallback', model: 'deepseek-flash' };
      },
    },
    primaryModel: 'claude-sonnet-5-5',
    fallbackModel: 'deepseek-flash',
  });
  const first = [];
  for await (const event of provider.chat({ messages: [], tools: [] })) first.push(event);
  assert.deepEqual(first, [{ text: 'fallback', model: 'deepseek-flash' }]);
  assert.equal(provider.fallbackUsed, true);
  assert.equal(provider.allowsResponseModel('claude-sonnet-5-5', 'deepseek-flash'), true);
  const second = [];
  for await (const event of provider.chat({ messages: [], tools: [] })) second.push(event);
  assert.deepEqual(seen, ['deepseek-flash', 'deepseek-flash']);
  assert.deepEqual(second, [{ text: 'fallback', model: 'deepseek-flash' }]);
});

test('DeepSeek discovery snapshots only the provider-maintained Flash route', async () => {
  let endpoint, init;
  const model = await resolveLatestDeepSeekFlash({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      endpoint = url;
      init = options;
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-flash' }] }));
    },
  });
  assert.equal(model, 'deepseek-flash');
  assert.equal(endpoint, 'https://api.deepseek.com/models');
  assert.equal(init.headers.authorization, 'Bearer test-key');
  await assert.rejects(
    () =>
      resolveLatestDeepSeekFlash({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'test-key',
        fetchImpl: async () => new Response('{"data":[]}'),
      }),
    /No provider-maintained DeepSeek Flash model/,
  );
});
