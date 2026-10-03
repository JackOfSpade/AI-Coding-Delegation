import { sseJson } from './sse.mjs';

export class ProviderError extends Error {
  constructor(message = 'Provider request failed', { status, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
  }
}
// Remove the listener on both paths. Retries can be numerous and long-lived;
// retaining one once-listener per completed retry is an avoidable leak.
const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      fn(value);
    };
    const abort = () => settle(reject, signal.reason ?? new Error('Aborted'));
    const timer = setTimeout(() => settle(resolve), ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
const positive = (value, name, fallback) => {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
};
const isLoopbackHost = (hostname) => {
  const host = String(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
};
const validModel = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1F\x7F]/.test(value);
const validToolIdentifier = (value, max) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1F\x7F]/.test(value);
const MAX_TOOL_CALLS = 64;
const MAX_TOOL_ARGUMENT_CHARS = 512_000;
const MAX_MESSAGE_CHARS = 1_000_000;

// Context may retain local metadata (for display or durability), but the
// provider receives only fields in the Chat Completions wire schema. In
// particular DeepSeek's tool messages document no `name` field.
export function wireMessages(messages) {
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || typeof message.role !== 'string') throw new ProviderError('Invalid transcript message');
    if (message.role === 'system' || message.role === 'user') {
      if (typeof message.content !== 'string' || message.content.length > MAX_MESSAGE_CHARS)
        throw new ProviderError('Invalid transcript content');
      return { role: message.role, content: message.content };
    }
    if (message.role === 'assistant') {
      if (typeof message.content !== 'string' || message.content.length > MAX_MESSAGE_CHARS)
        throw new ProviderError('Invalid assistant content');
      const output = { role: 'assistant', content: message.content };
      if (message.reasoning_content !== undefined) {
        if (typeof message.reasoning_content !== 'string' || message.reasoning_content.length > MAX_MESSAGE_CHARS)
          throw new ProviderError('Invalid assistant reasoning');
        output.reasoning_content = message.reasoning_content;
      }
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0 || message.tool_calls.length > MAX_TOOL_CALLS)
          throw new ProviderError('Invalid assistant tool calls');
        output.tool_calls = message.tool_calls.map((call) => {
          if (
            !call ||
            !validToolIdentifier(call.id, 512) ||
            !validToolIdentifier(call.function?.name, 128) ||
            typeof call.function?.arguments !== 'string' ||
            call.function.arguments.length > MAX_TOOL_ARGUMENT_CHARS
          )
            throw new ProviderError('Invalid assistant tool call');
          return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
        });
        if (new Set(output.tool_calls.map((call) => call.id)).size !== output.tool_calls.length)
          throw new ProviderError('Invalid assistant tool calls');
      }
      return output;
    }
    if (message.role === 'tool') {
      if (
        !validToolIdentifier(message.tool_call_id, 512) ||
        typeof message.content !== 'string' ||
        message.content.length > MAX_MESSAGE_CHARS
      )
        throw new ProviderError('Invalid tool result');
      return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content };
    }
    throw new ProviderError('Invalid transcript role');
  });
}

const isPlainRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
// Wire providers have used both OpenAI's prompt/completion names and the
// input/output spellings.  Accept either vocabulary, but never silently pick
// one out of an ambiguous response: a finite budget needs one authoritative
// counter for each billable direction.
const MISSING_USAGE_FIELD = Symbol('missing usage field');
const oneAlias = (source, names, label, { required = false } = {}) => {
  const present = names.filter((name) => Object.hasOwn(source, name));
  if (!present.length) {
    if (required) throw new ProviderError(`Missing usage.${label}`);
    return MISSING_USAGE_FIELD;
  }
  if (present.length !== 1) throw new ProviderError(`Ambiguous usage.${label}`);
  return source[present[0]];
};

const validUsageCounter = (value) => Number.isSafeInteger(value) && value >= 0;
// Some OpenAI-compatible providers redundantly report cache hits at both the
// top level and in prompt-token details.  Treat matching counters as one
// authoritative value, but never resolve a disagreement or malformed value by
// picking whichever representation happens to be checked first.
const reconcileDuplicateCounter = (nested, direct, label) => {
  if (nested === MISSING_USAGE_FIELD) return direct;
  if (direct === MISSING_USAGE_FIELD) return nested;
  if (!validUsageCounter(nested) || !validUsageCounter(direct) || nested !== direct) throw new ProviderError(`Conflicting usage.${label}`);
  return nested;
};

