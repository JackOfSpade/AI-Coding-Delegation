import test from 'node:test';
import assert from 'node:assert/strict';
import { sseJson } from '../../src/provider/sse.mjs';
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  OpenAIChatProvider,
  ProviderError,
  normalizeProviderFinishReason,
  normalizeUsage,
  providerFailure,
} from '../../src/provider/openai-chat.mjs';

test('provider attempt timeout defaults and exposes only bounded numeric metadata', () => {
  const provider = new OpenAIChatProvider({ baseUrl: 'https://example.test', model: 'm' });
  assert.equal(provider.timeoutMs, DEFAULT_ATTEMPT_TIMEOUT_MS);
  assert.equal(
    new OpenAIChatProvider({ baseUrl: 'https://example.test', model: 'm', timeoutMs: null }).timeoutMs,
    DEFAULT_ATTEMPT_TIMEOUT_MS,
  );
  assert.deepEqual(providerFailure(new ProviderError('timeout', { kind: 'attempt_timeout', attempts: 1, timeoutMs: 300_000 })), {
    kind: 'attempt_timeout',
    attempts: 1,
    timeoutMs: 300_000,
  });
  assert.deepEqual(
    providerFailure(
      new ProviderError('timeout', { kind: 'attempt_timeout', attempts: 1, timeoutMs: 1, endpoint: 'https://secret.invalid' }),
    ),
    { kind: 'attempt_timeout', attempts: 1 },
  );
});

