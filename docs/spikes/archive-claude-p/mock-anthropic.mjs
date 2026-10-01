#!/usr/bin/env node
// mock-anthropic.mjs - a scripted mock of the Anthropic Messages API.
//
// Purpose: let the REAL `claude -p` binary (Claude Code 2.1.x) run end-to-end
// against a local server with no real model, no real key and no outside network.
// Node built-ins only. See ./README.md for the API, script examples and gotchas.
//
//   import { startMock, toolUse, text } from './mock-anthropic.mjs';
//   const mock = await startMock({ script: [
//     { blocks: [toolUse('Write', { file_path: '/tmp/x.txt', content: 'hi' })] },
//     { blocks: [text('all done')] },
//   ]});
//   // ... spawn claude with ANTHROPIC_BASE_URL=mock.url ...
//   await mock.close();
//
// CLI:  node mock-anthropic.mjs --script script.json --port 0 --log file.jsonl
//       prints the base URL (one line) to stdout and serves until SIGINT/SIGTERM.

import http from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

// ---------------------------------------------------------------------------
// Script helpers (exported)
// ---------------------------------------------------------------------------

let idCounter = 0;
const nextId = (prefix) => `${prefix}_mock${(++idCounter).toString().padStart(4, '0')}${randomBytes(4).toString('hex')}`;

/** Text content block. */
export const text = (t) => ({ type: 'text', text: String(t) });

/**
 * Thinking content block. A random signature is generated unless one is given;
 * `signature: null` => no signature_delta is streamed at all.
 */
export const thinking = (t, signature) =>
  signature === undefined ? { type: 'thinking', thinking: String(t) } : { type: 'thinking', thinking: String(t), signature };

/**
 * tool_use block with a generated id (`toolu_mock...`).
 * `input` is normally an object. If it is a STRING it is streamed verbatim as the
 * input_json_delta payload, which lets a script emit malformed / partial JSON.
 */
export const toolUse = (name, input = {}, id) => ({ type: 'tool_use', id: id ?? nextId('toolu'), name, input });

/** A turn made of the given blocks (array or single block) plus optional turn fields. */
export const turn = (blocks, extra = {}) => ({ blocks: [].concat(blocks), ...extra });

/** An error-injection turn: `errorTurn(529)`, `errorTurn(429, undefined, {'retry-after': '0'})`. */
export const errorTurn = (status, body, headers) => ({ status, ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) });

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'billing_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  503: 'api_error',
  529: 'overloaded_error',
};

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, Math.min(ms, 2 ** 31 - 1));
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

const REDACT = '[REDACTED]';
function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (key === 'authorization' || key === 'proxy-authorization') {
      const scheme = String(v).split(/\s+/)[0] || '';
      out[key] = scheme ? `${scheme} ${REDACT}` : REDACT; // keep the scheme (Bearer), drop the secret
    } else if (key === 'x-api-key' || key === 'cookie' || key === 'set-cookie') {
      out[key] = REDACT;
    } else {
      out[key] = v;
    }
  }
  return out;
}

const textOf = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b?.text ?? (b?.type === 'image' ? '[image]' : ''))).join('') : '';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      try {
        const enc = String(req.headers['content-encoding'] || '').toLowerCase();
        if (enc === 'gzip') buf = gunzipSync(buf);
        else if (enc === 'deflate') buf = inflateSync(buf);
        else if (enc === 'br') buf = brotliDecompressSync(buf);
      } catch (e) {
        return resolve({ raw: buf.toString('utf8'), parseError: `decode ${e.message}` });
      }
      const raw = buf.toString('utf8');
      if (!raw) return resolve({});
      try { resolve({ json: JSON.parse(raw), raw }); }
      catch (e) { resolve({ raw, parseError: e.message }); }
    });
    req.on('error', reject);
  });
}

function splitChunks(str, size) {
  if (!size || size <= 0) return str === '' ? [] : [str];
  const cps = Array.from(str);
  const out = [];
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''));
  return out;
}

const approxTokens = (v) => Math.max(1, Math.ceil((typeof v === 'string' ? v : JSON.stringify(v ?? '')).length / 4));

