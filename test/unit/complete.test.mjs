import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  COMPLETE_CONTRACT_VERSION,
  COMPLETE_ERROR_CODES,
  __test,
  complete,
  completeDryRun,
  completeExitCode,
  deepseekBalance,
  defaultLedgerPath,
  pickRouteModel,
  validateCompleteRequest,
} from '../../src/complete.mjs';
import { runCli } from '../../src/cli.mjs';
import { cleanup, tempDir } from './helpers.mjs';

const OFF_PEAK = Date.parse('2026-10-05T12:00:00Z');
const PEAK = Date.parse('2026-10-05T02:00:00Z'); // Monday, inside 01:00-04:00 UTC
const CONFIG = {
  providers: {
    deepseek: { type: 'openai-chat', baseUrl: 'https://api.deepseek.com', keyRef: 'env:TEST_DEEPSEEK', pricing: 'deepseek-2026-10-01' },
  },
  profiles: {},
};
const withCaps = (caps) => ({ ...CONFIG, complete: { dailyUsdByCaller: caps } });
const enc = new TextEncoder();

function sseBody(events, { hang = false } = {}) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index < events.length) {
        const event = events[index++];
        controller.enqueue(enc.encode(event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`));
        // Let a consumer observe the first chunk before anything else happens.
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else if (!hang) controller.close();
      else await new Promise(() => {});
    },
  });
}
const sseResponse = (events, init = {}) =>
  new Response(sseBody(events, init), { status: 200, headers: { 'content-type': 'text/event-stream', ...init.headers } });
const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600, completion_tokens: 500 };
function okStream(text = 'hello', extra = {}) {
  return [
    { id: 'cmpl-1', model: 'deepseek-v4-flash', choices: [{ delta: { role: 'assistant', reasoning_content: 'SECRET-THINKING' } }] },
    { id: 'cmpl-1', choices: [{ delta: { reasoning_content: ' more thinking' } }] },
    { id: 'cmpl-1', choices: [{ delta: { content: text.slice(0, 2) } }] },
    { id: 'cmpl-1', choices: [{ delta: { content: text.slice(2) }, finish_reason: extra.finish ?? 'stop' }] },
    {
      id: 'cmpl-1',
      choices: [],
      usage: { ...usage, completion_tokens_details: { reasoning_tokens: 123 }, ...extra.usage },
    },
    '[DONE]',
  ];
}

/** A scripted DeepSeek: /models, /chat/completions and /user/balance, recording every call. */
function fakeDeepSeek({ models = ['deepseek-v4-flash', 'deepseek-v4-pro'], chat, balance } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method ?? 'GET', headers: init.headers, body: init.body });
    if (path === '/models') return jsonResponse({ data: models.map((id) => ({ id })) });
    if (path === '/user/balance') return balance ? balance() : jsonResponse({ is_available: true, balance_infos: [] });
    if (path === '/chat/completions') return chat ? chat(JSON.parse(init.body), init) : sseResponse(okStream());
    throw new Error(`unexpected request ${path}`);
  };
  return { fetchImpl, calls, chatCalls: () => calls.filter((call) => call.path === '/chat/completions') };
}

function harness(overrides = {}) {
  const dir = tempDir('offload-complete-');
  const ledgerPath = join(dir, 'state', 'offload', 'complete-ledger.jsonl');
  const server = overrides.server ?? fakeDeepSeek(overrides.deepseek);
  const options = {
    config: overrides.config ?? CONFIG,
    fetchImpl: server.fetchImpl,
    readKey: () => 'sk-test-key',
    ledgerPath,
    now: () => overrides.now ?? OFF_PEAK,
    env: { XDG_STATE_HOME: join(dir, 'state') },
  };
  const ledger = () => {
    try {
      return readFileSync(ledgerPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { dir, ledgerPath, server, options, ledger, done: () => cleanup(dir) };
}

const request = (overrides = {}) => ({
  route: 'deepseek-flash',
  messages: [{ role: 'user', content: 'Say hello' }],
  maxTokens: 100,
  reasoning: { enabled: true, effort: 'high' },
  timeoutMs: 5000,
  caller: 'test-app',
  tag: 'unit',
  ...overrides,
});

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test.beforeEach(() => __test.clearModelCache());

test('success returns only answer text with usage, reasoning tokens, cost and request id', async () => {
  const h = harness({ deepseek: { chat: () => sseResponse(okStream('hello world'), { headers: { 'x-request-id': 'req_hdr_1' } }) } });
  try {
    const result = await complete(request(), h.options);
    assert.equal(result.version, COMPLETE_CONTRACT_VERSION);
    assert.equal(result.ok, true);
    assert.equal(result.text, 'hello world');
    assert.ok(!JSON.stringify(result).includes('SECRET-THINKING'));
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.model, 'deepseek-v4-flash');
    assert.deepEqual(result.usage, {
      inputTokens: 1000,
      cacheHitTokens: 400,
      cacheMissTokens: 600,
      outputTokens: 500,
      reasoningTokens: 123,
    });
    assert.equal(result.providerRequestId, 'req_hdr_1');
    assert.equal(typeof result.latencyMs, 'number');
    assert.equal(completeExitCode(result), 0);
  } finally {
    h.done();
  }
});

test('cost math prices cache hit, cache miss and output, doubling in the peak window', async () => {
  const off = harness({ now: OFF_PEAK });
  const peak = harness({ now: PEAK });
  try {
    const a = await complete(request(), off.options);
    const b = await complete(request(), peak.options);
    const expectedOff = (400 * 0.003 + 600 * 0.15 + 500 * 0.6) / 1e6;
    assert.ok(Math.abs(a.costUsd - expectedOff) < 1e-12, `${a.costUsd} vs ${expectedOff}`);
    assert.ok(Math.abs(b.costUsd - expectedOff * 2) < 1e-12);
  } finally {
    off.done();
    peak.done();
  }
});

test('wire payload: messages byte-identical, only role+content, thinking and reasoning_effort mapped', async () => {
  const h = harness();
  try {
    const messages = [
      { role: 'system', content: 'You are terse.  \n' },
      { role: 'user', content: 'Unicode é中 "quotes" \\ trailing space ' },
      { role: 'assistant', content: 'earlier' },
      { role: 'user', content: '' },
    ];
    await complete(request({ messages, reasoning: { enabled: true, effort: 'max' }, maxTokens: 321 }), h.options);
    await complete(request({ messages, reasoning: { enabled: false } }), h.options);
    const [on, off] = h.server.chatCalls().map((call) => ({ raw: call.body, json: JSON.parse(call.body) }));
    assert.ok(on.raw.includes(JSON.stringify(messages)), 'messages serialize byte-identically');
    assert.deepEqual(on.json.messages, messages);
    assert.equal(on.json.model, 'deepseek-v4-flash');
    assert.equal(on.json.max_tokens, 321);
    assert.equal(on.json.stream, true);
    assert.deepEqual(on.json.thinking, { type: 'enabled' });
    assert.equal(on.json.reasoning_effort, 'max');
    assert.deepEqual(off.json.thinking, { type: 'disabled' });
    assert.equal('reasoning_effort' in off.json, false);
    assert.equal(on.raw, JSON.stringify({ ...on.json }), 'field order is stable');
    const call = h.server.chatCalls()[0];
    assert.equal(call.headers.authorization, 'Bearer sk-test-key');
  } finally {
    h.done();
  }
});

test('error mapping for HTTP statuses, with provider request ids', async () => {
  const cases = [
    [402, 'credit_exhausted', false],
    [401, 'auth_failed', false],
    [429, 'rate_limited', true],
    [500, 'provider_error', true],
    [503, 'provider_error', true],
    [400, 'invalid_request', false],
  ];
  for (const [status, code, retryable] of cases) {
    const h = harness({ deepseek: { chat: () => jsonResponse({ error: { message: 'nope' } }, status) } });
    try {
      const result = await complete(request(), h.options);
      assert.equal(result.ok, false, String(status));
      assert.equal(result.version, COMPLETE_CONTRACT_VERSION);
      assert.equal(result.error.code, code);
      assert.equal(result.error.retryable, retryable);
      assert.equal(result.error.httpStatus, status);
      assert.equal(completeExitCode(result), COMPLETE_ERROR_CODES[code]);
      assert.equal(h.ledger()[0].error, code);
    } finally {
      h.done();
    }
  }
});

test('providerRequestId comes from a header or from the 401 body request_id', async () => {
  const fromHeader = harness({ deepseek: { chat: () => jsonResponse({ error: { message: 'x' } }, 429, { 'x-request-id': 'hdr-42' }) } });
  const fromBody = harness({
    deepseek: { chat: () => jsonResponse({ error: { message: 'Authentication Fails (request_id: abc-123_XYZ)' } }, 401) },
  });
  try {
    assert.equal((await complete(request(), fromHeader.options)).error.providerRequestId, 'hdr-42');
    assert.equal((await complete(request(), fromBody.options)).error.providerRequestId, 'abc-123_XYZ');
  } finally {
    fromHeader.done();
    fromBody.done();
  }
});

test('finish_reason length is truncated and keeps the partial text; content_filter is refused', async () => {
  const cut = harness({ deepseek: { chat: () => sseResponse(okStream('partial answer', { finish: 'length' })) } });
  const filtered = harness({ deepseek: { chat: () => sseResponse(okStream('xx', { finish: 'content_filter' })) } });
  try {
    const truncated = await complete(request(), cut.options);
    assert.equal(truncated.ok, false);
    assert.equal(truncated.error.code, 'truncated');
    assert.equal(truncated.text, 'partial answer');
    assert.equal(truncated.usage.outputTokens, 500);
    assert.ok(truncated.costUsd > 0);
    assert.equal(completeExitCode(truncated), 14);
    assert.equal(cut.ledger()[0].error, 'truncated');
    const refused = await complete(request(), filtered.options);
    assert.equal(refused.error.code, 'refused');
    assert.equal(completeExitCode(refused), 15);
  } finally {
    cut.done();
    filtered.done();
  }
});

test('a stream that stalls past timeoutMs ends as timeout', async () => {
  const h = harness({ deepseek: { chat: () => sseResponse([okStream()[0]], { hang: true }) } });
  try {
    const result = await complete(request({ timeoutMs: 1000 }), h.options);
    assert.equal(result.error.code, 'timeout');
    assert.equal(result.error.retryable, false);
    assert.equal(completeExitCode(result), 16);
    assert.equal(h.ledger()[0].error, 'timeout');
  } finally {
    h.done();
  }
});

test('an AbortSignal mid-stream ends as cancelled, and a pre-aborted signal sends nothing', async () => {
  const h = harness({ deepseek: { chat: () => sseResponse(okStream().slice(0, 3), { hang: true }) } });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const result = await complete(request(), { ...h.options, signal: controller.signal });
    assert.equal(result.error.code, 'cancelled');
    assert.equal(completeExitCode(result), 17);
    assert.equal(h.ledger()[0].error, 'cancelled');
    const before = h.server.chatCalls().length;
    const pre = AbortSignal.abort();
    const second = await complete(request(), { ...h.options, signal: pre });
    assert.equal(second.error.code, 'cancelled');
    assert.equal(h.server.chatCalls().length, before);
  } finally {
    h.done();
  }
});

test('invalid requests are rejected before any network call', async () => {
  const h = harness();
  try {
    const bad = [
      null,
      [],
      request({ route: 'deepseek-ultra' }),
      request({ route: ['deepseek-flash'] }),
      request({ messages: [] }),
      request({ messages: 'hi' }),
      request({ messages: [{ role: 'user', content: 'x', name: 'n' }] }),
      request({ messages: [{ role: 'tool', content: 'x' }] }),
      request({ messages: [{ role: 'user', content: 5 }] }),
      request({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      }),
      request({ maxTokens: 0 }),
      request({ maxTokens: 1.5 }),
      request({ maxTokens: undefined }),
      request({ reasoning: { enabled: 'yes' } }),
      request({ reasoning: { enabled: true, effort: 'extreme' } }),
      request({ reasoning: { enabled: false, effort: 'high' } }),
      request({ timeoutMs: 5 }),
      request({ caller: 'bad caller' }),
      request({ caller: undefined }),
      request({ tag: '' }),
      request({ version: 2 }),
      { ...request(), extra: true },
    ];
    for (const value of bad) {
      const result = await complete(value, h.options);
      assert.equal(result.ok, false, JSON.stringify(value));
      assert.equal(result.error.code, 'invalid_request');
      assert.equal(completeExitCode(result), 2);
    }
    assert.equal(h.server.calls.length, 0);
    assert.equal(h.ledger().length, 0);
    assert.equal(validateCompleteRequest(request({ version: 1 })).route, 'deepseek-flash');
  } finally {
    h.done();
  }
});

test('missing key is auth_failed without a network call', async () => {
  const h = harness();
  try {
    const result = await complete(request(), {
      ...h.options,
      readKey: () => {
        throw new Error('no key');
      },
    });
    assert.equal(result.error.code, 'auth_failed');
    assert.equal(h.server.calls.length, 0);
  } finally {
    h.done();
  }
});

test('daily cap: a pre-seeded ledger over the cap yields budget_cap and no chat request', async () => {
  const h = harness({ config: withCaps({ 'test-app': 0.001 }) });
  try {
    mkdirSync(join(h.dir, 'state', 'offload'), { recursive: true });
    const entry = (caller, ts, costUsd) =>
      JSON.stringify({ ts, caller, tag: 't', route: 'deepseek-flash', model: 'm', usage: null, costUsd, latencyMs: 1, error: null });
    writeFileSync(
      h.ledgerPath,
      [
        entry('test-app', '2026-10-05T01:00:00.000Z', 0.001),
        entry('other-app', '2026-10-05T01:00:00.000Z', 5),
        entry('test-app', '2026-10-04T23:00:00.000Z', 5), // yesterday does not count
      ].join('\n') + '\n',
    );
    const capped = await complete(request(), h.options);
    assert.equal(capped.error.code, 'budget_cap');
    assert.equal(completeExitCode(capped), 18);
    assert.equal(h.server.chatCalls().length, 0);
    // An uncapped caller is unaffected.
    const free = await complete(request({ caller: 'other-app' }), h.options);
    assert.equal(free.ok, true);
    assert.equal(h.server.chatCalls().length, 1);
  } finally {
    h.done();
  }
});

test('daily cap: the first call under the cap runs and later calls count its recorded cost', async () => {
  const h = harness({ config: withCaps({ 'test-app': 0.0004 }) });
  try {
    const first = await complete(request(), h.options);
    assert.equal(first.ok, true); // about $0.00039 actual; worst-case estimate for 100 tokens is tiny
    const second = await complete(request(), h.options);
    assert.equal(second.error.code, 'budget_cap');
    assert.equal(h.server.chatCalls().length, 1);
    assert.deepEqual(readdirSync(__test.capPaths(h.ledgerPath).dir), [], 'reservations are released');
  } finally {
    h.done();
  }
});

test('unpriced newest model fails before any chat request', async () => {
  const h = harness({ deepseek: { models: ['deepseek-v9-flash'] } });
  try {
    const result = await complete(request(), h.options);
    assert.equal(result.error.code, 'unpriced_model');
    assert.equal(result.model, 'deepseek-v9-flash');
    assert.equal(completeExitCode(result), 19);
    assert.equal(h.server.chatCalls().length, 0);
    assert.equal(h.ledger().length, 0);
  } finally {
    h.done();
  }
});

test('pickRouteModel: alias wins, else the highest vN.M, per route', () => {
  assert.equal(pickRouteModel('deepseek-flash', ['deepseek-v4-flash', 'deepseek-flash']), 'deepseek-flash');
  assert.equal(
    pickRouteModel('deepseek-flash', ['deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v3.9-flash', 'deepseek-v4-pro']),
    'deepseek-v4.1-flash',
  );
  assert.equal(pickRouteModel('deepseek-flash', ['deepseek-v10-flash', 'deepseek-v9-flash']), 'deepseek-v10-flash');
  assert.equal(pickRouteModel('deepseek-pro', ['deepseek-v4-flash', 'deepseek-v4-pro']), 'deepseek-v4-pro');
  assert.equal(pickRouteModel('deepseek-pro', ['deepseek-v4-flash']), undefined);
  assert.equal(pickRouteModel('deepseek-pro', ['deepseek-v4-pro-preview', 'deepseek-reasoner']), undefined);
});

test('the pro route resolves to deepseek-v4-pro and is priced at the Pro rates', async () => {
  const h = harness({ deepseek: { chat: (body) => sseResponse(echoStream(body.model)) } });
  try {
    const result = await complete(request({ route: 'deepseek-pro' }), h.options);
    assert.equal(result.ok, true);
    assert.equal(h.server.chatCalls().map((call) => JSON.parse(call.body).model)[0], 'deepseek-v4-pro');
    const expected = (400 * 0.022 + 600 * 0.66 + 500 * 1.98) / 1e6;
    assert.ok(Math.abs(result.costUsd - expected) < 1e-12);
  } finally {
    h.done();
  }
});

test('the alias is used when the provider lists it and is still priced', async () => {
  const h = harness({ deepseek: { models: ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-pro'] } });
  try {
    assert.equal((await complete(request(), h.options)).ok, true);
    assert.equal((await complete(request({ route: 'deepseek-pro' }), h.options)).ok, true);
    assert.deepEqual(
      h.server.chatCalls().map((call) => JSON.parse(call.body).model),
      ['deepseek-flash', 'deepseek-pro'],
    );
  } finally {
    h.done();
  }
});

test('ledger privacy: no prompt or response text on disk, and exactly the allowed fields', async () => {
  const sentinel = 'SENTINEL-7f3a9c-do-not-persist';
  const h = harness({ deepseek: { chat: () => sseResponse(okStream(`reply ${sentinel}`)) } });
  try {
    const result = await complete(request({ messages: [{ role: 'user', content: `prompt ${sentinel}` }] }), h.options);
    assert.equal(result.ok, true);
    assert.ok(result.text.includes(sentinel));
    const files = walk(h.dir);
    assert.ok(files.length >= 1);
    for (const file of files) assert.ok(!readFileSync(file, 'utf8').includes(sentinel), file);
    const [entry] = h.ledger();
    assert.deepEqual(Object.keys(entry).sort(), ['caller', 'costUsd', 'error', 'latencyMs', 'model', 'route', 'tag', 'ts', 'usage']);
    assert.equal(entry.caller, 'test-app');
    assert.equal(entry.tag, 'unit');
    assert.equal(entry.route, 'deepseek-flash');
    assert.equal(entry.model, 'deepseek-v4-flash');
    assert.equal(entry.error, null);
    assert.equal(entry.usage.reasoningTokens, 123);
    assert.equal(entry.ts, new Date(OFF_PEAK).toISOString());
    assert.equal(statSync(h.ledgerPath).mode & 0o077, 0, 'ledger is owner-only');
  } finally {
    h.done();
  }
});

test('three parallel calls return their own replies and each lands in the ledger', async () => {
  const h = harness({
    deepseek: {
      chat: async (body) => {
        const id = body.messages[0].content;
        await new Promise((resolve) => setTimeout(resolve, 20 - Number(id.slice(-1)) * 5));
        return sseResponse(okStream(`answer-${id}`));
      },
    },
  });
  try {
    const results = await Promise.all(
      [0, 1, 2].map((n) => complete(request({ messages: [{ role: 'user', content: `job-${n}` }], tag: `t${n}` }), h.options)),
    );
    assert.deepEqual(
      results.map((result) => result.text),
      ['answer-job-0', 'answer-job-1', 'answer-job-2'],
    );
    assert.deepEqual(
      h
        .ledger()
        .map((entry) => entry.tag)
        .sort(),
      ['t0', 't1', 't2'],
    );
  } finally {
    h.done();
  }
});

test('concurrent calls under a cap reserve their worst case so the cap cannot be oversubscribed', async () => {
  // A 100k-token maxTokens call is estimated near $0.06; the cap admits one in flight, not three.
  const h = harness({
    config: withCaps({ 'test-app': 0.1 }),
    deepseek: {
      chat: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return sseResponse(okStream());
      },
    },
  });
  try {
    const results = await Promise.all([0, 1, 2].map(() => complete(request({ maxTokens: 100_000 }), h.options)));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.error?.code === 'budget_cap').length, 2);
  } finally {
    h.done();
  }
});

// A process that stays alive for the whole test, standing in for another `offload complete` process.
function otherProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  return { pid: child.pid, stop: () => child.kill('SIGKILL') };
}
function writeReservation(h, name, entry) {
  const { dir } = __test.capPaths(h.ledgerPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(entry));
}

test('daily cap: a live reservation from another process counts against the cap', async () => {
  const h = harness({ config: withCaps({ 'test-app': 0.01 }) });
  const other = otherProcess();
  try {
    writeReservation(h, 'other.json', { caller: 'test-app', usd: 0.01, pid: other.pid, expiresAt: Date.now() + 60_000, state: 'admitted' });
    const capped = await complete(request(), h.options);
    assert.equal(capped.error.code, 'budget_cap');
    assert.match(capped.error.message, /in flight \$0\.0100/);
    assert.equal(h.server.chatCalls().length, 0);
    // Another caller's reservation does not count.
    writeReservation(h, 'other.json', { caller: 'someone-else', usd: 0.01, pid: other.pid, expiresAt: Date.now() + 60_000 });
    assert.equal((await complete(request(), h.options)).ok, true);
  } finally {
    other.stop();
    h.done();
  }
});

test('daily cap: reservations left by a dead process or past their expiry are ignored and removed', async () => {
  const h = harness({ config: withCaps({ 'test-app': 0.01 }) });
  const other = otherProcess();
  const dead = otherProcess();
  dead.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    writeReservation(h, 'dead.json', { caller: 'test-app', usd: 1, pid: dead.pid, expiresAt: Date.now() + 60_000 });
    writeReservation(h, 'expired.json', { caller: 'test-app', usd: 1, pid: other.pid, expiresAt: Date.now() - 1 });
    const result = await complete(request(), h.options);
    assert.equal(result.ok, true);
    assert.deepEqual(readdirSync(__test.capPaths(h.ledgerPath).dir), []);
  } finally {
    other.stop();
    h.done();
  }
});

test('daily cap: a call steps back while another call is still deciding, and cancelling that wait sends nothing', async () => {
  const h = harness({ config: withCaps({ 'test-app': 0.01 }) });
  const holder = otherProcess();
  try {
    // Another process has a pending (not yet admitted) reservation that leaves no room.
    const pending = { caller: 'test-app', usd: 0.01, pid: holder.pid, expiresAt: Date.now() + 60_000, state: 'pending' };
    writeReservation(h, 'pending.json', pending);
    const started = Date.now();
    setTimeout(() => rmSync(join(__test.capPaths(h.ledgerPath).dir, 'pending.json'), { force: true }), 300);
    assert.equal((await complete(request(), h.options)).ok, true, 'admitted once the other call gave up');
    assert.ok(Date.now() - started >= 250, 'waited while the other call was deciding');

    writeReservation(h, 'pending.json', pending);
    const before = h.server.chatCalls().length;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const cancelled = await complete(request(), { ...h.options, signal: controller.signal });
    assert.equal(cancelled.error.code, 'cancelled');
    assert.equal(h.server.chatCalls().length, before);

    // An admitted reservation that leaves no room refuses at once.
    writeReservation(h, 'pending.json', { ...pending, state: 'admitted' });
    const quick = Date.now();
    assert.equal((await complete(request(), h.options)).error.code, 'budget_cap');
    assert.ok(Date.now() - quick < 1000);
  } finally {
    holder.stop();
    h.done();
  }
});

test('daily cap: abandoned temporary or unreadable reservation files are removed once old', async () => {
  const h = harness({ config: withCaps({ 'test-app': 1 }) });
  try {
    const { dir } = __test.capPaths(h.ledgerPath);
    writeReservation(h, '.tmp-old', 'partial');
    writeReservation(h, 'corrupt.json', null);
    writeReservation(h, '.tmp-fresh', 'partial');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(join(dir, '.tmp-old'), old, old);
    utimesSync(join(dir, 'corrupt.json'), old, old);
    assert.equal((await complete(request(), h.options)).ok, true);
    assert.deepEqual(readdirSync(dir), ['.tmp-fresh']);
  } finally {
    h.done();
  }
});

test('daily cap: separate OS processes share reservations, so parallel calls cannot overshoot', async () => {
  const h = harness();
  try {
    const script = `
      import { complete } from ${JSON.stringify(new URL('../../src/complete.mjs', import.meta.url).href)};
      const enc = new TextEncoder();
      const sse = (e) => 'data: ' + JSON.stringify(e) + '\\n\\n';
      const fetchImpl = async (url) => {
        const path = new URL(url).pathname;
        if (path === '/models') return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }));
        await new Promise((r) => setTimeout(r, 400));
        return new Response(sse({ model: 'deepseek-v4-flash', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })
          + sse({ choices: [], usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 2 } })
          + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
      };
      const config = ${JSON.stringify(withCaps({ 'test-app': 0.1 }))};
      const result = await complete(${JSON.stringify(request({ maxTokens: 100_000 }))}, {
        fetchImpl, config, ledgerPath: ${JSON.stringify(h.ledgerPath)}, readKey: () => 'sk-test',
        // Pinned like the in-process harness: prices are time-tiered, and at peak
        // one 100k-token worst case alone exceeds the cap, so no call would pass.
        now: () => ${OFF_PEAK},
      });
      process.stdout.write(JSON.stringify({ ok: result.ok, code: result.error?.code }));
    `;
    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (chunk) => (out += chunk));
        child.on('error', reject);
        child.on('exit', () => resolve(JSON.parse(out)));
      });
    const results = await Promise.all([run(), run(), run()]);
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    assert.equal(results.filter((result) => result.code === 'budget_cap').length, 2);
    assert.deepEqual(readdirSync(__test.capPaths(h.ledgerPath).dir), []);
  } finally {
    h.done();
  }
});

test('a stream with no finish reason or an unsupported one is a retryable provider_error', async () => {
  const none = harness({
    deepseek: { chat: () => sseResponse([{ id: 'c', choices: [{ delta: { content: 'x' } }] }, { choices: [], usage }, '[DONE]']) },
  });
  const odd = harness({ deepseek: { chat: () => sseResponse(okStream('x', { finish: 'insufficient_system_resource' })) } });
  try {
    for (const h of [none, odd]) {
      const result = await complete(request(), h.options);
      assert.equal(result.error.code, 'provider_error');
      assert.equal(result.error.retryable, true);
    }
  } finally {
    none.done();
    odd.done();
  }
});

test('dry run resolves model and price tier without a chat request', async () => {
  const off = harness({ now: OFF_PEAK, config: withCaps({ 'test-app': 5 }) });
  const peak = harness({ now: PEAK });
  try {
    const a = await completeDryRun({ route: 'deepseek-pro', caller: 'test-app' }, off.options);
    assert.equal(a.ok, true);
    assert.equal(a.dryRun, true);
    assert.equal(a.model, 'deepseek-v4-pro');
    assert.equal(a.keyOk, true);
    assert.equal(a.pricing.peakNow, false);
    assert.equal(a.pricing.usdPer1M.output, 1.98);
    assert.equal(a.dailyCapUsd, 5);
    assert.equal(a.spentTodayUsd, 0);
    const b = await completeDryRun(request(), peak.options);
    assert.equal(b.pricing.peakNow, true);
    assert.equal(b.pricing.usdPer1M.inputCacheMiss, 0.3);
    assert.ok(b.maxCostUsd > 0);
    assert.equal(off.server.chatCalls().length + peak.server.chatCalls().length, 0);
    assert.equal(off.ledger().length, 0);
    const bad = await completeDryRun({ route: 'nope' }, off.options);
    assert.equal(bad.error.code, 'invalid_request');
    __test.clearModelCache();
    const unpriced = harness({ deepseek: { models: ['deepseek-v9-flash'] } });
    try {
      assert.equal((await completeDryRun({ route: 'deepseek-flash' }, unpriced.options)).error.code, 'unpriced_model');
    } finally {
      unpriced.done();
    }
  } finally {
    off.done();
    peak.done();
  }
});

test('balance parses DeepSeek balance info and maps failures', async () => {
  const h = harness({
    deepseek: {
      balance: () =>
        jsonResponse({
          is_available: true,
          balance_infos: [{ currency: 'USD', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10.00' }],
        }),
    },
  });
  const denied = harness({ deepseek: { balance: () => jsonResponse({ error: { message: 'bad' } }, 401) } });
  try {
    const result = await deepseekBalance(h.options);
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'deepseek');
    assert.equal(result.isAvailable, true);
    assert.deepEqual(result.balances, [{ currency: 'USD', total: 12.5, granted: 2.5, toppedUp: 10 }]);
    assert.equal(h.server.chatCalls().length, 0);
    const failed = await deepseekBalance(denied.options);
    assert.equal(failed.error.code, 'auth_failed');
  } finally {
    h.done();
    denied.done();
  }
});

test('defaultLedgerPath honours XDG_STATE_HOME', () => {
  assert.equal(defaultLedgerPath({ XDG_STATE_HOME: '/x/state' }, '/home/u'), join('/x/state', 'offload', 'complete-ledger.jsonl'));
  assert.equal(defaultLedgerPath({}, '/home/u'), join('/home/u', '.local', 'state', 'offload', 'complete-ledger.jsonl'));
});

// ---- CLI -------------------------------------------------------------------------------

function cli(argv, { stdin = '', h, signalSource = new EventEmitter() } = {}) {
  const out = [];
  const err = [];
  let coreCreated = 0;
  const run = () =>
    runCli(argv, {
      stdin: Readable.from(typeof stdin === 'string' ? [Buffer.from(stdin)] : stdin),
      stdout: { write: (text) => out.push(text) },
      stderr: { write: (text) => err.push(text) },
      createCore: () => {
        coreCreated++;
        throw new Error('core must not be created');
      },
      signalSource,
      completeOptions: h.options,
    });
  return { run, out, err, created: () => coreCreated, signalSource };
}

test('cli complete: one JSON line on stdout, exit 0, no core, no prompt text on stderr', async () => {
  const h = harness();
  try {
    const c = cli(['complete'], { stdin: JSON.stringify(request({ messages: [{ role: 'user', content: 'PROMPT-TEXT' }] })), h });
    assert.equal(await c.run(), 0);
    assert.equal(c.out.length, 1);
    assert.ok(c.out[0].endsWith('\n') && !c.out[0].slice(0, -1).includes('\n'));
    const result = JSON.parse(c.out[0]);
    assert.equal(result.ok, true);
    assert.equal(result.text, 'hello');
    assert.equal(c.err.join(''), '');
    assert.equal(c.created(), 0);
  } finally {
    h.done();
  }
});

test('cli complete: provider errors print the result and exit with the code status', async () => {
  const h = harness({ deepseek: { chat: () => jsonResponse({ error: {} }, 402) } });
  try {
    const c = cli(['complete'], { stdin: JSON.stringify(request()), h });
    assert.equal(await c.run(), 10);
    assert.equal(JSON.parse(c.out[0]).error.code, 'credit_exhausted');
    assert.equal(c.created(), 0);
  } finally {
    h.done();
  }
});

test('cli complete: invalid JSON, empty stdin and oversized stdin are invalid_request results', async () => {
  const h = harness();
  try {
    for (const stdin of ['{not json', '', 'null']) {
      const c = cli(['complete'], { stdin, h });
      assert.equal(await c.run(), 2, JSON.stringify(stdin));
      assert.equal(JSON.parse(c.out[0]).error.code, 'invalid_request');
      assert.equal(c.err.join(''), '');
    }
    const big = cli(['complete'], { stdin: [Buffer.alloc(9 * 1024 * 1024, 97), Buffer.alloc(9 * 1024 * 1024, 97)], h });
    assert.equal(await big.run(), 2);
    assert.equal(JSON.parse(big.out[0]).error.code, 'invalid_request');
    assert.equal(h.server.calls.length, 0);
  } finally {
    h.done();
  }
});

test('cli complete --dry-run never posts a chat request', async () => {
  const h = harness();
  try {
    const c = cli(['complete', '--dry-run'], { stdin: JSON.stringify({ route: 'deepseek-flash' }), h });
    assert.equal(await c.run(), 0);
    const result = JSON.parse(c.out[0]);
    assert.equal(result.dryRun, true);
    assert.equal(result.model, 'deepseek-v4-flash');
    assert.equal(h.server.chatCalls().length, 0);
    assert.equal(c.created(), 0);
  } finally {
    h.done();
  }
});

test('cli balance deepseek requires exactly that positional and builds no core', async () => {
  const h = harness();
  try {
    const ok = cli(['balance', 'deepseek'], { h });
    assert.equal(await ok.run(), 0);
    assert.equal(JSON.parse(ok.out[0]).provider, 'deepseek');
    assert.equal(ok.created(), 0);
    for (const argv of [
      ['balance'],
      ['balance', 'openai'],
      ['balance', 'deepseek', 'extra'],
      ['complete', 'extra'],
      ['complete', '--bogus'],
    ]) {
      const bad = cli(argv, { h });
      assert.equal(await bad.run(), 2, argv.join(' '));
      assert.equal(bad.out.length, 0);
      assert.equal(bad.created(), 0);
    }
  } finally {
    h.done();
  }
});

test('cli complete: SIGTERM aborts the in-flight call, prints cancelled and exits 17; SIGINT too', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const h = harness({ deepseek: { chat: () => sseResponse(okStream().slice(0, 3), { hang: true }) } });
    try {
      const c = cli(['complete'], { stdin: JSON.stringify(request()), h });
      setTimeout(() => c.signalSource.emit(signal), 80);
      assert.equal(await c.run(), 17);
      assert.equal(JSON.parse(c.out[0]).error.code, 'cancelled');
      assert.equal(c.out.length, 1);
      assert.equal(c.signalSource.listenerCount(signal), 0, 'listeners are removed');
      assert.equal(c.created(), 0);
    } finally {
      h.done();
    }
  }
});

const echoStream = (model) => okStream().map((event, i) => (i === 0 ? { ...event, model } : event));

test('alias pricing: an echoed known model is priced at its own rates', async () => {
  const h = harness({
    deepseek: {
      models: ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4-pro'],
      chat: () => sseResponse(echoStream('deepseek-v4-pro')),
    },
  });
  try {
    const result = await complete(request(), h.options);
    assert.equal(h.server.chatCalls().map((call) => JSON.parse(call.body).model)[0], 'deepseek-flash');
    assert.equal(result.ok, true);
    assert.equal(result.model, 'deepseek-v4-pro');
    assert.ok(Math.abs(result.costUsd - (400 * 0.022 + 600 * 0.66 + 500 * 1.98) / 1e6) < 1e-12);
    assert.equal(result.pricingWarning, undefined);
  } finally {
    h.done();
  }
});

test('alias pricing: an echoed unpriced model succeeds, reports the echo, prices at the alias and warns', async () => {
  const h = harness({
    deepseek: { models: ['deepseek-v4-flash', 'deepseek-flash'], chat: () => sseResponse(echoStream('deepseek-v9-flash')) },
  });
  try {
    const result = await complete(request(), h.options);
    assert.equal(result.ok, true);
    assert.equal(result.model, 'deepseek-v9-flash');
    assert.ok(Math.abs(result.costUsd - (400 * 0.003 + 600 * 0.15 + 500 * 0.6) / 1e6) < 1e-12);
    assert.equal(typeof result.pricingWarning, 'string');
  } finally {
    h.done();
  }
});

// A response whose body sends one chunk and then never ends.
const hangingBody = (text) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
    },
    pull: () => new Promise(() => {}),
  });

test('balance: a caller abort while the 200 body streams is cancelled', async () => {
  const h = harness({
    deepseek: {
      balance: () => new Response(hangingBody('{"is_available":'), { status: 200, headers: { 'content-type': 'application/json' } }),
    },
  });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await deepseekBalance({ ...h.options, signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'cancelled');
  } finally {
    h.done();
  }
});

test('balance: a caller abort while a 500 error body streams is cancelled, not provider_error', async () => {
  const h = harness({
    deepseek: { balance: () => new Response(hangingBody('{"error":'), { status: 500, headers: { 'content-type': 'application/json' } }) },
  });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await deepseekBalance({ ...h.options, signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'cancelled');
  } finally {
    h.done();
  }
});

test('cli complete: a signal while stdin never ends prints cancelled, exits 17 and destroys stdin', async () => {
  const h = harness();
  try {
    const stdin = new Readable({ read() {} });
    stdin.push(Buffer.from('{"route":'));
    const signalSource = new EventEmitter();
    const out = [];
    setTimeout(() => signalSource.emit('SIGTERM'), 50);
    const code = await runCli(['complete'], {
      stdin,
      stdout: { write: (text) => out.push(text) },
      stderr: { write: () => {} },
      createCore: () => {
        throw new Error('core must not be created');
      },
      signalSource,
      completeOptions: h.options,
    });
    assert.equal(code, 17);
    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0]).error.code, 'cancelled');
    assert.equal(stdin.destroyed, true);
    assert.equal(h.server.calls.length, 0);
  } finally {
    h.done();
  }
});