test('SSE handles split UTF-8 and CRLF event boundaries', async () => {
  const bytes = new TextEncoder().encode('data: {"word":"é"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 16));
      controller.enqueue(bytes.slice(16, 18));
      controller.enqueue(bytes.slice(18));
      controller.close();
    },
  });
  const values = [];
  for await (const value of sseJson(stream)) values.push(value);
  assert.deepEqual(values, [{ word: 'é' }]);
});
test('SSE recognizes CR-only delimiters and CRLF split across chunks', async () => {
  const encoder = new TextEncoder();
  const crOnly = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"line":"cr"}\r\rdata: [DONE]\r\r'));
      controller.close();
    },
  });
  const crValues = [];
  for await (const value of sseJson(crOnly)) crValues.push(value);
  assert.deepEqual(crValues, [{ line: 'cr' }]);

  const split = new ReadableStream({
    start(controller) {
      for (const chunk of ['data: {"line":"crlf"}\r', '\n\r', '\ndata: [DONE]\r', '\n\r\n']) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const splitValues = [];
  for await (const value of sseJson(split)) splitValues.push(value);
  assert.deepEqual(splitValues, [{ line: 'crlf' }]);
});
test('usage favors prompt_tokens_details and unknown prices are representable', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 7 } }), {
    inputTokens: 10,
    outputTokens: 2,
    cacheHitTokens: 7,
    cacheMissTokens: 3,
    totalTokens: 12,
  });
});
test('provider finish reasons use a closed diagnostics-only vocabulary', () => {
  assert.equal(normalizeProviderFinishReason('stop'), 'stop');
  assert.equal(normalizeProviderFinishReason('content_filter'), 'content_filter');
  assert.equal(normalizeProviderFinishReason('provider-secret-reason'), 'other');
  assert.equal(normalizeProviderFinishReason(null), undefined);
  assert.equal(normalizeProviderFinishReason({ raw: 'provider-secret-reason' }), undefined);
});
test('usage accepts matching duplicated cache-hit counters across provider aliases', () => {
  for (const [detailsKey, directKey] of [
    ['cached_tokens', 'cache_hit_tokens'],
    ['cached_tokens', 'prompt_cache_hit_tokens'],
    ['cache_hit_tokens', 'prompt_cache_hit_tokens'],
  ]) {
    assert.deepEqual(
      normalizeUsage({
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { [detailsKey]: 7 },
        [directKey]: 7,
      }),
      { inputTokens: 10, outputTokens: 2, cacheHitTokens: 7, cacheMissTokens: 3, totalTokens: 12 },
    );
  }
});
test('usage normalizes the complete DeepSeek Chat Completions usage shape', () => {
  assert.deepEqual(
    normalizeUsage({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 7 },
      prompt_cache_hit_tokens: 7,
      prompt_cache_miss_tokens: 3,
    }),
    { inputTokens: 10, outputTokens: 2, cacheHitTokens: 7, cacheMissTokens: 3, totalTokens: 12 },
  );
});
test('usage rejects conflicting or malformed duplicated cache-hit counters', () => {
  for (const [nestedHit, directHit] of [
    [7, 6],
    [7.5, 7.5],
    [-1, -1],
    [7, 7.5],
  ])
    assert.throws(
      () =>
        normalizeUsage({
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: nestedHit },
          cache_hit_tokens: directHit,
        }),
      /Conflicting usage.cacheHitTokens/,
    );
});
test('usage counters must be safe, internally consistent integers', () => {
  for (const usage of [
    { prompt_tokens: 1.5, completion_tokens: 1 },
    { prompt_tokens: 3, completion_tokens: 1, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 2 },
    { prompt_tokens: 3, completion_tokens: 1, total_tokens: 3 },
  ])
    assert.throws(() => normalizeUsage(usage), /Invalid/);
});
test('usage requires one explicit counter for each billable direction', async () => {
  for (const usage of [
    {},
    { prompt_tokens: 1 },
    { completion_tokens: 1 },
    { prompt_tokens: 1, input_tokens: 1, completion_tokens: 1 },
    { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0, cache_hit_tokens: 0 } },
    { prompt_tokens: 1, completion_tokens: 1, cache_hit_tokens: 0, prompt_cache_hit_tokens: 0 },
  ])
    assert.throws(() => normalizeUsage(usage), /Missing|Ambiguous/);

  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () => new Response('data: {"choices":[],"usage":{}}\n\ndata: [DONE]\n\n', { status: 200 }),
  });
  await assert.rejects(async () => {
    for await (const _ of provider.chat({ messages: [], tools: [] })) {
    }
  }, /Missing usage/);
});
test('provider does not start a pre-aborted request', async () => {
  let calls = 0;
  const signal = AbortSignal.abort(new Error('cancelled'));
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    fetchImpl: async () => {
      calls++;
      throw new Error('should not fetch');
    },
  });
  await assert.rejects(async () => {
    for await (const _ of provider.chat({ messages: [], tools: [], signal })) {
    }
  }, /cancelled/);
  assert.equal(calls, 0);
});
test('provider permits HTTP only for loopback mocks and forbids remote cleartext', () => {
  assert.throws(() => new OpenAIChatProvider({ baseUrl: 'http://api.example.test', model: 'm' }), /HTTPS unless/);
  assert.doesNotThrow(() => new OpenAIChatProvider({ baseUrl: 'http://127.0.0.1:9999', model: 'm' }));
  assert.doesNotThrow(() => new OpenAIChatProvider({ baseUrl: 'http://[::1]:9999', model: 'm' }));
  for (const url of ['https://user:pass@example.test', 'https://example.test/?q=x', 'https://example.test/#fragment'])
    assert.throws(() => new OpenAIChatProvider({ baseUrl: url, model: 'm' }), /credentials, query, or fragment/);
  assert.throws(() => new OpenAIChatProvider({ baseUrl: 'https://example.test', model: 'model\nforged' }), /control-free/);
});
test('provider disables redirects for prompt-bearing POST requests', async () => {
  let init;
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async (_url, options) => {
      init = options;
      return new Response('data: [DONE]\n\n', { status: 200 });
    },
  });
  for await (const _ of provider.chat({ messages: [], tools: [] })) {
  }
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
});
test('provider forwards disabled thinking and permits a named tool choice', async () => {
  let body;
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    thinking: { type: 'disabled' },
    retries: 0,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response('data: [DONE]\n\n', { status: 200 });
    },
  });
  for await (const _ of provider.chat({ messages: [], tools: [], tool_choice: { type: 'function', function: { name: 'echo' } } })) {
  }
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'echo' } });
});
test('official DeepSeek capability is exact and a per-call required-tool focus disables constructor reasoning', async () => {
  let body;
  const provider = new OpenAIChatProvider({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
    thinking: { type: 'enabled' },
    retries: 0,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response('data: [DONE]\n\n', { status: 200 });
    },
  });
  assert.equal(provider.supportsForcedImplementationFocusFor('deepseek-v4-pro'), true);
  assert.equal(
    provider.supportsForcedImplementationFocusFor('deepseek-flash'),
    false,
    'request model must match the configured official model',
  );
  for await (const _ of provider.chat({
    messages: [],
    tools: [],
    thinking: { type: 'disabled' },
    reasoning_effort: 'none',
    tool_choice: 'required',
  })) {
  }
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.tool_choice, 'required');
  assert.equal(
    new OpenAIChatProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'unrecognized-deepseek-model',
    }).supportsForcedImplementationFocusFor('unrecognized-deepseek-model'),
    false,
  );
  assert.equal(
    new OpenAIChatProvider({ baseUrl: 'https://proxy.example.test', model: 'deepseek-v4-pro' }).supportsForcedImplementationFocusFor(
      'deepseek-v4-pro',
    ),
    false,
  );
  assert.equal(
    new OpenAIChatProvider({ baseUrl: 'https://api.deepseek.com:8443', model: 'deepseek-v4-pro' }).supportsForcedImplementationFocusFor(
      'deepseek-v4-pro',
    ),
    false,
  );
  assert.equal(
    new OpenAIChatProvider({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' }).supportsForcedImplementationFocusFor(
      'deepseek-v4-pro',
    ),
    false,
  );
});
test('provider appends chat operation to a root or v1 API base exactly once', async () => {
  let endpoint;
  const provider = new OpenAIChatProvider({
    baseUrl: 'https://example.test/proxy/openai/',
    model: 'm',
    retries: 0,
    fetchImpl: async (url) => {
      endpoint = url;
      return new Response('data: [DONE]\n\n', { status: 200 });
    },
  });
  for await (const _ of provider.chat({ messages: [], tools: [] })) {
  }
  assert.equal(endpoint, 'https://example.test/proxy/openai/chat/completions');
  const v1 = new OpenAIChatProvider({
    baseUrl: 'https://example.test/v1',
    model: 'm',
    retries: 0,
    fetchImpl: async (url) => {
      endpoint = url;
      return new Response('data: [DONE]\n\n', { status: 200 });
    },
  });
  for await (const _ of v1.chat({ messages: [], tools: [] })) {
  }
  assert.equal(endpoint, 'https://example.test/v1/chat/completions');
});

