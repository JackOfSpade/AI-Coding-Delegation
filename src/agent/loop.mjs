import { AgentContext } from './context.mjs';
import { TOOL_DEFINITIONS, isReadOnlyTool } from './tools.mjs';
import { Meter, resolveModel, samePricedModel } from '../pricing.mjs';

const asToolCalls = (calls) => calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
// Arguments originate with an untrusted provider response. Never persist a
// parser diagnostic: V8 includes source-adjacent text in some diagnostics.
const safeJson = (source) => {
  if (typeof source !== 'string') throw new Error('Invalid tool arguments');
  try {
    const value = JSON.parse(source || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('invalid');
    return value;
  } catch {
    throw new Error('Invalid tool arguments');
  }
};
const finishList = (value) =>
  value === undefined ||
  (Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === 'string' && item.length <= 1000));
const finishArgs = (value) =>
  typeof value.summary === 'string' &&
  value.summary.length > 0 &&
  value.summary.length <= 1500 &&
  finishList(value.concerns) &&
  finishList(value.testsRun);
const MAX_ASSISTANT_CHARS = 1_000_000;
const MAX_TOOL_CALLS = 64;
const MAX_TOOL_ARGUMENT_CHARS = 512_000;
const BASE_PROMPT_TOKEN_OVERHEAD = 256;
const MIN_REQUEST_OUTPUT_TOKENS = 16;
const MAX_REQUEST_OUTPUT_TOKENS = 16_384;
const validMetadata = (value, max = 256) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1F\x7F]/.test(value);
const validProviderCall = (call) =>
  !!call &&
  typeof call === 'object' &&
  validMetadata(call.id, 512) &&
  validMetadata(call.name, 128) &&
  typeof call.arguments === 'string' &&
  call.arguments.length <= MAX_TOOL_ARGUMENT_CHARS;
const isPlainRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
// Provider adapters are expected to normalize usage, but budget enforcement
// is a capability boundary. Validate it again here so a custom or future
// adapter cannot turn an absent usage record into a free, tool-authorized turn.
const normalizedUsage = (usage) => {
  if (!isPlainRecord(usage) || !Object.hasOwn(usage, 'inputTokens') || !Object.hasOwn(usage, 'outputTokens'))
    throw new Error('Provider yielded invalid usage');
  const result = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  for (const name of ['inputTokens', 'outputTokens'])
    if (!Number.isSafeInteger(result[name]) || result[name] < 0) throw new Error('Provider yielded invalid usage');
  for (const name of ['cacheHitTokens', 'cacheMissTokens']) {
    if (!Object.hasOwn(usage, name)) continue;
    if (!Number.isSafeInteger(usage[name]) || usage[name] < 0) throw new Error('Provider yielded invalid usage');
    result[name] = usage[name];
  }
  // Keep this boundary's normalized record identical to Meter's accounting
  // invariant. Without this, a custom provider's individually valid but
  // contradictory cache counters reach progress/accounting before Meter
  // rejects them later in the same stream.
  result.cacheHitTokens ??= 0;
  result.cacheMissTokens ??= result.inputTokens - result.cacheHitTokens;
  if (result.cacheMissTokens < 0 || result.cacheHitTokens + result.cacheMissTokens !== result.inputTokens)
    throw new Error('Provider yielded invalid usage');
  if (
    Object.hasOwn(usage, 'totalTokens') &&
    (!Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0 || usage.totalTokens !== result.inputTokens + result.outputTokens)
  )
    throw new Error('Provider yielded invalid usage');
  return result;
};

// Tokenizers consume at least one byte per ordinary token, so UTF-8 bytes are
// deliberately a pessimistic prompt-token estimate. The fixed allowance covers
// chat framing that is not represented by JSON. This is a reservation, not an
// attempt to predict provider billing; exact streamed usage remains decisive.
function reserveRequestBudget(table, model, messages, tools, remainingUsd) {
  const spec = resolveModel(table, model);
  if (!spec) return null;
  const rates = spec.usd_per_1m;
  const worst = (kind) => Math.max(...Object.values(rates[kind] || {}).map(Number));
  const inputRate = worst('input_cache_miss'),
    outputRate = worst('output');
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return null;
  let serialized;
  try {
    serialized = JSON.stringify({ messages, tools });
  } catch {
    return null;
  }
  // Reserve per-message/tool framing too; large conversations pay more than a
  // fixed JSON wrapper even when their textual fields are small.
  const framing = BASE_PROMPT_TOKEN_OVERHEAD + messages.length * 16 + tools.length * 64;
  const inputTokens = Buffer.byteLength(serialized, 'utf8') + framing;
  const inputUsd = (inputTokens * inputRate) / 1_000_000;
  const available = remainingUsd - inputUsd;
  if (!(available > 0)) return { inputTokens, inputUsd, maxTokens: 0 };
  const affordable = outputRate === 0 ? MAX_REQUEST_OUTPUT_TOKENS : Math.floor((available * 1_000_000) / outputRate);
  return { inputTokens, inputUsd, maxTokens: Math.min(MAX_REQUEST_OUTPUT_TOKENS, affordable) };
}