/**
 * Pull the tool_result blocks out of the most recent user message, joined to their tool_use (name/input).
 * Claude Code appends mid-conversation `role:"system"` messages AFTER the tool_result user message
 * (e.g. `<total_tokens>` reminders), so trailing system messages are skipped.
 */
function extractToolResults(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].role === 'system') i--;
  const last = msgs[i];
  if (!last || last.role !== 'user' || !Array.isArray(last.content)) return [];
  const uses = new Map();
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === 'tool_use') uses.set(b.id, b);
    }
  }
  return last.content
    .filter((b) => b?.type === 'tool_result')
    .map((b) => ({
      tool_use_id: b.tool_use_id,
      name: uses.get(b.tool_use_id)?.name,
      input: uses.get(b.tool_use_id)?.input,
      is_error: !!b.is_error,
      content: b.content,
      text: textOf(b.content),
    }));
}

/** Build a minimal JSON value that satisfies a (simple) JSON schema. */
function instanceFromSchema(schema, hint = 'Mock') {
  if (!schema || typeof schema !== 'object') return hint;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') ?? 'null' : schema.type;
  const alt = schema.anyOf || schema.oneOf;
  if (!type && Array.isArray(alt) && alt.length) return instanceFromSchema(alt.find((s) => s.type !== 'null') ?? alt[0], hint);
  switch (type) {
    case 'object': {
      const o = {};
      const props = schema.properties || {};
      for (const k of Object.keys(props)) o[k] = instanceFromSchema(props[k], `${hint} ${k}`);
      return o;
    }
    case 'array': return [];
    case 'string': return hint;
    case 'integer': case 'number': return 0;
    case 'boolean': return false;
    case 'null': return null;
    default: return hint;
  }
}

/**
 * Classify a POST /v1/messages request as 'main' | 'agent' | 'aux'.
 *
 * Observed with Claude Code 2.1.284 (see README "Request classification"):
 *  - main loop / sub-agent requests carry a non-empty `tools` array, `thinking`,
 *    `context_management`, and a `<system-reminder>` first user block or a
 *    mid-conversation `role:"system"` message. Sub-agent requests additionally carry
 *    an `x-claude-code-agent-id` header.
 *  - helper requests (e.g. the tool-use summary label) have `tools: []`, no `thinking`,
 *    no `context_management`, and a single plain user message.
 * Anything "main-like" is main/agent; the rest is aux. Override with `options.classify`.
 */
export function defaultClassify(body, headers = {}) {
  if (!body || typeof body !== 'object') return 'aux';
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const firstUser = msgs.find((m) => m.role === 'user');
  const firstBlock = Array.isArray(firstUser?.content) ? firstUser.content[0] : undefined;
  const hasReminder = typeof firstBlock?.text === 'string' && firstBlock.text.startsWith('<system-reminder>');
  const hasSystemRole = msgs.some((m) => m.role === 'system');
  const mainLike = hasTools || body.thinking !== undefined || body.context_management !== undefined || hasReminder || hasSystemRole;
  if (!mainLike) return 'aux';
  return headers['x-claude-code-agent-id'] ? 'agent' : 'main';
}

/** Sensible canned answer for an aux request. Returns a turn. */
export function defaultAuxTurn(body) {
  const sys = textOf(body?.system);
  const fmt = body?.output_config?.format ?? body?.response_format;
  const schema = fmt?.schema ?? fmt?.json_schema?.schema;
  if (schema) return { blocks: [text(JSON.stringify(instanceFromSchema(schema, 'Mock title')))], stopReason: 'end_turn' };
  if (/summary label/i.test(sys)) return { blocks: [text('Ran tool calls')], stopReason: 'end_turn' }; // tool_use_summary_generation
  if (/\btitle\b/i.test(sys) && /json/i.test(sys)) return { blocks: [text('{"title": "Mock session"}')], stopReason: 'end_turn' };
  if (/isNewTopic/i.test(sys)) return { blocks: [text('{"isNewTopic": false, "title": null}')], stopReason: 'end_turn' };
  return { blocks: [text('ok')], stopReason: 'end_turn' };
}

