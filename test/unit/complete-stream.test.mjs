import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { __test, complete, completeDryRun, streamComplete } from '../../src/complete.mjs';
import { runCompleteServe } from '../../src/complete-serve.mjs';
import { createKeepAliveFetch } from '../../src/keepalive-fetch.mjs';
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
const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 20 };
const sse = (event) => (event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** SSE events for `pieces` of answer text, `gapMs` apart; `hangAfter` stops the stream after that many pieces. */
function textEvents(pieces) {
  return [
    { id: 'cmpl-1', model: 'deepseek-v4-flash', choices: [{ delta: { role: 'assistant', content: '' } }] },
    ...pieces.map((content, index) => ({
      id: 'cmpl-1',
      choices: [{ delta: { content }, ...(index === pieces.length - 1 ? { finish_reason: 'stop' } : {}) }],
    })),
    { id: 'cmpl-1', choices: [], usage },
    '[DONE]',
  ];
}
function sseResponse(events, { gapMs = 5, hangAfter } = {}) {
  let index = 0;
  let pieces = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (hangAfter !== undefined && pieces >= hangAfter) return new Promise(() => {});
      if (index >= events.length) return controller.close();
      const event = events[index++];
      if (event?.choices?.[0]?.delta?.content) pieces++;
      controller.enqueue(enc.encode(sse(event)));
      await pause(gapMs);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A scripted DeepSeek. `chat(body)` returns a Response; the last user message picks the script. */
function fakeDeepSeek(chat) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body });
    if (path === '/models') return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }));
    if (path === '/chat/completions') return chat(JSON.parse(init.body), init);
    throw new Error(`unexpected request ${path}`);
  };
  return { fetchImpl, calls, chats: () => calls.filter((call) => call.path === '/chat/completions') };
}

function harness(chat = () => sseResponse(textEvents(['Hel', 'lo', '!']))) {
  const dir = tempDir('offload-stream-');
  const ledgerPath = join(dir, 'complete-ledger.jsonl');
  const server = fakeDeepSeek(chat);
  const options = { config: CONFIG, fetchImpl: server.fetchImpl, readKey: () => 'sk-test', ledgerPath, now: () => OFF_PEAK };
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
  messages: [{ role: 'user', content: 'PROMPT-TEXT' }],
  maxTokens: 100,
  reasoning: { enabled: false },
  timeoutMs: 5000,
  caller: 'voice',
  tag: 'opener',
  ...overrides,
});
const lastUser = (body) => body.messages.at(-1).content;

test.beforeEach(() => __test.clearModelCache());

test('stream: deltas arrive in order before the result; the result carries id, firstTokenMs and overheadMs', async () => {
  const h = harness();
  try {
    const deltas = [];
    let resultAt;
    const result = await complete(request({ stream: true, id: 'turn-1' }), {
      ...h.options,
      onDelta: (text) => {
        assert.equal(resultAt, undefined);
        deltas.push(text);
      },
    });
    resultAt = Date.now();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(deltas, ['Hel', 'lo', '!']);
    assert.equal(result.text, 'Hello!');
    assert.equal(result.id, 'turn-1');
    assert.ok(Number.isInteger(result.firstTokenMs) && result.firstTokenMs >= 0);
    assert.ok(Number.isInteger(result.overheadMs) && result.overheadMs >= 0);
    // The wire payload is unchanged by stream/id: DeepSeek always streams, and id never leaves Offload.
    const body = JSON.parse(h.server.chats()[0].body);
    assert.equal(body.id, undefined);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(h.ledger().length, 1);
  } finally {
    h.done();
  }
});

test('timing: firstTokenMs runs from request send to first text; overheadMs from overheadFrom to send', async () => {
  let clock = 1000;
  const h = harness(async () => {
    clock += 250; // time to first byte
    return sseResponse(textEvents(['a', 'b']));
  });
  try {
    const result = await complete(request(), { ...h.options, monotonicNow: () => clock, overheadFrom: 900 });
    assert.equal(result.ok, true);
    assert.equal(result.overheadMs, 100);
    assert.equal(result.firstTokenMs, 250);
    assert.equal(result.stream, undefined, 'non-streamed results look as before, plus timing');
  } finally {
    h.done();
  }
});

test('non-streamed results report firstTokenMs and overheadMs too, and no deltas are required', async () => {
  const h = harness();
  try {
    const result = await complete(request(), h.options);
    assert.equal(result.ok, true);
    assert.equal(typeof result.firstTokenMs, 'number');
    assert.equal(typeof result.overheadMs, 'number');
  } finally {
    h.done();
  }
});

