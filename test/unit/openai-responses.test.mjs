import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIResponsesProvider, createOpenAIResponsesProvider } from '../../src/provider/openai-responses.mjs';
import { ProviderError, providerFailure } from '../../src/provider/openai-chat.mjs';

const MODEL = 'gpt-6.1-terra';
const usage = (extra = {}) => ({
  input_tokens: 96,
  input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
  output_tokens: 161,
  output_tokens_details: { reasoning_tokens: 136 },
  total_tokens: 257,
  ...extra,
});
const body = (output, extra = {}) => ({ id: 'resp_1', model: MODEL, status: 'completed', output, usage: usage(), ...extra });
const json = (value, status = 200) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
const reasoningItem = { id: 'rs_1', type: 'reasoning', content: [], encrypted_content: 'ENC1', summary: [] };
const callItem = (callId = 'call_1', args = '{"path":"a"}', extra = {}) => ({
  id: `fc_${callId}`,
  type: 'function_call',
  status: 'completed',
  arguments: args,
  call_id: callId,
  name: 'read_file',
  ...extra,
});
const messageItem = (text) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const provider = (fetchImpl, extra = {}) =>
  new OpenAIResponsesProvider({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: MODEL, retries: 2, fetchImpl, ...extra });
const drain = async (instance, request = {}) => {
  const events = [];
  for await (const event of instance.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], ...request })) events.push(event);
  return events;
};
const TOOL = {
  type: 'function',
  function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
};

test('request body: input conversion, reasoning replay, tools, caps, effort, store and include', async () => {
  let url, init, payload;
  const instance = provider(
    async (u, i) => {
      url = u;
      init = i;
      payload = JSON.parse(i.body);
      return json(body([messageItem('ok')]));
    },
    { reasoningEffort: 'high' },
  );
  await drain(instance, {
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: 'disabled' },
    tools: [TOOL],
    tool_choice: 'required',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: 'looking',
        reasoning_content: 'ignored',
        anthropic_content: [{ type: 'text', text: 'looking' }],
        openai_reasoning: [{ type: 'reasoning', encrypted_content: 'ENC0', summary: [{ type: 'summary_text', text: 's' }] }],
        tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_0', name: 'read_file', content: 'file body' },
      { role: 'assistant', content: 'done', openai_reasoning: [{ type: 'reasoning', encrypted_content: 'ENC9', summary: [] }] },
      { role: 'assistant', content: '', openai_reasoning: [{ type: 'reasoning', encrypted_content: 'DANGLING', summary: [] }] },
    ],
  });
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.authorization, 'Bearer k');
  assert.deepEqual(payload, {
    model: MODEL,
    input: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'looking' },
      { type: 'reasoning', encrypted_content: 'ENC0', summary: [{ type: 'summary_text', text: 's' }] },
      { type: 'function_call', call_id: 'call_0', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call_0', output: 'file body' },
      { type: 'reasoning', encrypted_content: 'ENC9', summary: [] },
      { role: 'assistant', content: 'done' },
    ],
    tools: [
      {
        type: 'function',
        name: 'read_file',
        description: 'Read',
        parameters: TOOL.function.parameters,
        strict: false,
      },
    ],
    tool_choice: 'required',
    reasoning: { effort: 'high' },
    max_output_tokens: 4096,
    store: false,
    include: ['reasoning.encrypted_content'],
  });
  assert.equal('stream' in payload, false);
});

test('tool_choice maps named functions and request effort overrides the default', async () => {
  const payloads = [];
  const instance = provider(async (_u, init) => {
    payloads.push(JSON.parse(init.body));
    return json(body([messageItem('ok')]));
  });
  await drain(instance, { tools: [TOOL], tool_choice: { type: 'function', function: { name: 'finish' } }, reasoning_effort: 'low' });
  await drain(instance, { tool_choice: 'auto' });
  assert.deepEqual(payloads[0].tool_choice, { type: 'function', name: 'finish' });
  assert.deepEqual(payloads[0].reasoning, { effort: 'low' });
  assert.equal(payloads[1].tool_choice, 'auto');
  assert.equal('reasoning' in payloads[1], false);
  assert.equal('max_output_tokens' in payloads[1], false);
});