/** Drives a single worker conversation. The provider must yield normalized
 * stream events from OpenAIChatProvider; LocalTools supplies execute(). */
export class AgentLoop {
  constructor({
    provider,
    tools,
    context,
    meter,
    pricing,
    model,
    toolDefinitions = TOOL_DEFINITIONS,
    maxTurns = 80,
    timeoutMs = 30 * 60_000,
    maxUsd = Infinity,
    now = () => Date.now(),
    signal,
    progress,
  } = {}) {
    if (!provider || typeof provider.chat !== 'function') throw new TypeError('provider.chat is required');
    if (!tools || typeof tools.execute !== 'function') throw new TypeError('tools.execute is required');
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new TypeError('maxTurns must be a positive integer');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
    if (!(Number.isFinite(maxUsd) || maxUsd === Infinity) || maxUsd < 0) throw new TypeError('maxUsd must be non-negative');
    const allowedToolNames = new Set(TOOL_DEFINITIONS.map((tool) => tool.function.name));
    const names = Array.isArray(toolDefinitions) ? toolDefinitions.map((tool) => tool?.function?.name) : [];
    if (
      !Array.isArray(toolDefinitions) ||
      names.some((name) => typeof name !== 'string' || !allowedToolNames.has(name)) ||
      new Set(names).size !== names.length ||
      !names.includes('finish')
    )
      throw new TypeError('toolDefinitions must be a unique executable subset containing finish');
    if (progress !== undefined && typeof progress !== 'function') throw new TypeError('progress must be a function');
    this.provider = provider;
    this.tools = tools;
    this.context = context ?? new AgentContext();
    for (const method of ['add', 'addBatch', 'snapshot', 'flush', 'preflightAppend'])
      if (typeof this.context[method] !== 'function') throw new TypeError(`context.${method} is required`);
    this.meter = meter ?? new Meter({ table: pricing, model });
    this.model = model;
    this.toolDefinitions = toolDefinitions;
    this.allowedToolNames = new Set(names);
    this.maxTurns = maxTurns;
    this.timeoutMs = timeoutMs;
    this.maxUsd = maxUsd;
    this.now = now;
    this.signal = signal;
    this.progress = progress;
  }
  async #execute(calls, signal) {
    const result = new Array(calls.length);
    const one = async (call, i) => {
      try {
        if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
        result[i] = await this.tools.execute(call.name, safeJson(call.arguments), { signal });
      } catch (error) {
        // An abort is control flow, not a worker-visible tool failure.  In
        // particular, swallowing it would leave a subprocess running until
        // its own timeout and would allow another provider turn after the
        // loop's wall-clock deadline.
        if (signal?.aborted) throw signal.reason ?? error;
        // Tool implementations can wrap command output or OS errors.  Those
        // messages are fed back to the model and may contain credentials, so
        // keep the retry signal useful without reflecting untrusted text.
        result[i] = 'TOOL_ERROR: Tool execution failed';
      }
    };
    // Reads are concurrent. A write is a barrier, so its order relative to all
    // earlier calls is deterministic and human edits cannot race our writes.
    let reads = [];
    for (let i = 0; i < calls.length; i++) {
      if (isReadOnlyTool(calls[i].name)) reads.push(one(calls[i], i));
      else {
        await Promise.all(reads);
        reads = [];
        await one(calls[i], i);
      }
    }
    await Promise.all(reads);
    return result;
  }
  async run({ system, task, messages } = {}) {
    if (messages !== undefined && !Array.isArray(messages)) throw new TypeError('messages must be an array');
    if (system !== undefined && typeof system !== 'string') throw new TypeError('system must be a string');
    if (task !== undefined && typeof task !== 'string') throw new TypeError('task must be a string');
    // Transcript material is always oldest-first.  Adding a system prompt to
    // an existing conversation would create a second, reordered system turn.
    if (system && (this.context.snapshot().length || messages?.length))
      throw new Error('cannot add a system prompt to an existing transcript');
    const initial = [
      ...(messages ?? []),
      ...(system ? [{ role: 'system', content: system }] : []),
      ...(task ? [{ role: 'user', content: task }] : []),
    ];
    // A failure must not leave a prefix durable: that would turn a retry into
    // a different conversation and can prevent a valid system prompt later.
    this.context.preflightAppend(initial);
    if (initial.length) await this.context.addBatch(initial);
    // Do not issue a paid request until the durable transcript has accepted
    // the initial turn. This also observes an append failure synchronously
    // instead of leaving a rejected persistence promise behind on a budget
    // preflight exit.
    await this.context.flush();
    const started = this.now();
    const repeated = new Map();
    let totalUsage = this.meter.usage;
    const responseModels = new Set();
    const modelMeta = () => {
      const models = [...responseModels].slice(0, 16);
      return { requestedModel: this.model, responseModels: models, modelMismatch: models.some((model) => model !== this.model) };
    };
    // A zero allowance cannot purchase even one token.  Likewise, a finite
    // cap with no exact model price cannot safely authorize a paid request.
    const pricingKnown = !!(this.meter.table && resolveModel(this.meter.table, this.model));
    if (this.maxUsd !== Infinity && (this.maxUsd === 0 || !pricingKnown))
      return {
        status: 'BUDGET',
        turn: 0,
        usage: totalUsage,
        costUsd: this.meter.usd,
        pricingKnown,
        error: this.maxUsd === 0 ? 'Budget is zero' : 'Pricing is unknown for a finite budget',
        ...modelMeta(),
      };
    const deadline = new AbortController();
    const onAbort = () => deadline.abort(this.signal.reason ?? new Error('Aborted'));
    this.signal?.addEventListener('abort', onAbort, { once: true });
    if (this.signal?.aborted) deadline.abort(this.signal.reason ?? new Error('Aborted'));
    const timer = setTimeout(() => deadline.abort(new Error('Agent wall clock deadline exceeded')), this.timeoutMs);
    try {
      for (let turn = 1; turn <= this.maxTurns; turn++) {
        await this.context.flush();
        if (this.signal?.aborted)
          return { status: 'CANCELLED', turn: turn - 1, usage: totalUsage, costUsd: this.meter.usd, ...modelMeta() };
        if (this.now() - started > this.timeoutMs)
          return { status: 'TIMEOUT', turn: turn - 1, usage: totalUsage, costUsd: this.meter.usd, ...modelMeta() };
        let text = '',
          reasoning = '',
          calls = [],
          responseModel,
          usageRecords = 0,
          toolCallRecords = 0,
          unauthorizedResponseModel,
          modelConflict = false;
        const usageCharges = [];
        const messagesForTurn = this.context.snapshot();
        let maxTokens;
        if (this.maxUsd !== Infinity) {
          const reservation = reserveRequestBudget(
            this.meter.table,
            this.model,
            messagesForTurn,
            this.toolDefinitions,
            this.maxUsd - this.meter.usd,
          );
          if (!reservation || reservation.maxTokens < MIN_REQUEST_OUTPUT_TOKENS)
            return {
              status: 'BUDGET',
              turn: turn - 1,
              usage: totalUsage,
              costUsd: this.meter.usd,
              pricingKnown: true,
              error: 'Remaining budget cannot cover a conservative prompt and minimum response reservation',
              ...modelMeta(),
            };
          maxTokens = reservation.maxTokens;
        }
        try {
          for await (const event of this.provider.chat({
            messages: messagesForTurn,
            tools: this.toolDefinitions,
            model: this.model,
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
            ...(this.maxUsd !== Infinity ? { retryLimit: 0 } : {}),
            signal: deadline.signal,
          })) {
            if (
              !event ||
              typeof event !== 'object' ||
              Array.isArray(event) ||
              (event.text !== undefined && typeof event.text !== 'string') ||
              (event.reasoning !== undefined && typeof event.reasoning !== 'string') ||
              (event.model !== undefined && !validMetadata(event.model)) ||
              (event.modelConflict !== undefined && typeof event.modelConflict !== 'boolean') ||
              (event.toolCalls !== undefined &&
                (!Array.isArray(event.toolCalls) ||
                  event.toolCalls.length > MAX_TOOL_CALLS ||
                  event.toolCalls.some((call) => !validProviderCall(call))))
            )
              throw new Error('Provider yielded invalid event');
            text += event.text ?? '';
            reasoning += event.reasoning ?? '';
            // Adapters must emit one normalized, terminal tool-call event.  In
            // particular, never accept a later event that silently replaces a
            // previously authorized call list from a custom provider.
            if (event.toolCalls?.length) {
              toolCallRecords++;
              calls = event.toolCalls;
            }
            if (text.length + reasoning.length > MAX_ASSISTANT_CHARS) throw new Error('Provider response exceeds assistant size limit');
            // Some compatible providers send model metadata only in an earlier
            // delta and omit it from their terminal usage event. Carry the last
            // validated model forward so usage is not silently priced as the
            // requested model instead of the response model.
            if (event.model) {
              if (responseModel && responseModel !== event.model) modelConflict = true;
              responseModel ??= event.model;
              responseModels.add(event.model);
              // Reservation was made for the requested model. Under a finite
              // budget, only that exact priced entry (including an explicit table
              // alias) may authorize tool execution; a provider cannot silently
              // substitute a more expensive model after the request begins.
              if (this.maxUsd !== Infinity && !samePricedModel(this.meter.table, this.model, event.model))
                unauthorizedResponseModel ??= event.model;
            }
            modelConflict ||= event.modelConflict === true;
            // Aggregate usage sometimes precedes a model-only metadata chunk. Bill
            // it immediately so a later stream failure still reaches durable
            // progress, then reprice the provisional record when that first model
            // identifier arrives.
            if (responseModel) {
              let repriced = false;
              for (const charge of usageCharges)
                if (charge.provisional) {
                  if (typeof this.meter.reprice !== 'function') throw new Error('Meter cannot reprice late provider model metadata');
                  this.meter.reprice(charge.usage, charge.model, responseModel, charge.at);
                  charge.model = responseModel;
                  charge.provisional = false;
                  repriced = true;
                }
              if (repriced) await this.progress?.({ turn, usage: totalUsage, costUsd: this.meter.usd, action: 'provider_usage_repriced' });
            }
            if (event.usage !== undefined) {
              const usage = normalizedUsage(event.usage);
              const usageModel = responseModel ?? this.model;
              const at = typeof this.meter.now === 'function' ? this.meter.now() : undefined;
              usageRecords++;
              this.meter.add(usage, usageModel, at);
              usageCharges.push({ usage, model: usageModel, at, provisional: responseModel === undefined });
              totalUsage = this.meter.usage;
              await this.progress?.({ turn, usage: totalUsage, costUsd: this.meter.usd, action: 'provider_usage' });
            }
          }
        } catch (error) {
          if (this.signal?.aborted)
            return { status: 'CANCELLED', turn: turn - 1, usage: totalUsage, costUsd: this.meter.usd, ...modelMeta() };
          if (deadline.signal.aborted)
            return {
              status: 'TIMEOUT',
              turn: turn - 1,
              usage: totalUsage,
              costUsd: this.meter.usd,
              error: 'Agent wall clock deadline exceeded',
              ...modelMeta(),
            };
          throw error;
        }
        if (toolCallRecords > 1)
          return {
            status: 'FAILED',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            error: 'Provider yielded multiple tool-call events in one turn',
            ...modelMeta(),
          };
        // Duplicate usage is never coherent, even without a configured spend
        // cap. We still consume the whole stream first so any observed usage is
        // durably metered and an error cannot cause it to be retried as free.
        if (usageRecords > 1 || (this.maxUsd !== Infinity && usageRecords !== 1))
          return {
            status: 'FAILED',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            error: `Expected exactly one usage record, received ${usageRecords}`,
            ...modelMeta(),
          };
        if (modelConflict)
          return {
            status: 'FAILED',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            error: 'Provider response has conflicting model metadata',
            ...modelMeta(),
          };
        // Do not return as soon as a mismatched model appears: its terminal
        // usage record can arrive later in the same paid stream.  Consume and
        // account for the complete turn, then stop before any tool can execute.
        if (this.maxUsd !== Infinity && unauthorizedResponseModel)
          return {
            status: 'BUDGET',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            error: 'Provider response model is not authorized for this finite budget',
            ...modelMeta(),
          };
        if (this.meter.usd > this.maxUsd || (this.meter.unknownPricing && this.maxUsd !== Infinity))
          return {
            status: 'BUDGET',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            ...modelMeta(),
          };
        if (
          calls.length > MAX_TOOL_CALLS ||
          calls.some((call) => !validProviderCall(call)) ||
          calls.reduce((n, call) => n + call.arguments.length, 0) > MAX_TOOL_ARGUMENT_CHARS
        )
          return {
            status: 'FAILED',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            error: 'Provider tool calls exceed size limit',
            ...modelMeta(),
          };
        // Tool names are an authorization boundary, not merely prompt guidance.
        // A compromised/misconfigured provider must not reach capabilities that
        // were deliberately left out of this turn's advertised schema.
        if (calls.some((call) => !this.allowedToolNames.has(call.name)))
          return {
            status: 'FAILED',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            error: 'Provider requested an unadvertised tool',
            ...modelMeta(),
          };
        // DeepSeek requires reasoning_content to be passed through on all assistant
        // turns whenever tools are enabled, including ordinary text-only turns.
        // DeepSeek's tool-call replay requires a non-null content field.
        const assistant = { role: 'assistant', content: text || '' };
        if (reasoning) assistant.reasoning_content = reasoning;
        if (calls.length) assistant.tool_calls = asToolCalls(calls);
        if (!calls.length) {
          this.context.add(assistant);
          await this.context.flush();
          return {
            status: 'FAILED',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            error: 'Worker ended without mandatory finish call',
            text,
            ...modelMeta(),
          };
        }
        let parsed;
        try {
          parsed = calls.map((call) => {
            if (!call?.id || !call.name) throw new Error('Tool call is missing id or name');
            return safeJson(call.arguments);
          });
        } catch (error) {
          return {
            status: 'FAILED',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            error: error.message,
            ...modelMeta(),
          };
        }
        if (new Set(calls.map((call) => call.id)).size !== calls.length)
          return {
            status: 'FAILED',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            error: 'Duplicate tool call id',
            ...modelMeta(),
          };
        const finishIndex = calls.findIndex((call) => call.name === 'finish');
        if (finishIndex !== -1 && (calls.length !== 1 || !finishArgs(parsed[finishIndex])))
          return {
            status: 'FAILED',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            error: 'finish must be the sole valid tool call in a turn',
            ...modelMeta(),
          };
        // Persist only a valid assistant tool-call turn.  This ensures a repair
        // never replays an OpenAI-invalid assistant message without matching
        // tool results.
        this.context.add(assistant);
        await this.context.flush();
        let values;
        try {
          values = await this.#execute(calls, deadline.signal);
        } catch (error) {
          if (this.signal?.aborted) return { status: 'CANCELLED', turn, usage: totalUsage, costUsd: this.meter.usd, ...modelMeta() };
          if (deadline.signal.aborted)
            return {
              status: 'TIMEOUT',
              turn,
              usage: totalUsage,
              costUsd: this.meter.usd,
              error: 'Agent wall clock deadline exceeded',
              ...modelMeta(),
            };
          throw error;
        }
        if (this.signal?.aborted) return { status: 'CANCELLED', turn, usage: totalUsage, costUsd: this.meter.usd, ...modelMeta() };
        if (deadline.signal.aborted)
          return {
            status: 'TIMEOUT',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            error: 'Agent wall clock deadline exceeded',
            ...modelMeta(),
          };
        await this.progress?.({ turn, usage: totalUsage, costUsd: this.meter.usd, actions: calls.map((call) => call.name).slice(0, 32) });
        const signatures = calls.map((c) => `${c.name}:${c.arguments}`).join('|');
        const failed = values.some((v) => typeof v === 'string' && v.startsWith('TOOL_ERROR:'));
        const n = failed ? (repeated.get(signatures) ?? 0) + 1 : 0;
        if (failed) repeated.set(signatures, n);
        else repeated.delete(signatures);
        if (n >= 3)
          return {
            status: 'FAILED',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            error: 'Loop detected: identical failing tool calls repeated 3 times',
            ...modelMeta(),
          };
        for (let i = 0; i < calls.length; i++) {
          const value = values[i];
          if (calls[i].name === 'finish' && value && typeof value === 'object' && value.finish) {
            // Keep even the terminal call replay-valid.  A later manual repair
            // can then reuse this transcript without an orphan assistant call.
            this.context.addToolResult(calls[i].id, JSON.stringify(value.finish), calls[i].name);
            await this.context.flush();
            return {
              status: 'DONE',
              turn,
              usage: totalUsage,
              costUsd: this.meter.usd,
              pricingKnown: !this.meter.unknownPricing,
              model: responseModel,
              finish: value.finish,
              text,
              ...modelMeta(),
            };
          }
          this.context.addToolResult(calls[i].id, value, calls[i].name);
          await this.context.flush();
        }
      }
      return {
        status: 'BUDGET',
        turn: this.maxTurns,
        usage: totalUsage,
        costUsd: this.meter.usd,
        error: 'Maximum turns reached',
        ...modelMeta(),
      };
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', onAbort);
    }
  }
}
