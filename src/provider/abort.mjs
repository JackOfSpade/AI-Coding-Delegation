// Fetch implementations and response streams do not always settle on abort.
// Stop awaiting them ourselves, while still observing late rejections and
// asking the transport to release its resources.
export function abortable(value, signal) {
  const pending = Promise.resolve(value);
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
        else resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export function bestEffort(action) {
  try {
    Promise.resolve(action()).catch(() => {});
  } catch {
    // Cleanup must never replace the abort or wait for an unresponsive body.
  }
}

export function fetchAbortable(fetchImpl, url, options) {
  if (options?.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('Aborted'));
  const pending = Promise.resolve(fetchImpl(url, options)).then((response) => {
    // Headers may arrive after the caller stopped waiting for this request.
    if (options?.signal?.aborted) bestEffort(() => response.body?.cancel());
    return response;
  });
  return abortable(pending, options?.signal);
}

/** Bounded JSON reading for discovery and non-streaming provider responses. */
export async function readJsonAbortable(body, { signal, maxBytes = 8_000_000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');
  if (!body) throw new Error('Response has no body');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of abortableBody(body, signal)) {
    bytes += chunk.byteLength ?? Buffer.byteLength(chunk);
    if (bytes > maxBytes) throw new Error('Response exceeds configured size limit');
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error('Invalid response JSON');
  }
}

export async function* abortableBody(body, signal) {
  const reader = body.getReader?.();
  const iterator = reader ? undefined : body[Symbol.asyncIterator]();
  let done = false;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
      const result = await abortable(reader ? reader.read() : iterator.next(), signal);
      if (result.done) {
        done = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!done) bestEffort(() => (reader ? reader.cancel(signal?.reason) : iterator.return?.()));
    if (reader) bestEffort(() => reader.releaseLock());
  }
}