test('provider strips internal tool metadata from exact wire messages', async () => {
  let body;
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response('data: [DONE]\n\n', { status: 200 });
    },
  });
  for await (const _ of provider.chat({
    messages: [
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'reason',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' }, internal: 'drop' }],
      },
      { role: 'tool', tool_call_id: 'call-1', name: 'read_file', content: 'ok', internal: 'drop' },
    ],
    tools: [],
  })) {
  }
  assert.deepEqual(body.messages, [
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'reason',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
  ]);
});
test('provider rejects an empty assistant tool-call array before sending an invalid transcript', async () => {
  let requests = 0;
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () => {
      requests++;
      return new Response('data: [DONE]\n\n', { status: 200 });
    },
  });
  await assert.rejects(async () => {
    for await (const _ of provider.chat({ messages: [{ role: 'assistant', content: '', tool_calls: [] }], tools: [] })) {
    }
  }, /Invalid assistant tool calls/);
  assert.equal(requests, 0);
});

test('provider rejects conflicting tool fragments and preserves index order', async () => {
  const stream = (text) => new Response(text, { status: 200 });
  const conflict = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () =>
      stream(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"x","arguments":"{"}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"b","function":{"arguments":"}"}}]}}]}\n\ndata: [DONE]\n\n',
      ),
  });
  await assert.rejects(async () => {
    for await (const _ of conflict.chat({ messages: [], tools: [] })) {
    }
  }, /Conflicting tool call id/);
});
test('provider preserves explicit nullable reasoning in streaming tool-call chunks for exact replay', async () => {
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () =>
      new Response(
        'data: {"choices":[{"delta":{"content":null,"reasoning_content":null,"reasoning":null,"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"echo","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ),
  });
  const events = [];
  for await (const event of provider.chat({ messages: [], tools: [] })) events.push(event);
  assert.deepEqual(events, [
    { reasoning: null, model: undefined },
    { toolCalls: [{ id: 'call-1', name: 'echo', arguments: '{}' }], model: undefined },
  ]);
});

test('provider preserves explicit empty reasoning in streaming tool-call chunks for exact replay', async () => {
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () =>
      new Response(
        'data: {"choices":[{"delta":{"reasoning_content":"","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"echo","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ),
  });
  const events = [];
  for await (const event of provider.chat({ messages: [], tools: [] })) events.push(event);
  assert.deepEqual(events, [
    { reasoning: '', model: undefined },
    { toolCalls: [{ id: 'call-1', name: 'echo', arguments: '{}' }], model: undefined },
  ]);
});

