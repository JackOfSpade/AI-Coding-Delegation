import { AgentContext } from './context.mjs';
import { DEFAULT_COMMAND_TIMEOUT_SEC, MAX_COMMAND_TIMEOUT_SEC, TOOL_DEFINITIONS, isReadOnlyTool } from './tools.mjs';
import { Meter, resolveModel, samePricedModel } from '../pricing.mjs';
import { OpenAIChatProvider, PROVIDER_FINISH_REASONS, ProviderError, providerFailure } from '../provider/openai-chat.mjs';
import { FAILURE_ERRORS, summarizeToolFailure, toolErrorHint } from '../failure.mjs';
import { MAX_BATCH_COMMAND_SEC } from '../timing.mjs';

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
  (value.report === undefined || (typeof value.report === 'string' && value.report.length <= 256_000)) &&
  finishList(value.concerns) &&
  finishList(value.testsRun);
const MAX_ASSISTANT_CHARS = 1_000_000;
const MAX_TOOL_CALLS = 64;
const MAX_TOOL_ARGUMENT_CHARS = 512_000;
const BASE_PROMPT_TOKEN_OVERHEAD = 256;
const MIN_REQUEST_OUTPUT_TOKENS = 16;
const MAX_REQUEST_OUTPUT_TOKENS = 16_384;
// The capability-advertised DeepSeek implementation-focus request deliberately
// uses a smaller response ceiling: it requires a tool call, where a long
// reasoning response is counterproductive. Other finite requests use their
// full affordable reservation.
const MAX_FINITE_REQUEST_OUTPUT_TOKENS = 4_096;
const CAPPED_REASONING_REMINDER = 'Continue using an allowed tool call. When complete, call finish as the sole tool call.';
const FORCED_FOCUS_CAPPED_REASONING_REMINDER = 'Continue using a required allowed tool call. Read needed input, or make the next mutation.';
// A direct write is not proof that a multi-file implementation is complete.
// A capped, tool-less response after one instead earns exactly one crash-safe
// continuation with the normal tool contract.
const CAPPED_IMPLEMENTATION_RECOVERY_REMINDER = 'Continue implementation using an allowed tool call.';
// Unlike the capped-response tail above, this projection is intentionally not
// appended to the durable transcript. It is the entire trusted request after
// that transcript can no longer fit the remaining finite budget.
const BUDGET_FINISH_RECOVERY_MESSAGE = 'Call the finish tool now.';
// A finish call that shares its turn with other calls, or whose arguments are
// invalid, is never run, and neither is anything beside it: finishing is the
// end of the job, so a turn that also mutates cannot be told apart from a
// half-formed one. Every call in that turn gets one of these fixed results (the
// transcript must answer every tool_call id) and the worker gets one retry. The
// `TOOL_ERROR:` prefix matters: a refused write_file/edit_file must not read as
// a successful direct write when a transcript is resumed. Provider-controlled
// text (names, arguments) never appears in either.
const FINISH_ALONE_CORRECTION =
  'TOOL_ERROR: finish must be the only tool call in its turn; nothing in this turn was executed; call finish alone (re-issue other calls in a separate turn first if still needed)';
const FINISH_ARGUMENTS_CORRECTION =
  'finish arguments are invalid: summary is required (1-1500 characters); concerns and testsRun are optional arrays of up to 100 strings of up to 1000 characters; report is an optional string of up to 256000 characters';
const MISSING_TOOL_RECOVERY_REMINDER =
  'Do not reply with prose only. Invoke one or more allowed non-finish tools to continue, or call finish as the sole tool call if complete.';
// A provider-controlled name never reaches a durable record or the model. The
// only text derived from it is a name from this job's own advertised set, used
// to say whether the response was a near miss (case, whitespace, or a wrapper
// such as "functions.write_file") or something unrelated.
const unadvertisedToolReminder = (advertised) =>
  `The previous response named a tool that is not available and was not run. Use only: ${[...advertised].join(', ')}. Call one of them now.`;
const unadvertisedToolHint = (name, advertised) => {
  const bare = String(name)
    .toLowerCase()
    .replace(/^(functions?|tools?)[._:/-]+/, '')
    .replace(/[^a-z_]/g, '');
  for (const known of advertised) if (bare === known || bare.startsWith(known)) return `near_miss:${known}`;
  return 'unknown';
};
const successfulDirectWriteInTranscript = (messages) => {
  for (let index = 0; index < messages.length; index++) {
    const assistant = messages[index];
    if (assistant?.role !== 'assistant' || !Array.isArray(assistant.tool_calls) || assistant.tool_calls.length === 0) continue;
    const calls = assistant.tool_calls;
    const byId = new Map(calls.map((call) => [call?.id, call]));
    if (byId.size !== calls.length || [...byId.keys()].some((id) => typeof id !== 'string')) continue;
    // Direct-write evidence is valid only inside a complete, replayable tool
    // transaction. Do not let a tool-call ID from one transaction authorize a
    // result from a later transaction that reused the same ID.
    const results = messages.slice(index + 1, index + 1 + calls.length);
    const complete =
      results.length === calls.length &&
      results.every((result) => {
        const call = byId.get(result?.tool_call_id);
        return result?.role === 'tool' && call?.function?.name === result?.name;
      }) &&
      new Set(results.map((result) => result.tool_call_id)).size === calls.length;
    if (!complete) continue;
    if (
      results.some((result) => {
        const name = byId.get(result.tool_call_id)?.function?.name;
        return (
          (name === 'write_file' || name === 'edit_file') &&
          result.elided !== true &&
          !(typeof result.content === 'string' && result.content.startsWith('TOOL_ERROR:'))
        );
      })
    )
      return true;
    index += results.length;
  }
  return false;
};
const cappedImplementationRecoveryPendingInTranscript = (messages) =>
  messages.length >= 2 &&
  messages.at(-1)?.role === 'user' &&
  messages.at(-1)?.content === CAPPED_IMPLEMENTATION_RECOVERY_REMINDER &&
  messages.at(-2)?.role === 'assistant' &&
  typeof messages.at(-2)?.content === 'string' &&
  !Object.hasOwn(messages.at(-2), 'tool_calls');
