/** Dependency-free SSE decoding. TextDecoder streaming preserves split UTF-8
 * sequences; parsing CR, LF, and CRLF after chunks avoids treating split CRLF
 * as two breaks. */
const bounded = (value, name, fallback) => {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
};
export async function* sseEvents(body, { maxEventBytes, maxAttemptBytes } = {}) {
  if (!body) throw new Error('SSE response has no body');
  maxEventBytes = bounded(maxEventBytes, 'maxEventBytes', 1_000_000);
  maxAttemptBytes = bounded(maxAttemptBytes, 'maxAttemptBytes', 8_000_000);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data = [];
  let eventBytes = 0;
  let attemptBytes = 0;
  const emit = () => {
    if (!data.length) return null;
    const event = { data: data.join('\n') };
    data = [];
    eventBytes = 0;
    return event;
  };
  const consumeLine = (line) => {
    if (!line) return emit();
    if (!line.startsWith(':') && line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      eventBytes += Buffer.byteLength(value);
      if (eventBytes > maxEventBytes) throw new Error('SSE event exceeds configured size limit');
      data.push(value);
    }
    return null;
  };
  const consume = function* (final = false) {
    while (true) {
      const lf = pending.indexOf('\n'),
        cr = pending.indexOf('\r');
      const index = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
      if (index < 0) break;
      // A CR at the end of an incomplete chunk might be the first half of a
      // CRLF delimiter. Preserve it until the next chunk decides the form.
      if (!final && pending[index] === '\r' && index + 1 === pending.length) break;
      const line = pending.slice(0, index);
      const delimiter = pending[index] === '\r' && pending[index + 1] === '\n' ? 2 : 1;
      pending = pending.slice(index + delimiter);
      const event = consumeLine(line);
      if (event) yield event;
    }
    if (Buffer.byteLength(pending) > maxEventBytes) throw new Error('SSE event exceeds configured size limit');
    if (final && pending) {
      const line = pending;
      pending = '';
      const event = consumeLine(line);
      if (event) yield event;
    }
  };
  for await (const chunk of body) {
    attemptBytes += chunk.byteLength ?? Buffer.byteLength(chunk);
    if (attemptBytes > maxAttemptBytes) throw new Error('SSE attempt exceeds configured size limit');
    pending += decoder.decode(chunk, { stream: true });
    yield* consume();
  }
  pending += decoder.decode();
  yield* consume(true);
  const event = emit();
  if (event) yield event;
}
export async function* sseJson(body, options) {
  let done = false;
  for await (const { data } of sseEvents(body, options)) {
    if (data === '[DONE]') {
      done = true;
      break;
    }
    try {
      yield JSON.parse(data);
    } catch {
      throw new Error('Invalid JSON in SSE data');
    }
  }
  if (!done) throw new Error('SSE stream ended without [DONE]');
}
