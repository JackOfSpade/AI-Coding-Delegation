import http from 'node:http';

/** A deterministic OpenAI-compatible SSE fixture. Each queued script item is
 * a {chunks}, {status, body}, or {stallMs} object; recorded requests aid tests. */
export async function createMockOpenAIServer(scripts = []) {
  const queue = [...scripts],
    requests = [],
    sockets = new Set();
  const wait = (ms, res) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const closed = () => done();
      function done() {
        clearTimeout(timer);
        res.removeListener('close', closed);
        resolve();
      }
      res.once('close', closed);
    });
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    const script = queue.shift() ?? {
      chunks: [
        { choices: [{ delta: { content: 'default' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ],
    };
    if (script.stallMs) await wait(script.stallMs, res);
    if (script.status && script.status !== 200) {
      res.writeHead(script.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(script.body ?? { error: { message: 'mock error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const line of script.comments ?? []) res.write(`: ${line}\n\n`);
    let index = 0;
    for (const chunk of script.chunks ?? []) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      index++;
      if (script.stallAfterChunks === index) await wait(script.stallMs ?? 60_000, res);
      else if (script.delayMs) await wait(script.delayMs, res);
    }
    if (!script.noDone) res.end('data: [DONE]\n\n');
    else res.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    push: (script) => queue.push(script),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