const implementationCheckpoint = (remainingTurns) => {
  const prefix = `Implementation checkpoint: ${remainingTurns} model turn${remainingTurns === 1 ? '' : 's'} remain.`;
  return `${prefix} The next response must make an allowed tool call. If necessary information remains unread, read or list it now; otherwise make a mutation immediately. Put source only in write_file.content. To avoid output caps, write one complete file per response when multiple files are material. Finish when complete.`;
};
const verifierCompletionCheckpoint = (remainingTurns) => {
  const prefix = `Completion checkpoint: ${remainingTurns} model turn${remainingTurns === 1 ? '' : 's'} remain.`;
  return `${prefix} A focused server verifier will run after finish. Do not continue exploring or rerun the verifier. If the required in-scope changes are complete, call finish now as the sole tool call. Use another tool only for an essential remaining edit or diagnosis.`;
};
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
function reserveRequestBudget(table, model, messages, tools, remainingUsd, requestOptions) {
  const spec = resolveModel(table, model);
  if (!spec) return null;
  const rates = spec.usd_per_1m;
  const worst = (kind) => Math.max(...Object.values(rates[kind] || {}).map(Number));
  const inputRate = worst('input_cache_miss'),
    outputRate = worst('output');
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return null;
  let serialized;
  try {
    serialized = JSON.stringify({ messages, tools, ...(requestOptions || {}) });
  } catch {
    return null;
  }
  // Reserve per-message/tool framing too; large conversations pay more than a
  // fixed JSON wrapper even when their textual fields are small.
  const framing = BASE_PROMPT_TOKEN_OVERHEAD + messages.length * 16 + tools.length * 64;
  const inputTokens = Buffer.byteLength(serialized, 'utf8') + framing;
  const inputUsd = (inputTokens * inputRate) / 1_000_000;
  const available = remainingUsd - inputUsd;
  const minOutputUsd = (MIN_REQUEST_OUTPUT_TOKENS * outputRate) / 1_000_000;
  if (!(available > 0)) return { inputTokens, inputUsd, minOutputUsd, maxTokens: 0 };
  const affordable = outputRate === 0 ? MAX_REQUEST_OUTPUT_TOKENS : Math.floor((available * 1_000_000) / outputRate);
  return { inputTokens, inputUsd, minOutputUsd, maxTokens: Math.min(MAX_REQUEST_OUTPUT_TOKENS, affordable) };
}