function normalizeTurn(t) {
  if (t === undefined || t === null) return null;
  if (typeof t === 'string') return { blocks: [text(t)] };
  if (Array.isArray(t)) return { blocks: t.map((b) => (typeof b === 'string' ? text(b) : b)) };
  if (typeof t === 'object' && ['text', 'thinking', 'tool_use'].includes(t.type)) return { blocks: [t] };
  if (typeof t === 'object') return { ...t, ...(Array.isArray(t.blocks) ? { blocks: t.blocks.map((b) => (typeof b === 'string' ? text(b) : b)) } : {}) };
  return null;
}

/** Fill in generated ids / signatures so what we log is exactly what we send. */
function materializeBlocks(blocks) {
  return (blocks ?? []).map((b) => {
    if (b.type === 'tool_use') return { ...b, id: b.id ?? nextId('toolu'), input: b.input ?? {} };
    if (b.type === 'thinking') return { ...b, ...(b.signature === undefined ? { signature: `mocksig${randomBytes(6).toString('hex')}` } : {}) };
    return { ...b };
  });
}

function buildUsage(body, blocks, turnUsage) {
  const outTok = blocks.reduce((n, b) => n + approxTokens(b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : b.input), 0);
  return {
    input_tokens: approxTokens(body ?? ''),
    output_tokens: outTok,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...(turnUsage ?? {}),
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

function buildMessage({ id, model, blocks, stopReason, usage }) {
  return {
    id, type: 'message', role: 'assistant', model,
    content: blocks.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking, ...(b.signature !== null ? { signature: b.signature } : {}) };
      return { type: 'tool_use', id: b.id, name: b.name, input: typeof b.input === 'string' ? safeParse(b.input) : b.input };
    }),
    stop_reason: stopReason, stop_sequence: null, usage,
  };
}

function buildSseEvents({ id, model, blocks, stopReason, usage, chunk }) {
  const ev = [];
  ev.push(['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }]);
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      if (index === 0) ev.push(['ping', { type: 'ping' }]);
      for (const piece of splitChunks(b.text, chunk)) ev.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }]);
    } else if (b.type === 'thinking') {
      ev.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }]);
      if (index === 0) ev.push(['ping', { type: 'ping' }]);
      for (const piece of splitChunks(b.thinking, chunk)) ev.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: piece } }]);
      if (b.signature !== null) ev.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } }]);
    } else if (b.type === 'tool_use') {
      ev.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }]);
      if (index === 0) ev.push(['ping', { type: 'ping' }]);
      const json = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {});
      for (const piece of splitChunks(json, chunk)) ev.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } }]);
    }
    ev.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage }]);
  ev.push(['message_stop', { type: 'message_stop' }]);
  return ev;
}

// ---------------------------------------------------------------------------
// startMock
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {Array|Function} [options.script]       turns for MAIN-thread requests (array consumed in order) or `(ctx) => turn`
 *                                                 (a function is called for main, agent and aux requests alike)
 * @param {Array|Function} [options.agentScript]  same, for sub-agent requests (those carrying x-claude-code-agent-id)
 * @param {string}  [options.logFile]             append one JSON line per request
 * @param {number}  [options.port=0]              0 = ephemeral
 * @param {string}  [options.basePath='']         path prefix appended to `url` (e.g. '/anthropic' to mimic DeepSeek)
 * @param {string}  [options.expectToken]         if set, /v1/messages requests whose x-api-key / Bearer token differ get a 401
 * @param {string}  [options.defaultText='done']  text sent once a script is exhausted
 * @param {(body, headers)=>('main'|'agent'|'aux')} [options.classify]  override request classification
 * @param {(body)=>object} [options.auxTurn]      override the canned aux answer (returns a turn)
 * @param {object}  [options.routes]              per-route overrides for non-messages endpoints, e.g.
 *                                                 `{ 'HEAD /api/hello': {status: 404}, 'GET /v1/models': {status: 200, body: {...}} }`
 * @param {string[]} [options.rejectBetas]        anthropic-beta values to reject with Anthropic's real 400 text
 *                                                 ("Unexpected value(s) `x` for the `anthropic-beta` header ..."), like an
 *                                                 upstream that does not know them. Claude Code strips them and retries.
 * @param {number}  [options.chunk=24]            characters per streamed delta (0 = whole string in one delta)
 */
