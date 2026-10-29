import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIChatProvider, ProviderError, providerFailure } from '../../src/provider/openai-chat.mjs';
import { CreditFallbackProvider } from '../../src/provider/fallback.mjs';

const sse = (...chunks) =>
  new Response(chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join(''), { status: 200 });
const okStream = () =>
  sse(
    { model: 'gpt-6.1-terra', choices: [{ delta: { content: 'hi' } }] },
    { model: 'gpt-6.1-terra', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    '[DONE]',
  );
const openai = (fetchImpl, extra = {}) =>
  new OpenAIChatProvider({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-6.1-terra', retries: 2, fetchImpl, ...extra });
const drain = async (provider, request = {}) => {
  const events = [];
  for await (const event of provider.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], ...request })) events.push(event);
  return events;
};
const failure = (body, status) => () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('OpenAI wire uses max_completion_tokens, reasoning_effort and no DeepSeek fields', async () => {
  let payload;
  const provider = openai(
    async (_url, init) => {
      payload = JSON.parse(init.body);
      return okStream();
    },
    { reasoningEffort: 'high', thinking: { type: 'enabled' } },
  );
  await drain(provider, {
    max_tokens: 123,
    thinking: { type: 'enabled' },
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'a', reasoning_content: 'secret reasoning' },
    ],
  });
  assert.equal(payload.max_completion_tokens, 123);
  assert.equal('max_tokens' in payload, false);
  assert.equal(payload.reasoning_effort, 'high');
  assert.equal('thinking' in payload, false);
  assert.equal('reasoning_content' in payload.messages[1], false);
});

test('DeepSeek wire is unchanged', async () => {
  let payload;
  const provider = new OpenAIChatProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'k',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
    thinking: { type: 'enabled' },
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return okStream();
    },
  });
  await drain(provider, { max_tokens: 7, messages: [{ role: 'assistant', content: 'a', reasoning_content: 'r' }] });
  assert.equal(payload.max_tokens, 7);
  assert.equal('max_completion_tokens' in payload, false);
  assert.deepEqual(payload.thinking, { type: 'enabled' });
  assert.equal(payload.messages[0].reasoning_content, 'r');
});

test('OpenAI credit exhaustion detection table', async () => {
  const cases = [
    [429, { error: { code: 'credit_balance_exhausted', message: 'SECRET BODY' } }, true],
    [402, { error: { code: 'credit_balance_exhausted' } }, true],
    [400, { error: { code: 'insufficient_quota' } }, true],
    [429, { error: { type: 'insufficient_quota', message: 'SECRET BODY' } }, true],
    [429, { error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, false],
    [429, { error: { code: 'slow_down' } }, false],
    [429, { error: { code: 'project_spend_limit_exceeded' } }, false],
    [429, { error: { code: 'organization_usage_limit_exceeded' } }, false],
    [429, { error: 'insufficient_quota' }, false],
    [429, 'not json', false],
    [400, { error: { code: 'invalid_request' } }, false],
    [401, { error: { code: 'insufficient_quota' } }, false],
    [403, { error: { code: 'credit_balance_exhausted' } }, false],
    [500, { error: { code: 'insufficient_quota' } }, false],
  ];
  for (const [status, body, exhausted] of cases) {
    let calls = 0;
    const provider = openai(async () => {
      calls++;
      return failure(body, status)();
    });
    await assert.rejects(
      () => drain(provider),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, exhausted ? 'credit_exhausted' : 'http', `${status} ${JSON.stringify(body)}`);
        assert.equal(error.status, status);
        assert.doesNotMatch(error.message + JSON.stringify(providerFailure(error)), /SECRET/);
        if (exhausted) assert.equal(error.retryable, false);
        return true;
      },
    );
    if (exhausted) assert.equal(calls, 1, 'credit exhaustion is never retried');
  }
});

test('ordinary OpenAI 429 stays retryable and retried', async () => {
  let calls = 0;
  const provider = openai(
    async () => {
      calls++;
      return calls === 1 ? failure({ error: { type: 'rate_limit_error' } }, 429)() : okStream();
    },
    { retries: 1 },
  );
  assert.ok((await drain(provider)).some((event) => event.text === 'hi'));
  assert.equal(calls, 2);
});

test('oversized OpenAI error bodies are not credit exhaustion and DeepSeek never classifies bodies', async () => {
  const big = JSON.stringify({ error: { code: 'insufficient_quota', pad: 'x'.repeat(70_000) } });
  await assert.rejects(
    () => drain(openai(failure(big, 429), { retries: 0 })),
    (error) => error.kind === 'http',
  );
  const deepseek = new OpenAIChatProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'k',
    model: 'deepseek-flash',
    retries: 0,
    fetchImpl: failure({ error: { code: 'insufficient_quota' } }, 429),
  });
  await assert.rejects(
    () => drain(deepseek),
    (error) => error.kind === 'http' && error.retryable === true,
  );
});

