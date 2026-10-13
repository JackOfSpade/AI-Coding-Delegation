import { sseEvents } from './sse.mjs';
import { ProviderError } from './openai-chat.mjs';
import { assertModelAllowed, isAnthropicSonnetModel, modelPolicyViolation } from '../model-policy.mjs';
import { anthropicContentMatchesAssistant, cloneAnthropicContent, validAnthropicContent } from '../anthropic-content.mjs';

export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const MAX_SSE_EVENT_BYTES = 1_000_000;
const MAX_SSE_ATTEMPT_BYTES = 8_000_000;
const MAX_TOOL_CALLS = 64;
const MAX_TOOL_ARGUMENT_CHARS = 512_000;

const validText = (value, limit = 1_000_000) => typeof value === 'string' && value.length <= limit && !/[\0\x0b\x0c\x7f]/.test(value);
const validId = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\0-\x1f\x7f]/.test(value);
const loopback = (host) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

function checkedBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError('baseUrl must be an http(s) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !loopback(parsed.hostname)))
    throw new TypeError('baseUrl must use HTTPS unless its host is loopback');
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new TypeError('baseUrl must not contain credentials, query, or fragment');
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function normalizedUsage(input, output) {
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  if (!input || !count(input.input_tokens) || !count(output?.output_tokens)) throw new ProviderError('Invalid Anthropic usage record');
  const hit = input.cache_read_input_tokens ?? 0;
  if (!count(hit) || hit > input.input_tokens) throw new ProviderError('Invalid Anthropic cache usage');
  return {
    inputTokens: input.input_tokens,
    outputTokens: output.output_tokens,
    cacheHitTokens: hit,
    cacheMissTokens: input.input_tokens - hit,
    totalTokens: input.input_tokens + output.output_tokens,
  };
}

function wireTools(tools) {
  return tools.map((tool) => {
    const functionTool = tool?.function;
    if (!functionTool || !validId(functionTool.name, 128) || !validText(functionTool.description ?? '', 8_000) || !functionTool.parameters)
      throw new ProviderError('Invalid tool definition');
    return { name: functionTool.name, description: functionTool.description, input_schema: functionTool.parameters };
  });
}

function wireToolChoice(value) {
  if (value === undefined) return undefined;
  if (value?.type === 'tool' && validId(value.name, 128)) return { type: 'tool', name: value.name };
  if (value?.type === 'function' && validId(value.function?.name, 128)) return { type: 'tool', name: value.function.name };
  throw new ProviderError('Invalid Anthropic tool choice');
}

function wireNativeAnthropicContent(value) {
  if (!validAnthropicContent(value)) throw new ProviderError('Invalid Anthropic assistant content');
  return value.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    if (block.type === 'redacted_thinking') return { type: 'redacted_thinking', data: block.data };
    try {
      return { type: 'tool_use', id: block.id, name: block.name, input: JSON.parse(block.input) };
    } catch {
      // validAnthropicContent() has already checked this. Keep the provider
      // boundary closed if a hostile caller mutates an input between checks.
      throw new ProviderError('Invalid Anthropic assistant tool JSON');
    }
  });
}