export async function startMock(options = {}) {
  const opts = { defaultText: 'done', chunk: 24, basePath: '', ...options };
  const requests = [];
  const sockets = new Set();
  const closing = new AbortController();
  let script = opts.script ?? [];
  let agentScript = opts.agentScript;
  const counters = { main: 0, agent: 0, aux: 0 };
  let seq = 0;
  const waiters = [];

  const classify = opts.classify ?? defaultClassify;
  const auxTurn = opts.auxTurn ?? defaultAuxTurn;

  // Requests are pushed to `requests` as soon as their body is parsed (so in-flight / stalled
  // requests are visible) and written to the JSONL log once they complete (or at close()).
  const logged = new WeakSet();
  function arrive(rec) {
    requests.push(rec);
    for (const w of [...waiters]) w();
  }
  function flushLog(rec) {
    if (!opts.logFile || logged.has(rec)) return;
    logged.add(rec);
    try { appendFileSync(opts.logFile, JSON.stringify(rec) + '\n'); } catch { /* best effort */ }
  }

  function checkAuth(req, rec) {
    const xKey = req.headers['x-api-key'];
    const authz = req.headers['authorization'];
    const bearer = typeof authz === 'string' && /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, '') : undefined;
    rec.auth = { scheme: xKey && bearer ? 'both' : xKey ? 'x-api-key' : bearer ? 'bearer' : authz ? 'other' : 'none' };
    if (opts.expectToken !== undefined) {
      rec.auth.ok = xKey === opts.expectToken || bearer === opts.expectToken;
      return rec.auth.ok;
    }
    return true;
  }

  function sendJson(res, status, obj, headers = {}) {
    const payload = typeof obj === 'string' ? obj : JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers });
    res.end(payload);
  }

  function errorBody(status, body) {
    if (body !== undefined) return body;
    return { type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message: `mock error ${status}` }, request_id: nextId('req') };
  }

  async function handleMessages(req, res, rec, parsed, gone) {
    const body = parsed.json;
    const stream = !!body?.stream;
    const kind = classify(body, req.headers);
    rec.kind = kind;
    const agentId = req.headers['x-claude-code-agent-id'] ? String(req.headers['x-claude-code-agent-id']) : null;
    if (agentId) rec.agentId = agentId;
    const model = body?.model ?? 'mock-model';

    if (opts.rejectBetas?.length) {
      const sent = String(req.headers['anthropic-beta'] ?? '').split(',').map((b) => b.trim()).filter(Boolean);
      const bad = sent.filter((b) => opts.rejectBetas.includes(b));
      if (bad.length) {
        rec.response = { source: 'rejectBetas', status: 400, rejectedBetas: bad };
        const list = bad.map((b) => `\`${b}\``).join(', ');
        return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `Unexpected value(s) ${list} for the \`anthropic-beta\` header. Please consult our documentation at docs.anthropic.com or try again without the header.` }, request_id: nextId('req') });
      }
    }

    const ctx = {
      n: counters[kind]++, // 0-based index among requests of the same kind
      kind, isAux: kind === 'aux', isSubagent: kind === 'agent', agentId,
      seq: rec.seq, body, model,
      lastToolResults: extractToolResults(body),
      request: rec,
    };

    // ---- pick the turn ----
    const src = kind === 'agent' && agentScript !== undefined ? agentScript : script;
    let t = null;
    let source = 'default';
    if (typeof src === 'function') {
      t = normalizeTurn(await src(ctx));
      if (t) source = 'script-fn';
    } else if (kind !== 'aux' && Array.isArray(src) && ctx.n < src.length) {
      t = normalizeTurn(src[ctx.n]);
      if (t) source = `${src === agentScript ? 'agentScript' : 'script'}[${ctx.n}]`;
    }
    if (!t) {
      if (kind === 'aux') { t = normalizeTurn(auxTurn(body)); source = 'aux-default'; }
      else if (kind === 'agent') { t = { blocks: [text('agent done')], stopReason: 'end_turn' }; source = 'agent-default'; }
      else { t = { blocks: [text(opts.defaultText)], stopReason: 'end_turn' }; source = 'exhausted-default'; }
    }
    rec.response = { source };

    // ---- stall ----
    if (t.hangMs !== undefined) {
      rec.response.hangMs = t.hangMs;
      await sleep(t.hangMs, gone.signal);
      if (gone.signal.aborted) { rec.response.clientClosed = true; return; }
      if (!t.blocks && t.status === undefined) { rec.response.dropped = true; req.socket.destroy(); return; }
    }

    // ---- error injection ----
    if (t.status !== undefined && t.status !== 200) {
      rec.response.status = t.status;
      return sendJson(res, t.status, errorBody(t.status, t.body), t.headers ?? {});
    }

    // ---- normal reply ----
    const blocks = materializeBlocks(t.blocks ?? [text(opts.defaultText)]);
    const stopReason = t.stopReason ?? (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
    const usage = buildUsage(body, blocks, t.usage);
    const id = nextId('msg');
    const outModel = t.model ?? model;
    rec.response = { ...rec.response, status: 200, stream, id, model: outModel, stopReason, blocks };

    if (!stream) {
      return sendJson(res, 200, buildMessage({ id, model: outModel, blocks, stopReason, usage }), { 'request-id': nextId('req'), ...(t.headers ?? {}) });
    }

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': nextId('req'), ...(t.headers ?? {}) });
    res.socket?.setNoDelay(true);
    const events = buildSseEvents({ id, model: outModel, blocks, stopReason, usage, chunk: t.chunk ?? opts.chunk });
    let sent = 0;
    for (const [name, data] of events) {
      if (res.destroyed || gone.signal.aborted) { rec.response.clientClosed = true; return; }
      if (t.streamError && sent === (t.streamError.afterEvents ?? 2)) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: t.streamError.type ?? 'overloaded_error', message: t.streamError.message ?? 'mock stream error' } })}\n\n`);
        rec.response.streamError = true;
        return res.end();
      }
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      sent++;
      if (t.delayMs) await sleep(t.delayMs, gone.signal);
    }
    res.end();
  }

  function routeOverride(method, path) {
    for (const [key, val] of Object.entries(opts.routes ?? {})) {
      const [m, p] = key.split(/\s+/);
      if ((m === '*' || m === method) && (p === '*' || path === p || path.endsWith(p))) return val;
    }
    return undefined;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const rec = {
      seq: ++seq, ts: new Date().toISOString(), method: req.method, path, query: url.search ? url.search.slice(1) : '',
      headers: redactHeaders(req.headers),
    };
    // Aborted when the client goes away (or the mock closes) so stalls / slow streams stop promptly.
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    closing.signal.addEventListener('abort', () => gone.abort(), { once: true });
    try {
      const parsed = await readBody(req);
      if (parsed.json !== undefined) rec.body = parsed.json;
      else if (parsed.raw) { rec.bodyRaw = parsed.raw.slice(0, 4000); if (parsed.parseError) rec.bodyParseError = parsed.parseError; }
      const authOk = checkAuth(req, rec);
      arrive(rec);

      if (req.method === 'OPTIONS') { rec.kind = 'options'; rec.response = { status: 204 }; res.writeHead(204); return res.end(); }

      const isMessages = req.method === 'POST' && path.endsWith('/v1/messages');
      const isCount = req.method === 'POST' && path.endsWith('/v1/messages/count_tokens');
      const isModels = req.method === 'GET' && /\/v1\/models(\/.*)?$/.test(path);

      const override = !isMessages ? routeOverride(req.method, path) : undefined;
      if (override) {
        rec.kind = 'route-override';
        rec.response = { status: override.status ?? 200 };
        if (req.method === 'HEAD') { res.writeHead(override.status ?? 200, override.headers ?? {}); return res.end(); }
        return sendJson(res, override.status ?? 200, override.body ?? {}, override.headers ?? {});
      }
      if (!authOk && (isMessages || isCount)) {
        rec.kind = isMessages ? 'messages-unauthorized' : 'count_tokens-unauthorized';
        rec.response = { status: 401 };
        return sendJson(res, 401, errorBody(401));
      }
      if (isMessages) return await handleMessages(req, res, rec, parsed, gone);
      if (isCount) {
        rec.kind = 'count_tokens';
        const n = approxTokens(parsed.json ?? '');
        rec.response = { status: 200, input_tokens: n };
        return sendJson(res, 200, { input_tokens: n });
      }
      if (isModels) {
        // DeepSeek's Anthropic surface has no /v1/models: 404 by default.
        rec.kind = 'models';
        const mr = opts.modelsResponse ?? { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'Not Found' } } };
        rec.response = { status: mr.status };
        return sendJson(res, mr.status, mr.body ?? {});
      }
      // Anything else (HEAD /api/hello connectivity probe, telemetry, event logging, ...): succeed quietly.
      rec.kind = 'other';
      rec.response = { status: 200 };
      if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
      return sendJson(res, 200, {});
    } catch (e) {
      rec.error = String(e?.stack ?? e);
      if (!res.headersSent) { try { sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: `mock internal error: ${e.message}` } }); } catch { /* ignore */ } }
      else res.destroy();
    } finally {
      if (!requests.includes(rec)) arrive(rec);
      flushLog(rec);
    }
  });

  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}${opts.basePath}`,
    port,
    /** Live array of every request received (messages, count_tokens, probes, telemetry...). See README for the record shape. */
    requests,
    /** Replace the main script (array or function) and rewind the per-kind cursors to 0. Optionally replace the agent script too. */
    setScript(s, agent) {
      script = s ?? [];
      if (agent !== undefined) agentScript = agent;
      counters.main = counters.agent = counters.aux = 0;
    },
    /** Clear recorded requests (script and cursors untouched). */
    reset() { requests.length = 0; },
    mainRequests: () => requests.filter((r) => r.kind === 'main'),
    agentRequests: () => requests.filter((r) => r.kind === 'agent'),
    auxRequests: () => requests.filter((r) => r.kind === 'aux'),
    /** Resolve once `predicate(requests)` is true (re-checked on every new request). */
    waitFor(predicate, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        const check = () => { if (predicate(requests)) { cleanup(); resolve(requests); } };
        const t = setTimeout(() => { cleanup(); reject(new Error('mock.waitFor timeout')); }, timeoutMs);
        const cleanup = () => { clearTimeout(t); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); };
        waiters.push(check);
        check();
      });
    },
    async close() {
      closing.abort();
      for (const rec of requests) {
        if (!logged.has(rec)) { rec.response = { ...(rec.response ?? {}), incomplete: true }; flushLog(rec); }
      }
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
        for (const s of sockets) s.destroy();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function loadScript(file) {
  const p = resolvePath(String(file));
  if (/\.(m?js)$/.test(p)) {
    const mod = await import(pathToFileURL(p).href);
    return mod.default ?? mod.script ?? [];
  }
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(j) ? j : j.turns ?? j.script ?? [];
}

async function cli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[a.slice(2)] = argv[++i];
    else args[a.slice(2)] = true;
  }
  if (args.help || args.h) {
    process.stdout.write('usage: node mock-anthropic.mjs [--script script.json|script.mjs] [--agent-script file] [--port 0] [--log file.jsonl] [--base-path /anthropic] [--expect-token TOKEN]\n');
    return;
  }
  const mock = await startMock({
    script: args.script ? await loadScript(args.script) : [],
    agentScript: args['agent-script'] ? await loadScript(args['agent-script']) : undefined,
    port: args.port ? Number(args.port) : 0,
    logFile: args.log ? String(args.log) : undefined,
    basePath: args['base-path'] ? String(args['base-path']) : '',
    expectToken: args['expect-token'] ? String(args['expect-token']) : undefined,
  });
  process.stdout.write(mock.url + '\n');
  const stop = async () => { await mock.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.stack ?? e}\n`); process.exit(1); });
}