test('unknown, stream and invalid options are rejected before any request', async () => {
  let calls = 0;
  const instance = provider(async () => {
    calls++;
    return json(body([]));
  });
  for (const options of [
    { previous_response_id: 'resp_0' },
    { store: true },
    { stream: true },
    { stream_options: { include_usage: true } },
    { max_tokens: 15 },
    { max_tokens: 1.5 },
    { reasoning_effort: 'extreme' },
    { tool_choice: 'sometimes' },
    { model: 'deepseek-flash' },
  ])
    await assert.rejects(() => drain(instance, options), ProviderError);
  await assert.rejects(() => drain(instance, { messages: [{ role: 'assistant', content: 'a', openai_reasoning: [{ type: 'x' }] }] }), {
    message: 'Invalid assistant reasoning replay',
  });
  await assert.rejects(
    () =>
      drain(instance, {
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'dup', type: 'function', function: { name: 'a', arguments: '{}' } },
              { id: 'dup', type: 'function', function: { name: 'b', arguments: '{}' } },
            ],
          },
        ],
      }),
    { message: 'Invalid assistant tool calls' },
  );
  await assert.rejects(() => drain(instance, { tools: [{ type: 'function', function: { name: 'x' } }] }), {
    message: 'Invalid tool definition',
  });
  assert.equal(calls, 0);
});

test('constructor validation matches the Chat adapter', () => {
  const ok = { baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: MODEL, fetchImpl: async () => json({}) };
  assert.ok(createOpenAIResponsesProvider(ok) instanceof OpenAIResponsesProvider);
  assert.equal(createOpenAIResponsesProvider(ok).supportsForcedImplementationFocusFor(MODEL), false);
  assert.ok(new OpenAIResponsesProvider({ ...ok, baseUrl: 'http://127.0.0.1:9/v1', model: 'local' }));
  for (const bad of [
    { baseUrl: 'http://api.openai.com/v1' },
    { baseUrl: 'https://u:p@api.openai.com/v1' },
    { baseUrl: 'https://api.openai.com/v1?x=1' },
    { baseUrl: 'ftp://api.openai.com' },
    { model: 'gpt-4o' },
    { model: '' },
    { fetchImpl: 'nope' },
    { headers: [] },
    { timeoutMs: 0 },
    { maxResponseBytes: 0 },
    { reasoningEffort: 'extreme' },
  ])
    assert.throws(() => new OpenAIResponsesProvider({ ...ok, ...bad }));
});

test('text, reasoning and tool-call events arrive in contract order', async () => {
  const instance = provider(async () =>
    json(
      body([
        { ...reasoningItem, summary: [{ type: 'summary_text', text: 'thought' }] },
        messageItem('hello'),
        { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] },
        callItem('call_1'),
        callItem('call_2', ''),
      ]),
    ),
  );
  const events = await drain(instance);
  assert.deepEqual(events, [
    { text: 'hello\nno', model: MODEL },
    {
      openaiReasoning: [{ type: 'reasoning', encrypted_content: 'ENC1', summary: [{ type: 'summary_text', text: 'thought' }] }],
      model: MODEL,
    },
    {
      toolCalls: [
        { id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
        { id: 'call_2', name: 'read_file', arguments: '{}' },
      ],
      model: MODEL,
    },
    { usage: { inputTokens: 96, outputTokens: 161, cacheHitTokens: 0, cacheMissTokens: 96, totalTokens: 257 }, model: MODEL },
    { providerFinishReason: 'tool_calls' },
  ]);
});

test('message items and parts are joined with newlines', async () => {
  const events = await drain(
    provider(async () =>
      json(
        body([
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'A' },
              { type: 'refusal', refusal: 'R' },
            ],
          },
          messageItem('B'),
        ]),
      ),
    ),
  );
  assert.equal(events[0].text, 'A\nR\nB');
});

test('unusable reasoning items are skipped without discarding a billed tool call', async () => {
  const events = await drain(
    provider(async () =>
      json(
        body([
          { ...reasoningItem, encrypted_content: '' },
          { ...reasoningItem, encrypted_content: 'bad\u0001ciphertext' },
          ...Array.from({ length: 33 }, (_, index) => ({ ...reasoningItem, encrypted_content: `ENC${index}` })),
          callItem('call_1'),
        ]),
      ),
    ),
  );
  const replay = events.find((event) => event.openaiReasoning).openaiReasoning;
  assert.equal(replay.length, 32);
  assert.equal(replay[0].encrypted_content, 'ENC0');
  assert.equal(replay.at(-1).encrypted_content, 'ENC31');
  assert.deepEqual(events.find((event) => event.toolCalls).toolCalls, [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }]);
  assert.equal(events.at(-1).providerFinishReason, 'tool_calls');
});