function wireMessages(messages) {
  const system = [];
  const wire = [];
  let toolResults = [];
  const flushToolResults = () => {
    if (!toolResults.length) return;
    // Anthropic requires every tool_result block for an assistant tool-use
    // turn to be in the immediately following user message. The normalized
    // Offload transcript stores one `tool` record per call, so coalesce each
    // contiguous run before serializing it to the Messages API.
    wire.push({ role: 'user', content: toolResults });
    toolResults = [];
  };
  for (const message of messages) {
    if (!message || typeof message !== 'object' || !['system', 'user', 'assistant', 'tool'].includes(message.role))
      throw new ProviderError('Invalid transcript message');
    if (message.role === 'tool') {
      if (!validId(message.tool_call_id, 512) || !validText(message.content) || (message.name !== undefined && !validId(message.name, 128)))
        throw new ProviderError('Invalid tool result');
      toolResults.push({ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content });
      continue;
    }
    flushToolResults();
    if (message.role === 'system') {
      if (!validText(message.content)) throw new ProviderError('Invalid system content');
      system.push({ type: 'text', text: message.content });
      continue;
    }
    if (message.role === 'user') {
      if (!validText(message.content)) throw new ProviderError('Invalid user content');
      wire.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      if (!validText(message.content ?? '')) throw new ProviderError('Invalid assistant content');
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length > MAX_TOOL_CALLS)
          throw new ProviderError('Invalid assistant tool calls');
        for (const call of message.tool_calls) {
          if (
            !validId(call?.id, 512) ||
            !validId(call?.function?.name, 128) ||
            !validText(call?.function?.arguments ?? '', MAX_TOOL_ARGUMENT_CHARS)
          )
            throw new ProviderError('Invalid assistant tool call');
          let input;
          try {
            input = JSON.parse(call.function.arguments || '{}');
          } catch {
            throw new ProviderError('Invalid assistant tool call JSON');
          }
          if (!input || Array.isArray(input) || typeof input !== 'object') throw new ProviderError('Invalid assistant tool call JSON');
        }
      }
      const portable = {
        content: message.content ?? '',
        ...(message.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {}),
      };
      const content =
        message.anthropic_content === undefined
          ? [
              ...(message.content ? [{ type: 'text', text: message.content }] : []),
              ...(message.tool_calls ?? []).map((call) => ({
                type: 'tool_use',
                id: call.id,
                name: call.function.name,
                input: JSON.parse(call.function.arguments || '{}'),
              })),
            ]
          : anthropicContentMatchesAssistant(message.anthropic_content, portable)
            ? wireNativeAnthropicContent(message.anthropic_content)
            : (() => {
                throw new ProviderError('Anthropic assistant replay does not match tool transaction');
              })();
      wire.push({ role: 'assistant', content: content.length ? content : '' });
      continue;
    }
  }
  flushToolResults();
  return { ...(system.length ? { system } : {}), messages: wire };
}

function finishReason(value) {
  if (value === 'max_tokens') return 'length';
  if (value === 'end_turn' || value === 'stop_sequence') return 'stop';
  if (value === 'tool_use') return 'tool_calls';
  return value === undefined || value === null ? undefined : 'other';
}

function creditExhaustedCode(body, status) {
  const value = body?.error?.type ?? body?.error?.code ?? body?.type ?? body?.code;
  return (
    (typeof value === 'string' && ['credit_balance_too_low', 'insufficient_credit', 'insufficient_funds'].includes(value)) ||
    (status === 402 && value === 'billing_error')
  );
}

async function responseError(response) {
  let body;
  try {
    const text = await response.text();
    if (text.length <= 65_536) body = JSON.parse(text);
  } catch {
    // Never preserve or expose a provider response body in diagnostics.
  }
  const exhausted = creditExhaustedCode(body, response.status);
  return new ProviderError(exhausted ? 'Claude promotional credit is exhausted' : `Chat request failed (HTTP ${response.status})`, {
    status: response.status,
    kind: exhausted ? 'credit_exhausted' : 'http',
    retryable: response.status === 429 || response.status >= 500,
  });
}