test('streamComplete yields id-tagged deltas, then exactly one result line', async () => {
  const h = harness();
  try {
    const lines = [];
    for await (const line of streamComplete(request({ stream: true, id: 'g1' }), h.options)) lines.push(line);
    assert.deepEqual(
      lines.slice(0, -1),
      ['Hel', 'lo', '!'].map((text) => ({ type: 'delta', id: 'g1', text })),
    );
    assert.equal(lines.at(-1).type, 'result');
    assert.equal(lines.at(-1).ok, true);
    assert.equal(lines.at(-1).id, 'g1');
  } finally {
    h.done();
  }
});

test('an AbortSignal mid-stream ends as cancelled with the text already streamed, and the turn is recorded', async () => {
  const h = harness(() => sseResponse(textEvents(['first ', 'second ', 'third']), { hangAfter: 2 }));
  try {
    const controller = new AbortController();
    const lines = [];
    for await (const line of streamComplete(request({ stream: true, id: 'c1' }), { ...h.options, signal: controller.signal })) {
      lines.push(line);
      if (line.type === 'delta' && line.text === 'second ') controller.abort();
    }
    const result = lines.at(-1);
    assert.equal(result.type, 'result');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'cancelled');
    assert.equal(result.text, 'first second ');
    assert.equal(result.id, 'c1');
    assert.equal(typeof result.firstTokenMs, 'number');
    const [entry] = h.ledger();
    assert.equal(entry.error, 'cancelled');
    assert.ok(!JSON.stringify(h.ledger()).includes('first'), 'no response text on disk');
  } finally {
    h.done();
  }
});

test('a non-streamed cancellation does not echo partial text', async () => {
  const h = harness(() => sseResponse(textEvents(['first ', 'second']), { hangAfter: 1 }));
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const result = await complete(request(), { ...h.options, signal: controller.signal });
    assert.equal(result.error.code, 'cancelled');
    assert.equal(result.text, undefined);
  } finally {
    h.done();
  }
});

test('stream and id are validated before any network call', async () => {
  const h = harness();
  try {
    for (const bad of [
      { stream: 'yes' },
      { id: '' },
      { id: 'has space' },
      { id: 7 },
      { stream: true, tools: [{ name: 'f', parameters: { type: 'object' } }], toolLoop: { id: 'l' } },
    ]) {
      const result = await complete(request(bad), h.options);
      assert.equal(result.error?.code, 'invalid_request', JSON.stringify(bad));
    }
    assert.equal(h.server.calls.length, 0);
    const dry = await completeDryRun({ route: 'deepseek-flash' }, h.options);
    assert.equal(dry.capabilities.stream, true);
    assert.equal(dry.capabilities.serve, true);
  } finally {
    h.done();
  }
});

