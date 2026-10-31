import { readJsonAbortable } from './abort.mjs';
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  ProviderError,
  checkedBaseUrl,
  collectAttempts,
  normalizeOpenAISnapshot,
  positive,
  validModel,
} from './openai-chat.mjs';
import { assertModelAllowed, modelPolicyViolation } from '../model-policy.mjs';
import { plainObject } from '../plain-object.mjs';
import { MAX_OPENAI_REASONING_ITEMS, cloneOpenAIReasoning, validOpenAIReasoning } from '../openai-reasoning.mjs';
import { MAX_MESSAGE_CHARS, MAX_TOOL_ARGUMENT_CHARS, MAX_TOOL_CALLS, validToolIdentifier } from '../transcript-limits.mjs';

const MAX_OUTPUT_ITEMS = 1_024;
const MAX_CONTENT_PARTS = 256;
// OpenAI rejects a smaller output cap. Clamping it upward would silently spend
// beyond a budget reservation, so a request below the floor fails locally.
const MIN_OUTPUT_TOKENS = 16;
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const TOOL_CHOICES = new Set(['auto', 'none', 'required']);
// Below this output cap a reasoning model can spend every token thinking and
// return an `incomplete` response with no tool call (a 16-token cap at high
// effort did exactly that live). AgentLoop's budget-finish and near-budget
// turns use such caps, so they run without reasoning unless the request names
// an effort itself.
const SMALL_OUTPUT_TOKENS = 1_024;
const SMALL_OUTPUT_EFFORT = 'none';

const validText = (value, limit = MAX_MESSAGE_CHARS) => typeof value === 'string' && value.length <= limit;
const validCounter = (value) => Number.isSafeInteger(value) && value >= 0;
const invalidResponse = (message) => new ProviderError(message, { kind: 'response' });

// Context may retain local metadata (anthropic_content, DeepSeek
// reasoning_content, display names); the Responses API receives only its own
// input item schema. Encrypted reasoning is replayed without its item id:
// `store: false` means OpenAI holds no server-side copy to reference.
function wireInput(messages) {
  const input = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || typeof message.role !== 'string') throw new ProviderError('Invalid transcript message');
    if (message.role === 'system' || message.role === 'user') {
      if (!validText(message.content)) throw new ProviderError('Invalid transcript content');
      input.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === 'tool') {
      if (!validToolIdentifier(message.tool_call_id, 512) || !validText(message.content)) throw new ProviderError('Invalid tool result');
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
      continue;
    }
    if (message.role !== 'assistant') throw new ProviderError('Invalid transcript role');
    if (!validText(message.content ?? '')) throw new ProviderError('Invalid assistant content');
    if (message.reasoning_content !== undefined && message.reasoning_content !== null && !validText(message.reasoning_content))
      throw new ProviderError('Invalid assistant reasoning');
    let calls = [];
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0 || message.tool_calls.length > MAX_TOOL_CALLS)
        throw new ProviderError('Invalid assistant tool calls');
      calls = message.tool_calls.map((call) => {
        if (
          !call ||
          !validToolIdentifier(call.id, 512) ||
          !validToolIdentifier(call.function?.name, 128) ||
          !validText(call.function?.arguments, MAX_TOOL_ARGUMENT_CHARS)
        )
          throw new ProviderError('Invalid assistant tool call');
        return { type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments };
      });
      if (new Set(calls.map((call) => call.call_id)).size !== calls.length) throw new ProviderError('Invalid assistant tool calls');
    }
    let reasoning = [];
    if (message.openai_reasoning !== undefined) {
      if (!validOpenAIReasoning(message.openai_reasoning)) throw new ProviderError('Invalid assistant reasoning replay');
      reasoning = cloneOpenAIReasoning(message.openai_reasoning);
    }
    if (message.content) input.push({ role: 'assistant', content: message.content });
    // A reasoning item must be followed by the output it produced. Place it
    // immediately before this turn's function calls, else before its text.
    // A capped response with nothing else to replay drops it: OpenAI accepts
    // a transcript without prior reasoning, but not a dangling reasoning item.
    if (reasoning.length && calls.length) input.push(...reasoning, ...calls);
    else if (reasoning.length && message.content) input.splice(input.length - 1, 0, ...reasoning);
    else input.push(...calls);
  }
  return input;
}

