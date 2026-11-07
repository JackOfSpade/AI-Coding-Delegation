/**
 * `offload complete --serve`: one long-lived process that reads NDJSON requests on stdin and writes
 * NDJSON lines on stdout, so a host pays Node startup, module loading and model listing once, and
 * the provider connection stays open between turns (keepalive-fetch.mjs). The API key is read
 * once and kept in memory for up to ten minutes.
 *
 * Input lines (one JSON object each, at most 16 MiB):
 *   { "id": "t1", ...request }                 a completion: the `offload complete` request with an id
 *   { "type": "cancel", "id": "t1" }           cancel an in-flight request
 *   { "type": "warm", "id": "w1", "route": "deepseek-flash" }
 *                                              resolve the route's model and open the provider
 *                                              connection ahead of a turn; never spends
 * Output lines:
 *   { "type": "ready", "version", "pid" }      once, before anything else
 *   { "type": "delta", "id", "text" }          requests with "stream": true, as text arrives
 *   { "type": "result", "id", ...result }      exactly one per accepted completion
 *   { "type": "warm", "id", ...dryRunResult }
 *   { "type": "error", "id"?, "message" }      a line that was not accepted (no result follows)
 *
 * Requests run concurrently. `overheadMs` on each result counts from the moment its line arrived.
 * EOF on stdin lets in-flight requests finish, then exits 0. SIGTERM or SIGINT cancels every
 * in-flight request (each still gets its `cancelled` result line) and exits 17. If stdout breaks
 * (the host died), every in-flight request is cancelled so nothing keeps spending, and the process
 * exits 17. Prompt and response text go only to stdout, never to stderr or disk.
 */
import { COMPLETE_CONTRACT_VERSION, complete, completeDryRun } from './complete.mjs';
import { createKeepAliveFetch } from './keepalive-fetch.mjs';
import { plainObject } from './plain-object.mjs';
import { resolveKeyRef } from './secrets.mjs';

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_IN_FLIGHT = 16;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A keychain lookup costs ~13 ms per call on macOS; the process keeps the key this long.
const KEY_CACHE_MS = 10 * 60_000;

/** `readKey` memoized per key reference, so a turn does not pay a keychain lookup. */
function cachedReadKey(readKey) {
  const cache = new Map();
  return (ref) => {
    const hit = cache.get(ref);
    if (hit && performance.now() - hit.at < KEY_CACHE_MS) return hit.key;
    const key = readKey(ref);
    cache.set(ref, { at: performance.now(), key });
    return key;
  };
}

export async function runCompleteServe({ stdin, stdout, signalSource, providerOptions = {}, monotonicNow = () => performance.now() }) {
  const shutdown = new AbortController();
  const inFlight = new Map(); // id -> { controller, done }
  // A host-supplied fetch (tests) is used as is; otherwise one keep-alive pool for the process.
  const ownFetch = providerOptions.fetchImpl ? undefined : createKeepAliveFetch();
  const env = providerOptions.env ?? process.env;
  const options = {
    ...providerOptions,
    ...(ownFetch ? { fetchImpl: ownFetch } : {}),
    readKey: cachedReadKey(providerOptions.readKey ?? ((ref) => resolveKeyRef(ref, { env }))),
  };
  let broken = false;
  const breakOff = () => {
    if (broken) return;
    broken = true;
    shutdown.abort();
    stdin.destroy?.();
  };
  const write = (line) => {
    if (broken) return;
    try {
      stdout.write(`${JSON.stringify(line)}\n`, (error) => error && breakOff());
    } catch {
      breakOff();
    }
  };
  stdout.on?.('error', breakOff);
  stdout.on?.('close', breakOff);
  const onSignal = () => {
    shutdown.abort();
    stdin.destroy?.();
  };
  const signals = ['SIGTERM', 'SIGINT'];
  for (const name of signals) signalSource.once(name, onSignal);
  write({ type: 'ready', version: COMPLETE_CONTRACT_VERSION, pid: process.pid });

  const handle = (text, receivedAt) => {
    let line;
    try {
      line = JSON.parse(text);
    } catch {
      return write({ type: 'error', message: 'each line must be one JSON object' });
    }
    if (!plainObject(line)) return write({ type: 'error', message: 'each line must be one JSON object' });
    const { type = 'complete', ...rest } = line;
    const { id } = rest;
    if (typeof id !== 'string' || !ID.test(id)) return write({ type: 'error', message: `every line needs an id matching ${ID.source}` });
    if (type === 'cancel') {
      const entry = inFlight.get(id);
      if (!entry) return write({ type: 'error', id, message: 'no request in flight with this id' });
      entry.controller.abort();
      return undefined;
    }
    if (type !== 'complete' && type !== 'warm') return write({ type: 'error', id, message: 'type must be complete, cancel or warm' });
    if (inFlight.has(id)) return write({ type: 'error', id, message: 'a request with this id is already in flight' });
    if (inFlight.size >= MAX_IN_FLIGHT) return write({ type: 'error', id, message: `at most ${MAX_IN_FLIGHT} requests in flight` });
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, shutdown.signal]);
    const run = async () => {
      if (type === 'warm') {
        write({ type: 'warm', ...(await completeDryRun(rest, { ...options, signal })), id });
        return;
      }
      const result = await complete(rest, {
        ...options,
        signal,
        overheadFrom: receivedAt,
        ...(rest.stream === true ? { onDelta: (piece) => write({ type: 'delta', id, text: piece }) } : {}),
      });
      write({ type: 'result', ...result, id });
    };
    const done = run()
      .catch(() => write({ type: 'error', id, message: 'unexpected failure' }))
      .finally(() => inFlight.delete(id));
    inFlight.set(id, { controller, done });
    return undefined;
  };

  try {
    let pending = Buffer.alloc(0);
    let overflow = false;
    try {
      for await (const chunk of stdin) {
        const receivedAt = monotonicNow();
        let buffer = Buffer.concat([pending, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)]);
        for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
          const bytes = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          if (overflow) {
            overflow = false; // the end of an oversized line
            continue;
          }
          const text = bytes.toString('utf8').trim();
          if (text) handle(text, receivedAt);
        }
        if (buffer.length > MAX_LINE_BYTES) {
          if (!overflow) write({ type: 'error', message: `a line exceeds ${MAX_LINE_BYTES} bytes` });
          overflow = true;
          buffer = Buffer.alloc(0);
        }
        pending = buffer;
        if (shutdown.signal.aborted) break;
      }
    } catch {
      // stdin destroyed by a signal or a broken host, or a read error: stop reading and drain.
    }
    const tail = pending.toString('utf8').trim();
    if (tail && !shutdown.signal.aborted) handle(tail, monotonicNow());
    while (inFlight.size) await Promise.all([...inFlight.values()].map((entry) => entry.done));
    return shutdown.signal.aborted ? 17 : 0;
  } finally {
    for (const name of signals) signalSource.removeListener(name, onSignal);
    stdout.removeListener?.('error', breakOff);
    stdout.removeListener?.('close', breakOff);
    ownFetch?.close();
  }
}