test('a throwing onDelta sink does not break the call', async () => {
  const h = harness();
  try {
    const result = await complete(request({ stream: true }), {
      ...h.options,
      onDelta: () => {
        throw new Error('sink');
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.text, 'Hello!');
  } finally {
    h.done();
  }
});

// ---- CLI one-shot --stream ----

function cli(argv, stdin, h) {
  const out = [];
  const signalSource = new EventEmitter();
  const run = () =>
    runCli(argv, {
      stdin: typeof stdin === 'string' ? Readable.from([Buffer.from(stdin)]) : stdin,
      stdout: { write: (text) => out.push(text) },
      stderr: { write: () => {} },
      createCore: () => {
        throw new Error('core must not be created');
      },
      signalSource,
      completeOptions: h.options,
    });
  const lines = () =>
    out
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { run, out, lines, signalSource };
}

test('cli complete --stream: NDJSON delta lines then one result line; stream:true in the request does the same', async () => {
  for (const [argv, extra] of [
    [['complete', '--stream'], {}],
    [['complete'], { stream: true }],
  ]) {
    const h = harness();
    try {
      const c = cli(argv, JSON.stringify(request({ id: 'x1', ...extra })), h);
      assert.equal(await c.run(), 0);
      const lines = c.lines();
      assert.deepEqual(
        lines.slice(0, -1),
        ['Hel', 'lo', '!'].map((text) => ({ type: 'delta', id: 'x1', text })),
      );
      assert.equal(lines.at(-1).type, 'result');
      assert.equal(lines.at(-1).text, 'Hello!');
      assert.equal(typeof lines.at(-1).overheadMs, 'number');
    } finally {
      h.done();
    }
  }
});

test('cli complete --stream: SIGTERM mid-stream ends with a cancelled result line and exit 17', async () => {
  const h = harness(() => sseResponse(textEvents(['one ', 'two']), { hangAfter: 1 }));
  try {
    const c = cli(['complete', '--stream'], JSON.stringify(request()), h);
    const running = c.run();
    while (!c.lines().some((line) => line.type === 'delta')) await pause(5);
    c.signalSource.emit('SIGTERM');
    assert.equal(await running, 17);
    const lines = c.lines();
    assert.deepEqual(lines[0], { type: 'delta', text: 'one ' });
    assert.equal(lines.at(-1).type, 'result');
    assert.equal(lines.at(-1).error.code, 'cancelled');
    assert.equal(lines.at(-1).text, 'one ');
  } finally {
    h.done();
  }
});

test('cli complete: --stream, --serve and --dry-run are mutually exclusive', async () => {
  const h = harness();
  try {
    for (const argv of [
      ['complete', '--stream', '--dry-run'],
      ['complete', '--serve', '--stream'],
      ['complete', '--serve', '--dry-run'],
    ]) {
      const c = cli(argv, '', h);
      assert.equal(await c.run(), 2, argv.join(' '));
      assert.equal(c.out.length, 0);
    }
  } finally {
    h.done();
  }
});

// ---- --serve (in process) ----

function serve(h, providerOptions = h.options) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const signalSource = new EventEmitter();
  let buffered = '';
  const lines = [];
  const waiters = [];
  stdout.on('data', (chunk) => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffered.slice(0, index)));
      buffered = buffered.slice(index + 1);
    }
    for (const waiter of [...waiters]) waiter();
  });
  const exit = runCompleteServe({ stdin, stdout, signalSource, providerOptions });
  const send = (line) => stdin.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
  /** Resolve once `predicate` holds for some line. */
  const waitFor = (predicate) =>
    new Promise((resolve) => {
      const check = () => {
        const found = lines.find(predicate);
        if (found) {
          waiters.splice(waiters.indexOf(check), 1);
          resolve(found);
        }
      };
      waiters.push(check);
      check();
    });
  return { stdin, stdout, signalSource, lines, exit, send, waitFor };
}

test('serve: ready line first, then concurrent requests multiplexed by id with their own deltas and one result each', async () => {
  const h = harness(async (body) => {
    if (lastUser(body) === 'slow') return sseResponse(textEvents(['s1', 's2', 's3']), { gapMs: 40 });
    if (lastUser(body) === 'fast') return sseResponse(textEvents(['f1', 'f2']), { gapMs: 5 });
    return sseResponse(textEvents(['plain']));
  });
  try {
    const s = serve(h);
    s.send(request({ id: 'slow', stream: true, messages: [{ role: 'user', content: 'slow' }] }));
    s.send(request({ id: 'fast', stream: true, messages: [{ role: 'user', content: 'fast' }] }));
    s.send(request({ id: 'quiet', messages: [{ role: 'user', content: 'quiet' }] }));
    s.stdin.end();
    assert.equal(await s.exit, 0);
    assert.equal(s.lines[0].type, 'ready');
    assert.equal(s.lines[0].version, 1);
    const of = (id) => s.lines.filter((line) => line.id === id);
    assert.deepEqual(
      of('slow')
        .filter((line) => line.type === 'delta')
        .map((line) => line.text),
      ['s1', 's2', 's3'],
    );
    assert.deepEqual(
      of('fast')
        .filter((line) => line.type === 'delta')
        .map((line) => line.text),
      ['f1', 'f2'],
    );
    assert.deepEqual(
      of('quiet').map((line) => line.type),
      ['result'],
      'no deltas without stream',
    );
    for (const id of ['slow', 'fast', 'quiet']) {
      const results = of(id).filter((line) => line.type === 'result');
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, true);
      assert.equal(typeof results[0].overheadMs, 'number');
      assert.equal(typeof results[0].firstTokenMs, 'number');
    }
    // Interleaved: the fast request finished while the slow one was still streaming.
    const index = (id) => s.lines.findIndex((line) => line.type === 'result' && line.id === id);
    assert.ok(index('fast') < index('slow'));
    assert.equal(h.server.calls.filter((call) => call.path === '/models').length, 1, 'model list is resolved once and reused');
    assert.equal(h.ledger().length, 3);
  } finally {
    h.done();
  }
});