function wireTools(tools) {
  return tools.map((tool) => {
    const functionTool = tool?.function;
    if (
      tool?.type !== 'function' ||
      !functionTool ||
      !validToolIdentifier(functionTool.name, 128) ||
      (functionTool.description !== undefined && !validText(functionTool.description, 8_000)) ||
      !plainObject(functionTool.parameters)
    )
      throw new ProviderError('Invalid tool definition');
    return {
      type: 'function',
      name: functionTool.name,
      ...(functionTool.description !== undefined ? { description: functionTool.description } : {}),
      parameters: functionTool.parameters,
      strict: false,
    };
  });
}

function wireToolChoice(value) {
  if (value === undefined) return undefined;
  if (TOOL_CHOICES.has(value)) return value;
  if (value?.type === 'function' && validToolIdentifier(value.function?.name, 128)) return { type: 'function', name: value.function.name };
  if (value?.type === 'function' && validToolIdentifier(value.name, 128)) return { type: 'function', name: value.name };
  throw new ProviderError('Invalid tool_choice');
}

// Responses usage: output_tokens already includes reasoning_tokens, and
// cache_write_tokens is a subset of the uncached input. A finite budget needs
// every counter to reconcile; never repair a disagreement by guessing.
function normalizeResponsesUsage(usage) {
  if (!plainObject(usage)) throw invalidResponse('Invalid response usage');
  const { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens } = usage;
  if (!validCounter(inputTokens) || !validCounter(outputTokens)) throw invalidResponse('Invalid response usage');
  const inputDetails = usage.input_tokens_details ?? {};
  const outputDetails = usage.output_tokens_details ?? {};
  if (!plainObject(inputDetails) || !plainObject(outputDetails)) throw invalidResponse('Invalid response usage details');
  const cacheHitTokens = inputDetails.cached_tokens ?? 0;
  const cacheWriteTokens = inputDetails.cache_write_tokens ?? 0;
  const reasoningTokens = outputDetails.reasoning_tokens ?? 0;
  if (!validCounter(cacheHitTokens) || cacheHitTokens > inputTokens) throw invalidResponse('Invalid cache usage');
  const cacheMissTokens = inputTokens - cacheHitTokens;
  if (!validCounter(cacheWriteTokens) || cacheWriteTokens > cacheMissTokens) throw invalidResponse('Invalid cache usage');
  if (!validCounter(reasoningTokens) || reasoningTokens > outputTokens) throw invalidResponse('Invalid reasoning usage');
  if (totalTokens !== undefined && totalTokens !== inputTokens + outputTokens) throw invalidResponse('Invalid usage totalTokens');
  if (!Number.isSafeInteger(inputTokens + outputTokens)) throw invalidResponse('Invalid usage totalTokens');
  return {
    inputTokens,
    outputTokens,
    cacheHitTokens,
    cacheMissTokens,
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    totalTokens: inputTokens + outputTokens,
  };
}

function finishReason(json) {
  if (json.status === 'completed') return undefined;
  if (json.status === 'incomplete') {
    const reason = plainObject(json.incomplete_details) ? json.incomplete_details.reason : undefined;
    return reason === 'max_output_tokens' ? 'length' : reason === 'content_filter' ? 'content_filter' : 'other';
  }
  // failed, cancelled, queued, in_progress, or a status we do not know: a
  // non-terminal or unsuccessful body is never executable output.
  throw invalidResponse('Unsupported response status');
}

function summaryParts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidResponse('Invalid reasoning summary');
  return value.map((part) => {
    if (!plainObject(part) || part.type !== 'summary_text' || !validText(part.text)) throw invalidResponse('Invalid reasoning summary');
    return { type: 'summary_text', text: part.text };
  });
}

function messageText(item) {
  if (item.role !== 'assistant' || !Array.isArray(item.content) || item.content.length > MAX_CONTENT_PARTS)
    throw invalidResponse('Invalid response message');
  return item.content
    .map((part) => {
      if (!plainObject(part)) throw invalidResponse('Invalid response message part');
      if (part.type === 'output_text' && validText(part.text)) return part.text;
      if (part.type === 'refusal' && validText(part.refusal)) return part.refusal;
      throw invalidResponse('Unsupported response message part');
    })
    .join('\n');
}

const validArguments = (value) => {
  try {
    return plainObject(JSON.parse(value || '{}'));
  } catch {
    return false;
  }
};

