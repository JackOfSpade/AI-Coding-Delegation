// Tests for test/fixtures/mock-anthropic.mjs, including end-to-end proofs with the REAL `claude -p`
// binary (skipped when it is not installed). Run:  node --test test/mock-anthropic.test.mjs
//
// Env knobs: CLAUDE_BIN=/path/to/claude   DSW_TMPDIR=/where/to/put/temp/dirs   DSW_KEEP=1 (keep temp dirs)
// Real-claude tests never touch the real ~/.claude: fresh CLAUDE_CONFIG_DIR + HOME, loopback-only
// (macOS sandbox-exec when available), dummy credentials, env built from scratch.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMock, toolUse, text, thinking, errorTurn } from './fixtures/mock-anthropic.mjs';
import { findClaude, makeScratch, makeTempRepo, runClaude, sandboxAvailable } from './fixtures/claude-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_FILE = join(here, 'fixtures', 'mock-anthropic.mjs');
const claudeBin = findClaude();

const scratchDirs = [];
const scratch = () => { const d = makeScratch(); scratchDirs.push(d); return d; };
after(() => { if (!process.env.DSW_KEEP) for (const d of scratchDirs) rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function withMock(opts, fn) {
  const mock = await startMock(opts);
  try { return await fn(mock); } finally { await mock.close(); }
}

const post = (mock, path, body, headers = {}) =>
  fetch(mock.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

function parseSse(body) {
  return body.split('\n\n').filter(Boolean).map((chunk) => {
    const ev = {};
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) ev.event = line.slice(7);
      else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
    }
    return ev;
  });
}

const mainBody = (extra = {}) => ({
  model: 'deepseek-v4-pro', max_tokens: 1000, stream: true,
  tools: [{ name: 'Bash', description: 'x', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

// ---------------------------------------------------------------------------
// mock server behaviour (no claude binary needed)
// ---------------------------------------------------------------------------

describe('mock server', () => {
  test('binds 127.0.0.1 on an ephemeral port', async () => {
    await withMock({}, async (mock) => {
      assert.match(mock.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.ok(mock.port > 0);
    });
  });

  test('streams text + thinking(+signature) + tool_use as Anthropic SSE', async () => {
    const input = { file_path: '/tmp/x.txt', content: 'a fairly long content string so that it gets split into several deltas' };
    await withMock({ script: [{ blocks: [thinking('pondering the task at hand'), text('Let me write the file.'), toolUse('Write', input)] }] }, async (mock) => {
      const res = await post(mock, '/v1/messages?beta=true', mainBody());
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/event-stream/);
      const evs = parseSse(await res.text());
      const names = evs.map((e) => e.event);
      assert.equal(names[0], 'message_start');
      assert.equal(names.at(-2), 'message_delta');
      assert.equal(names.at(-1), 'message_stop');
      assert.equal(evs[0].data.message.model, 'deepseek-v4-pro'); // echoes the requested model
      assert.equal(evs[0].data.message.role, 'assistant');

      const starts = evs.filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block.type);
      assert.deepEqual(starts, ['thinking', 'text', 'tool_use']);
      assert.equal(evs.filter((e) => e.event === 'content_block_stop').length, 3);

      const deltas = (idx, type) => evs.filter((e) => e.event === 'content_block_delta' && e.data.index === idx && e.data.delta.type === type).map((e) => e.data.delta);
      assert.equal(deltas(0, 'thinking_delta').map((d) => d.thinking).join(''), 'pondering the task at hand');
      assert.equal(deltas(0, 'signature_delta').length, 1);
      assert.ok(deltas(0, 'signature_delta')[0].signature.length > 0);
      assert.equal(deltas(1, 'text_delta').map((d) => d.text).join(''), 'Let me write the file.');
      const json = deltas(2, 'input_json_delta').map((d) => d.partial_json);
      assert.ok(json.length > 1, 'tool input is split across several input_json_delta events');
      assert.deepEqual(JSON.parse(json.join('')), input);

      const toolStart = evs.find((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use').data.content_block;
      assert.match(toolStart.id, /^toolu_[A-Za-z0-9_-]+$/);
      assert.equal(toolStart.name, 'Write');
      const md = evs.find((e) => e.event === 'message_delta').data;
      assert.equal(md.delta.stop_reason, 'tool_use');
      assert.ok(md.usage.output_tokens > 0);
    });
  });

  test('non-streaming request gets a plain JSON message', async () => {
    await withMock({ script: [{ blocks: [text('hello'), toolUse('Bash', { command: 'ls' })] }] }, async (mock) => {
      const res = await post(mock, '/v1/messages', mainBody({ stream: false }));
      assert.equal(res.status, 200);
      const msg = await res.json();
      assert.equal(msg.type, 'message');
      assert.equal(msg.stop_reason, 'tool_use');
      assert.equal(msg.content[0].text, 'hello');
      assert.deepEqual(msg.content[1].input, { command: 'ls' });
      assert.ok(msg.usage.input_tokens > 0);
    });
  });

  test('turn options: explicit stopReason, chunk=0 sends whole strings, usage override', async () => {
    await withMock({ script: [{ blocks: [text('abcdefghijklmnopqrstuvwxyz0123456789')], stopReason: 'max_tokens', chunk: 0, usage: { input_tokens: 123456 } }] }, async (mock) => {
      const evs = parseSse(await (await post(mock, '/v1/messages', mainBody())).text());
      assert.equal(evs.filter((e) => e.event === 'content_block_delta').length, 1);
      assert.equal(evs.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'max_tokens');
      assert.equal(evs[0].data.message.usage.input_tokens, 123456);
    });
  });

  test('array script is consumed in order, then replies "done" end_turn; setScript rewinds', async () => {
    await withMock({ script: [{ blocks: [text('one')] }, { blocks: [text('two')] }] }, async (mock) => {
      const ask = async () => (await (await post(mock, '/v1/messages', mainBody({ stream: false }))).json());
      assert.equal((await ask()).content[0].text, 'one');
      assert.equal((await ask()).content[0].text, 'two');
      const done = await ask();
      assert.equal(done.content[0].text, 'done');
      assert.equal(done.stop_reason, 'end_turn');
      mock.setScript([{ blocks: [text('again')] }]);
      assert.equal((await ask()).content[0].text, 'again');
      assert.equal(mock.mainRequests().length, 4);
    });
  });

  test('turn shorthands: string, array of blocks, single block', async () => {
    await withMock({ script: ['plain string', [text('a'), text('b')], toolUse('Bash', { command: 'pwd' })] }, async (mock) => {
      const ask = async () => (await (await post(mock, '/v1/messages', mainBody({ stream: false }))).json());
      assert.equal((await ask()).content[0].text, 'plain string');
      assert.equal((await ask()).content.length, 2);
      assert.equal((await ask()).content[0].name, 'Bash');
    });
  });

  test('function script receives ctx {n, body, model, lastToolResults, isAux}; trailing system messages are skipped', async () => {
    const seen = [];
    await withMock({ script: (ctx) => { seen.push(ctx); return ctx.n === 0 ? toolUse('Bash', { command: 'ls' }, 'toolu_fixed1') : text(`n=${ctx.n}`); } }, async (mock) => {
      await post(mock, '/v1/messages', mainBody({ stream: false }));
      const second = mainBody({
        stream: false,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fixed1', name: 'Bash', input: { command: 'ls' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fixed1', content: [{ type: 'text', text: 'a.txt\nb.txt' }], is_error: false }] },
          { role: 'system', content: [{ type: 'text', text: '<total_tokens>123 left</total_tokens>' }] }, // Claude Code appends these
        ],
      });
      const reply = await (await post(mock, '/v1/messages', second)).json();
      assert.equal(reply.content[0].text, 'n=1');
      assert.equal(seen[0].n, 0);
      assert.deepEqual(seen[0].lastToolResults, []);
      assert.equal(seen[1].n, 1);
      assert.equal(seen[1].isAux, false);
      assert.equal(seen[1].model, 'deepseek-v4-pro');
      assert.equal(seen[1].lastToolResults.length, 1);
      assert.deepEqual({ ...seen[1].lastToolResults[0], content: undefined }, {
        tool_use_id: 'toolu_fixed1', name: 'Bash', input: { command: 'ls' }, is_error: false, content: undefined, text: 'a.txt\nb.txt',
      });
    });
  });

  test('aux requests (tools: [] / no thinking) are answered by the built-in responder and do not consume the main script', async () => {
    await withMock({ script: [{ blocks: [text('MAIN-0')] }] }, async (mock) => {
      const aux = {
        model: 'deepseek-flash', max_tokens: 100, stream: false, tools: [],
        system: [{ type: 'text', text: 'Write a short summary label describing what these tool calls accomplished.' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Tools completed: ...\nLabel:' }] }],
      };
      const auxReply = await (await post(mock, '/v1/messages', aux)).json();
      assert.equal(auxReply.content[0].text, 'Ran tool calls');
      const mainReply = await (await post(mock, '/v1/messages', mainBody({ stream: false }))).json();
      assert.equal(mainReply.content[0].text, 'MAIN-0');
      assert.deepEqual(mock.requests.map((r) => r.kind), ['aux', 'main']);
      assert.equal(mock.auxRequests().length, 1);
    });
  });

  test('aux request asking for structured output gets a schema-valid JSON instance', async () => {
    await withMock({}, async (mock) => {
      const body = {
        model: 'deepseek-flash', max_tokens: 100, stream: false, tools: [],
        output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { title: { type: 'string' }, ok: { type: 'boolean' } }, required: ['title', 'ok'] } } },
        messages: [{ role: 'user', content: 'name this' }],
      };
      const reply = await (await post(mock, '/v1/messages', body)).json();
      const parsed = JSON.parse(reply.content[0].text);
      assert.equal(typeof parsed.title, 'string');
      assert.equal(parsed.ok, false);
    });
  });

  test('sub-agent requests (x-claude-code-agent-id) are kind "agent" and use agentScript', async () => {
    await withMock({ script: [{ blocks: [text('MAIN')] }], agentScript: [{ blocks: [text('AGENT')] }] }, async (mock) => {
      const agent = await (await post(mock, '/v1/messages', mainBody({ stream: false }), { 'x-claude-code-agent-id': 'abc123' })).json();
      const main = await (await post(mock, '/v1/messages', mainBody({ stream: false }))).json();
      assert.equal(agent.content[0].text, 'AGENT');
      assert.equal(main.content[0].text, 'MAIN');
      assert.deepEqual(mock.requests.map((r) => r.kind), ['agent', 'main']);
      assert.equal(mock.requests[0].agentId, 'abc123');
    });
  });

  test('error injection: status, default Anthropic error body, custom body and headers', async () => {
    await withMock({ script: [errorTurn(529), errorTurn(429, undefined, { 'retry-after': '7' }), { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'custom' } } }, { status: 401 }] }, async (mock) => {
      const r1 = await post(mock, '/v1/messages', mainBody());
      assert.equal(r1.status, 529);
      assert.equal((await r1.json()).error.type, 'overloaded_error');
      const r2 = await post(mock, '/v1/messages', mainBody());
      assert.equal(r2.status, 429);
      assert.equal(r2.headers.get('retry-after'), '7');
      const r3 = await post(mock, '/v1/messages', mainBody());
      assert.equal((await r3.json()).error.message, 'custom');
      const r4 = await post(mock, '/v1/messages', mainBody());
      assert.equal((await r4.json()).error.type, 'authentication_error');
    });
  });

  test('hangMs alone stalls then drops the connection; hangMs with blocks stalls then answers', async () => {
    await withMock({ script: [{ hangMs: 80 }, { hangMs: 80, blocks: [text('late')] }] }, async (mock) => {
      await assert.rejects(post(mock, '/v1/messages', mainBody()));
      const t0 = Date.now();
      const evs = parseSse(await (await post(mock, '/v1/messages', mainBody())).text());
      assert.ok(Date.now() - t0 >= 70);
      assert.ok(evs.some((e) => e.event === 'message_stop'));
    });
  });

  test('delayMs spaces SSE chunks', async () => {
    await withMock({ script: [{ blocks: [text('x')], delayMs: 40 }] }, async (mock) => {
      const t0 = Date.now();
      await (await post(mock, '/v1/messages', mainBody())).text();
      assert.ok(Date.now() - t0 >= 5 * 40 - 10, 'about 8 events * 40ms');
    });
  });

  test('streamError emits an SSE error event mid-stream', async () => {
    await withMock({ script: [{ blocks: [text('some text here')], streamError: { afterEvents: 3, type: 'overloaded_error' } }] }, async (mock) => {
      const evs = parseSse(await (await post(mock, '/v1/messages', mainBody())).text());
      assert.equal(evs.at(-1).event, 'error');
      assert.equal(evs.at(-1).data.error.type, 'overloaded_error');
      assert.ok(!evs.some((e) => e.event === 'message_stop'));
    });
  });

  test('a STRING tool input is streamed verbatim (malformed JSON injection)', async () => {
    await withMock({ script: [{ blocks: [toolUse('Write', '{"file_path": "/tmp/x", "content": "unterminated')] }] }, async (mock) => {
      const evs = parseSse(await (await post(mock, '/v1/messages', mainBody())).text());
      const json = evs.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.partial_json).join('');
      assert.equal(json, '{"file_path": "/tmp/x", "content": "unterminated');
      assert.throws(() => JSON.parse(json));
    });
  });

  test('count_tokens answers, /v1/models is 404, everything else is 200', async () => {
    await withMock({}, async (mock) => {
      const ct = await post(mock, '/v1/messages/count_tokens', { model: 'm', messages: [{ role: 'user', content: 'hello there' }] });
      assert.equal(ct.status, 200);
      assert.ok((await ct.json()).input_tokens > 0);
      const models = await fetch(mock.url + '/v1/models');
      assert.equal(models.status, 404);
      assert.equal((await models.json()).error.type, 'not_found_error');
      assert.equal((await fetch(mock.url + '/api/event_logging/batch', { method: 'POST', body: '{"events":[]}' })).status, 200);
      assert.equal((await fetch(mock.url + '/api/hello', { method: 'HEAD' })).status, 200);
      assert.equal((await fetch(mock.url + '/anything', { method: 'OPTIONS' })).status, 204);
      assert.deepEqual(mock.requests.map((r) => r.kind), ['count_tokens', 'models', 'other', 'other', 'options']);
    });
  });

  test('records every request with auth values redacted to their scheme, and appends JSONL to logFile', async () => {
    const dir = scratch();
    const logFile = join(dir, 'mock.jsonl');
    await withMock({ logFile, script: [{ blocks: [text('hi')] }] }, async (mock) => {
      await post(mock, '/v1/messages?beta=true', mainBody({ stream: false }), { 'x-api-key': 'sk-SECRET-1', 'anthropic-beta': 'a,b' });
      await post(mock, '/v1/messages', mainBody({ stream: false }), { authorization: 'Bearer SECRET-2' });
      const [a, b] = mock.requests;
      assert.equal(a.method, 'POST');
      assert.equal(a.path, '/v1/messages');
      assert.equal(a.query, 'beta=true');
      assert.equal(a.headers['x-api-key'], '[REDACTED]');
      assert.equal(a.headers['anthropic-beta'], 'a,b');
      assert.deepEqual(a.auth, { scheme: 'x-api-key' });
      assert.equal(b.headers.authorization, 'Bearer [REDACTED]');
      assert.deepEqual(b.auth, { scheme: 'bearer' });
      assert.equal(a.body.model, 'deepseek-v4-pro');
      assert.equal(a.response.stopReason, 'end_turn');
      assert.ok(!JSON.stringify(mock.requests).includes('SECRET'));
    });
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].body.messages[0].content, 'hi');
    assert.ok(!readFileSync(logFile, 'utf8').includes('SECRET'));
  });

  test('expectToken: wrong credential gets 401 for /v1/messages, right one (either header style) passes', async () => {
    await withMock({ expectToken: 'right', script: [{ blocks: [text('ok1')] }, { blocks: [text('ok2')] }] }, async (mock) => {
      assert.equal((await post(mock, '/v1/messages', mainBody({ stream: false }), { 'x-api-key': 'wrong' })).status, 401);
      assert.equal((await post(mock, '/v1/messages', mainBody({ stream: false }))).status, 401);
      assert.equal((await post(mock, '/v1/messages', mainBody({ stream: false }), { 'x-api-key': 'right' })).status, 200);
      assert.equal((await post(mock, '/v1/messages', mainBody({ stream: false }), { authorization: 'Bearer right' })).status, 200);
      assert.deepEqual(mock.requests.map((r) => r.auth.ok), [false, false, true, true]);
    });
  });

  test('basePath is part of url and is accepted as a prefix (mimics https://api.deepseek.com/anthropic)', async () => {
    await withMock({ basePath: '/anthropic', script: [{ blocks: [text('ok')] }] }, async (mock) => {
      assert.match(mock.url, /\/anthropic$/);
      const res = await post(mock, '/v1/messages?beta=true', mainBody({ stream: false }));
      assert.equal(res.status, 200);
      assert.equal(mock.requests[0].path, '/anthropic/v1/messages');
      assert.equal(mock.requests[0].kind, 'main');
    });
  });

  test('rejectBetas answers with the real Anthropic 400 text and does not consume the script', async () => {
    await withMock({ rejectBetas: ['bad-beta-1'], script: [{ blocks: [text('fine')] }] }, async (mock) => {
      const res = await post(mock, '/v1/messages', mainBody({ stream: false }), { 'anthropic-beta': 'ok-beta,bad-beta-1' });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, /^Unexpected value\(s\) `bad-beta-1` for the `anthropic-beta` header/);
      const ok = await post(mock, '/v1/messages', mainBody({ stream: false }), { 'anthropic-beta': 'ok-beta' });
      assert.equal((await ok.json()).content[0].text, 'fine');
    });
  });

  test('routes overrides non-messages endpoints (e.g. make HEAD /api/hello 404 like an upstream without it)', async () => {
    await withMock({ routes: { 'HEAD /api/hello': { status: 404 }, 'GET /v1/models': { status: 200, body: { data: [] } } } }, async (mock) => {
      assert.equal((await fetch(mock.url + '/api/hello', { method: 'HEAD' })).status, 404);
      const m = await fetch(mock.url + '/v1/models');
      assert.equal(m.status, 200);
      assert.deepEqual(await m.json(), { data: [] });
    });
  });

  test('waitFor resolves when a matching request arrives', async () => {
    await withMock({}, async (mock) => {
      const waiting = mock.waitFor((reqs) => reqs.some((r) => r.path === '/ping'), 2000);
      setTimeout(() => fetch(mock.url + '/ping'), 30);
      await waiting;
      await assert.rejects(mock.waitFor(() => false, 50), /timeout/);
    });
  });

  test('CLI: --script script.json --port 0 --log file prints the URL and serves', async () => {
    const dir = scratch();
    const scriptFile = join(dir, 'script.json');
    const logFile = join(dir, 'cli.jsonl');
    writeFileSync(scriptFile, JSON.stringify([{ blocks: [{ type: 'text', text: 'from cli' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }]));
    const child = spawn(process.execPath, [MOCK_FILE, '--script', scriptFile, '--port', '0', '--log', logFile], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      const url = await new Promise((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', (d) => { buf += d; const m = buf.match(/^(http:\/\/127\.0\.0\.1:\d+)\n/); if (m) resolve(m[1]); });
        child.on('exit', (c) => reject(new Error(`mock CLI exited early (${c})`)));
        setTimeout(() => reject(new Error('mock CLI did not print a URL')), 5000);
      });
      const msg = await (await fetch(`${url}/v1/messages`, { method: 'POST', body: JSON.stringify(mainBody({ stream: false })) })).json();
      assert.equal(msg.content[0].text, 'from cli');
      assert.match(msg.content[1].id, /^toolu_/); // id generated for a JSON-scripted tool_use
      assert.equal(msg.stop_reason, 'tool_use');
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    }
    assert.equal(readFileSync(logFile, 'utf8').trim().split('\n').length, 1);
  });
});