test('provider accepts identical reasoning aliases and rejects conflicting aliases', async () => {
  const matching = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () =>
      new Response('data: {"choices":[{"delta":{"reasoning_content":"same","reasoning":"same"}}]}\n\ndata: [DONE]\n\n', { status: 200 }),
  });
  const events = [];
  for await (const event of matching.chat({ messages: [], tools: [] })) events.push(event);
  assert.deepEqual(events, [{ reasoning: 'same', model: undefined }]);

  const conflicting = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () =>
      new Response('data: {"choices":[{"delta":{"reasoning_content":"first","reasoning":"second"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
      }),
  });
  await assert.rejects(async () => {
    for await (const _ of conflicting.chat({ messages: [], tools: [] })) {
    }
  }, /Conflicting response reasoning aliases/);
});

test('provider replays a nullable non-thinking tool response without adding a forced tool choice', async () => {
  let body;
  const provider = new OpenAIChatProvider({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    thinking: { type: 'enabled' },
    reasoningEffort: 'high',
    retries: 0,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response('data: [DONE]\n\n', { status: 200 });
    },
  });
  for await (const _ of provider.chat({
    messages: [
      {
        role: 'assistant',
        content: '',
        reasoning_content: null,
        tool_calls: [
          { id: 'write-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/a.mjs","content":"x"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'write-1', content: 'WROTE: src/a.mjs' },
    ],
    tools: [],
    thinking: { type: 'disabled' },
    reasoning_effort: 'none',
  })) {
  }
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_effort, 'none');
  assert.ok(!Object.hasOwn(body, 'tool_choice'));
  assert.deepEqual(body.messages[0].reasoning_content, null);
});
test('provider rejects oversized or control-bearing response model metadata', async () => {
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () =>
      new Response(`data: {"model":"${'m'.repeat(257)}","choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n`, { status: 200 }),
  });
  await assert.rejects(async () => {
    for await (const _ of provider.chat({ messages: [], tools: [] })) {
    }
  }, /Invalid response model/);
});
test('provider marks conflicting model metadata for the loop to reject safely', async () => {
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () =>
      new Response(
        'data: {"model":"first","choices":[{"delta":{"content":"x"}}]}\n\ndata: {"model":"second","choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ),
  });
  const events = [];
  for await (const event of provider.chat({ messages: [], tools: [] })) events.push(event);
  assert.deepEqual(events, [
    { text: 'x', model: 'first' },
    {
      usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0 },
      model: 'second',
      modelConflict: true,
    },
  ]);
});
test('provider emits a terminal conflict marker for metadata that arrives after usage', async () => {
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () =>
      new Response(
        'data: {"model":"first","choices":[{"delta":{"content":"x"}}]}\n\ndata: {"model":"first","choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\ndata: {"model":"second","choices":[]}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ),
  });
  const events = [];
  for await (const event of provider.chat({ messages: [], tools: [] })) events.push(event);
  assert.deepEqual(events, [
    { text: 'x', model: 'first' },
    { usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0 }, model: 'first' },
    { model: 'first', modelConflict: true },
  ]);
});
test('provider emits one normalized terminal finish reason without raw provider text', async () => {
  const raw = 'provider-secret-reason';
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () =>
      new Response(
        `data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"${raw}"}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":{"raw":"${raw}"}}]}\n\ndata: [DONE]\n\n`,
        { status: 200 },
      ),
  });
  const events = [];
  for await (const event of provider.chat({ messages: [], tools: [] })) events.push(event);
  assert.deepEqual(events, [{ text: 'x', model: undefined }, { providerFinishReason: 'other' }]);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(raw));
});
test('provider bounds untrusted tool-call fragments before buffering them', async () => {
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () =>
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x\\nforged","function":{"name":"read_file","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ),
  });
  await assert.rejects(async () => {
    for await (const _ of provider.chat({ messages: [], tools: [] })) {
    }
  }, /Tool call id fragment is invalid/);
});
test('provider errors expose HTTP status without echoing an arbitrary error body', async () => {
  const secretBody = 'provider body: sk-this-must-never-appear';
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () => new Response(secretBody, { status: 401 }),
  });
  await assert.rejects(
    async () => {
      for await (const _ of provider.chat({ messages: [], tools: [] })) {
      }
    },
    (error) => {
      assert.equal(error.name, 'ProviderError');
      assert.equal(error.status, 401);
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /sk-this-must-never-appear/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});
test('an uncapped provider-owned attempt timeout retries once and can recover', async () => {
  let attempts = 0;
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    timeoutMs: 5,
    retries: 1,
    fetchImpl: async (_url, { signal }) => {
      attempts++;
      if (attempts === 1)
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('provider timeout test')), { once: true }),
        );
      return new Response('data: {"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    },
  });
  for await (const _ of provider.chat({ messages: [], tools: [] })) {
  }
  assert.equal(attempts, 2);
});
test('external cancellation is not relabeled as a provider attempt timeout', async () => {
  const controller = new AbortController();
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    timeoutMs: 1_000,
    retries: 1,
    fetchImpl: async (_url, { signal }) => {
      requestStarted();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('provider-side text must not become classification')), { once: true }),
      );
    },
  });
  const request = (async () => {
    for await (const _ of provider.chat({ messages: [], tools: [], signal: controller.signal })) {
    }
  })();
  await started;
  const cancellation = new Error('outer request cancelled');
  controller.abort(cancellation);
  await assert.rejects(request, (error) => error === cancellation);
});
test('retry backoff unregisters its abort listener after a normal delay', async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal),
    remove = signal.removeEventListener.bind(signal);
  let added = 0,
    removed = 0;
  signal.addEventListener = (...args) => {
    added++;
    return add(...args);
  };
  signal.removeEventListener = (...args) => {
    removed++;
    return remove(...args);
  };
  let requests = 0;
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 1,
    fetchImpl: async () => {
      requests++;
      return requests === 1
        ? new Response('untrusted first error', { status: 500 })
        : new Response('data: {"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
    },
  });
  for await (const _ of provider.chat({ messages: [], tools: [], signal })) {
  }
  assert.equal(requests, 2);
  assert.equal(added, removed, 'every retry/backoff abort listener is removed');
});
test('provider rejects an oversized unterminated SSE event with a safe error', async () => {
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    maxSseEventBytes: 32,
    maxSseAttemptBytes: 64,
    fetchImpl: async () => new Response(`data: ${'x'.repeat(100)}`, { status: 200 }),
  });
  await assert.rejects(
    async () => {
      for await (const _ of provider.chat({ messages: [], tools: [] })) {
      }
    },
    (error) => {
      assert.equal(error.name, 'ProviderError');
      assert.equal(error.message, 'Chat request failed');
      return true;
    },
  );
});
test('provider rejects malformed protocol fragments and duplicate aggregate usage', async () => {
  const invalidType = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () =>
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"not-a-function","function":{"arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ),
  });
  await assert.rejects(async () => {
    for await (const _ of invalidType.chat({ messages: [], tools: [] })) {
    }
  }, /Invalid tool call fragment/);
  const duplicateUsage = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () =>
      new Response(
        'data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\ndata: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ),
  });
  await assert.rejects(async () => {
    for await (const _ of duplicateUsage.chat({ messages: [], tools: [] })) {
    }
  }, /Duplicate SSE usage/);
});
test('provider bounds raw transcript messages before a request is sent', async () => {
  let fetched = false;
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () => {
      fetched = true;
      return new Response('data: [DONE]\n\n', { status: 200 });
    },
  });
  await assert.rejects(async () => {
    for await (const _ of provider.chat({ messages: [{ role: 'user', content: 'x'.repeat(1_000_001) }], tools: [] })) {
    }
  }, /Invalid transcript content/);
  assert.equal(fetched, false);
});
test('provider rejects a stream without the required DONE terminator', async () => {
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () => new Response('data: {"choices":[{"delta":{}}]}\n\n', { status: 200 }),
  });
  await assert.rejects(async () => {
    for await (const _ of provider.chat({ messages: [], tools: [] })) {
    }
  }, /Chat request failed/);
});
test('non-OK response bodies are cancelled without being read', async () => {
  let cancelled = 0;
  const body = new ReadableStream({
    cancel() {
      cancelled++;
    },
  });
  const provider = new OpenAIChatProvider({
    baseUrl: 'http://localhost',
    model: 'm',
    retries: 0,
    fetchImpl: async () => new Response(body, { status: 401 }),
  });
  await assert.rejects(async () => {
    for await (const _ of provider.chat({ messages: [], tools: [] })) {
    }
  }, /401/);
  assert.equal(cancelled, 1);
});