function responseOutput(json) {
  let stop = finishReason(json);
  if (!Array.isArray(json.output) || json.output.length > MAX_OUTPUT_ITEMS) throw invalidResponse('Invalid response output');
  const texts = [];
  let textChars = 0;
  const reasoning = [];
  const calls = [];
  for (const item of json.output) {
    if (!plainObject(item) || typeof item.type !== 'string') throw invalidResponse('Invalid response output item');
    if (item.type === 'message') {
      const itemText = messageText(item);
      if (itemText) texts.push(itemText);
      // Separate message items stay separate paragraphs in the transcript.
      textChars += itemText.length + (texts.length > 1 && itemText ? 1 : 0);
      if (textChars > MAX_MESSAGE_CHARS) throw invalidResponse('Response text exceeds size limit');
    } else if (item.type === 'reasoning') {
      const summary = summaryParts(item.summary);
      // Without encrypted content there is nothing to replay statelessly.
      if (item.encrypted_content === undefined || item.encrypted_content === null) continue;
      if (typeof item.encrypted_content !== 'string') throw invalidResponse('Invalid reasoning item');
      // Replay is optional (OpenAI accepts a transcript without prior
      // reasoning), so one unusable item never discards a billed tool call:
      // skip it, and keep at most the replay limit.
      const candidate = { type: 'reasoning', encrypted_content: item.encrypted_content, summary };
      if (reasoning.length < MAX_OPENAI_REASONING_ITEMS && validOpenAIReasoning([candidate])) reasoning.push(candidate);
    } else if (item.type === 'function_call') {
      if (
        !validToolIdentifier(item.call_id, 512) ||
        !validToolIdentifier(item.name, 128) ||
        typeof item.arguments !== 'string' ||
        (item.status !== undefined && typeof item.status !== 'string')
      )
        throw invalidResponse('Invalid function call');
      if (item.arguments.length > MAX_TOOL_ARGUMENT_CHARS) throw invalidResponse('Tool arguments exceed size limit');
      if (calls.length >= MAX_TOOL_CALLS) throw invalidResponse('Too many tool calls');
      if (calls.some((call) => call.id === item.call_id)) throw invalidResponse('Duplicate tool call id');
      calls.push({ id: item.call_id, name: item.name, arguments: item.arguments, status: item.status });
    } else throw invalidResponse('Unsupported response output item');
  }
  const toolCalls = [];
  for (const call of calls) {
    if ((call.status === undefined || call.status === 'completed') && validArguments(call.arguments)) {
      toolCalls.push({ id: call.id, name: call.name, arguments: call.arguments || '{}' });
      continue;
    }
    // An output cap can cut a tool call mid-arguments. That is a completed,
    // billed `length` response, not a malformed one: drop the unexecutable
    // fragment and let the loop's output-cap recovery see the finish reason.
    if (stop !== 'length') throw invalidResponse('Incomplete tool JSON');
  }
  stop ??= toolCalls.length ? 'tool_calls' : 'stop';
  return { text: texts.join('\n'), openaiReasoning: reasoning.length ? cloneOpenAIReasoning(reasoning) : undefined, toolCalls, stop };
}

/** OpenAI Responses adapter for the official endpoint. Chat Completions there
 * rejects function tools combined with reasoning, so this path sends a
 * stateless, non-streaming Responses request and replays encrypted reasoning
 * itself. A whole response is read before anything is yielded, so a retry can
 * never duplicate output. The attempt timeout stays live through body EOF. */