const MAX_BUDGET_DIAGNOSTIC_NUMBER = 10_000_000_000;
const safeBudgetNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_BUDGET_DIAGNOSTIC_NUMBER ? value : undefined;
function budgetReservationDiagnostic(reservation, { remainingUsd, projection, elidedToolResults }) {
  const conservativeInputTokens = reservation?.inputTokens;
  const conservativeInputUsd = reservation?.inputUsd;
  const minOutputUsd = reservation?.minOutputUsd;
  if (
    !Number.isSafeInteger(conservativeInputTokens) ||
    safeBudgetNumber(conservativeInputUsd) === undefined ||
    safeBudgetNumber(minOutputUsd) === undefined ||
    safeBudgetNumber(remainingUsd) === undefined ||
    !['raw', 'tool-elision', 'deep-tool-elision'].includes(projection) ||
    !Number.isSafeInteger(elidedToolResults) ||
    elidedToolResults < 0 ||
    elidedToolResults > 1_000_000
  )
    return undefined;
  const requiredUsd = conservativeInputUsd + minOutputUsd;
  const shortfallUsd = Math.max(0, requiredUsd - remainingUsd);
  if (safeBudgetNumber(requiredUsd) === undefined || safeBudgetNumber(shortfallUsd) === undefined) return undefined;
  return {
    conservativeInputTokens,
    conservativeInputUsd,
    minOutputTokens: MIN_REQUEST_OUTPUT_TOKENS,
    minOutputUsd,
    remainingUsd,
    requiredUsd,
    shortfallUsd,
    projection,
    elidedToolResults,
  };
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
    persistCappedFinishRecovery,
    persistBudgetFinishRecovery,
    // This value is authenticated durable job state when AgentLoop is used by
    // Core.  The transcript reminder is deliberately not authority: callers
    // may legitimately use the same prose in a task.
    cappedFinishRecovery,
    budgetFinishRecovery,
    // The manager has a focused verifier it will run after a successful
    // finish. This affects only completion steering; it never changes the
    // tools a worker may execute or exposes the verifier command to it.
    serverVerifierConfigured = false,
    // `[[absolutePrefix, label], ...]` applied to the failing call recorded when
    // the loop guard trips, so a temp or home directory never reaches a report.
    pathAliases = [],
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
    if (persistCappedFinishRecovery !== undefined && typeof persistCappedFinishRecovery !== 'function')
      throw new TypeError('persistCappedFinishRecovery must be a function');
    if (persistBudgetFinishRecovery !== undefined && typeof persistBudgetFinishRecovery !== 'function')
      throw new TypeError('persistBudgetFinishRecovery must be a function');
    if (typeof serverVerifierConfigured !== 'boolean') throw new TypeError('serverVerifierConfigured must be boolean');
    if (
      !Array.isArray(pathAliases) ||
      pathAliases.length > 16 ||
      pathAliases.some((pair) => !Array.isArray(pair) || pair.length !== 2 || pair.some((part) => typeof part !== 'string'))
    )
      throw new TypeError('pathAliases must be up to 16 [prefix, label] string pairs');
    this.pathAliases = pathAliases;
    this.provider = provider;
    this.tools = tools;
    this.context = context ?? new AgentContext();
    for (const method of ['add', 'addBatch', 'snapshot', 'flush', 'preflightAppend'])
      if (typeof this.context[method] !== 'function') throw new TypeError(`context.${method} is required`);
    for (const method of ['providerBudgetElisionSnapshots', 'providerBudgetDeepElisionSnapshots'])
      if (this.context[method] !== undefined && typeof this.context[method] !== 'function')
        throw new TypeError(`context.${method} must be a function when supplied`);
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
    this.persistCappedFinishRecovery = persistCappedFinishRecovery;
    this.persistBudgetFinishRecovery = persistBudgetFinishRecovery;
    this.cappedFinishRecovery = cappedFinishRecovery;
    this.budgetFinishRecovery = budgetFinishRecovery;
    this.serverVerifierConfigured = serverVerifierConfigured;
  }
  async #execute(calls, signal, errors = [], timings = []) {
    const result = new Array(calls.length);
    const one = async (call, i) => {
      // Reads overlap, so these are per-call figures (for the longest call), not
      // a partition of the batch's wall time.
      const startedAt = this.now();
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
        // keep the retry signal useful without reflecting untrusted text. The
        // real error is kept for the server (the loop guard records it for the
        // primary); the worker sees at most a fixed hint chosen by pattern.
        errors[i] = error;
        const hint = toolErrorHint(error);
        result[i] = hint ? `TOOL_ERROR: Tool execution failed (hint: ${hint})` : 'TOOL_ERROR: Tool execution failed';
      } finally {
        timings.push({ name: call.name, ms: Math.max(0, Math.round(this.now() - startedAt)) });
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
    const recoveryFailure = (error) => ({ status: 'FAILED', turn: 0, usage: this.meter.usage, costUsd: this.meter.usd, error });
    const recoveryState = this.cappedFinishRecovery;
    const budgetRecoveryState = this.budgetFinishRecovery;
    const recoveryTranscript = this.context.snapshot();
    // Validate lifecycle state before appending an input turn. A queued
    // recovery owns an exact durable tail; adding even a repair prompt would
    // mutate the request that the state authorizes. Direct/embedded users that
    // cannot provide an awaited durable transition callback simply do not get
    // this paid recovery path.
    if (!['queued', 'consumed', 'settled', undefined].includes(recoveryState))
      return recoveryFailure('invalid capped implementation recovery state; start a fresh job');
    if (!['queued', 'consumed', undefined].includes(budgetRecoveryState))
      return recoveryFailure('invalid budget finish recovery state; start a fresh job');
    if (recoveryState !== undefined && typeof this.persistCappedFinishRecovery !== 'function')
      return recoveryFailure('capped implementation recovery persistence is unavailable; start a fresh job');
    if (budgetRecoveryState !== undefined && typeof this.persistBudgetFinishRecovery !== 'function')
      return recoveryFailure('budget finish recovery persistence is unavailable; start a fresh job');
    if (((recoveryState !== undefined && recoveryState !== 'settled') || budgetRecoveryState !== undefined) && initial.length)
      return recoveryFailure('finish recovery cannot append a new task; start a fresh job');
    if (recoveryState === 'consumed')
      return recoveryFailure('capped implementation recovery may already have been sent; start a fresh job');
    if (budgetRecoveryState === 'consumed') return recoveryFailure('budget finish recovery may already have been sent; start a fresh job');
    if (recoveryState === 'queued' && budgetRecoveryState === 'queued')
      return recoveryFailure('multiple queued finish recoveries are not safe to resume; start a fresh job');
    if (
      recoveryState === 'queued' &&
      (!successfulDirectWriteInTranscript(recoveryTranscript) || !cappedImplementationRecoveryPendingInTranscript(recoveryTranscript))
    )
      return recoveryFailure('queued capped implementation recovery transcript is incomplete; start a fresh job');
    if (budgetRecoveryState === 'queued' && !successfulDirectWriteInTranscript(recoveryTranscript))
      return recoveryFailure('queued budget finish recovery transcript is incomplete; start a fresh job');
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
    const initialTranscript = this.context.snapshot();
    let cappedReasoningContinuationUsed = false;
    let missingToolRecoveryUsed = false;
    let unadvertisedToolRecoveryUsed = false;
    // One finish-protocol correction per run (so per round of a job): a second
    // violation is the worker's, not a fluke, and ends the round.
    let finishProtocolRecoveryUsed = false;
    // The durable lifecycle state—not a human-language transcript marker—is
    // the authority for the one post-write implementation continuation. In
    // particular, a user task equal to the reminder remains an ordinary task.
    let cappedFinishRecoveryState = recoveryState;
    let cappedFinishRecoveryUsed = cappedFinishRecoveryState !== undefined;
    let cappedFinishRecoveryPending = cappedFinishRecoveryState === 'queued';
    const settleCappedImplementationRecovery = async () => {
      if (cappedFinishRecoveryState !== 'consumed') return;
      // The provider response and every tool result must be durable before
      // this one-shot continuation becomes ordinary resolved history. A crash
      // before that transition remains fail-closed at `consumed`.
      await this.persistCappedFinishRecovery({
        action: 'provider_capped_implementation_recovery_settled',
        cappedFinishRecovery: 'settled',
      });
      cappedFinishRecoveryState = 'settled';
    };
    // This lifecycle authorizes a fixed, transcript-free terminal request.
    // It remains distinct from cappedFinishRecovery, whose exact transcript
    // tail is part of its authorization contract.
    let budgetFinishRecoveryState = budgetRecoveryState;
    let budgetFinishRecoveryUsed = budgetFinishRecoveryState !== undefined;
    let budgetFinishRecoveryPending = budgetFinishRecoveryState === 'queued';
    // This is deliberately advisory: it neither blocks tools nor infers what a
    // shell command changed.  It only notices direct, successful write tools.
    const writeCapable = this.allowedToolNames.has('write_file') || this.allowedToolNames.has('edit_file');
    // Only the official capability-advertised DeepSeek route can make the
    // early checkpoint a required-tool, non-thinking boundary. Generic finite
    // providers retain the gradual advisory cadence. Neither route narrows
    // the job's ordinary tool contract.
    const earlyFocusedWriteCapable =
      this.maxUsd !== Infinity &&
      this.provider instanceof OpenAIChatProvider &&
      this.provider.supportsForcedImplementationFocusFor?.(this.model) === true;
    const checkpointThreshold = earlyFocusedWriteCapable ? 2 : Math.max(2, Math.min(4, Math.floor(this.maxTurns / 3)));
    let completedNonWritingTurns = 0;
    let directWriteSucceeded = successfulDirectWriteInTranscript(initialTranscript);
    let implementationCheckpointUsed = false;
    // A successful write used to disable every later focus reminder. That
    // left a worker free to spend its final turns re-exploring even though the
    // manager already had a focused verifier waiting for finish. One separate
    // post-write checkpoint preserves room for essential follow-up work while
    // making the finish boundary explicit.
    let verifierCompletionCheckpointUsed = false;
    let implementationFocusPending = false;
    // A DeepSeek-focused required-tool request that exhausts its output
    // allowance before it can call a tool gets the loop's existing one
    // capped-response continuation. Keep its required-tool wire contract for
    // that one request; no other response path creates a focused retry.
    let forcedImplementationFocusContinuationPending = false;
    // A disabled-thinking DeepSeek tool-call response has no provider-issued
    // reasoning_content to replay.  DeepSeek requires an exact replay of
    // prior assistant reasoning whenever thinking is enabled, so keep the
    // remainder of this conversation non-thinking after the first focused
    // tool call instead of inventing a reasoning value or issuing an invalid
    // mixed-mode transcript.
    let deepSeekNonThinkingReplay = initialTranscript.some(
      (message) =>
        message?.role === 'assistant' &&
        message.tool_calls?.length &&
        (message.reasoning_content === undefined || message.reasoning_content === null || message.reasoning_content === ''),
    );
    let totalUsage = this.meter.usage;
    const responseModels = new Set();
    let providerFinishReason;
    const modelMeta = () => {
      const models = [...responseModels].slice(0, 16);
      return {
        requestedModel: this.model,
        responseModels: models,
        modelMismatch: models.some((model) => model !== this.model),
        ...(providerFinishReason !== undefined ? { providerFinishReason } : {}),
      };
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
        budgetCap: 'other',
        ...modelMeta(),
      };
    const deadline = new AbortController();
    const onAbort = () => deadline.abort(this.signal.reason ?? new Error('Aborted'));
    this.signal?.addEventListener('abort', onAbort, { once: true });
    if (this.signal?.aborted) deadline.abort(this.signal.reason ?? new Error('Aborted'));
    const timer = setTimeout(() => deadline.abort(new Error('Agent wall clock deadline exceeded')), this.timeoutMs);
    try {
      for (let turn = 1; turn <= this.maxTurns; turn++) {
        providerFinishReason = undefined;
        await this.context.flush();
        if (this.signal?.aborted)
          return { status: 'CANCELLED', turn: turn - 1, usage: totalUsage, costUsd: this.meter.usd, ...modelMeta() };
        if (this.now() - started > this.timeoutMs)
          return { status: 'TIMEOUT', turn: turn - 1, usage: totalUsage, costUsd: this.meter.usd, ...modelMeta() };
        let text = '',
          reasoning = '',
          calls = [],
          reasoningWasExplicitNull = false,
          reasoningWasExplicitString = false,
          responseModel,
          usageRecords = 0,
          toolCallRecords = 0,
          unauthorizedResponseModel,
          modelConflict = false;
        const usageCharges = [];
        const rawMessagesForTurn = this.context.snapshot();
        let messagesForTurn = rawMessagesForTurn;
        let maxTokens;
        // The checkpoint is advisory until this single request is actually
        // authorized. It keeps the complete job-authorized schema: counting
        // prior transactions cannot prove that every necessary input has been
        // read. On the official capability-gated DeepSeek route it requires
        // some allowed tool call and disables thinking; other OpenAI-compatible
        // providers retain advisory focus and normal replay.
        const implementationFocus = implementationFocusPending || forcedImplementationFocusContinuationPending;
        // The recovery is authorized only after a direct write has completed.
        // It deliberately retains the ordinary/full tool contract: a first
        // file write does not prove that a multi-file implementation is done.
        const budgetFinishRecovery = budgetFinishRecoveryPending;
        const forcedFocusCapable =
          this.provider instanceof OpenAIChatProvider && this.provider.supportsForcedImplementationFocusFor?.(this.model) === true;
        const forcedImplementationFocus = implementationFocus && forcedFocusCapable;
        const forcedBudgetFinishRecovery = budgetFinishRecovery && forcedFocusCapable;
        const nonThinkingDeepSeekReplay = deepSeekNonThinkingReplay && forcedFocusCapable;
        let activeToolDefinitions = budgetFinishRecovery
          ? this.toolDefinitions.filter((tool) => tool.function.name === 'finish')
          : this.toolDefinitions;
        let activeToolNames = new Set(activeToolDefinitions.map((tool) => tool.function.name));
        // DeepSeek rejects required/named tool selection while thinking is
        // enabled. Its official route explicitly advertises this capability,
        // so a single implementation focus may disable thinking and require
        // one of the complete job-authorized tool set. Once that non-thinking
        // assistant tool call is durable, retain disabled thinking for its
        // later replay. Unknown OpenAI-compatible providers retain their
        // ordinary advisory focus request untouched.
        let focusRequestOptions =
          forcedImplementationFocus || forcedBudgetFinishRecovery || nonThinkingDeepSeekReplay
            ? {
                thinking: { type: 'disabled' },
                reasoning_effort: 'none',
                ...(forcedImplementationFocus
                  ? { tool_choice: 'required' }
                  : forcedBudgetFinishRecovery
                    ? { tool_choice: { type: 'function', function: { name: 'finish' } } }
                    : {}),
              }
            : undefined;
        if (budgetFinishRecovery) messagesForTurn = [{ role: 'user', content: BUDGET_FINISH_RECOVERY_MESSAGE }];
        if (this.maxUsd !== Infinity) {
          // First reserve against the exact durable transcript.  A provider
          // projection is considered only when that unchanged request cannot
          // afford the minimum response, never as a cheaper normal path.
          let reservation = reserveRequestBudget(
            this.meter.table,
            this.model,
            messagesForTurn,
            activeToolDefinitions,
            this.maxUsd - this.meter.usd,
            focusRequestOptions,
          );
          const rejected = [];
          if (!reservation || reservation.maxTokens < MIN_REQUEST_OUTPUT_TOKENS)
            rejected.push({ reservation, projection: 'raw', elidedToolResults: 0 });
          if (!budgetFinishRecovery && (!reservation || reservation.maxTokens < MIN_REQUEST_OUTPUT_TOKENS)) {
            // Each candidate is a fresh provider-only clone.  Re-run the same
            // worst-case reservation after every single old-result elision;
            // neither the durable context nor its replayable transcript is
            // mutated to make a finite-budget request fit.
            const candidates = this.context.providerBudgetElisionSnapshots?.() ?? [];
            for (const candidate of candidates) {
              const compactReservation = reserveRequestBudget(
                this.meter.table,
                this.model,
                candidate.messages,
                activeToolDefinitions,
                this.maxUsd - this.meter.usd,
                focusRequestOptions,
              );
              if (!compactReservation || compactReservation.maxTokens < MIN_REQUEST_OUTPUT_TOKENS) {
                rejected.push({
                  reservation: compactReservation,
                  projection: 'tool-elision',
                  elidedToolResults: candidate.elidedToolResults ?? 0,
                });
                continue;
              }
              messagesForTurn = candidate.messages;
              reservation = compactReservation;
              await this.progress?.({ turn, action: 'provider_context_budget_elided' });
              break;
            }
          }
          if (!budgetFinishRecovery && (!reservation || reservation.maxTokens < MIN_REQUEST_OUTPUT_TOKENS)) {
            // The configured newest-result retention has already been tried in
            // full above.  As a last provider-only fallback, retain the newest
            // complete assistant transaction but progressively elide older
            // results.  The durable replay transcript remains unchanged.
            const candidates = this.context.providerBudgetDeepElisionSnapshots?.() ?? [];
            for (const candidate of candidates) {
              const compactReservation = reserveRequestBudget(
                this.meter.table,
                this.model,
                candidate.messages,
                activeToolDefinitions,
                this.maxUsd - this.meter.usd,
                focusRequestOptions,
              );
              if (!compactReservation || compactReservation.maxTokens < MIN_REQUEST_OUTPUT_TOKENS) {
                rejected.push({
                  reservation: compactReservation,
                  projection: 'deep-tool-elision',
                  elidedToolResults: candidate.elidedToolResults ?? 0,
                });
                continue;
              }
              messagesForTurn = candidate.messages;
              reservation = compactReservation;
              await this.progress?.({ turn, action: 'provider_context_budget_elided' });
              break;
            }
          }
          if (!reservation || reservation.maxTokens < MIN_REQUEST_OUTPUT_TOKENS) {
            const remainingUsd = this.maxUsd - this.meter.usd;
            // The normal durable transcript and every permitted provider-only
            // projection have failed. A successful direct write still needs a
            // mandatory finish, but only the current available logical turn
            // may exchange the exhausted transcript for this fixed trusted
            // request. Do not append it: the durable lifecycle state is the
            // resume authority.
            let budgetFinishReservation;
            const terminalBudgetFinishRecovery =
              directWriteSucceeded &&
              !cappedFinishRecoveryUsed &&
              !budgetFinishRecoveryUsed &&
              typeof this.persistBudgetFinishRecovery === 'function';
            if (terminalBudgetFinishRecovery) {
              const finishOnlyTools = this.toolDefinitions.filter((tool) => tool.function.name === 'finish');
              const forcedBudgetFinishRecovery = forcedFocusCapable;
              const finishOnlyOptions = forcedBudgetFinishRecovery
                ? {
                    thinking: { type: 'disabled' },
                    reasoning_effort: 'none',
                    tool_choice: { type: 'function', function: { name: 'finish' } },
                  }
                : undefined;
              budgetFinishReservation = reserveRequestBudget(
                this.meter.table,
                this.model,
                [{ role: 'user', content: BUDGET_FINISH_RECOVERY_MESSAGE }],
                finishOnlyTools,
                remainingUsd,
                finishOnlyOptions,
              );
              if (budgetFinishReservation?.maxTokens >= MIN_REQUEST_OUTPUT_TOKENS) {
                // Queue before the provider boundary. On a crash before the
                // next transition, a resume receives this same bounded fixed
                // projection; it never reconstructs task or transcript text.
                await this.persistBudgetFinishRecovery({
                  action: 'provider_budget_finish_recovery_queued',
                  budgetFinishRecovery: 'queued',
                });
                budgetFinishRecoveryState = 'queued';
                budgetFinishRecoveryUsed = true;
                budgetFinishRecoveryPending = true;
                messagesForTurn = [{ role: 'user', content: BUDGET_FINISH_RECOVERY_MESSAGE }];
                activeToolDefinitions = finishOnlyTools;
                activeToolNames = new Set(['finish']);
                focusRequestOptions = finishOnlyOptions;
                reservation = budgetFinishReservation;
                maxTokens = Math.min(reservation.maxTokens, 128);
              }
            }
            if (!(budgetFinishRecoveryPending && reservation?.maxTokens >= MIN_REQUEST_OUTPUT_TOKENS)) {
              const cheapest = rejected
                .map((candidate) => ({
                  ...candidate,
                  diagnostic: budgetReservationDiagnostic(candidate.reservation, { remainingUsd, ...candidate }),
                }))
                .filter((candidate) => candidate.diagnostic)
                .sort((left, right) => left.diagnostic.requiredUsd - right.diagnostic.requiredUsd)[0]?.diagnostic;
              if (cheapest) await this.progress?.({ turn, action: 'budget_reservation_exhausted', budgetReservation: cheapest });
              return {
                status: 'BUDGET',
                turn: turn - 1,
                usage: totalUsage,
                costUsd: this.meter.usd,
                pricingKnown: true,
                error: 'Remaining budget cannot cover a conservative prompt and minimum response reservation',
                budgetCap: 'reservation',
                ...(cheapest ? { budgetReservation: cheapest } : {}),
                ...modelMeta(),
              };
            }
          }
          maxTokens =
            budgetFinishRecovery || budgetFinishRecoveryPending
              ? Math.min(reservation.maxTokens, 128)
              : (maxTokens ??
                (forcedImplementationFocus ? Math.min(reservation.maxTokens, MAX_FINITE_REQUEST_OUTPUT_TOKENS) : reservation.maxTokens));
        }
        try {
          // A request can spend its whole provider-attempt timeout without a
          // streamed token or tool result. Mark that safe waiting state before
          // entering the adapter so callers do not mistake a live request for
          // a frozen worker. No endpoint, payload, or provider text is kept.
          // A finish reason describes only the immediately preceding provider
          // response. Clear the durable diagnostic before the next request is
          // in flight so status cannot claim that an older response is still
          // current. Null is an explicit reset sentinel for JobManager; it is
          // never a provider value and is not retained in the job record.
          if (implementationFocusPending) {
            // The durable checkpoint was appended after a completed tool
            // transaction. Mark the restricted paid request separately so a
            // crashed observer can tell it was authorized before the call.
            await this.progress?.({ turn, action: 'implementation_focus' });
            implementationFocusPending = false;
          }
          // The capped continuation inherits a focus contract only once. Clear
          // it immediately before the provider request so any later ordinary
          // continuation or completed tool transaction restores the full
          // schema and normal request options.
          if (forcedImplementationFocusContinuationPending) forcedImplementationFocusContinuationPending = false;
          // Consume this immediately before the request. The one authorized
          // post-write implementation continuation may use normal tools, but
          // a crash after this boundary must still fail closed rather than
          // replaying a possibly billed provider POST.
          if (cappedFinishRecoveryPending) {
            // Persist the irreversible transition before the network boundary.
            // If this process dies after this point, a resumed worker sees
            // "consumed" and refuses to replay an ambiguously billed POST.
            await this.persistCappedFinishRecovery({ action: 'provider_capped_finish_recover', cappedFinishRecovery: 'consumed' });
            cappedFinishRecoveryState = 'consumed';
            cappedFinishRecoveryPending = false;
          }
          if (budgetFinishRecoveryPending) {
            // Consume immediately before POST. A reconstructed worker seeing
            // this state must fail closed because the fixed request may have
            // been billed even if no stream event reached this process.
            await this.persistBudgetFinishRecovery({
              action: 'provider_budget_finish_recover',
              budgetFinishRecovery: 'consumed',
            });
            budgetFinishRecoveryState = 'consumed';
            budgetFinishRecoveryPending = false;
          }
          await this.progress?.({ turn, action: 'provider_request_pending', providerFinishReason: null });
          for await (const event of this.provider.chat({
            messages: messagesForTurn,
            tools: activeToolDefinitions,
            model: this.model,
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
            ...(this.maxUsd !== Infinity ? { retryLimit: 0 } : {}),
            ...(focusRequestOptions || {}),
            signal: deadline.signal,
          })) {
            if (
              !event ||
              typeof event !== 'object' ||
              Array.isArray(event) ||
              (event.text !== undefined && typeof event.text !== 'string') ||
              (event.reasoning !== undefined && event.reasoning !== null && typeof event.reasoning !== 'string') ||
              (event.model !== undefined && !validMetadata(event.model)) ||
              (event.modelConflict !== undefined && typeof event.modelConflict !== 'boolean') ||
              (event.providerFinishReason !== undefined && !PROVIDER_FINISH_REASONS.has(event.providerFinishReason)) ||
              (event.toolCalls !== undefined &&
                (!Array.isArray(event.toolCalls) ||
                  event.toolCalls.length > MAX_TOOL_CALLS ||
                  event.toolCalls.some((call) => !validProviderCall(call))))
            )
              throw new Error('Provider yielded invalid event');
            if (event.providerFinishReason !== undefined) {
              providerFinishReason = event.providerFinishReason;
              await this.progress?.({ turn, providerFinishReason });
            }
            text += event.text ?? '';
            if (event.reasoning === null) {
              // Some OpenAI-compatible streaming implementations send null as
              // an incremental placeholder before or after reasoning text.
              // A string fragment is the authoritative replay value, so null
              // must not make an otherwise exact transcript fail mid-stream.
              reasoningWasExplicitNull = true;
            } else if (event.reasoning !== undefined) {
              reasoningWasExplicitString = true;
              reasoning += event.reasoning;
            }
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
          if (error instanceof ProviderError) {
            const failure = providerFailure(error);
            return {
              status: failure?.kind === 'attempt_timeout' ? 'TIMEOUT' : 'FAILED',
              turn: turn - 1,
              usage: totalUsage,
              costUsd: this.meter.usd,
              pricingKnown: !this.meter.unknownPricing,
              error: error.message,
              ...(failure ? { providerFailure: failure } : {}),
              ...modelMeta(),
            };
          }
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
            budgetCap: 'other',
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
            // A finite budget with an unpriced response trips here too; only a real overspend is the USD cap.
            budgetCap: this.meter.usd > this.maxUsd ? 'usd' : 'other',
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
        const unadvertisedCall = calls.find((call) => !activeToolNames.has(call.name));
        if (unadvertisedCall) {
          // Neither provider-supplied names nor arguments are safe durable
          // diagnostics: printable metadata can still contain source or a
          // secret-looking value. Keep only a fixed category.
          const hint = unadvertisedToolHint(unadvertisedCall.name, activeToolNames);
          // One bounded, execute-nothing correction. The response was already
          // metered above, nothing from it is replayed or run, and every
          // reservation/timeout check still applies to the next request. It
          // is withheld from the finish-only and capped-continuation
          // recoveries, which stay fail-closed.
          const recoverUnadvertisedTool =
            !unadvertisedToolRecoveryUsed &&
            !budgetFinishRecovery &&
            !cappedFinishRecoveryUsed &&
            turn < this.maxTurns &&
            usageRecords === 1;
          if (recoverUnadvertisedTool) {
            unadvertisedToolRecoveryUsed = true;
            this.context.add({ role: 'user', content: unadvertisedToolReminder(activeToolNames) });
            await this.context.flush();
            await this.progress?.({ turn, action: `provider_unadvertised_tool_recover:${hint}` });
            continue;
          }
          await this.progress?.({ turn, action: `provider_unadvertised_tool:${hint}` });
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
        }
        // DeepSeek requires exact reasoning_content replay when the provider
        // supplied it, including an explicit null or empty string from a
        // non-thinking tool call. Tool-call replay also requires a non-null
        // content field.
        const assistant = { role: 'assistant', content: text || '' };
        if (reasoningWasExplicitString) assistant.reasoning_content = reasoning;
        else if (reasoningWasExplicitNull) assistant.reasoning_content = null;
        if (calls.length) assistant.tool_calls = asToolCalls(calls);
        // Never invent an empty reasoning_content to make a disabled-thinking
        // tool response look like a thinking response.  Once this exact
        // replay shape is durable, subsequent official DeepSeek requests must
        // remain non-thinking for the rest of this conversation.
        if (calls.length && !reasoning) deepSeekNonThinkingReplay = true;
        if (!calls.length) {
          // A direct source mutation is durable, but a provider can cap before
          // the next allowed tool call while the worker is still planning a
          // later file. Permit one—not a retry loop—crash-safe implementation
          // continuation when the provider conclusively reports `length`.
          // Persist authenticated lifecycle state first, then the response
          // and trusted reminder before that next paid call; an interrupted
          // persistence window fails closed. The following request keeps the
          // normal tool schema and any existing DeepSeek non-thinking replay.
          const cappedFinishRecovery =
            directWriteSucceeded &&
            !cappedFinishRecoveryUsed &&
            typeof this.persistCappedFinishRecovery === 'function' &&
            turn < this.maxTurns &&
            providerFinishReason === 'length' &&
            maxTokens !== undefined &&
            usageRecords === 1;
          if (cappedFinishRecovery) {
            // Record the one-shot lifecycle transition before changing the
            // transcript. A crash in either persistence window is fail-closed:
            // a later resume must see both this authenticated state and the
            // exact internal tail before it can send the one allowed
            // implementation-continuation request.
            await this.persistCappedFinishRecovery({ action: 'provider_capped_finish_recovery_queued', cappedFinishRecovery: 'queued' });
            cappedFinishRecoveryState = 'queued';
            cappedFinishRecoveryUsed = true;
            await this.context.addBatch([assistant, { role: 'user', content: CAPPED_IMPLEMENTATION_RECOVERY_REMINDER }]);
            await this.context.flush();
            cappedFinishRecoveryPending = true;
            continue;
          }
          // A finite-budget model can cap before its first tool call. A
          // terminal provider `length` signal is conclusive even when the
          // partial response contains ordinary planning prose. This is a
          // completed, billable response (not a replayable timeout), so allow
          // exactly one durable continuation when the evidence is unambiguous.
          const cappedBeforeToolCall =
            !directWriteSucceeded &&
            !cappedFinishRecoveryUsed &&
            !cappedReasoningContinuationUsed &&
            turn < this.maxTurns &&
            maxTokens !== undefined &&
            usageRecords === 1 &&
            providerFinishReason === 'length';
          if (cappedBeforeToolCall) {
            cappedReasoningContinuationUsed = true;
            await this.context.addBatch([
              assistant,
              { role: 'user', content: forcedImplementationFocus ? FORCED_FOCUS_CAPPED_REASONING_REMINDER : CAPPED_REASONING_REMINDER },
            ]);
            if (forcedImplementationFocus) forcedImplementationFocusContinuationPending = true;
            await this.progress?.({ turn, usage: totalUsage, costUsd: this.meter.usd, action: 'provider_output_capped_continue' });
            continue;
          }
          // A capped response may resume with an uncapped,
          // text-only answer instead of the required tool call.  Preserve that
          // paid response and permit one explicit recovery turn, but never
          // broaden the existing capped-response continuation into a retry
          // loop.  The next iteration retains all normal reservation,
          // timeout, accounting, and provider-failure checks.
          const recoverMissingTool =
            !directWriteSucceeded &&
            !cappedFinishRecoveryUsed &&
            cappedReasoningContinuationUsed &&
            !missingToolRecoveryUsed &&
            turn < this.maxTurns &&
            maxTokens !== undefined &&
            usageRecords === 1 &&
            providerFinishReason !== 'length';
          if (recoverMissingTool) {
            missingToolRecoveryUsed = true;
            await this.context.addBatch([assistant, { role: 'user', content: MISSING_TOOL_RECOVERY_REMINDER }]);
            // Do not allow a second paid request to race durable recovery
            // state. In particular, an append failure must not make this a
            // hidden provider retry.
            await this.context.flush();
            await this.progress?.({ turn, usage: totalUsage, costUsd: this.meter.usd, action: 'provider_missing_tool_recover' });
            continue;
          }
          // The bounded continuation above has already paid for one extra
          // chance to produce an allowed tool call. A second cap is terminal,
          // not a safe basis for another provider POST; make that distinction
          // visible to callers instead of misclassifying it as ordinary prose.
          const outputCapRecoveryExhausted =
            (cappedReasoningContinuationUsed || cappedFinishRecoveryUsed) &&
            maxTokens !== undefined &&
            usageRecords === 1 &&
            providerFinishReason === 'length';
          this.context.add(assistant);
          await this.context.flush();
          await settleCappedImplementationRecovery();
          return {
            status: 'FAILED',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            // A closed, worker-side cause that offload_continue may resume. A
            // content-filter stop is the provider's, and would simply recur.
            ...(providerFinishReason === 'content_filter' ? {} : { failureKind: outputCapRecoveryExhausted ? 'output-cap' : 'no-finish' }),
            error: outputCapRecoveryExhausted ? FAILURE_ERRORS['output-cap'] : FAILURE_ERRORS['no-finish'],
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
        const finishNotAlone = finishIndex !== -1 && calls.length !== 1;
        const finishInvalid = finishIndex !== -1 && !finishArgs(parsed[finishIndex]);
        if (finishNotAlone || finishInvalid) {
          // One bounded, execute-nothing correction, like the unadvertised-tool
          // one above. The response was already metered, nothing in it runs, the
          // retry takes a normal turn (so it counts against maxTurns, and needs
          // one left) and keeps every reservation, timeout and accounting check.
          // The finish-only budget recovery stays fail-closed.
          const recoverFinishProtocol = !finishProtocolRecoveryUsed && !budgetFinishRecovery && turn < this.maxTurns;
          if (recoverFinishProtocol) {
            finishProtocolRecoveryUsed = true;
            const correction = finishNotAlone
              ? `${FINISH_ALONE_CORRECTION}${finishInvalid ? `; also, ${FINISH_ARGUMENTS_CORRECTION}` : ''}`
              : `TOOL_ERROR: ${FINISH_ARGUMENTS_CORRECTION}; nothing in this turn was executed; call finish alone again`;
            // One atomic, durable batch: a crash can never leave an assistant
            // tool_call without its result.
            await this.context.addBatch([
              assistant,
              ...calls.map((call) => ({ role: 'tool', tool_call_id: call.id, name: call.name, content: correction })),
            ]);
            await this.context.flush();
            await settleCappedImplementationRecovery();
            await this.progress?.({ turn, usage: totalUsage, costUsd: this.meter.usd, action: 'finish_protocol_recover' });
            continue;
          }
          return {
            status: 'FAILED',
            turn,
            usage: totalUsage,
            costUsd: this.meter.usd,
            pricingKnown: !this.meter.unknownPricing,
            model: responseModel,
            // A worker-side cause offload_continue may resume (the work is in the workspace).
            failureKind: 'finish-protocol',
            error: FAILURE_ERRORS['finish-protocol'],
            ...modelMeta(),
          };
        }
        // Persist only a valid assistant tool-call turn.  This ensures a repair
        // never replays an OpenAI-invalid assistant message without matching
        // tool results.
        this.context.add(assistant);
        await this.context.flush();
        let values;
        const toolErrors = new Array(calls.length);
        const toolTimings = [];
        // Marks the start of tool time: nothing else is reported between the
        // provider's answer and the tools' results, so without it a long
        // command is indistinguishable from a stuck round. It carries no
        // `action`/`actions`, which would overwrite the job's recent actions.
        // Commands run one after another, so the batch's limit is the sum of theirs.
        const commandLimits = calls.flatMap((call, i) =>
          call.name === 'run_command'
            ? [
                Number.isSafeInteger(parsed[i]?.timeoutSec)
                  ? Math.min(MAX_COMMAND_TIMEOUT_SEC, Math.max(1, parsed[i].timeoutSec))
                  : DEFAULT_COMMAND_TIMEOUT_SEC,
              ]
            : [],
        );
        const commandTimeoutSec = commandLimits.length
          ? Math.min(
              MAX_BATCH_COMMAND_SEC,
              commandLimits.reduce((sum, limit) => sum + limit, 0),
            )
          : undefined;
        // `finish` is the sole call of its turn and returns at once: no marker.
        if (finishIndex === -1)
          await this.progress?.({
            turn,
            phase: 'tool',
            tools: calls.map((call) => call.name).slice(0, 8),
            ...(commandTimeoutSec ? { commandTimeoutSec } : {}),
          });
        try {
          values = await this.#execute(calls, deadline.signal, toolErrors, toolTimings);
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
        await this.progress?.({
          turn,
          usage: totalUsage,
          costUsd: this.meter.usd,
          actions: calls.map((call) => call.name).slice(0, 32),
          // `finish` is not worker tool time.
          toolTimings: toolTimings.filter((timing) => timing.name !== 'finish').slice(0, 32),
        });
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
            failureKind: 'tool-loop',
            error: FAILURE_ERRORS['tool-loop'],
            toolFailure: summarizeToolFailure({
              calls,
              parsed,
              values,
              errors: toolErrors,
              turn,
              repeats: n,
              pathAliases: this.pathAliases,
            }),
            ...modelMeta(),
          };
        for (let i = 0; i < calls.length; i++) {
          const value = values[i];
          if (calls[i].name === 'finish' && value && typeof value === 'object' && value.finish) {
            // Keep even the terminal call replay-valid.  A later manual repair
            // can then reuse this transcript without an orphan assistant call.
            this.context.addToolResult(calls[i].id, JSON.stringify(value.finish), calls[i].name);
            await this.context.flush();
            await settleCappedImplementationRecovery();
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
        await settleCappedImplementationRecovery();
        // Place this fixed, trusted reminder only after every tool result in
        // the transaction is durable.  A persistence failure therefore stops
        // the loop before another paid request can see a partial checkpoint.
        const successfulDirectWrite = calls.some(
          (call, index) =>
            (call.name === 'write_file' || call.name === 'edit_file') &&
            !(typeof values[index] === 'string' && values[index].startsWith('TOOL_ERROR:')),
        );
        directWriteSucceeded ||= successfulDirectWrite;
        if (this.serverVerifierConfigured && successfulDirectWrite && !verifierCompletionCheckpointUsed && turn < this.maxTurns) {
          verifierCompletionCheckpointUsed = true;
          this.context.add({ role: 'user', content: verifierCompletionCheckpoint(this.maxTurns - turn) });
          await this.context.flush();
          await this.progress?.({ turn, action: 'verifier_completion_checkpoint' });
          // Keep the official DeepSeek route at its focused tool-call boundary
          // for this next response. The complete schema remains available: a
          // worker may still make an essential edit, but cannot spend the turn
          // on narrative instead of either acting or finishing.
          if (this.maxUsd !== Infinity) implementationFocusPending = true;
        }
        if (!successfulDirectWrite) completedNonWritingTurns++;
        if (
          writeCapable &&
          !directWriteSucceeded &&
          !implementationCheckpointUsed &&
          this.maxTurns >= 4 &&
          completedNonWritingTurns >= checkpointThreshold &&
          turn < this.maxTurns
        ) {
          implementationCheckpointUsed = true;
          this.context.add({ role: 'user', content: implementationCheckpoint(this.maxTurns - turn) });
          await this.context.flush();
          await this.progress?.({ turn, action: 'implementation_checkpoint' });
          // This is only activated for a finite priced write job.  Unlimited
          // callers retain the normal complete schema on every turn.
          if (this.maxUsd !== Infinity) implementationFocusPending = true;
        }
      }
      return {
        status: 'BUDGET',
        turn: this.maxTurns,
        usage: totalUsage,
        costUsd: this.meter.usd,
        error: 'Maximum turns reached',
        budgetCap: 'turns',
        ...modelMeta(),
      };
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', onAbort);
    }
  }
}