test('serve: cancel by id stops that stream only; its result is cancelled with the text streamed so far', async () => {
  const h = harness(async (body) =>
    lastUser(body) === 'hang'
      ? sseResponse(textEvents(['partial ', 'never']), { hangAfter: 1 })
      : sseResponse(textEvents(['ok']), { gapMs: 30 }),
  );
  try {
    const s = serve(h);
    s.send(request({ id: 'h', stream: true, messages: [{ role: 'user', content: 'hang' }] }));
    await s.waitFor((line) => line.type === 'delta' && line.id === 'h');
    s.send(request({ id: 'other', messages: [{ role: 'user', content: 'other' }] }));
    s.send({ type: 'cancel', id: 'h' });
    const cancelled = await s.waitFor((line) => line.type === 'result' && line.id === 'h');
    assert.equal(cancelled.error.code, 'cancelled');
    assert.equal(cancelled.text, 'partial ');
    const other = await s.waitFor((line) => line.type === 'result' && line.id === 'other');
    assert.equal(other.ok, true);
    s.send({ type: 'cancel', id: 'h' });
    assert.equal((await s.waitFor((line) => line.type === 'error' && line.id === 'h')).message, 'no request in flight with this id');
    s.stdin.end();
    assert.equal(await s.exit, 0);
  } finally {
    h.done();
  }
});

test('serve: rejected lines get an error line and never reach the provider', async () => {
  const h = harness(() => sseResponse(textEvents(['x']), { hangAfter: 0 }));
  try {
    const s = serve(h);
    s.send('{not json');
    s.send('[1,2]');
    s.send(request()); // no id
    s.send({ type: 'bogus', id: 'b' });
    s.send(request({ id: 'dup' }));
    s.send(request({ id: 'dup' }));
    s.send(request({ id: 'bad', maxTokens: 0 }));
    const errors = () => s.lines.filter((line) => line.type === 'error');
    while (errors().length < 5) await pause(5);
    assert.equal((await s.waitFor((line) => line.type === 'result' && line.id === 'bad')).error.code, 'invalid_request');
    assert.deepEqual(
      errors().map((line) => line.id),
      [undefined, undefined, undefined, 'b', 'dup'],
    );
    assert.equal(h.server.chats().length, 1, 'only the first dup was sent');
    s.signalSource.emit('SIGTERM');
    assert.equal(await s.exit, 17);
    assert.equal(s.lines.filter((line) => line.type === 'result' && line.id === 'dup').length, 1);
  } finally {
    h.done();
  }
});

test('serve: SIGTERM cancels every in-flight request, each still gets its cancelled result, exit 17', async () => {
  const h = harness(() => sseResponse(textEvents(['a', 'b']), { hangAfter: 1 }));
  try {
    const s = serve(h);
    s.send(request({ id: 'one', stream: true }));
    s.send(request({ id: 'two' }));
    await s.waitFor((line) => line.type === 'delta' && line.id === 'one');
    while (h.server.chats().length < 2) await pause(5);
    s.signalSource.emit('SIGTERM');
    assert.equal(await s.exit, 17);
    for (const id of ['one', 'two'])
      assert.equal(s.lines.find((line) => line.type === 'result' && line.id === id)?.error.code, 'cancelled', id);
    assert.equal(s.signalSource.listenerCount('SIGTERM'), 0);
  } finally {
    h.done();
  }
});

test('serve: a broken stdout (host gone) cancels in-flight work so nothing keeps spending', async () => {
  let aborted = 0;
  const h = harness((body, init) => {
    init.signal.addEventListener('abort', () => aborted++);
    return sseResponse(textEvents(['a', 'b']), { hangAfter: 1 });
  });
  try {
    const s = serve(h);
    s.send(request({ id: 'one', stream: true }));
    await s.waitFor((line) => line.type === 'delta');
    s.stdout.destroy(new Error('EPIPE'));
    assert.equal(await s.exit, 17);
    assert.equal(aborted, 1);
    assert.equal(h.ledger()[0]?.error, 'cancelled', 'the turn is still recorded');
  } finally {
    h.done();
  }
});