test('a small output cap runs without reasoning unless the request names an effort', async () => {
  const payloads = [];
  const instance = provider(
    async (_u, init) => {
      payloads.push(JSON.parse(init.body));
      return json(body([callItem('call_1')]));
    },
    { reasoningEffort: 'high' },
  );
  await drain(instance, { tools: [TOOL], max_tokens: 128 });
  await drain(instance, { tools: [TOOL], max_tokens: 1023, reasoning_effort: 'low' });
  await drain(instance, { tools: [TOOL], max_tokens: 1024 });
  await drain(instance, { tools: [TOOL] });
  assert.deepEqual(
    payloads.map((payload) => payload.reasoning),
    [{ effort: 'none' }, { effort: 'low' }, { effort: 'high' }, { effort: 'high' }],
  );
  assert.equal(payloads[0].max_output_tokens, 128);
});

test('text-only responses finish with stop and reasoning without ciphertext is skipped', async () => {
  const events = await drain(provider(async () => json(body([{ id: 'rs', type: 'reasoning', summary: [] }, messageItem('hi')]))));
  assert.deepEqual(
    events.map((event) => Object.keys(event)[0]),
    ['text', 'usage', 'providerFinishReason'],
  );
  assert.equal(events.at(-1).providerFinishReason, 'stop');
});