// ---------------------------------------------------------------------------
// the real `claude -p` against the mock
// ---------------------------------------------------------------------------

const skipReal = claudeBin ? false : 'claude binary not found (set CLAUDE_BIN)';
const CLAUDE_TIMEOUT = 60000;

describe('real claude -p against the mock', { skip: skipReal, concurrency: 3 }, () => {
  // Env that must never reach the child: the harness builds the env from scratch.
  const ALLOWED_ENV = new Set(['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy']);

  const toolResultsIn = (req) => (req.body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
  const toolUsesIn = (req) => (req.body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_use');

  for (const auth of ['api-key', 'auth-token']) {
    test(`PROOF (${auth}): Write -> Bash -> final text; file created, result line OK, tool_result round trips captured, no outside network`, async () => {
      const dir = scratch();
      const repo = makeTempRepo(dir);
      const target = join(repo, 'hello.txt');
      await withMock({
        script: [
          { blocks: [text('Creating the file.'), toolUse('Write', { file_path: target, content: 'hello from mock\n' })] },
          { blocks: [toolUse('Bash', { command: 'git status --short', description: 'git status' })] },
          { blocks: [text('All finished.')] },
        ],
      }, async (mock) => {
        const r = await runClaude({
          mock, auth, scratch: dir, cwd: repo, timeoutMs: CLAUDE_TIMEOUT,
          prompt: 'Create hello.txt containing a greeting, then run git status.',
          allowedTools: ['Write', 'Edit', 'Bash(git status*)'],
        });
        assert.equal(r.code, 0, `exit code; stderr: ${r.stderr}`);
        assert.deepEqual(r.rawLines, [], 'stdout is pure stream-json');

        // 1. the file was really created by claude's Write tool
        assert.equal(readFileSync(target, 'utf8'), 'hello from mock\n');

        // 2. final stream-json result line
        assert.equal(r.result.type, 'result');
        assert.equal(r.result.subtype, 'success');
        assert.equal(r.result.is_error, false);
        assert.equal(r.result.result, 'All finished.');
        assert.equal(r.result.num_turns, 3);
        assert.equal(r.result.terminal_reason, 'completed');
        assert.equal(r.init.type, 'system');

        // 3. mock.requests captured three main-loop requests with the tool_result round trips
        const main = mock.mainRequests();
        assert.equal(main.length, 3);
        assert.deepEqual(mock.requests.map((q) => q.kind), ['main', 'main', 'main'], 'no /v1/models, count_tokens, telemetry or aux calls in a plain -p run');
        assert.deepEqual(toolResultsIn(main[0]), []);
        const writeId = main[0].response.blocks.find((b) => b.type === 'tool_use').id;
        const bashId = main[1].response.blocks.find((b) => b.type === 'tool_use').id;
        const tr1 = toolResultsIn(main[1]);
        assert.equal(tr1.length, 1);
        assert.equal(tr1[0].tool_use_id, writeId);
        assert.match(JSON.stringify(tr1[0].content), /File created successfully/);
        const tr2 = toolResultsIn(main[2]);
        assert.deepEqual(tr2.map((t) => t.tool_use_id), [writeId, bashId]); // history is replayed in full
        assert.match(JSON.stringify(tr2[1].content), /\?\? hello\.txt/); // real `git status --short` output
        assert.deepEqual(toolUsesIn(main[2]).map((t) => t.name), ['Write', 'Bash']);
        assert.equal(main[0].path, '/v1/messages');
        assert.equal(main[0].query, 'beta=true');
        assert.equal(main[0].body.stream, true);

        // 4. auth style on the wire, redacted in the record
        if (auth === 'api-key') {
          assert.deepEqual(main[0].auth, { scheme: 'x-api-key' });
          assert.equal(main[0].headers['x-api-key'], '[REDACTED]');
          assert.equal(main[0].headers.authorization, undefined);
        } else {
          assert.deepEqual(main[0].auth, { scheme: 'bearer' });
          assert.equal(main[0].headers.authorization, 'Bearer [REDACTED]');
          assert.equal(main[0].headers['x-api-key'], undefined);
        }

        // 5. hermetic: env built from scratch, nothing tried to leave the machine
        assert.deepEqual(Object.keys(r.env).filter((k) => !ALLOWED_ENV.has(k)), []);
        assert.deepEqual(r.outsideAttempts, []);
        assert.ok(existsSync(join(r.configDir, '.claude.json')), 'state went to the fresh CLAUDE_CONFIG_DIR');
        console.log(`    [info] ${auth}: ${r.durationMs}ms, sandboxed=${r.sandboxed}`);
      });
    });
  }

  test('no credential at all => "Not logged in", exit 1, and nothing reaches the mock', async () => {
    await withMock({}, async (mock) => {
      const r = await runClaude({ mock, auth: 'none', scratch: scratch(), prompt: 'hi', timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 1);
      assert.equal(r.result.is_error, true);
      assert.match(r.result.result, /Not logged in/);
      assert.equal(mock.requests.filter((q) => q.kind === 'main').length, 0);
    });
  });

  test('wrong credential (expectToken) => 401 after retries => is_error with api_error_status 401', async () => {
    await withMock({ expectToken: 'the-right-token' }, async (mock) => {
      const r = await runClaude({ mock, auth: 'auth-token', token: 'the-wrong-token', scratch: scratch(), prompt: 'hi', env: { CLAUDE_CODE_MAX_RETRIES: '1' }, timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 1);
      assert.equal(r.result.is_error, true);
      assert.equal(r.result.api_error_status, 401);
      assert.ok(mock.requests.filter((q) => q.kind === 'messages-unauthorized').length >= 1);
    });
  });

  test('function script: Read -> Edit -> Edit(create) -> Edit(error); lastToolResults carries real tool output and is_error', async () => {
    const dir = scratch();
    const repo = makeTempRepo(dir);
    const seen = [];
    await withMock({
      script: (ctx) => {
        seen.push(ctx.lastToolResults.map((t) => ({ name: t.name, is_error: t.is_error, text: t.text })));
        switch (ctx.n) {
          case 0: return toolUse('Read', { file_path: join(repo, 'README.md') });
          case 1: return toolUse('Edit', { file_path: join(repo, 'README.md'), old_string: '# temp repo', new_string: '# edited repo' });
          case 2: return toolUse('Edit', { file_path: join(repo, 'new.txt'), old_string: '', new_string: 'brand new\n' }); // empty old_string creates the file
          case 3: return toolUse('Edit', { file_path: join(repo, 'missing.txt'), old_string: 'x', new_string: 'y' });
          default: return text('finished');
        }
      },
    }, async (mock) => {
      const r = await runClaude({ mock, scratch: dir, cwd: repo, prompt: 'edit things', allowedTools: ['Read', 'Edit'], timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.result, 'finished');
      assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), '# edited repo\n');
      assert.equal(readFileSync(join(repo, 'new.txt'), 'utf8'), 'brand new\n');
      assert.deepEqual(seen[0], []);
      assert.equal(seen[1][0].name, 'Read');
      assert.match(seen[1][0].text, /# temp repo/);
      assert.equal(seen[2][0].name, 'Edit');
      assert.equal(seen[2][0].is_error, false);
      assert.equal(seen[4][0].is_error, true);
      assert.match(seen[4][0].text, /<tool_use_error>File does not exist/);
    });
  });

  test('permission denial surfaces as an is_error tool_result (--allowedTools Edit does NOT permit Write under dontAsk)', async () => {
    const dir = scratch();
    const repo = makeTempRepo(dir);
    let denied;
    await withMock({
      script: (ctx) => {
        if (ctx.n === 0) return toolUse('Write', { file_path: join(repo, 'a.txt'), content: 'A\n' });
        denied = ctx.lastToolResults[0];
        return text('gave up');
      },
    }, async (mock) => {
      const r = await runClaude({ mock, scratch: dir, cwd: repo, prompt: 'write a.txt', allowedTools: ['Edit'], timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(existsSync(join(repo, 'a.txt')), false);
      assert.equal(denied.is_error, true);
      assert.match(denied.text, /Permission to use Write has been denied/);
    });
  });

  test('thinking blocks are echoed back (with their signature) in the next request', async () => {
    await withMock({
      script: [
        { blocks: [thinking('I should look first.', 'sig-abc-123'), text('Looking.'), toolUse('Bash', { command: 'echo hello', description: 'echo' })] },
        { blocks: [text('seen')] },
      ],
    }, async (mock) => {
      const r = await runClaude({ mock, scratch: scratch(), prompt: 'echo hello', allowedTools: ['Bash(echo *)'], timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 0, r.stderr);
      const second = mock.mainRequests()[1];
      const assistant = second.body.messages.find((m) => m.role === 'assistant');
      const th = assistant.content.find((b) => b.type === 'thinking');
      assert.equal(th.thinking, 'I should look first.');
      assert.equal(th.signature, 'sig-abc-123');
    });
  });

  test('529 is retried by claude and the next scripted turn is served; terminal 400 => is_error / terminal_reason api_error', async () => {
    await withMock({ script: [errorTurn(529), { blocks: [text('recovered')] }] }, async (mock) => {
      const r = await runClaude({ mock, scratch: scratch(), prompt: 'hi', env: { CLAUDE_CODE_MAX_RETRIES: '2' }, timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.result, 'recovered');
      assert.ok(r.events.some((e) => e.type === 'system' && e.subtype === 'api_retry' && e.error_status === 529));
      assert.deepEqual(mock.mainRequests().map((q) => q.response.status), [529, 200]);
    });
    await withMock({ script: [errorTurn(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages.1: bad stuff' } })] }, async (mock) => {
      const r = await runClaude({ mock, scratch: scratch(), prompt: 'hi', timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 1);
      assert.equal(r.result.is_error, true);
      assert.equal(r.result.terminal_reason, 'api_error');
      assert.equal(r.result.api_error_status, 400);
      assert.equal(r.result.result, 'API Error: 400 messages.1: bad stuff');
      assert.equal(mock.mainRequests().length, 1, '400 is not retried');
    });
  });

  test('a stalled response (hangMs) hits API_TIMEOUT_MS, is retried, and the mock sees the client go away', async () => {
    await withMock({ script: [{ hangMs: 60000, blocks: [text('never')] }, { blocks: [text('second try')] }] }, async (mock) => {
      const r = await runClaude({ mock, scratch: scratch(), prompt: 'hi', env: { API_TIMEOUT_MS: '1500', CLAUDE_CODE_MAX_RETRIES: '1' }, timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.result, 'second try');
      assert.equal(mock.mainRequests()[0].response.clientClosed, true);
    });
  });

  test('a mid-stream SSE error makes claude fall back to a NON-streaming request (served from the next turn)', async () => {
    await withMock({ script: [{ blocks: [text('partial text that will be cut short by an error')], streamError: { afterEvents: 4 } }, { blocks: [text('after fallback')] }] }, async (mock) => {
      const r = await runClaude({ mock, scratch: scratch(), prompt: 'hi', env: { CLAUDE_CODE_MAX_RETRIES: '2' }, timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.result, 'after fallback');
      assert.deepEqual(mock.mainRequests().map((q) => q.body.stream), [true, false]);
    });
  });

  test('upstream that rejects an anthropic-beta (rejectBetas): claude strips it, drops role:"system" messages, and retries', async () => {
    await withMock({ rejectBetas: ['mid-conversation-system-2026-04-07'], script: [{ blocks: [text('hello')] }] }, async (mock) => {
      const r = await runClaude({ mock, scratch: scratch(), prompt: 'hi', timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 0, r.stderr);
      const main = mock.mainRequests();
      assert.deepEqual(main.map((q) => q.response.status), [400, 200]);
      assert.ok(main[0].body.messages.some((m) => m.role === 'system'), 'first attempt carries a mid-conversation system message');
      assert.ok(!main[1].body.messages.some((m) => m.role === 'system'), 'retry has none');
      assert.ok(!main[1].headers['anthropic-beta'].includes('mid-conversation-system'));
    });
  });

  test('aux (haiku-class) requests are classified "aux", answered, and never consume the main script', async () => {
    await withMock({
      script: [
        { blocks: [toolUse('Bash', { command: 'echo hello', description: 'echo' })] },
        { blocks: [text('MAIN FINAL')] },
        { blocks: [text('MUST NOT BE USED')] },
      ],
    }, async (mock) => {
      const r = await runClaude({
        mock, scratch: scratch(), prompt: 'echo hello', allowedTools: ['Bash(echo *)'], timeoutMs: CLAUDE_TIMEOUT,
        // CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES makes claude issue a helper call on the small/fast (haiku-class) model
        env: { ANTHROPIC_MODEL: 'deepseek-v4-pro', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash', CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES: '1' },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.result, 'MAIN FINAL');
      const aux = mock.auxRequests();
      assert.ok(aux.length >= 1, 'a helper request was made');
      assert.equal(aux[0].body.model, 'deepseek-flash');
      assert.deepEqual(aux[0].body.tools, []);
      assert.equal(aux[0].body.thinking, undefined);
      assert.equal(aux[0].response.source, 'aux-default');
      assert.equal(mock.mainRequests().length, 2);
      assert.deepEqual(mock.mainRequests().map((q) => q.body.model), ['deepseek-v4-pro', 'deepseek-v4-pro']);
    });
  });

  test('DeepSeek-style env: AUTH_TOKEN bearer, /anthropic base path, model aliases on the wire, effort, metadata.user_id', async () => {
    await withMock({ basePath: '/anthropic', expectToken: 'ds-token', script: [{ blocks: [text('ok')] }] }, async (mock) => {
      const r = await runClaude({
        mock, auth: 'auth-token', token: 'ds-token', scratch: scratch(), prompt: 'hi', timeoutMs: CLAUDE_TIMEOUT,
        env: {
          ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
          CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
          CLAUDE_CODE_EFFORT_LEVEL: 'max',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
        },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.result, 'ok');
      const req = mock.mainRequests()[0];
      assert.equal(req.path, '/anthropic/v1/messages');
      assert.equal(req.auth.ok, true);
      assert.equal(req.body.model, 'deepseek-v4-pro', 'the [1m] suffix is a client-side marker and is stripped on the wire');
      assert.deepEqual(req.body.output_config, { effort: 'max' });
      assert.equal(req.body.thinking.type, 'adaptive');
      const uid = JSON.parse(req.body.metadata.user_id); // a JSON *string*: contains { } " : (DeepSeek reportedly only allows [A-Za-z0-9_-])
      assert.equal(uid.session_id, r.init.session_id);
    });
  });

  test('sub-agent (Agent tool, foreground) requests are kind "agent", carry x-claude-code-agent-id and use CLAUDE_CODE_SUBAGENT_MODEL', async () => {
    await withMock({
      script: (ctx) => {
        if (ctx.isSubagent) return text('SUBAGENT REPORT: nothing found.');
        if (ctx.n === 0) return [text('Delegating.'), toolUse('Agent', { description: 'Find things', prompt: 'List files and report.', subagent_type: 'claude', run_in_background: false })];
        return text('Main final.');
      },
    }, async (mock) => {
      const r = await runClaude({
        mock, scratch: scratch(), prompt: 'delegate', allowedTools: ['Agent'], timeoutMs: CLAUDE_TIMEOUT,
        env: { ANTHROPIC_MODEL: 'deepseek-v4-pro', CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash' },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.result, 'Main final.');
      const agent = mock.agentRequests();
      assert.equal(agent.length, 1);
      assert.equal(agent[0].body.model, 'deepseek-flash');
      assert.ok(agent[0].agentId);
      assert.equal(mock.mainRequests().length, 2);
      assert.match(JSON.stringify(toolResultsIn(mock.mainRequests()[1])), /SUBAGENT REPORT/);
    });
  });

  test('--json-schema: scripting a StructuredOutput tool_use yields result.structured_output', async () => {
    await withMock({ script: [{ blocks: [toolUse('StructuredOutput', { answer: 'forty-two', n: 42 })] }, { blocks: [text('done')] }] }, async (mock) => {
      const schema = { type: 'object', properties: { answer: { type: 'string' }, n: { type: 'number' } }, required: ['answer', 'n'] };
      const r = await runClaude({ mock, scratch: scratch(), prompt: 'answer', args: ['--json-schema', JSON.stringify(schema)], timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.result.structured_output, { answer: 'forty-two', n: 42 });
      assert.ok(mock.mainRequests()[0].body.tools.some((t) => t.name === 'StructuredOutput'));
    });
  });

  test('minimal env: HOME may be unset, and --bare works with both auth styles', async () => {
    for (const [auth, args] of [['api-key', []], ['auth-token', []], ['api-key', ['--bare']], ['auth-token', ['--bare']]]) {
      await withMock({ script: [{ blocks: [text(`ok ${auth} ${args.join(' ')}`.trim())] }] }, async (mock) => {
        const r = await runClaude({ mock, auth, args, scratch: scratch(), prompt: 'hi', env: { HOME: null }, timeoutMs: CLAUDE_TIMEOUT });
        assert.equal(r.code, 0, `${auth} ${args}: ${r.stderr}`);
        assert.equal(r.env.HOME, undefined);
        assert.equal(r.result.result, `ok ${auth} ${args.join(' ')}`.trim());
        assert.equal(mock.mainRequests()[0].auth.scheme, auth === 'api-key' ? 'x-api-key' : 'bearer');
      });
    }
  });

  test('NEGATIVE CONTROL: without CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC claude tries api.anthropic.com (caught by the refusing canary proxy)', { skip: sandboxAvailable() ? false : 'only run when the loopback-only sandbox is available' }, async () => {
    await withMock({ script: [{ blocks: [text('ok')] }] }, async (mock) => {
      const r = await runClaude({ mock, scratch: scratch(), prompt: 'hi', env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: null }, timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 0, r.stderr); // the refused / blocked telemetry never breaks the run
      assert.ok(r.outsideAttempts.some((a) => a === 'CONNECT api.anthropic.com:443'), `canary saw: ${JSON.stringify(r.outsideAttempts)}`);
    });
  });

  test('without the proxy env claude also sends HEAD /api/hello to the base URL; a 404 for it (like DeepSeek) does not matter', async () => {
    await withMock({ routes: { 'HEAD /api/hello': { status: 404 } }, basePath: '/anthropic', script: [{ blocks: [text('ok')] }] }, async (mock) => {
      const r = await runClaude({ mock, scratch: scratch(), prompt: 'hi', canary: false, timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.result, 'ok');
      const hello = mock.requests.find((q) => q.method === 'HEAD');
      assert.equal(hello.path, '/anthropic/api/hello'); // relative to the base URL, NOT under /v1
      assert.equal(hello.response.status, 404);
    });
  });

  test('gotcha: stdin left as an open pipe makes claude wait 3s and warn; stream-json needs --verbose with -p', async () => {
    await withMock({ script: [{ blocks: [text('ok')] }] }, async (mock) => {
      const slow = await runClaude({ mock, scratch: scratch(), prompt: 'hi', stdin: 'pipe-open', timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(slow.code, 0);
      assert.match(slow.stderr, /no stdin data received in 3s/);
      assert.ok(slow.durationMs >= 3000, `took ${slow.durationMs}ms`);
    });
    await withMock({}, async (mock) => {
      const r = await runClaude({ mock, scratch: scratch(), cliArgs: ['-p', 'hi', '--output-format', 'stream-json'], timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /--output-format=stream-json requires --verbose/);
      assert.equal(mock.requests.length, 0);
    });
  });

  test('429 (retry-after) and 500 are retried by claude', async () => {
    for (const first of [errorTurn(429, undefined, { 'retry-after': '0' }), errorTurn(500)]) {
      await withMock({ script: [first, { blocks: [text('recovered')] }] }, async (mock) => {
        const r = await runClaude({ mock, scratch: scratch(), prompt: 'hi', env: { CLAUDE_CODE_MAX_RETRIES: '2' }, timeoutMs: CLAUDE_TIMEOUT });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.result.result, 'recovered');
        assert.deepEqual(mock.mainRequests().map((q) => q.response.status), [first.status, 200]);
      });
    }
  });

  test('huge usage.input_tokens triggers claude\'s LOCAL auto-compaction (status events) - no summarisation request reaches the mock', async () => {
    const dir = scratch();
    const repo = makeTempRepo(dir);
    await withMock({
      script: (ctx) => (ctx.n < 4
        ? { blocks: [toolUse('Bash', { command: `echo step ${ctx.n}`, description: 'echo' })], usage: { input_tokens: 190000 } }
        : { blocks: [text('after compaction')] }),
    }, async (mock) => {
      const r = await runClaude({ mock, scratch: dir, cwd: repo, prompt: 'loop', allowedTools: ['Bash(echo *)'], env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' }, timeoutMs: CLAUDE_TIMEOUT });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.result, 'after compaction');
      assert.ok(r.events.some((e) => e.type === 'system' && e.subtype === 'status' && e.status === 'compacting'), 'compaction was attempted');
      assert.deepEqual(mock.requests.map((q) => q.kind), ['main', 'main', 'main', 'main', 'main'], 'no extra request for compaction');
    });
  });

  test('the optional macOS sandbox profile blocks outside network and writes under <home>/.claude (checked against a throwaway fake home, never the real one)', { skip: sandboxAvailable() ? false : 'sandbox-exec not available' }, async () => {
    const { execFileSync } = await import('node:child_process');
    const { sandboxProfile } = await import('./fixtures/claude-harness.mjs');
    const { mkdirSync } = await import('node:fs');
    const fakeHome = scratch();
    mkdirSync(join(fakeHome, '.claude'));
    const sb = (cmd) => { try { execFileSync('/usr/bin/sandbox-exec', ['-p', sandboxProfile(fakeHome), ...cmd], { stdio: 'pipe', timeout: 10000 }); return 0; } catch (e) { return e.status ?? 1; } };
    assert.notEqual(sb(['/usr/bin/curl', '-sS', '-m', '4', 'https://example.com']), 0, 'outside network is denied');
    assert.notEqual(sb(['/usr/bin/touch', join(fakeHome, '.claude', 'probe')]), 0, 'writes under <home>/.claude are denied');
    assert.notEqual(sb(['/usr/bin/touch', join(fakeHome, '.claude.json')]), 0, 'writes to <home>/.claude.json are denied');
    assert.equal(sb(['/usr/bin/touch', join(fakeHome, 'other.txt')]), 0, 'other writes are still allowed');
    assert.equal(existsSync(join(fakeHome, '.claude', 'probe')), false);
  });
});
