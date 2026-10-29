import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AnthropicMessagesProvider,
  resolveLatestAnthropicSonnet,
  resolveLatestAnthropicOpus,
} from '../../src/provider/anthropic-messages.mjs';
import { ProviderError, providerFailure } from '../../src/provider/openai-chat.mjs';
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
  assert.deepEqual(request.body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(request.body.thinking, { type: 'adaptive' });
  assert.equal(request.body.max_tokens, 16_384);
  assert.deepEqual(request.body.system, [{ type: 'text', text: 'local-only worker' }]);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'say hello' }]);
  assert.deepEqual(events, [
    { text: 'hello', model: 'claude-sonnet-5-5' },
    {
      usage: { inputTokens: 13, outputTokens: 3, cacheHitTokens: 2, cacheMissTokens: 11, totalTokens: 16 },
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
    routes: [
      {
        provider: {
          async *chat() {
            throw new ProviderError('credit exhausted', { kind: 'credit_exhausted' });
          },
        },
        model: 'claude-sonnet-5-5',
      },
      {
        provider: {
          async *chat(request) {
            seen.push(request.model);
            yield { text: 'fallback', model: 'deepseek-flash' };
          },
        },
        model: 'deepseek-flash',
      },
    ],
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

test('Opus discovery filters by line and uses provider release order across pages', async () => {
  const urls = [];
  const model = await resolveLatestAnthropicOpus({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify(
          urls.length === 1
            ? { data: [{ id: 'claude-sonnet-5-5', line: 'sonnet' }], has_more: true, last_id: 'claude-sonnet-5-5' }
            : {
                data: [
                  { id: 'claude-opus-5-5', line: 'opus' },
                  { id: 'claude-opus-4-8', line: 'opus' },
                ],
              },
        ),
      );
    },
  });
  assert.equal(model, 'claude-opus-5-5');
  assert.equal(new URL(urls[1]).searchParams.get('after_id'), 'claude-sonnet-5-5');
});

for (const streaming of [false, true]) {
  test(`provider transcript corruption is classified without leaking its body (${streaming ? 'SSE' : 'HTTP'})`, async () => {
    let requests = 0;
    const body = { type: 'error', error: { type: 'api_error', message: 'corrupt transcript: invalid interior JSON private-body' } };
    const provider = new AnthropicMessagesProvider({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-5-5',
      retries: 1,
      fetchImpl: async () => {
        requests++;
        return streaming ? sseResponse([body]) : new Response(JSON.stringify(body), { status: 400 });
      },
    });
    await assert.rejects(
      async () => {
        for await (const _ of provider.chat({ messages: [], tools: [], retryLimit: 0 })) {
          /* finite jobs do not auto-spend */
        }
      },
      (error) =>
        error instanceof ProviderError &&
        error.kind === 'transcript_corruption' &&
        error.retryable === true &&
        error.message === 'Provider transcript was corrupt',
    );
    assert.equal(requests, 1);
  });
}

test('an unrelated provider 400 error is never a transcript-corruption retry', async () => {
  const provider = new AnthropicMessagesProvider({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-opus-5-5',
    retries: 1,
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'invalid request' } }), { status: 400 }),
  });
  await assert.rejects(
    async () => {
      for await (const _ of provider.chat({ messages: [], tools: [] })) {
        /* consume */
      }
    },
    (error) => error.kind === 'http' && error.retryable === false,
  );
});

test('automatic worker caching retains the growing prefix and counts disjoint Anthropic cache tokens', async () => {
  const requests = [];
  const provider = new AnthropicMessagesProvider({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-opus-5-5',
    retries: 0,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return sseResponse([
        {
          type: 'message_start',
          message: {
            model: 'claude-opus-5-5',
            usage:
              requests.length === 1
                ? { input_tokens: 10, cache_creation_input_tokens: 5000 }
                : { input_tokens: 2, cache_read_input_tokens: 5000, cache_creation_input_tokens: 20 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]);
    },
  });
  const messages = [{ role: 'user', content: 'long stable prefix '.repeat(2000) }];
  const usages = [];
  for await (const event of provider.chat({ messages, tools: [] })) if (event.usage) usages.push(event.usage);
  messages.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: 'continue' });
  for await (const event of provider.chat({ messages, tools: [] })) if (event.usage) usages.push(event.usage);
  for (const request of requests) assert.deepEqual(request.cache_control, { type: 'ephemeral' });
  assert.deepEqual(requests[1].messages.slice(0, 1), requests[0].messages);
  assert.deepEqual(usages, [
    { inputTokens: 5010, cacheHitTokens: 0, cacheMissTokens: 5010, cacheWriteTokens: 5000, outputTokens: 3, totalTokens: 5013 },
    { inputTokens: 5022, cacheHitTokens: 5000, cacheMissTokens: 22, cacheWriteTokens: 20, outputTokens: 3, totalTokens: 5025 },
  ]);
});