test('serve: the API key is read once and reused across requests', async () => {
  const h = harness();
  try {
    let reads = 0;
    const s = serve(h, {
      ...h.options,
      readKey: () => {
        reads++;
        return 'sk-test';
      },
    });
    for (const id of ['a', 'b', 'c']) s.send(request({ id }));
    s.stdin.end();
    assert.equal(await s.exit, 0);
    assert.equal(s.lines.filter((line) => line.type === 'result' && line.ok).length, 3);
    assert.equal(reads, 1);
  } finally {
    h.done();
  }
});

test('serve: warm resolves the model ahead of the first turn and never posts a chat request', async () => {
  const h = harness();
  try {
    const s = serve(h);
    s.send({ type: 'warm', id: 'w', route: 'deepseek-flash' });
    const warm = await s.waitFor((line) => line.type === 'warm');
    assert.equal(warm.ok, true);
    assert.equal(warm.model, 'deepseek-v4-flash');
    assert.equal(warm.id, 'w');
    s.send(request({ id: 't' }));
    await s.waitFor((line) => line.type === 'result');
    s.stdin.end();
    assert.equal(await s.exit, 0);
    assert.equal(h.server.calls.filter((call) => call.path === '/models').length, 1);
    assert.equal(h.server.chats().length, 1);
  } finally {
    h.done();
  }
});

// ---- keep-alive fetch over a real loopback socket ----

function loopbackDeepSeek(handler) {
  const connections = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    handler(req, res, raw ? JSON.parse(raw) : undefined);
  });
  server.on('connection', (socket) => connections.push(socket));
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        connections,
        close: () =>
          new Promise((done) => {
            for (const socket of connections) socket.destroy();
            server.close(done);
          }),
      }),
    ),
  );
}
const streamOk = (res, pieces = ['ok']) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of textEvents(pieces)) res.write(sse(event));
  res.end();
};

