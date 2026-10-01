// Minimal Anthropic-surface mock for capturing what Claude Code sends. Zero deps.
import http from 'node:http';
import fs from 'node:fs';

const LOG = process.env.MOCK_LOG;
const PORTFILE = process.env.MOCK_PORTFILE;
const MODE = process.env.MOCK_MODE || 'text'; // text | tool
let n = 0;

function redact(h) {
  const o = { ...h };
  for (const k of ['authorization', 'x-api-key']) if (o[k]) o[k] = `<redacted len=${String(o[k]).length} prefix=${String(o[k]).slice(0, k === 'authorization' ? 7 : 0)}>`;
  return o;
}
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}
function msgStart(model) {
  return ['message_start', { type: 'message_start', message: { id: 'msg_mock' + n, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
}
function textEvents(model, text) {
  return [msgStart(model),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }]];
}
function toolEvents(model, toolName, input) {
  return [msgStart(model),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'mock reasoning: I should run the tool.' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '0188d6a3-ad7b-43df-954b-6c4c60f7699b' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_mock1', name: toolName, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }]];
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    n++;
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch {}
    fs.appendFileSync(LOG, JSON.stringify({ n, t: new Date().toISOString(), method: req.method, url: req.url, headers: redact(req.headers), body, rawLen: raw.length }) + '\n');
    const path = req.url.split('?')[0];
    if (req.method === 'HEAD' && path === '/api/hello') { res.writeHead(200); return res.end(); }
    if (req.method === 'GET' && path === '/v1/models') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } })); }
    if (req.method === 'POST' && path === '/v1/messages/count_tokens') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"not found"}}'); }
    if (req.method === 'POST' && path === '/v1/messages') {
      const model = body?.model || 'unknown';
      const hasToolResult = JSON.stringify(body?.messages || []).includes('"tool_result"');
      let events;
      if (MODE === 'tool' && !hasToolResult && Array.isArray(body?.tools) && body.tools.some((t) => t.name === 'Bash') && (body.tools.length > 3)) {
        events = toolEvents(model, 'Bash', { command: 'echo mock-tool-ran', description: 'mock' });
      } else {
        events = textEvents(model, 'mock reply ok');
      }
      if (body?.stream) return sse(res, events);
      // non-streaming
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_mock' + n, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'mock reply ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"mock: not found"}}');
  });
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(PORTFILE, String(server.address().port));
});