/** Anthropic Messages adapter normalized to Offload's provider event contract. */
export class AnthropicMessagesProvider {
  constructor({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch, timeoutMs = 300_000, retries = 3 } = {}) {
    this.baseUrl = checkedBaseUrl(baseUrl);
    if (typeof apiKey !== 'string' || !apiKey) throw new TypeError('apiKey is required');
    if (!isAnthropicSonnetModel(model)) throw new TypeError('model must be a concrete Claude Sonnet model id');
    assertModelAllowed({ type: 'anthropic-messages', baseUrl: this.baseUrl, model });
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) throw new TypeError('timeoutMs is invalid');
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 3) throw new TypeError('retries is invalid');
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }
  async #collect(payload, signal, retryLimit = this.retries) {
    let last;
    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
      const abort = () => controller.abort(signal?.reason ?? new Error('Aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await this.fetch(new URL('v1/messages', `${this.baseUrl}/`).href, {
          method: 'POST',
          signal: controller.signal,
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': DEFAULT_ANTHROPIC_VERSION,
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw await responseError(response);
        const events = [];
        for await (const event of sseEvents(response.body, {
          maxEventBytes: MAX_SSE_EVENT_BYTES,
          maxAttemptBytes: MAX_SSE_ATTEMPT_BYTES,
        })) {
          try {
            events.push(JSON.parse(event.data));
          } catch {
            throw new ProviderError('Invalid JSON in SSE data', { kind: 'sse_protocol' });
          }
        }
        return events;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        const providerError = timedOut
          ? new ProviderError('Provider request timed out', { kind: 'attempt_timeout', retryable: true, timeoutMs: this.timeoutMs })
          : error instanceof ProviderError
            ? error
            : new ProviderError('Chat request failed', { kind: 'transport', retryable: true });
        providerError.attempts = attempt + 1;
        if (!providerError.retryable || attempt === retryLimit) throw providerError;
        last = providerError;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    }
    throw last;
  }
  async *chat({ messages, tools, signal, retryLimit, model, max_tokens = 16_384, tool_choice, ...options } = {}) {
    if (!Array.isArray(messages) || !Array.isArray(tools)) throw new TypeError('messages and tools must be arrays');
    if (Object.keys(options).length) throw new ProviderError('Unsupported Anthropic request option');
    if (retryLimit !== undefined && (!Number.isSafeInteger(retryLimit) || retryLimit < 0 || retryLimit > this.retries))
      throw new TypeError('retryLimit is invalid');
    const requestModel = model ?? this.model;
    if (modelPolicyViolation({ type: 'anthropic-messages', baseUrl: this.baseUrl, model: requestModel }))
      throw new ProviderError('Offload model policy rejected Anthropic request', { kind: 'request' });
    if (!Number.isSafeInteger(max_tokens) || max_tokens < 1 || max_tokens > 131_072)
      throw new ProviderError('max_tokens is required for Anthropic requests');
    const wire = wireMessages(messages);
    const choice = wireToolChoice(tool_choice);
    const events = await this.#collect(
      { model: requestModel, max_tokens, stream: true, tools: wireTools(tools), ...(choice ? { tool_choice: choice } : {}), ...wire },
      signal,
      retryLimit,
    );
    let modelName,
      inputUsage,
      outputUsage,
      stop,
      sawStop = false;
    const blocks = new Map();
    for (const event of events) {
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string')
        throw new ProviderError('Invalid Anthropic SSE event');
      if (event.type === 'message_start') {
        if (!isAnthropicSonnetModel(event.message?.model)) throw new ProviderError('Invalid Anthropic response model');
        modelName = event.message.model;
        inputUsage = event.message.usage;
      } else if (event.type === 'content_block_start') {
        const index = event.index;
        if (!Number.isSafeInteger(index) || index < 0 || blocks.has(index)) throw new ProviderError('Invalid Anthropic content block');
        const block = event.content_block;
        if (block?.type === 'text' && validText(block.text ?? '')) blocks.set(index, { type: 'text', text: block.text ?? '' });
        else if (block?.type === 'tool_use' && validId(block.id, 512) && validId(block.name, 128))
          blocks.set(index, { type: 'tool_use', id: block.id, name: block.name, input: '' });
        else if (block?.type === 'thinking' && validText(block.thinking ?? '') && validText(block.signature ?? ''))
          blocks.set(index, { type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '' });
        else if (block?.type === 'redacted_thinking' && validText(block.data ?? '') && block.data.length > 0)
          blocks.set(index, { type: 'redacted_thinking', data: block.data });
        else throw new ProviderError('Unsupported Anthropic content block');
      } else if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index);
        if (!block || !event.delta || typeof event.delta !== 'object') throw new ProviderError('Invalid Anthropic content delta');
        if (block.type === 'text' && event.delta.type === 'text_delta' && validText(event.delta.text ?? '')) {
          block.text += event.delta.text ?? '';
          if (!validText(block.text)) throw new ProviderError('Anthropic text exceeds size limit');
        } else if (
          block.type === 'tool_use' &&
          event.delta.type === 'input_json_delta' &&
          validText(event.delta.partial_json ?? '', MAX_TOOL_ARGUMENT_CHARS)
        ) {
          block.input += event.delta.partial_json ?? '';
          if (block.input.length > MAX_TOOL_ARGUMENT_CHARS) throw new ProviderError('Tool arguments exceed size limit');
        } else if (block.type === 'thinking' && event.delta.type === 'thinking_delta' && validText(event.delta.thinking ?? '')) {
          block.thinking += event.delta.thinking ?? '';
          if (!validText(block.thinking)) throw new ProviderError('Anthropic thinking exceeds size limit');
        } else if (block.type === 'thinking' && event.delta.type === 'signature_delta' && validText(event.delta.signature ?? '')) {
          block.signature += event.delta.signature ?? '';
          if (!validText(block.signature)) throw new ProviderError('Anthropic thinking signature exceeds size limit');
        } else throw new ProviderError('Unsupported Anthropic content delta');
      } else if (event.type === 'message_delta') {
        stop = finishReason(event.delta?.stop_reason);
        outputUsage = event.usage;
      } else if (event.type === 'message_stop') sawStop = true;
    }
    if (!sawStop || !modelName || !inputUsage || !outputUsage)
      throw new ProviderError('Incomplete Anthropic SSE response', { kind: 'sse_protocol' });
    let text = '';
    const toolCalls = [];
    const anthropicContent = [];
    let hasThinking = false;
    for (const [, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
      if (block.type === 'text') {
        text += block.text;
        anthropicContent.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        try {
          const parsed = JSON.parse(block.input || '{}');
          if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid');
        } catch {
          throw new ProviderError('Incomplete Anthropic tool JSON');
        }
        toolCalls.push({ id: block.id, name: block.name, arguments: block.input || '{}' });
        anthropicContent.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input || '{}' });
      } else if (block.type === 'thinking') {
        if (!block.signature) throw new ProviderError('Incomplete Anthropic thinking signature');
        hasThinking = true;
        anthropicContent.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
      } else {
        hasThinking = true;
        anthropicContent.push({ type: 'redacted_thinking', data: block.data });
      }
    }
    if (text) yield { text, model: modelName };
    if (toolCalls.length) yield { toolCalls, model: modelName };
    // Sonnet's adaptive thinking is on by default. Its native thinking blocks
    // must be sent back unchanged with the next tool_result user turn; retain
    // the complete ordered assistant response only when that protocol applies.
    if (hasThinking) yield { anthropicContent: cloneAnthropicContent(anthropicContent), model: modelName };
    yield { usage: normalizedUsage(inputUsage, outputUsage), model: modelName };
    if (stop !== undefined) yield { providerFinishReason: stop };
  }
}

