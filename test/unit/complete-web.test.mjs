// offload complete: built-in web tools (DeepSeek Search/Fetch) run by Offload
// inside one call, with per-turn ledger lines, web request pricing and the
// same error codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { __test, complete, completeDryRun, validateCompleteRequest } from '../../src/complete.mjs';
import { builtinTool, webToolPrices } from '../../src/complete-web.mjs';
import { loadPricing } from '../../src/pricing-registry.mjs';
import { cleanup, tempDir } from './helpers.mjs';

const OFF_PEAK = Date.parse('2026-10-05T12:00:00Z');
const CONFIG = {
  providers: {
    deepseek: { type: 'openai-chat', baseUrl: 'https://api.deepseek.com', keyRef: 'env:TEST_DEEPSEEK', pricing: 'deepseek-2026-10-01' },
  },
  profiles: {},
};
const WEB = 0.00075;
const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600, completion_tokens: 500 };
const CALL_COST = (400 * 0.003 + 600 * 0.15 + 500 * 0.6) / 1e6;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`);
const enc = new TextEncoder();

const sse = (events) => {
  let index = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (index >= events.length) return controller.close();
        const event = events[index++];
        controller.enqueue(enc.encode(event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function reply({ text = '', calls = [], reasoning = 'R' } = {}) {
  const events = [{ id: 'c', model: 'deepseek-v4-flash', choices: [{ delta: { role: 'assistant', reasoning_content: reasoning } }] }];
  if (text) events.push({ id: 'c', choices: [{ delta: { content: text } }] });
  calls.forEach((call, index) =>
    events.push({
      id: 'c',
      choices: [
        { delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] } },
      ],
    }),
  );
  events.push({ id: 'c', choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
  events.push({ id: 'c', choices: [], usage }, '[DONE]');
  return sse(events);
}
const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
const SEARCH_RESULTS = {
  results: [
    {
      rerank_score: 2.1,
      title: 'ACME careers',
      url: 'https://acme.example/jobs/1',
      snippet: 'short',
      summary: 'SUMMARY-TEXT staff engineer pays $250k',
      content: '',
      site_name: 'ACME',
      site_icon: null,
      date: '2026-09-01T00:00:00Z',
      authority: 3,
    },
    { title: 'no url' },
  ],
};

function harness({ chat = [], search = [], fetchPage = [], config = CONFIG } = {}) {
  const dir = tempDir('offload-complete-web-');
  const ledgerPath = join(dir, 'state', 'offload', 'complete-ledger.jsonl');
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    if (path === '/models') return json({ data: [{ id: 'deepseek-v4-flash' }] });
    const queue =
      path === '/chat/completions' ? chat : path === '/v1/tools/search' ? search : path === '/v1/tools/fetch' ? fetchPage : undefined;
    if (!queue) throw new Error(`unexpected ${path}`);
    const next = queue.shift();
    if (!next) throw new Error(`no scripted response for ${path}`);
    return next(calls.at(-1).body, init);
  };
  const options = {
    config,
    fetchImpl,
    readKey: () => 'sk-web',
    ledgerPath,
    now: () => OFF_PEAK,
    env: { XDG_STATE_HOME: join(dir, 'state') },
    webRetryDelayMs: 1,
  };
  const ledgerText = () => {
    try {
      return readFileSync(ledgerPath, 'utf8');
    } catch {
      return '';
    }
  };
  return {
    dir,
    ledgerPath,
    options,
    ledgerText,
    ledger: () =>
      ledgerText()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    on: (path) => calls.filter((entry) => entry.path === path),
    chatBodies: () => calls.filter((entry) => entry.path === '/chat/completions').map((entry) => entry.body),
    done: () => cleanup(dir),
  };
}
const request = (overrides = {}) => ({
  route: 'deepseek-flash',
  messages: [{ role: 'user', content: 'What does ACME pay a staff engineer?' }],
  maxTokens: 1000,
  timeoutMs: 5000,
  caller: 'canvas',
  tag: 'job-compensation-research-batch',
  tools: [
    { builtin: 'web_search', count: 3 },
    { builtin: 'web_fetch', maxChars: 1000 },
  ],
  toolLoop: { id: 'web-1', maxTurns: 6 },
  ...overrides,
});

test.beforeEach(() => __test.clearModelCache());

test('one call searches, fetches and answers, with every turn ledgered and web requests priced', async () => {
  const h = harness({
    chat: [
      () => reply({ calls: [call('s1', 'web_search', { query: 'ACME staff engineer salary site:acme.example' })] }),
      () => reply({ calls: [call('f1', 'web_fetch', { url: 'https://acme.example/jobs/1' })] }),
      () => reply({ text: 'About $250k base.' }),
    ],
    search: [() => json(SEARCH_RESULTS)],
    fetchPage: [() => json({ title: 'Staff Engineer', content: 'PAGE-BODY base salary $250,000' })],
  });
  try {
    const result = await complete(request(), h.options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.text, 'About $250k base.');
    assert.equal(result.toolCalls, undefined);
    near(result.costUsd, 3 * CALL_COST + 2 * WEB);
    assert.deepEqual(result.usage, {
      inputTokens: 3000,
      cacheHitTokens: 1200,
      cacheMissTokens: 1800,
      outputTokens: 1500,
      reasoningTokens: 0,
    });
    assert.equal(result.toolLoop.turn, 3);
    assert.equal(result.toolLoop.toolCalls, 2);
    near(result.toolLoop.costUsd, 3 * CALL_COST + 2 * WEB);
    assert.deepEqual(
      result.newMessages.map((message) => message.role),
      ['assistant', 'tool', 'assistant', 'tool', 'assistant'],
    );
    // Search request shape, and what the model sees.
    const [searchCall] = h.on('/v1/tools/search');
    assert.deepEqual(searchCall.body, { query: 'ACME staff engineer salary site:acme.example', count: 3, need_content: false });
    assert.equal(searchCall.headers.authorization, 'Bearer sk-web');
    assert.deepEqual(JSON.parse(result.newMessages[1].content), {
      results: [
        {
          title: 'ACME careers',
          url: 'https://acme.example/jobs/1',
          date: '2026-09-01T00:00:00Z',
          site: 'ACME',
          summary: 'SUMMARY-TEXT staff engineer pays $250k',
        },
      ],
    });
    assert.deepEqual(h.on('/v1/tools/fetch')[0].body, { url: 'https://acme.example/jobs/1' });
    assert.equal(result.newMessages[3].content, '# Staff Engineer\n\nPAGE-BODY base salary $250,000');
    // Later turns replay the earlier ones, tool declarations included.
    const bodies = h.chatBodies();
    assert.equal(bodies[2].messages.length, 5);
    assert.deepEqual(
      bodies[0].tools.map((tool) => tool.function.name),
      ['web_search', 'web_fetch'],
    );
    assert.equal('builtin' in bodies[0].tools[0].function, false, 'only name, description and parameters reach DeepSeek');
    assert.equal(bodies[2].messages[1].reasoning_content, 'R');
    // One ledger line per model turn, with web counts and no query, URL or page text.
    const lines = h.ledger();
    assert.deepEqual(
      lines.map((line) => [line.turn, line.toolCalls, line.webSearches, line.webFetches, line.error]),
      [
        [1, 1, 1, 0, null],
        [2, 1, 0, 1, null],
        [3, 0, 0, 0, null],
      ],
    );
    near(lines[0].costUsd, CALL_COST + WEB);
    near(lines[2].costUsd, CALL_COST);
    for (const secret of ['ACME', 'acme.example', 'PAGE-BODY', 'SUMMARY-TEXT', 'salary'])
      assert.ok(!h.ledgerText().includes(secret), secret);
  } finally {
    h.done();
  }
});

test('a turn with a host call runs the built-in calls and returns only the host calls', async () => {
  const tools = [
    { builtin: 'web_search' },
    { name: 'save_note', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
  ];
  const h = harness({
    chat: [
      () => reply({ calls: [call('s1', 'web_search', { query: 'acme' }), call('h1', 'save_note', { text: 'x' })] }),
      () => reply({ text: 'done' }),
    ],
    search: [() => json(SEARCH_RESULTS)],
  });
  try {
    const first = await complete(request({ tools }), h.options);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.finishReason, 'tool_calls');
    assert.deepEqual(first.toolCalls, [call('h1', 'save_note', { text: 'x' })]);
    assert.deepEqual(
      first.newMessages.map((message) => message.role),
      ['assistant', 'tool'],
    );
    assert.equal(first.newMessages[0].toolCalls.length, 2);
    assert.equal(first.newMessages[1].toolCallId, 's1');
    const base = request({ tools });
    const second = await complete(
      { ...base, messages: [...base.messages, ...first.newMessages, { role: 'tool', toolCallId: 'h1', content: 'saved' }] },
      h.options,
    );
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.text, 'done');
    assert.equal(second.toolLoop.turn, 2);
    near(second.toolLoop.costUsd, 2 * CALL_COST + WEB);
  } finally {
    h.done();
  }
});

test('web tool failures become tool results the model can read; only successful results are billed', async () => {
  const h = harness({
    chat: [
      () =>
        reply({
          calls: [
            call('a', 'web_search', { query: 'x'.repeat(129) }),
            call('b', 'web_fetch', { url: 'ftp://acme.example/file' }),
            call('c', 'web_fetch', { url: 'https://gone.example/' }),
            call('d', 'web_search', { query: 'nothing here' }),
            call('e', 'web_search', { query: 'busy' }),
            call('f', 'web_fetch', { url: 'https://down.example/' }),
          ],
        }),
      () => reply({ text: 'could not find it' }),
    ],
    // The pool runs four at a time; responses are matched per endpoint in arrival order.
    search: [() => json({ results: [] }), () => json({ error: {} }, 429), () => json(SEARCH_RESULTS)],
    fetchPage: [() => json({ error: {} }, 404), () => json({}, 500), () => json({}, 503), () => json({}, 502)],
  });
  try {
    const result = await complete(request({ toolLoop: { id: 'web-f', maxToolCallsPerTurn: 8 } }), h.options);
    assert.equal(result.ok, true, JSON.stringify(result));
    const content = Object.fromEntries(result.newMessages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m.content]));
    assert.equal(JSON.parse(content.a).error, 'invalid_arguments');
    assert.equal(JSON.parse(content.b).error, 'invalid_arguments');
    assert.equal(JSON.parse(content.c).error, 'no_content');
    assert.deepEqual(JSON.parse(content.d), { results: [] });
    assert.equal(JSON.parse(content.e).results.length, 1, '429 is retried');
    assert.equal(JSON.parse(content.f).error, 'unavailable', '5xx retried twice, then reported');
    assert.equal(h.on('/v1/tools/search').length, 3, 'invalid arguments are never sent');
    assert.equal(h.on('/v1/tools/fetch').length, 4);
    // Billed: only the search that returned results.
    near(result.costUsd, 2 * CALL_COST + WEB);
    assert.deepEqual([h.ledger()[0].webSearches, h.ledger()[0].webFetches], [1, 0]);
  } finally {
    h.done();
  }
});

test('a fetched page is cut to maxChars with a marker', async () => {
  const h = harness({
    chat: [() => reply({ calls: [call('f', 'web_fetch', { url: 'https://acme.example/' })] }), () => reply({ text: 'ok' })],
    fetchPage: [() => json({ title: '', content: 'y'.repeat(1500) })],
  });
  try {
    const result = await complete(request(), h.options);
    assert.equal(result.newMessages[1].content, `${'y'.repeat(1000)}\n\n[cut: first 1000 of 1500 characters]`);
  } finally {
    h.done();
  }
});

test('402 from a web tool is credit_exhausted and keeps the progress and the billed chat turn', async () => {
  const h = harness({
    chat: [() => reply({ calls: [call('s', 'web_search', { query: 'acme' })] })],
    search: [() => json({ error: { message: 'Insufficient Balance' } }, 402)],
  });
  try {
    const result = await complete(request(), h.options);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'credit_exhausted');
    assert.equal(result.error.httpStatus, 402);
    near(result.costUsd, CALL_COST);
    assert.equal(result.newMessages, undefined, 'a tool-call turn without its tool results is never handed back');
    assert.equal(result.toolLoop.turn, 1);
    assert.deepEqual(
      h.ledger().map((line) => [line.error, line.webSearches]),
      [['credit_exhausted', 0]],
    );
  } finally {
    h.done();
  }
});

test('401 from a web tool is auth_failed', async () => {
  const h = harness({
    chat: [() => reply({ calls: [call('f', 'web_fetch', { url: 'https://acme.example/' })] })],
    fetchPage: [() => json({}, 401)],
  });
  try {
    assert.equal((await complete(request(), h.options)).error.code, 'auth_failed');
  } finally {
    h.done();
  }
});

test('toolLoop.maxUsd is checked before every internal turn and counts web requests', async () => {
  const h = harness({
    chat: [
      () => reply({ calls: [call('s', 'web_search', { query: 'acme' })] }),
      () => reply({ calls: [call('s2', 'web_search', { query: 'acme 2' })] }),
    ],
    search: [() => json(SEARCH_RESULTS), () => json(SEARCH_RESULTS)],
  });
  try {
    // Turn 1 fits; after it ($0.00039 chat + $0.00075 search) turn 2's worst case does not.
    const result = await complete(request({ toolLoop: { id: 'web-cap', maxToolCallsPerTurn: 1, maxUsd: 0.0026 } }), h.options);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, 'budget_cap');
    assert.equal(h.chatBodies().length, 1);
    near(result.costUsd, CALL_COST + WEB);
    near(result.toolLoop.costUsd, CALL_COST + WEB);
    assert.equal(result.newMessages.length, 2);
    assert.deepEqual(
      h.ledger().map((line) => line.error),
      [null, 'budget_cap'],
    );
  } finally {
    h.done();
  }
});

test('the last allowed turn forbids tools, so a web loop always ends', async () => {
  const h = harness({
    chat: [() => reply({ calls: [call('s', 'web_search', { query: 'acme' })] }), () => reply({ text: 'final' })],
    search: [() => json(SEARCH_RESULTS)],
  });
  try {
    const result = await complete(request({ toolLoop: { id: 'web-2', maxTurns: 2 } }), h.options);
    assert.equal(result.ok, true);
    assert.equal(result.toolLoop.final, true);
    const bodies = h.chatBodies();
    assert.equal('tool_choice' in bodies[0], false);
    assert.equal(bodies[1].tool_choice, 'none');
  } finally {
    h.done();
  }
});

test('the daily cap reserves per internal turn and releases every reservation', async () => {
  const h = harness({
    config: { ...CONFIG, complete: { dailyUsdByCaller: { canvas: 1 } } },
    chat: [() => reply({ calls: [call('s', 'web_search', { query: 'acme' })] }), () => reply({ text: 'ok' })],
    search: [() => json(SEARCH_RESULTS)],
  });
  try {
    const result = await complete(request(), h.options);
    assert.equal(result.ok, true);
    assert.deepEqual(readdirSync(__test.capPaths(h.ledgerPath).dir), []);
  } finally {
    h.done();
  }
});

test('cancelling while a web request is in flight is cancelled and still reports the billed chat turn', async () => {
  const controller = new AbortController();
  const h = harness({
    chat: [() => reply({ calls: [call('f', 'web_fetch', { url: 'https://slow.example/' })] })],
    fetchPage: [
      () => {
        setTimeout(() => controller.abort(), 5);
        return new Promise(() => {});
      },
    ],
  });
  try {
    const result = await complete(request(), { ...h.options, signal: controller.signal });
    assert.equal(result.error.code, 'cancelled');
    near(result.costUsd, CALL_COST);
    assert.equal(h.ledger()[0].error, 'cancelled');
    near(h.ledger()[0].costUsd, CALL_COST);
  } finally {
    h.done();
  }
});

test('built-in tool declarations are validated', async () => {
  const h = harness();
  try {
    const bad = [
      [{ builtin: 'web_browse' }],
      [{ builtin: 'web_search', count: 0 }],
      [{ builtin: 'web_search', count: 21 }],
      [{ builtin: 'web_fetch', maxChars: 999 }],
      [{ builtin: 'web_fetch', count: 3 }],
      [{ builtin: 'web_search', name: 'other' }],
      [{ builtin: 'web_search' }, { builtin: 'web_search' }],
      [{ builtin: 'web_search' }, { name: 'web_search', parameters: { type: 'object' } }],
    ];
    for (const tools of bad) {
      const result = await complete(request({ tools }), h.options);
      assert.equal(result.error?.code, 'invalid_request', JSON.stringify(tools));
    }
    assert.equal(h.chatBodies().length, 0);
    const normalized = validateCompleteRequest(request({ tools: [{ builtin: 'web_search' }] }));
    assert.equal(normalized.tools[0].options.count, 5);
    assert.equal(normalized.tools[0].parameters.required[0], 'query');
    assert.equal(builtinTool({ builtin: 'web_fetch' }).tool.options.maxChars, 20_000);
  } finally {
    h.done();
  }
});

test('web request prices come from the trusted complete table; dry run reports them as capabilities', async () => {
  assert.deepEqual(webToolPrices(loadPricing('deepseek-complete-2026-10-01')), { web_search: WEB, web_fetch: WEB });
  assert.equal(webToolPrices(loadPricing('deepseek-2026-10-01')), undefined, 'agent jobs have no web tool prices');
  const h = harness();
  try {
    const dry = await completeDryRun(
      {
        route: 'deepseek-flash',
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 10,
        tools: [{ builtin: 'web_search' }],
        toolLoop: { id: 'd' },
      },
      h.options,
    );
    assert.equal(dry.ok, true, JSON.stringify(dry));
    assert.deepEqual(dry.capabilities, { tools: true, builtinTools: ['web_search', 'web_fetch'] });
    assert.deepEqual(dry.pricing.webUsdPerRequest, { web_search: WEB, web_fetch: WEB });
  } finally {
    h.done();
  }
});

test('review fixes: web requests billed before a cancel are counted, and the cut-off turn is not returned', async () => {
  const controller = new AbortController();
  const h = harness({
    chat: [
      () => reply({ calls: [call('s', 'web_search', { query: 'acme' })] }),
      () => reply({ calls: [call('a', 'web_search', { query: 'one' }), call('b', 'web_fetch', { url: 'https://slow.example/' })] }),
    ],
    search: [() => json(SEARCH_RESULTS), () => json(SEARCH_RESULTS)],
    fetchPage: [
      () => {
        setTimeout(() => controller.abort(), 20);
        return new Promise(() => {});
      },
    ],
  });
  try {
    const result = await complete(request(), { ...h.options, signal: controller.signal });
    assert.equal(result.error.code, 'cancelled');
    near(result.costUsd, 2 * CALL_COST + 2 * WEB);
    assert.deepEqual(
      result.newMessages.map((message) => message.role),
      ['assistant', 'tool'],
      'only the finished first turn',
    );
    assert.deepEqual(
      h.ledger().map((line) => [line.turn, line.webSearches, line.error]),
      [
        [1, 1, null],
        [2, 1, 'cancelled'],
      ],
    );
    near(h.ledger()[1].costUsd, CALL_COST + WEB);
  } finally {
    h.done();
  }
});

test('review fixes: a fetch that returns no content is not billed', async () => {
  const h = harness({
    chat: [() => reply({ calls: [call('f', 'web_fetch', { url: 'https://empty.example/' })] }), () => reply({ text: 'ok' })],
    fetchPage: [() => json({ title: 'Empty', content: '' })],
  });
  try {
    const result = await complete(request(), h.options);
    assert.equal(JSON.parse(result.newMessages[1].content).error, 'no_content');
    near(result.costUsd, 2 * CALL_COST);
    assert.equal(h.ledger()[0].webFetches, 0);
  } finally {
    h.done();
  }
});

test('review fixes: provider titles, urls, dates and sites are length-capped', async () => {
  const h = harness({
    chat: [
      () => reply({ calls: [call('s', 'web_search', { query: 'acme' }), call('f', 'web_fetch', { url: 'https://acme.example/' })] }),
      () => reply({ text: 'ok' }),
    ],
    search: [
      () =>
        json({
          results: [
            {
              title: 'T'.repeat(5000),
              url: `https://x.example/${'u'.repeat(20_000)}`,
              date: 'D'.repeat(500),
              site_name: 'S'.repeat(5000),
              summary: 'ok',
            },
          ],
        }),
    ],
    fetchPage: [() => json({ title: 'T'.repeat(1_100_000), content: 'body' })],
  });
  try {
    const result = await complete(request({ toolLoop: { id: 'caps', maxToolCallsPerTurn: 2 } }), h.options);
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
    const [item] = JSON.parse(result.newMessages[1].content).results;
    assert.deepEqual([item.title.length, item.url.length, item.date.length, item.site.length], [500, 8192, 64, 200]);
    assert.ok(result.newMessages[2].content.length < 1000);
  } finally {
    h.done();
  }
});

test('review fixes: the dry-run worst case includes the web requests a turn may make', async () => {
  const h = harness();
  try {
    const base = {
      route: 'deepseek-flash',
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 10,
      toolLoop: { id: 'd', maxToolCallsPerTurn: 4 },
    };
    const host = await completeDryRun({ ...base, tools: [{ name: 'web_search', parameters: { type: 'object' } }] }, h.options);
    const web = await completeDryRun({ ...base, tools: [{ builtin: 'web_search' }] }, h.options);
    assert.ok(web.maxCostUsd - host.maxCostUsd > 4 * WEB - 1e-4, `${web.maxCostUsd} vs ${host.maxCostUsd}`);
  } finally {
    h.done();
  }
});