test('keep-alive fetch reuses one socket across requests separated by idle time, and an abort destroys it', async () => {
  const server = await loopbackDeepSeek((req, res, body) => {
    if (req.url === '/hang') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse(textEvents(['x'])[1]));
      return undefined;
    }
    return streamOk(res, [body?.n ?? 'ok']);
  });
  const fetchImpl = createKeepAliveFetch();
  try {
    for (const n of ['1', '2']) {
      const response = await fetchImpl(`${server.url}/chat`, {
        method: 'POST',
        body: JSON.stringify({ n }),
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(`"content":"${n}"`));
      await pause(50);
    }
    assert.equal(server.connections.length, 1, 'the second request reused the warm connection');
    assert.equal(fetchImpl.idleSockets(), 1);
    const controller = new AbortController();
    const response = await fetchImpl(`${server.url}/hang`, { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await assert.rejects(reader.read());
    await pause(20);
    // The hanging request reused the pooled socket; the abort destroyed it instead of pooling it.
    assert.equal(fetchImpl.idleSockets(), 0, 'the aborted socket was not returned to the pool');
    const after = await fetchImpl(`${server.url}/chat`, { method: 'POST', body: JSON.stringify({ n: '3' }) });
    assert.match(await after.text(), /"content":"3"/);
    assert.equal(server.connections.length, 2, 'the next request opened a fresh connection');
  } finally {
    fetchImpl.close();
    await server.close();
  }
});

test('keep-alive fetch refuses redirects', async () => {
  const server = await loopbackDeepSeek((req, res) => {
    res.writeHead(302, { location: 'https://example.invalid/' });
    res.end();
  });
  const fetchImpl = createKeepAliveFetch();
  try {
    await assert.rejects(fetchImpl(`${server.url}/x`), /redirect/);
  } finally {
    fetchImpl.close();
    await server.close();
  }
});

// ---- process death: a real `--serve` process over real sockets ----

// Every serve process a test spawns, so a failed assertion cannot leave one
// alive: its open stdin would keep this file's event loop running until the
// suite's own timeout instead of reporting the failure.
const spawnedServes = new Set();
test.afterEach(() => {
  for (const child of spawnedServes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  spawnedServes.clear();
});

/**
 * Spawn a serve process whose DeepSeek traffic goes to the loopback server through the keep-alive fetch.
 * Its clock is pinned off-peak: DeepSeek prices are time-tiered, so a cap sized to one call's worst case
 * would otherwise admit the call or refuse it depending on the hour the suite runs.
 */
function spawnServe(serverUrl, ledgerPath, caps = {}) {
  const src = (path) => JSON.stringify(new URL(`../../src/${path}`, import.meta.url).href);
  const config = { ...CONFIG, complete: { dailyUsdByCaller: caps } };
  const script = `
    import { runCli } from ${src('cli.mjs')};
    import { createKeepAliveFetch } from ${src('keepalive-fetch.mjs')};
    const pool = createKeepAliveFetch();
    const fetchImpl = (url, init) => pool(String(url).replace('https://api.deepseek.com', ${JSON.stringify(serverUrl)}), init);
    process.exitCode = await runCli(['complete', '--serve'], {
      completeOptions: { fetchImpl, config: ${JSON.stringify(config)}, readKey: () => 'sk-test', ledgerPath: ${JSON.stringify(ledgerPath)}, now: () => ${OFF_PEAK} },
    });
    pool.close();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  spawnedServes.add(child);
  const lines = [];
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffered.slice(0, index)));
      buffered = buffered.slice(index + 1);
    }
  });
  child.stdout.on('error', () => {});
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const until = async (predicate, ms = 5000) => {
    const end = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > end) throw new Error(`timed out; lines: ${JSON.stringify(lines)}`);
      await pause(10);
    }
  };
  return { child, lines, exited, until, send: (line) => child.stdin.write(`${JSON.stringify(line)}\n`) };
}

test('process death: a SIGKILLed serve process drops its provider stream and its cap reservation does not block later calls', async () => {
  const dir = tempDir('offload-serve-death-');
  let requestClosed = false;
  const server = await loopbackDeepSeek((req, res) => {
    if (req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }));
    }
    res.on('close', () => (requestClosed = true));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse(textEvents(['spoken '])[0]));
    res.write(sse(textEvents(['spoken '])[1]));
    return undefined; // never finishes
  });
  try {
    const ledgerPath = join(dir, 'complete-ledger.jsonl');
    // A cap the stuck call's worst case fills: a later call fits only once that reservation is gone.
    const p = spawnServe(server.url, ledgerPath, { voice: 0.0001 });
    p.send(request({ id: 'k', stream: true, maxTokens: 120 }));
    await p.until(() => p.lines.some((line) => line.type === 'delta'));
    assert.equal(readdirSync(__test.capPaths(ledgerPath).dir).length, 1, 'the in-flight turn holds a reservation');
    p.child.kill('SIGKILL');
    assert.equal((await p.exited).signal, 'SIGKILL');
    const end = Date.now() + 5000;
    while (!requestClosed && Date.now() < end) await pause(10);
    assert.ok(requestClosed, 'the provider saw the stream close');
    // A new process admits a call under the same cap: the dead process's reservation is ignored and removed.
    const q = spawnServe(server.url, ledgerPath, { voice: 0.0001 });
    q.send({ type: 'warm', id: 'w', route: 'deepseek-flash' });
    await q.until(() => q.lines.some((line) => line.type === 'warm'));
    q.child.stdin.end();
    assert.equal((await q.exited).code, 0);
    const next = await complete(request({ maxTokens: 120 }), {
      config: { ...CONFIG, complete: { dailyUsdByCaller: { voice: 0.0001 } } },
      readKey: () => 'sk-test',
      ledgerPath,
      now: () => OFF_PEAK,
      fetchImpl: async (url) =>
        new URL(url).pathname === '/models'
          ? new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }))
          : sseResponse(textEvents(['fine'])),
    });
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.deepEqual(readdirSync(__test.capPaths(ledgerPath).dir), []);
  } finally {
    await server.close();
    cleanup(dir);
  }
});

test('process death: when the host goes away (pipes close) a serve process cancels its stream and exits', async () => {
  const dir = tempDir('offload-serve-host-');
  let requestClosed = false;
  const server = await loopbackDeepSeek((req, res) => {
    if (req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }));
    }
    res.on('close', () => (requestClosed = true));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let n = 0;
    const timer = setInterval(() => res.write(sse({ id: 'c', choices: [{ delta: { content: `w${n++} ` } }] })), 20);
    res.on('close', () => clearInterval(timer));
    return undefined;
  });
  try {
    const ledgerPath = join(dir, 'complete-ledger.jsonl');
    const p = spawnServe(server.url, ledgerPath);
    p.send(request({ id: 'h', stream: true }));
    await p.until(() => p.lines.some((line) => line.type === 'delta'));
    p.child.stdout.destroy();
    p.child.stdin.destroy();
    const { code } = await p.exited;
    assert.equal(code, 17);
    assert.ok(requestClosed, 'the provider stream was closed');
    const ledger = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].error, 'cancelled');
  } finally {
    await server.close();
    cleanup(dir);
  }
});