const route = (model, chat) => ({ model, provider: { chat } });
const exhausted = () => new ProviderError('x', { kind: 'credit_exhausted' });
const collect = async (provider) => {
  const out = [];
  for await (const event of provider.chat({ messages: [] })) out.push(event);
  return out;
};

test('N-route fallback: Claude -> OpenAI, then OpenAI -> Flash, persisting each stage first', async () => {
  const log = [];
  const routes = [
    route('claude-sonnet-5-5', async function* () {
      log.push('claude');
      throw exhausted();
    }),
    route('gpt-6.1-terra', async function* (request) {
      log.push(`openai:${request.model}`);
      throw exhausted();
    }),
    route('deepseek-flash', async function* (request) {
      log.push(`flash:${request.model}`);
      yield { text: 'ok' };
    }),
  ];
  const provider = new CreditFallbackProvider({ routes, onTransition: (stage) => log.push(`persist:${stage}`) });
  assert.deepEqual(await collect(provider), [{ text: 'ok' }]);
  assert.deepEqual(log, ['claude', 'persist:1', 'openai:gpt-6.1-terra', 'persist:2', 'flash:deepseek-flash']);
  assert.equal(provider.stage, 2);
  assert.equal(provider.fallbackUsed, true);
  assert.equal(provider.allowsResponseModel('x', 'gpt-6.1-terra'), true);
  assert.equal(provider.allowsResponseModel('x', 'gpt-9-terra'), false);
  await collect(provider);
  assert.equal(log.at(-1), 'flash:deepseek-flash');
  assert.equal(log.filter((entry) => entry.startsWith('claude')).length, 1);
});

test('fallback: the last route and partial streams never switch', async () => {
  const routes = [
    route('a', async function* () {
      yield { text: 'partial' };
      throw exhausted();
    }),
    route('b', async function* () {
      yield { text: 'no' };
    }),
  ];
  let transitions = 0;
  await assert.rejects(async () => collect(new CreditFallbackProvider({ routes, onTransition: () => transitions++ })));
  assert.equal(transitions, 0);
  const last = new CreditFallbackProvider({
    routes: [
      routes[1],
      route('c', async function* () {
        throw exhausted();
      }),
    ],
    stage: 1,
    onTransition: () => transitions++,
  });
  await assert.rejects(
    async () => collect(last),
    (error) => error.kind === 'credit_exhausted',
  );
  assert.equal(transitions, 0);
});

test('continuation resumes at persisted stage and legacy signature maps to routes', async () => {
  const seen = [];
  const mk = (name) => ({
    async *chat(request) {
      seen.push(`${name}:${request.model}`);
      yield { text: name };
    },
  });
  const resumed = new CreditFallbackProvider({
    routes: [
      { provider: mk('a'), model: 'ma' },
      { provider: mk('b'), model: 'mb' },
      { provider: mk('c'), model: 'mc' },
    ],
    stage: 2,
  });
  await collect(resumed);
  assert.deepEqual(seen, ['c:mc']);
  const legacy = new CreditFallbackProvider({
    primary: mk('p'),
    fallback: mk('f'),
    primaryModel: 'mp',
    fallbackModel: 'mf',
    fallbackUsed: true,
  });
  assert.equal(legacy.stage, 1);
  await collect(legacy);
  assert.equal(seen.at(-1), 'f:mf');
  assert.throws(() => new CreditFallbackProvider({ routes: [{ provider: mk('a'), model: 'ma' }] }), TypeError);
  assert.throws(
    () =>
      new CreditFallbackProvider({
        routes: [
          { provider: mk('a'), model: 'ma' },
          { provider: mk('b'), model: 'mb' },
        ],
        stage: 2,
      }),
    TypeError,
  );
});

test('OpenAI dated snapshot echoes normalize to the requested alias; other models do not', async () => {
  const dated = (model) => async () =>
    sse(
      { model, choices: [{ delta: { content: 'hi' } }] },
      { model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
      '[DONE]',
    );
  const events = await drain(openai(dated('gpt-6.1-terra-2026-10-26')));
  assert.ok(events.every((event) => event.model === 'gpt-6.1-terra'));
  const other = await drain(openai(dated('gpt-6.1-terra-mini')));
  assert.ok(other.some((event) => event.model === 'gpt-6.1-terra-mini'));
  const deepseek = new OpenAIChatProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'k',
    model: 'deepseek-flash',
    fetchImpl: dated('deepseek-flash-2026-10-26'),
  });
  assert.ok((await drain(deepseek)).some((event) => event.model === 'deepseek-flash-2026-10-26'));
});