export function normalizeUsage(usage) {
  if (!isPlainRecord(usage)) throw new ProviderError('Invalid SSE usage');
  const detailValue = oneAlias(usage, ['prompt_tokens_details', 'input_tokens_details'], 'details');
  const details = detailValue === MISSING_USAGE_FIELD ? {} : detailValue;
  if (!isPlainRecord(details)) throw new ProviderError('Invalid usage.details');
  const inputTokens = oneAlias(usage, ['prompt_tokens', 'input_tokens'], 'inputTokens', { required: true });
  const outputTokens = oneAlias(usage, ['completion_tokens', 'output_tokens'], 'outputTokens', { required: true });
  for (const [name, value] of Object.entries({ inputTokens, outputTokens }))
    if (!Number.isSafeInteger(value) || value < 0) throw new ProviderError(`Invalid usage.${name}`);
  const nestedHit = oneAlias(details, ['cached_tokens', 'cache_hit_tokens'], 'cacheHitTokens');
  const directHit = oneAlias(usage, ['cache_hit_tokens', 'prompt_cache_hit_tokens'], 'cacheHitTokens');
  const cacheHitTokens = reconcileDuplicateCounter(nestedHit, directHit, 'cacheHitTokens');
  const normalizedCacheHitTokens = cacheHitTokens === MISSING_USAGE_FIELD ? 0 : cacheHitTokens;
  const nestedMiss = oneAlias(details, ['cache_miss_tokens'], 'cacheMissTokens');
  const directMiss = oneAlias(usage, ['cache_miss_tokens', 'prompt_cache_miss_tokens'], 'cacheMissTokens');
  if (nestedMiss !== MISSING_USAGE_FIELD && directMiss !== MISSING_USAGE_FIELD) throw new ProviderError('Ambiguous usage.cacheMissTokens');
  const cacheMissTokens =
    nestedMiss !== MISSING_USAGE_FIELD
      ? nestedMiss
      : directMiss !== MISSING_USAGE_FIELD
        ? directMiss
        : Math.max(0, inputTokens - normalizedCacheHitTokens);
  const totalValue = oneAlias(usage, ['total_tokens'], 'totalTokens');
  const totalTokens = totalValue === MISSING_USAGE_FIELD ? inputTokens + outputTokens : totalValue;
  if (
    !validUsageCounter(normalizedCacheHitTokens) ||
    !Number.isSafeInteger(cacheMissTokens) ||
    cacheMissTokens < 0 ||
    normalizedCacheHitTokens + cacheMissTokens !== inputTokens
  )
    throw new ProviderError('Invalid cache usage');
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0 || totalTokens !== inputTokens + outputTokens)
    throw new ProviderError('Invalid usage.totalTokens');
  return { inputTokens, outputTokens, cacheHitTokens: normalizedCacheHitTokens, cacheMissTokens, totalTokens };
}

/** OpenAI chat-completions adapter. A whole successful attempt is buffered
 * before yielding: retrying a broken stream can therefore never duplicate a
 * previously emitted delta. The request timeout stays live through body EOF. */