test('invalid Anthropic cache counters fail closed', async () => {
  for (const usage of [
    { input_tokens: 1, cache_creation_input_tokens: -1 },
    { input_tokens: 1, cache_read_input_tokens: 1.5 },
    { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1 },
  ]) {
    const provider = new AnthropicMessagesProvider({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-5-5',
      retries: 0,
      fetchImpl: async () =>
        sseResponse([
          { type: 'message_start', message: { model: 'claude-opus-5-5', usage } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]),
    });
    await assert.rejects(async () => {
      for await (const _ of provider.chat({ messages: [], tools: [] })) {
      }
    }, /cache usage/);
  }
});

/** A 200 response whose SSE body sends one event and then never ends, until its request is aborted. */
const hangingFetch =
  (counter) =>
  async (_url, { signal }) => {
    counter.fetches += 1;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } })}\n\n`),
        );
        signal.addEventListener('abort', () => controller.error(signal.reason ?? new Error('aborted')), { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
const drain = async (provider, options = {}) => {
  for await (const _ of provider.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], ...options })) {
  }
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('Anthropic: a response body that hangs mid-stream ends at attemptTimeoutMs as attempt_timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const counter = { fetches: 0 };
  const provider = new AnthropicMessagesProvider({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-sonnet-5-5',
    timeoutMs: 300_000,
    retries: 0,
    fetchImpl: hangingFetch(counter),
  });
  let outcome;
  const pending = drain(provider).then(
    () => (outcome = 'resolved'),
    (error) => (outcome = error),
  );
  for (let index = 0; index < 5; index += 1) await settle();
  assert.equal(counter.fetches, 1);
  t.mock.timers.tick(299_999);
  for (let index = 0; index < 5; index += 1) await settle();
  assert.equal(outcome, undefined, 'still within the attempt limit');
  t.mock.timers.tick(1);
  await pending;
  assert.ok(outcome instanceof ProviderError, String(outcome));
  assert.equal(outcome.kind, 'attempt_timeout');
  assert.equal(outcome.timeoutMs, 300_000);
  assert.equal(outcome.attempts, 1);
});

test('Anthropic: an already-aborted signal sends no request, and a cancel mid-stream ends it at once', async () => {
  const counter = { fetches: 0 };
  const provider = new AnthropicMessagesProvider({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-sonnet-5-5',
    timeoutMs: 300_000,
    retries: 3,
    fetchImpl: hangingFetch(counter),
  });
  const cancelled = new Error('job cancelled');
  await assert.rejects(drain(provider, { signal: AbortSignal.abort(cancelled) }), (error) => error === cancelled);
  assert.equal(counter.fetches, 0, 'nothing was sent after the cancel');
  const controller = new AbortController();
  const started = Date.now();
  const pending = drain(provider, { signal: controller.signal });
  setTimeout(() => controller.abort(cancelled), 50);
  await assert.rejects(pending, (error) => error === cancelled, 'the cancel, not a retry or a timeout, ends the request');
  assert.ok(Date.now() - started < 2_000);
  assert.equal(counter.fetches, 1, 'a cancel is never retried');
});

// Regression: oj-20261021-458f1a7c. A capped continuation that ran out of
// max_tokens mid tool_use failed as an opaque `request` provider failure
// instead of reaching the loop's output-cap recovery.
const cappedProvider = (events) =>
  new AnthropicMessagesProvider({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-opus-5-5',
    retries: 0,
    fetchImpl: async () => sseResponse(events),
  });
const collect = async (provider, messages = [{ role: 'user', content: 'Edit a.js.' }]) => {
  const events = [];
  for await (const event of provider.chat({
    messages,
    tools: [{ type: 'function', function: { name: 'write_file', description: 'write a file', parameters: { type: 'object' } } }],
  }))
    events.push(event);
  return events;
};
const truncatedToolUse = (stopReason) => [
  { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Write the file.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_write', name: 'write_file' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.js","content":"export const' } },
  { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 16_384 } },
  { type: 'message_stop' },
];

test('Anthropic: max_tokens mid tool_use drops the fragment and reports a length finish', async () => {
  const events = await collect(cappedProvider(truncatedToolUse('max_tokens')));
  assert.equal(
    events.some((event) => event.toolCalls),
    false,
  );
  assert.deepEqual(events.find((event) => event.anthropicContent)?.anthropicContent, [
    { type: 'thinking', thinking: 'Write the file.', signature: 'sig' },
  ]);
  assert.deepEqual(events.at(-1), { providerFinishReason: 'length' });
});

test('Anthropic: incomplete tool JSON without a cap is a non-retryable response failure with a redacted reason', async () => {
  await assert.rejects(collect(cappedProvider(truncatedToolUse('tool_use'))), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.deepEqual(providerFailure(error), {
      kind: 'response',
      retryable: false,
      reason: 'incomplete_anthropic_tool_json',
    });
    return true;
  });
});

test('Anthropic: an unsigned thinking block cut by max_tokens is dropped and never replayed as an empty turn', async () => {
  const events = await collect(
    cappedProvider([
      { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Still planning' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 16_384 } },
      { type: 'message_stop' },
    ]),
  );
  assert.equal(
    events.some((event) => event.anthropicContent || event.text || event.toolCalls),
    false,
  );
  assert.deepEqual(events.at(-1), { providerFinishReason: 'length' });
  let request;
  const replay = new AnthropicMessagesProvider({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-opus-5-5',
    retries: 0,
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return sseResponse(truncatedToolUse('max_tokens'));
    },
  });
  await collect(replay, [
    { role: 'user', content: 'Edit a.js.' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'Continue using an allowed tool call.' },
  ]);
  assert.deepEqual(request.messages, [
    { role: 'user', content: 'Edit a.js.' },
    { role: 'user', content: 'Continue using an allowed tool call.' },
  ]);
});

for (const [label, status, error, exhausted] of [
  [
    'explicit balance message',
    400,
    { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.' },
    true,
  ],
  ['payment failure without exhaustion', 402, { type: 'billing_error', message: 'Payment method declined' }, false],
  ['explicit credit code on 402', 402, { type: 'billing_error', code: 'insufficient_credit' }, true],
  ['code behind generic type', 400, { type: 'invalid_request_error', code: 'insufficient_credit' }, true],
  ['unrelated invalid request', 400, { type: 'invalid_request_error', message: 'Invalid tool schema' }, false],
  ['credit mention only', 400, { type: 'invalid_request_error', message: 'Please check your credits or billing settings' }, false],
  [
    'authentication with balance text',
    401,
    { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' },
    false,
  ],
  ['authentication envelope with credit code', 400, { type: 'authentication_error', code: 'insufficient_credit' }, false],
  ['authentication code', 403, { type: 'insufficient_credit' }, false],
  ['server failure', 500, { type: 'credit_balance_too_low' }, false],
  ['unsupported request', 400, { type: 'invalid_request_error', message: 'Thinking is not supported' }, false],
])
  test(`exhaustion classification: ${label}`, async () => {
    const provider = new AnthropicMessagesProvider({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-5-5',
      retries: 0,
      fetchImpl: async () => new Response(JSON.stringify({ error }), { status }),
    });
    await assert.rejects(
      async () => {
        for await (const _ of provider.chat({ messages: [], tools: [] })) {
        }
      },
      (failure) => {
        assert.equal(failure.kind, exhausted ? 'credit_exhausted' : 'http');
        assert.doesNotMatch(JSON.stringify(providerFailure(failure)), /Plans|Billing|balance|schema/);
        return true;
      },
    );
  });

test('fallback refuses partial streams, transport and ordinary HTTP errors', async () => {
  for (const kind of ['http', 'transport', 'partial']) {
    let transitions = 0,
      fallbackCalls = 0;
    const provider = new CreditFallbackProvider({
      routes: [
        {
          provider: {
            async *chat() {
              if (kind === 'partial') yield { text: 'partial' };
              throw new ProviderError('fixed failure', { kind: kind === 'partial' ? 'credit_exhausted' : kind, status: 400 });
            },
          },
          model: 'claude-sonnet-5-5',
        },
        {
          provider: {
            async *chat() {
              fallbackCalls++;
              yield { text: 'unexpected' };
            },
          },
          model: 'deepseek-flash',
        },
      ],
      onTransition: () => {
        transitions++;
      },
    });
    await assert.rejects(async () => {
      for await (const _ of provider.chat({ messages: [] })) {
      }
    });
    assert.equal(transitions, 0);
    assert.equal(fallbackCalls, 0);
  }
});