export async function resolveLatestAnthropicSonnet({ baseUrl, apiKey, fetchImpl = globalThis.fetch, signal } = {}) {
  const checked = checkedBaseUrl(baseUrl);
  // Anthropic documents newest-first ordering. Keep that provider-defined
  // release order rather than guessing from model-id spelling. Prefer the
  // active-only server-side filter, but retain compatibility with accounts
  // whose Models endpoint has not yet accepted that query parameter.
  const seenCursors = new Set();
  let afterId;
  let activeOnly = true;
  for (let page = 0; page < 32;) {
    const endpoint = new URL('v1/models', `${checked}/`);
    if (activeOnly) endpoint.searchParams.set('lifecycle', 'active');
    if (afterId) endpoint.searchParams.set('after_id', afterId);
    const response = await fetchImpl(endpoint.href, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': DEFAULT_ANTHROPIC_VERSION },
      signal,
      redirect: 'error',
    });
    // A few API deployments accepted the Models endpoint before supporting
    // lifecycle filtering. On that precise initial validation failure, retry
    // the ordinary newest-first catalogue and locally reject non-active rows.
    // Do not mask auth, network, pagination, or later-page errors.
    if (!response.ok && activeOnly && page === 0 && response.status === 400) {
      activeOnly = false;
      continue;
    }
    if (!response.ok) throw await responseError(response);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new ProviderError('Invalid Anthropic Models response');
    }
    if (!Array.isArray(body?.data)) throw new ProviderError('Invalid Anthropic Models response');
    const model = body.data.find(
      (entry) =>
        entry?.line === 'sonnet' &&
        isAnthropicSonnetModel(entry.id) &&
        (activeOnly || entry.lifecycle === undefined || entry.lifecycle === 'active'),
    );
    if (model) return model.id;
    if (body.has_more !== true) break;
    if (!validId(body.last_id, 256) || seenCursors.has(body.last_id)) throw new ProviderError('Invalid Anthropic Models pagination');
    seenCursors.add(body.last_id);
    afterId = body.last_id;
    page += 1;
  }
  throw new ProviderError('No supported Claude Sonnet model is available');
}