export class OpenAIResponsesProvider {
  constructor({
    baseUrl,
    apiKey,
    model,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    retries = 3,
    headers = {},
    reasoningEffort,
    // Accepted for constructor parity with OpenAIChatProvider; OpenAI never
    // takes a DeepSeek-style thinking switch.
    thinking: _thinking,
    maxResponseBytes = 8_000_000,
  } = {}) {
    const { parsed, baseUrl: normalizedBaseUrl } = checkedBaseUrl(baseUrl);
    if (!validModel(model)) throw new TypeError('model is required and must be a short control-free string');
    assertModelAllowed({ baseUrl: parsed.href, model });
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (apiKey !== undefined && typeof apiKey !== 'string') throw new TypeError('apiKey must be a string');
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new TypeError('headers must be an object');
    if (reasoningEffort !== undefined && !REASONING_EFFORTS.has(reasoningEffort)) throw new TypeError('reasoningEffort is invalid');
    this.baseUrl = normalizedBaseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = positive(timeoutMs, 'timeoutMs', DEFAULT_ATTEMPT_TIMEOUT_MS);
    if (!this.timeoutMs) throw new TypeError('timeoutMs must be positive');
    this.retries = positive(retries, 'retries', 3);
    this.headers = headers;
    this.reasoningEffort = reasoningEffort;
    // AgentLoop counts encrypted reasoning only against routes that send it.
    this.replaysOpenAIReasoning = true;
    // The forced-focus override is DeepSeek-specific; never claim it here.
    this.supportsForcedImplementationFocusFor = () => false;
    this.maxResponseBytes = positive(maxResponseBytes, 'maxResponseBytes', 8_000_000);
    if (!this.maxResponseBytes) throw new TypeError('maxResponseBytes must be positive');
  }
  async #readJson(body, signal) {
    try {
      return await readJsonAbortable(body, { signal, maxBytes: this.maxResponseBytes });
    } catch (error) {
      // A billed but unusable body is not retried: a second attempt would
      // spend again for an answer this adapter would refuse the same way.
      if (['Response has no body', 'Response exceeds configured size limit', 'Invalid response JSON'].includes(error?.message))
        throw invalidResponse(error.message);
      throw error;
    }
  }
  #collect(payload, externalSignal, retryLimit = this.retries) {
    return collectAttempts({
      fetchImpl: this.fetch,
      baseUrl: this.baseUrl,
      path: 'responses',
      headers: this.headers,
      apiKey: this.apiKey,
      payload,
      timeoutMs: this.timeoutMs,
      retryLimit,
      externalSignal,
      readBody: (body, signal) => this.#readJson(body, signal),
    });
  }
  async *chat({ messages, tools, signal, retryLimit, ...options } = {}) {
    if (!Array.isArray(messages) || !Array.isArray(tools)) throw new TypeError('messages and tools must be arrays');
    if (retryLimit !== undefined && (!Number.isSafeInteger(retryLimit) || retryLimit < 0 || retryLimit > this.retries))
      throw new TypeError('retryLimit must be an integer from 0 to configured retries');
    const {
      model,
      max_tokens: maxTokens,
      reasoning_effort: requestedEffort,
      tool_choice: toolChoice,
      // OpenAI never takes a DeepSeek thinking switch; AgentLoop may send one.
      thinking: _thinking,
      stream,
      stream_options: streamOptions,
      ...unknown
    } = options;
    if (stream !== undefined || streamOptions !== undefined)
      throw new ProviderError('stream options are controlled by the provider adapter');
    // Forward nothing we have not mapped: an unknown key could change billing
    // or retention (for example `store` or `previous_response_id`).
    if (Object.keys(unknown).length) throw new ProviderError('Unsupported OpenAI Responses request option');
    const requestModel = model ?? this.model;
    if (!validModel(requestModel)) throw new ProviderError('Invalid request model');
    const modelViolation = modelPolicyViolation({ baseUrl: this.baseUrl, model: requestModel });
    if (modelViolation) throw new ProviderError(`Offload model policy: ${modelViolation}`, { kind: 'model-policy' });
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < MIN_OUTPUT_TOKENS))
      throw new ProviderError('Output token cap below provider minimum');
    const effort = requestedEffort ?? (maxTokens < SMALL_OUTPUT_TOKENS ? SMALL_OUTPUT_EFFORT : this.reasoningEffort);
    if (effort !== undefined && !REASONING_EFFORTS.has(effort)) throw new ProviderError('Invalid reasoning effort');
    const choice = wireToolChoice(toolChoice);
    const json = await this.#collect(
      {
        model: requestModel,
        input: wireInput(messages),
        tools: wireTools(tools),
        ...(choice !== undefined ? { tool_choice: choice } : {}),
        ...(effort !== undefined ? { reasoning: { effort } } : {}),
        ...(maxTokens !== undefined ? { max_output_tokens: maxTokens } : {}),
        store: false,
        include: ['reasoning.encrypted_content'],
      },
      signal,
      retryLimit,
    );
    if (!plainObject(json)) throw invalidResponse('Invalid response body');
    if (!validModel(json.model)) throw invalidResponse('Invalid response model');
    // OpenAI may echo the dated snapshot of the requested alias; it is the
    // same priced model. Any other model is reported as echoed, so AgentLoop's
    // reservation check can refuse to execute its tool calls.
    const responseModel = normalizeOpenAISnapshot(json.model, requestModel);
    // Usage is checked first: an unaccountable response must never hand
    // AgentLoop text or tool calls to act on.
    const usage = normalizeResponsesUsage(json.usage);
    let output;
    try {
      output = responseOutput(json);
    } catch (error) {
      // The response was billed even though its output is unusable. Report
      // the usage so a finite budget still meters it, as the Chat adapter does
      // for a stream whose terminal checks fail after its usage record.
      yield { usage, model: responseModel };
      throw error;
    }
    const { text, openaiReasoning, toolCalls, stop } = output;
    if (text) yield { text, model: responseModel };
    if (openaiReasoning) yield { openaiReasoning, model: responseModel };
    if (toolCalls.length) yield { toolCalls, model: responseModel };
    yield { usage, model: responseModel };
    yield { providerFinishReason: stop };
  }
}