export class OpenAIChatProvider {
  constructor({
    baseUrl,
    apiKey,
    model,
    fetchImpl = globalThis.fetch,
    timeoutMs = 120_000,
    retries = 3,
    headers = {},
    reasoningEffort,
    thinking,
    maxSseEventBytes = 1_000_000,
    maxSseAttemptBytes = 8_000_000,
  } = {}) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new TypeError('baseUrl must be an http(s) URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('baseUrl must be an http(s) URL');
    if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname))
      throw new TypeError('baseUrl must use HTTPS unless its host is loopback');
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new TypeError('baseUrl must not contain credentials, query, or fragment');
    if (!validModel(model)) throw new TypeError('model is required and must be a short control-free string');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (apiKey !== undefined && typeof apiKey !== 'string') throw new TypeError('apiKey must be a string');
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new TypeError('headers must be an object');
    this.baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = positive(timeoutMs, 'timeoutMs', 120_000);
    if (!this.timeoutMs) throw new TypeError('timeoutMs must be positive');
    this.retries = positive(retries, 'retries', 3);
    this.headers = headers;
    this.reasoningEffort = reasoningEffort;
    this.thinking = thinking;
    this.maxSseEventBytes = positive(maxSseEventBytes, 'maxSseEventBytes', 1_000_000);
    this.maxSseAttemptBytes = positive(maxSseAttemptBytes, 'maxSseAttemptBytes', 8_000_000);
    if (!this.maxSseEventBytes || !this.maxSseAttemptBytes) throw new TypeError('SSE limits must be positive');
  }
  async #collect(payload, externalSignal, retryLimit = this.retries) {
    if (externalSignal?.aborted) throw externalSignal.reason ?? new Error('Aborted');
    let last;
    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Provider request timed out')), this.timeoutMs);
      const abort = () => controller.abort(externalSignal.reason ?? new Error('Aborted'));
      externalSignal?.addEventListener('abort', abort, { once: true });
      try {
        // `baseUrl` is the provider's API base, not its origin. DeepSeek's
        // documented base is the origin while OpenAI-compatible deployments
        // commonly supply a path ending in `/v1`; append only the operation.
        const endpoint = new URL('chat/completions', `${this.baseUrl}/`).href;
        const response = await this.fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          redirect: 'error',
          headers: {
            ...this.headers,
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(payload),
        });
        // Provider response bodies may contain an echoed prompt, credentials,
        // or other untrusted data.  Never put them in an error/log path.
        if (!response.ok) {
          try {
            await response.body?.cancel?.();
          } catch {
            /* best-effort connection release */
          }
          throw new ProviderError(`Chat request failed (HTTP ${response.status})`, {
            status: response.status,
            retryable: response.status === 429 || response.status >= 500,
          });
        }
        const chunks = [];
        for await (const chunk of sseJson(response.body, {
          maxEventBytes: this.maxSseEventBytes,
          maxAttemptBytes: this.maxSseAttemptBytes,
        }))
          chunks.push(chunk);
        return chunks;
      } catch (error) {
        if (externalSignal?.aborted) throw externalSignal.reason ?? error;
        // Fetch/SSE errors can include arbitrary remote text too.  Preserve
        // only our status-bearing ProviderError; otherwise expose a generic
        // safe error, without retaining an error cause that logs may inspect.
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError(/redirect/i.test(String(error?.message)) ? 'Provider redirect rejected' : 'Chat request failed', {
                retryable: !/redirect/i.test(String(error?.message)),
              });
        if (!providerError.retryable || attempt === retryLimit) throw providerError;
        last = providerError;
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', abort);
      }
      await delay(Math.min(4_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 125), externalSignal);
    }
    throw last;
  }
  async *chat({ messages, tools, signal, retryLimit, ...options } = {}) {
    if (!Array.isArray(messages) || !Array.isArray(tools)) throw new TypeError('messages and tools must be arrays');
    if (retryLimit !== undefined && (!Number.isSafeInteger(retryLimit) || retryLimit < 0 || retryLimit > this.retries))
      throw new TypeError('retryLimit must be an integer from 0 to configured retries');
    const { thinking: requestedThinking, stream: requestedStream, stream_options: requestedStreamOptions, ...requestOptions } = options;
    if (requestedStream !== undefined || requestedStreamOptions !== undefined)
      throw new ProviderError('stream options are controlled by the provider adapter');
    const requestModel = requestOptions.model ?? this.model;
    if (!validModel(requestModel)) throw new ProviderError('Invalid request model');
    const thinking = requestedThinking ?? this.thinking;
    if (thinking?.type === 'enabled' && (options.tool_choice === 'required' || typeof options.tool_choice === 'object'))
      throw new ProviderError('Thinking mode does not support required or named tool_choice');
    const chunks = await this.#collect(
      {
        ...requestOptions,
        model: requestModel,
        messages: wireMessages(messages),
        tools,
        stream: true,
        stream_options: { include_usage: true },
        ...(this.reasoningEffort || requestOptions.reasoning_effort
          ? { reasoning_effort: requestOptions.reasoning_effort ?? this.reasoningEffort }
          : {}),
        ...(thinking ? { thinking } : {}),
      },
      signal,
      retryLimit,
    );
    const calls = new Map();
    let model,
      usageSeen = false,
      modelConflict = false,
      conflictReported = false;
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw new ProviderError('Invalid SSE response chunk');
      if (chunk?.model !== undefined && !validModel(chunk.model)) throw new ProviderError('Invalid response model');
      if (chunk.choices !== undefined) {
        if (!Array.isArray(chunk.choices)) throw new ProviderError('Invalid SSE response choices');
        const choice = chunk.choices[0];
        if (
          choice !== undefined &&
          (!choice ||
            typeof choice !== 'object' ||
            Array.isArray(choice) ||
            (choice.delta !== undefined && (!choice.delta || typeof choice.delta !== 'object' || Array.isArray(choice.delta))))
        )
          throw new ProviderError('Invalid SSE response choices');
      }
      if (chunk.model !== undefined) {
        if (model !== undefined && model !== chunk.model) modelConflict = true;
        model ??= chunk.model;
      }
      const delta = chunk?.choices?.[0]?.delta ?? {};
      const echoedModel = chunk.model ?? model;
      const conflict = modelConflict ? { modelConflict: true } : {};
      // OpenAI-compatible streaming tool-call chunks (including DeepSeek's)
      // may carry `content: null` while the assistant emits no text.
      if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string')
        throw new ProviderError('Invalid response content');
      if (delta.reasoning_content !== undefined && delta.reasoning_content !== null && typeof delta.reasoning_content !== 'string')
        throw new ProviderError('Invalid response reasoning');
      if (delta.reasoning !== undefined && delta.reasoning !== null && typeof delta.reasoning !== 'string')
        throw new ProviderError('Invalid response reasoning');
      if (delta.content) {
        if (modelConflict) conflictReported = true;
        yield { text: delta.content, model: echoedModel, ...conflict };
      }
      if (delta.reasoning_content ?? delta.reasoning) {
        if (modelConflict) conflictReported = true;
        yield { reasoning: delta.reasoning_content ?? delta.reasoning, model: echoedModel, ...conflict };
      }
      if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) throw new ProviderError('Invalid tool call list');
      for (const part of delta.tool_calls ?? []) {
        if (
          !part ||
          typeof part !== 'object' ||
          Array.isArray(part) ||
          (part.type !== undefined && part.type !== 'function') ||
          (part.function !== undefined && (!part.function || typeof part.function !== 'object' || Array.isArray(part.function)))
        )
          throw new ProviderError('Invalid tool call fragment');
        if (!Number.isSafeInteger(part.index) || part.index < 0) throw new ProviderError('Tool call is missing a valid index');
        if (!calls.has(part.index) && calls.size >= MAX_TOOL_CALLS) throw new ProviderError('Too many tool calls');
        const prior = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
        if (part.id !== undefined && !validToolIdentifier(part.id, 512)) throw new ProviderError('Tool call id fragment is invalid');
        if (part.function?.name !== undefined && !validToolIdentifier(part.function.name, 128))
          throw new ProviderError('Tool call name fragment is invalid');
        if (part.id !== undefined && prior.id && part.id !== prior.id) throw new ProviderError('Conflicting tool call id fragments');
        if (part.function?.name !== undefined && prior.name && part.function.name !== prior.name)
          throw new ProviderError('Conflicting tool call name fragments');
        prior.id ||= part.id ?? '';
        prior.name ||= part.function?.name ?? '';
        if (part.function?.arguments !== undefined && typeof part.function.arguments !== 'string')
          throw new ProviderError('Tool arguments fragment must be a string');
        prior.arguments += part.function?.arguments ?? '';
        if (prior.arguments.length > MAX_TOOL_ARGUMENT_CHARS) throw new ProviderError('Tool arguments exceed size limit');
        calls.set(part.index, prior);
      }
      // With include_usage enabled, a completed request has one aggregate
      // record. Multiple records would double-charge callers that account per
      // turn, so reject rather than silently accumulating them.
      if (chunk.usage != null) {
        if (!chunk.usage || typeof chunk.usage !== 'object' || Array.isArray(chunk.usage) || usageSeen)
          throw new ProviderError(usageSeen ? 'Duplicate SSE usage record' : 'Invalid SSE usage');
        usageSeen = true;
        if (modelConflict) conflictReported = true;
        yield { usage: normalizeUsage(chunk.usage), model: echoedModel, ...conflict };
      }
    }
    const toolCalls = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
    for (const call of toolCalls) {
      if (!call.id || !call.name) throw new ProviderError('Incomplete tool call: missing id or function name');
      try {
        JSON.parse(call.arguments || '{}');
      } catch {
        throw new ProviderError('Incomplete tool JSON');
      }
    }
    if (toolCalls.length) {
      if (modelConflict) conflictReported = true;
      yield { toolCalls, model, ...(modelConflict ? { modelConflict: true } : {}) };
    }
    // A provider may append a metadata-only chunk after the terminal usage
    // record. Surface that conflict too: otherwise a loop would account the
    // response yet proceed to execute a previously accumulated tool call.
    if (modelConflict && !conflictReported) yield { model, modelConflict: true };
  }
}
export const createOpenAIChatProvider = (options) => new OpenAIChatProvider(options);
