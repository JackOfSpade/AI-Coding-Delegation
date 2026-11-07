/**
 * A minimal fetch for `offload complete --serve` that keeps provider connections open between
 * requests. Node's built-in fetch closes an idle pooled connection after about four seconds unless
 * the server says otherwise, so a voice turn that follows a pause of a few seconds would pay a new
 * TCP and TLS handshake. This uses node:https / node:http agents with keep-alive, whose idle
 * sockets stay open until the server closes them (or `idleSocketMs` passes).
 *
 * It implements only what Offload's provider calls use: method, headers, a string body, `signal`,
 * and `redirect: 'error'` (any 3xx is a network error). The response is a web `Response` whose body
 * streams; cancelling that body destroys the socket rather than returning it to the pool.
 */
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export function createKeepAliveFetch({ idleSocketMs = 600_000, maxSockets = 16 } = {}) {
  const options = { keepAlive: true, keepAliveMsecs: 15_000, maxSockets, maxFreeSockets: maxSockets, timeout: idleSocketMs };
  const agents = { 'https:': new https.Agent(options), 'http:': new http.Agent(options) };

  function keepAliveFetch(input, init = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(String(input));
      const transport = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : undefined;
      if (!transport) return reject(new TypeError(`unsupported protocol ${url.protocol}`));
      const { signal } = init;
      if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
      const headers = { ...(init.headers ?? {}) };
      const body = init.body === undefined || init.body === null ? undefined : Buffer.from(String(init.body), 'utf8');
      if (body) headers['content-length'] = String(body.length);
      const request = transport.request(url, { method: init.method ?? 'GET', headers, agent: agents[url.protocol] });
      const onAbort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const detach = () => signal?.removeEventListener('abort', onAbort);
      request.on('error', (error) => {
        detach();
        reject(error);
      });
      request.on('response', (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          detach();
          return reject(new TypeError('redirect refused'));
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
        response.once('close', detach);
        const stream = status === 204 || status === 304 || init.method === 'HEAD' ? null : Readable.toWeb(response);
        resolve(new Response(stream, { status, statusText: response.statusMessage ?? '', headers: responseHeaders }));
      });
      request.end(body);
    });
  }
  keepAliveFetch.close = () => {
    for (const agent of Object.values(agents)) agent.destroy();
  };
  /** Idle sockets ready for reuse, per origin (for tests and diagnostics). */
  keepAliveFetch.idleSockets = () =>
    Object.values(agents).reduce((sum, agent) => sum + Object.values(agent.freeSockets).reduce((n, list) => n + list.length, 0), 0);
  return keepAliveFetch;
}