test('incomplete responses map to length or content_filter and drop a partial call', async () => {
  const capped = await drain(
    provider(async () =>
      json(
        body([reasoningItem, callItem('call_1', '{"path":', { status: 'incomplete' })], {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      ),
    ),
  );
  assert.equal(
    capped.some((event) => event.toolCalls),
    false,
  );
  assert.ok(capped.some((event) => event.openaiReasoning));
  assert.equal(capped.at(-1).providerFinishReason, 'length');
  const filtered = await drain(
    provider(async () => json(body([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }))),
  );
  assert.equal(filtered.at(-1).providerFinishReason, 'content_filter');
  const other = await drain(provider(async () => json(body([], { status: 'incomplete', incomplete_details: { reason: 'mystery' } }))));
  assert.equal(other.at(-1).providerFinishReason, 'other');
});

test('a malformed call on a completed response fails after metering its usage', async () => {
  const events = [];
  await assert.rejects(
    async () => {
      for await (const event of provider(async () => json(body([callItem('call_1', '{"path":')]))).chat({
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
      }))
        events.push(event);
    },
    (error) => error instanceof ProviderError && error.kind === 'response' && error.message === 'Incomplete tool JSON',
  );
  assert.deepEqual(Object.keys(events[0]), ['usage', 'model']);
  await assert.rejects(
    () => drain(provider(async () => json(body([callItem('call_1', '[]')])))),
    (error) => error.kind === 'response',
  );
});

test('failed and non-terminal statuses are response errors', async () => {
  for (const status of ['failed', 'cancelled', 'queued', 'in_progress', 'weird'])
    await assert.rejects(
      () => drain(provider(async () => json(body([messageItem('x')], { status })))),
      (error) => error instanceof ProviderError && error.kind === 'response' && error.reason === 'unsupported_response_status',
    );
});

test('response shape is validated strictly', async () => {
  const cases = [
    body([{ type: 'web_search_call' }]),
    body([{ type: 'message', role: 'assistant', content: [{ type: 'output_audio' }] }]),
    body([{ type: 'message', role: 'user', content: [] }]),
    body([{ ...reasoningItem, encrypted_content: 7 }]),
    body([{ ...reasoningItem, summary: [{ type: 'other', text: 'x' }] }]),
    body([callItem('a'), callItem('a')]),
    body([callItem('bad\nid')]),
    body([callItem('a', 'x'.repeat(512_001))]),
    body(Array.from({ length: 65 }, (_, index) => callItem(`c${index}`))),
    body('not an array'),
    { ...body([]), model: undefined },
    [],
  ];
  for (const value of cases)
    await assert.rejects(
      () => drain(provider(async () => json(value))),
      (error) => error instanceof ProviderError,
    );
});

test('usage normalization covers cache hits, writes and inconsistent totals', async () => {
  const usageOf = async (value) =>
    (await drain(provider(async () => json(body([messageItem('x')], { usage: value }))))).find((e) => e.usage);
  assert.deepEqual(
    (
      await usageOf(
        usage({
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 4 },
          total_tokens: 110,
        }),
      )
    ).usage,
    { inputTokens: 100, outputTokens: 10, cacheHitTokens: 60, cacheMissTokens: 40, cacheWriteTokens: 30, totalTokens: 110 },
  );
  assert.deepEqual((await usageOf({ input_tokens: 5, output_tokens: 2 })).usage, {
    inputTokens: 5,
    outputTokens: 2,
    cacheHitTokens: 0,
    cacheMissTokens: 5,
    totalTokens: 7,
  });
  for (const bad of [
    undefined,
    null,
    usage({ total_tokens: 1 }),
    usage({ input_tokens: -1 }),
    usage({ output_tokens: '161' }),
    usage({ input_tokens_details: { cached_tokens: 97 } }),
    usage({ input_tokens_details: { cached_tokens: 90, cache_write_tokens: 7 } }),
    usage({ output_tokens_details: { reasoning_tokens: 162 } }),
    usage({ input_tokens_details: [] }),
  ])
    await assert.rejects(
      () => drain(provider(async () => json(body([messageItem('x')], { usage: bad })))),
      (error) => error instanceof ProviderError && error.kind === 'response',
    );
});

test('a dated snapshot echo normalizes to the requested alias; another model is reported as echoed', async () => {
  const dated = await drain(provider(async () => json(body([messageItem('x')], { model: `${MODEL}-2026-10-01` }))));
  assert.ok(dated.filter((event) => 'model' in event).every((event) => event.model === MODEL));
  const other = await drain(provider(async () => json(body([messageItem('x')], { model: 'gpt-6.1-sol' }))));
  assert.ok(other.filter((event) => 'model' in event).every((event) => event.model === 'gpt-6.1-sol'));
  const suffix = await drain(provider(async () => json(body([messageItem('x')], { model: `${MODEL}-latest` }))));
  assert.equal(suffix[0].model, `${MODEL}-latest`);
});

test('credit exhaustion is classified and never retried', async () => {
  for (const status of [400, 402, 429]) {
    let calls = 0;
    await assert.rejects(
      () =>
        drain(
          provider(async () => {
            calls++;
            return json(
              { error: { code: status === 400 ? 'insufficient_quota' : 'credit_balance_exhausted', message: 'SECRET BODY' } },
              status,
            );
          }),
        ),
      (error) =>
        error instanceof ProviderError &&
        error.kind === 'credit_exhausted' &&
        error.retryable === false &&
        !error.message.includes('SECRET'),
    );
    assert.equal(calls, 1);
  }
});

test('ordinary 400 is a non-retryable http error without body text', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      drain(
        provider(async () => {
          calls++;
          return json({ error: { type: 'invalid_request_error', param: 'reasoning', message: 'SECRET BODY' } }, 400);
        }),
      ),
    (error) => {
      assert.equal(error.kind, 'http');
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /SECRET|reasoning/);
      assert.deepEqual(providerFailure(error), { kind: 'http', retryable: false, attempts: 1, status: 400 });
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('5xx and transport failures retry; redirects do not', async () => {
  let calls = 0;
  const events = await drain(
    provider(async () => {
      calls++;
      if (calls === 1) return json({ error: {} }, 503);
      if (calls === 2) throw new Error('socket hang up SECRET');
      return json(body([messageItem('ok')]));
    }),
  );
  assert.equal(calls, 3);
  assert.equal(events[0].text, 'ok');
  calls = 0;
  await assert.rejects(
    () =>
      drain(
        provider(async () => {
          calls++;
          throw new TypeError('fetch failed: redirect mode is set to error');
        }),
      ),
    (error) => error.kind === 'redirect' && error.retryable === false,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      drain(
        provider(async () => {
          throw new Error('SECRET transport text');
        }),
        { retryLimit: 0 },
      ),
    (error) => error.kind === 'transport' && error.attempts === 1 && !error.message.includes('SECRET'),
  );
});

test('attempt timeout is reported and retried within retryLimit', async () => {
  let calls = 0;
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      calls++;
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  const instance = provider(hang, { timeoutMs: 20, retries: 1 });
  await assert.rejects(
    () => drain(instance, { retryLimit: 0 }),
    (error) => error.kind === 'attempt_timeout' && error.retryable === true && error.attempts === 1,
  );
  assert.equal(calls, 1);
});

test('caller abort stops the request with the caller reason', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled by caller');
  const instance = provider(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        setTimeout(() => controller.abort(reason), 5);
      }),
  );
  await assert.rejects(() => drain(instance, { signal: controller.signal }), reason);
  const preAborted = new AbortController();
  preAborted.abort(reason);
  let calls = 0;
  await assert.rejects(
    () =>
      drain(
        provider(async () => {
          calls++;
          return json(body([]));
        }),
        { signal: preAborted.signal },
      ),
    reason,
  );
  assert.equal(calls, 0);
});

test('oversized or non-JSON bodies are non-retryable response errors', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      drain(
        provider(
          async () => {
            calls++;
            return json(body([messageItem('x'.repeat(2_000))]));
          },
          { maxResponseBytes: 1_000 },
        ),
      ),
    (error) => error.kind === 'response' && error.reason === 'response_exceeds_configured_size_limit' && error.retryable === false,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () => drain(provider(async () => json('SECRET not json'))),
    (error) => error.kind === 'response' && !error.message.includes('SECRET'),
  );
});
