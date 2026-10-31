import {
  anthropicContentChars,
  anthropicContentMatchesAssistant,
  cloneAnthropicContent,
  validAnthropicContent,
} from '../anthropic-content.mjs';
import { cloneOpenAIReasoning, openAIReasoningChars, validOpenAIReasoning } from '../openai-reasoning.mjs';
import { MAX_MESSAGE_CHARS, MAX_TOOL_ARGUMENT_CHARS, MAX_TOOL_CALLS, validToolIdentifier } from '../transcript-limits.mjs';

/** Append-only conversation store.  Only old bulky tool output is replaced,
 * preserving message order (and therefore provider prefix-cache locality). */
export class AgentContext {
  constructor(
    messages = [],
    { maxToolChars = 96_000, keepRecentToolResults = 8, maxTranscriptChars = 2_000_000, onAppend, onAppendBatch } = {},
  ) {
    if (
      !Array.isArray(messages) ||
      !Number.isSafeInteger(maxToolChars) ||
      maxToolChars < 0 ||
      !Number.isSafeInteger(keepRecentToolResults) ||
      keepRecentToolResults < 0 ||
      !Number.isSafeInteger(maxTranscriptChars) ||
      maxTranscriptChars < 1 ||
      (onAppend !== undefined && typeof onAppend !== 'function') ||
      (onAppendBatch !== undefined && typeof onAppendBatch !== 'function')
    )
      throw new TypeError('invalid context options');
    const checked = validateTranscript(messages);
    this.messages = checked.messages.map((value) => cloneMessage(value, { includeElided: true }));
    this.trimmedIncomplete = checked.trimmedIncomplete;
    this.maxToolChars = maxToolChars;
    this.keepRecentToolResults = keepRecentToolResults;
    this.maxTranscriptChars = maxTranscriptChars;
    this.onAppend = onAppend;
    this.onAppendBatch = onAppendBatch;
    this.pending = Promise.resolve();
    this.pendingFailure = null;
    this.elide();
    this.assertBounded();
  }
  add(message) {
    validateMessageShape(message);
    // Elision mutates tool records. Stage it on owned clones so a rejected
    // oversized append cannot silently alter an already durable transcript.
    const candidate = this.#staged([message]);
    const stored = candidate.at(-1);
    const inbound = cloneMessage(message, { includeElided: true });
    // A single append is also a durability boundary.  Do not make it visible
    // in memory until its callback succeeds: otherwise a failed disk write
    // leaves a later provider call with state it can never resume from.
    const action = async () => {
      // Re-stage against the committed transcript after prior queued appends.
      // This retains ordering when callers enqueue multiple records before a
      // flush, while a failed predecessor never leaks into live state.
      const next = this.#staged([inbound]);
      if (this.onAppend) await this.onAppend(cloneMessage(next.at(-1), { includeElided: true }));
      this.messages = next;
    };
    const queued = this.pending.then(action);
    this.pending = queued.catch((error) => {
      this.pendingFailure ??= error;
    });
    return cloneMessage(stored, { includeElided: true });
  }
  addToolResult(toolCallId, content, name) {
    return this.add({ role: 'tool', tool_call_id: toolCallId, name, content: String(content) });
  }
  /**
   * Persist and commit an initial (or otherwise indivisible) turn.  Unlike
   * add(), the live transcript changes only after the durable batch callback
   * succeeds, so a rejected second record cannot leave a system-only prefix.
   */
  addBatch(messages) {
    if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('messages must be a non-empty array');
    const inbound = messages.map((message) => {
      validateMessageShape(message);
      return cloneMessage(message, { includeElided: true });
    });
    const action = async () => {
      const prior = this.messages.length;
      const checked = validateTranscript([...this.messages.map((value) => cloneMessage(value, { includeElided: true })), ...inbound]);
      if (checked.trimmedIncomplete) throw new Error('Conversation transcript contains an incomplete tool-call transaction');
      const candidate = checked.messages.map((value) => cloneMessage(value, { includeElided: true }));
      elideMessages(candidate, this.maxToolChars, this.keepRecentToolResults);
      if (transcriptChars(candidate) > this.maxTranscriptChars) throw new Error('Conversation transcript exceeds size limit');
      const durable = candidate.slice(prior).map((value) => cloneMessage(value, { includeElided: true }));
      if (this.onAppendBatch) await this.onAppendBatch(durable.map((value) => cloneMessage(value, { includeElided: true })));
      else if (this.onAppend) {
        // A legacy one-record callback cannot safely emulate an atomic batch.
        if (durable.length !== 1) throw new Error('context batch persistence callback is required');
        await this.onAppend(cloneMessage(durable[0], { includeElided: true }));
      }
      this.messages = candidate;
      this.trimmedIncomplete = false;
      return durable.map((value) => cloneMessage(value, { includeElided: true }));
    };
    const queued = this.pending.then(action);
    // The caller receives this failure, but it did not change live state, so
    // a retry can enqueue a fresh atomic batch instead of inheriting a stale
    // rejected promise from a batch that was never committed.
    this.pending = queued.catch(() => {});
    return queued;
  }
  // Validate a complete batch without touching the live/durable transcript.
  // The shallow copies keep staging elision from mutating an existing tool
  // result when a later candidate proves invalid or too large.
  preflightAppend(messages) {
    if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
    const candidate = new AgentContext([...this.messages, ...messages], {
      maxToolChars: this.maxToolChars,
      keepRecentToolResults: this.keepRecentToolResults,
      maxTranscriptChars: this.maxTranscriptChars,
    });
    // Constructor recovery intentionally trims one crash-residue transaction
    // at EOF. A caller supplying a new batch is different: accepting that
    // batch would later persist an orphan assistant call one message at a time.
    if (candidate.trimmedIncomplete) throw new Error('Conversation transcript contains an incomplete tool-call transaction');
  }
  async flush() {
    await this.pending;
    if (this.pendingFailure) {
      const error = this.pendingFailure;
      this.pendingFailure = null;
      throw error;
    }
  }
  totalChars() {
    return transcriptChars(this.messages);
  }
  // Stage `extra` after the live transcript on owned clones, applying
  // retention elision and the size limit without touching live state.
  #staged(extra) {
    const next = [...this.messages, ...extra].map((value) => cloneMessage(value, { includeElided: true }));
    elideMessages(next, this.maxToolChars, this.keepRecentToolResults);
    if (transcriptChars(next) > this.maxTranscriptChars) throw new Error('Conversation transcript exceeds size limit');
    return next;
  }
  assertBounded() {
    if (this.totalChars() > this.maxTranscriptChars) throw new Error('Conversation transcript exceeds size limit');
  }
  elide() {
    elideMessages(this.messages, this.maxToolChars, this.keepRecentToolResults);
  }
  snapshot() {
    return this.messages.map((message) => cloneMessage(message, { includeElided: true }));
  }
  /**
   * Yield provider-only transcript variants that progressively replace the
   * oldest bulky tool results with the same neutral marker used by durable
   * transcript retention.  This never changes this.messages (or invokes a
   * persistence callback): callers may use one variant for a single request
   * without changing what a later repair can replay.
   *
   * Every result of the newest complete assistant tool-call transaction is
   * intentionally never a candidate. keepRecentToolResults additionally
   * retains that many newer *older* results, while assistant reasoning, calls,
   * identifiers, and message order remain byte-for-byte cloned from durable
   * state.
   */
  *providerBudgetElisionSnapshots() {
    const plan = this.#elisionPlan();
    const compact = plan.source.map((message) => cloneMessage(message, { includeElided: true }));
    yield* elideProgressively(compact, plan.ordinaryEligible, 0);
  }
  /**
   * Yield a second, provider-only budget fallback after every ordinary
   * retention-preserving projection has already proved unaffordable.  It
   * starts from the most compact ordinary projection, then relaxes that
   * quality retention oldest-first. The ordinary projection was already tried
   * by the caller, so this yields only strictly deeper candidates. The newest
   * complete assistant tool-call transaction is never touched: a model must
   * receive every result needed to answer its most recently issued calls.
   *
   * Like providerBudgetElisionSnapshots(), this is only a request projection.
   * It neither alters durable state nor calls persistence callbacks.
   */
  *providerBudgetDeepElisionSnapshots() {
    const plan = this.#elisionPlan();
    if (!plan.protectedIndexes) return;
    const { source, olderToolIndexes, ordinaryEligible } = plan;
    const compact = source.map((message) => cloneMessage(message, { includeElided: true }));
    for (const index of ordinaryEligible) compact[index].content = toolOutputElisionMarker(compact[index].content.length);
    yield* elideProgressively(
      compact,
      olderToolIndexes.filter((index) => !ordinaryEligible.has(index) && canElideToolResult(source[index])),
      ordinaryEligible.size,
    );
  }
  #elisionPlan() {
    const source = this.snapshot();
    const protectedIndexes = newestCompleteToolTransactionIndexes(source);
    const skip = protectedIndexes ?? new Set();
    const olderToolIndexes = source.flatMap((message, index) => (message.role === 'tool' && !skip.has(index) ? [index] : []));
    const ordinaryEligible = new Set(
      olderToolIndexes
        .slice(0, Math.max(0, olderToolIndexes.length - this.keepRecentToolResults))
        .filter((index) => canElideToolResult(source[index])),
    );
    return { source, protectedIndexes, olderToolIndexes, ordinaryEligible };
  }
}
function* elideProgressively(compact, indexes, elidedToolResults) {
  for (const index of indexes) {
    compact[index].content = toolOutputElisionMarker(compact[index].content.length);
    elidedToolResults++;
    yield { messages: compact.map((message) => cloneMessage(message, { includeElided: true })), elidedToolResults };
  }
}
const toolOutputElisionMarker = (chars) => `[tool output elided: ${chars} chars; request a narrower read if needed]`;
const canElideToolResult = (message) =>
  message.elided !== true && toolOutputElisionMarker(message.content.length).length < message.content.length;
function newestCompleteToolTransactionIndexes(messages) {
  let newest;
  for (let index = 0; index < messages.length; index++) {
    const assistant = messages[index];
    if (assistant.role !== 'assistant' || !Array.isArray(assistant.tool_calls) || assistant.tool_calls.length === 0) continue;
    const ids = new Set(assistant.tool_calls.map((call) => call?.id));
    if (ids.size !== assistant.tool_calls.length || ids.has(undefined)) continue;
    const results = messages.slice(index + 1, index + 1 + assistant.tool_calls.length);
    if (
      results.length !== assistant.tool_calls.length ||
      results.some((result) => result?.role !== 'tool' || !ids.has(result.tool_call_id)) ||
      new Set(results.map((result) => result.tool_call_id)).size !== ids.size
    )
      continue;
    newest = new Set(results.map((_result, offset) => index + 1 + offset));
    index += results.length;
  }
  return newest;
}
const transcriptChars = (messages) => messages.reduce((total, message) => total + messageChars(message), 0);
function messageChars(message) {
  return typeof message?.content === 'string'
    ? message.content.length +
        (typeof message.reasoning_content === 'string' ? message.reasoning_content.length : 0) +
        anthropicContentChars(message.anthropic_content) +
        openAIReasoningChars(message.openai_reasoning) +
        (Array.isArray(message.tool_calls)
          ? message.tool_calls.reduce((n, call) => n + String(call?.function?.arguments ?? '').length, 0)
          : 0)
    : typeof message?.reasoning_content === 'string'
      ? message.reasoning_content.length + anthropicContentChars(message.anthropic_content) + openAIReasoningChars(message.openai_reasoning)
      : anthropicContentChars(message?.anthropic_content) + openAIReasoningChars(message?.openai_reasoning);
}
function elideMessages(messages, maxToolChars, keepRecentToolResults) {
  const tools = messages.map((message, index) => [message, index]).filter(([message]) => message.role === 'tool' && !message.elided);
  const protectedIndexes = newestCompleteToolTransactionIndexes(messages) ?? new Set();
  const olderTools = tools.filter(([, index]) => !protectedIndexes.has(index));
  let chars = tools.reduce((total, [message]) => total + (message.content?.length ?? 0), 0);
  // A current tool-call transaction is an atomic provider replay unit. Its
  // results may exceed maxToolChars together, but splitting or eliding one
  // would make the preceding assistant call unreplayable. Retention applies
  // in addition to that transaction, to the newest older results.
  for (const [message] of olderTools.slice(0, Math.max(0, olderTools.length - keepRecentToolResults))) {
    if (chars <= maxToolChars) break;
    if (!canElideToolResult(message)) continue;
    const original = message.content ?? '';
    message.content = toolOutputElisionMarker(original.length);
    message.elided = true;
    chars -= original.length - message.content.length;
  }
}

/**
 * A process can die after durable storage receives an assistant tool-call
 * record but before all results arrive. That one trailing transaction is safe
 * to discard on resume; any incomplete/mismatched transaction in the middle
 * would reorder provider state, so reject it rather than guessing.
 */
const boundedText = (value, max = MAX_MESSAGE_CHARS) => typeof value === 'string' && value.length <= max;
function cloneMessage(message, { includeElided = false } = {}) {
  if (message.role === 'system' || message.role === 'user') return { role: message.role, content: message.content };
  if (message.role === 'assistant')
    return {
      role: 'assistant',
      content: message.content,
      ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}),
      ...(message.anthropic_content !== undefined ? { anthropic_content: cloneAnthropicContent(message.anthropic_content) } : {}),
      ...(message.openai_reasoning !== undefined ? { openai_reasoning: cloneOpenAIReasoning(message.openai_reasoning) } : {}),
      ...(message.tool_calls !== undefined
        ? {
            tool_calls: message.tool_calls.map((call) => ({
              id: call.id,
              type: call.type,
              function: { name: call.function.name, arguments: call.function.arguments },
            })),
          }
        : {}),
    };
  return {
    role: 'tool',
    tool_call_id: message.tool_call_id,
    content: message.content,
    ...(message.name !== undefined ? { name: message.name } : {}),
    ...(includeElided && message.elided === true ? { elided: true } : {}),
  };
}
function validCall(call) {
  return (
    !!call &&
    call.type === 'function' &&
    validToolIdentifier(call.id, 512) &&
    validToolIdentifier(call.function?.name, 128) &&
    boundedText(call.function?.arguments, MAX_TOOL_ARGUMENT_CHARS)
  );
}
function validateMessageShape(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.role !== 'string')
    throw new Error('Conversation transcript contains an invalid message');
  if (message.role !== 'assistant' && message.openai_reasoning !== undefined)
    throw new Error('Conversation transcript has OpenAI reasoning outside an assistant message');
  if (message.role === 'system' || message.role === 'user') {
    if (!boundedText(message.content)) throw new Error('Conversation transcript has invalid content');
    return;
  }
  if (message.role === 'assistant') {
    if (
      !boundedText(message.content) ||
      (message.reasoning_content !== undefined && message.reasoning_content !== null && !boundedText(message.reasoning_content)) ||
      (message.anthropic_content !== undefined && !validAnthropicContent(message.anthropic_content)) ||
      (message.openai_reasoning !== undefined && !validOpenAIReasoning(message.openai_reasoning))
    )
      throw new Error('Conversation transcript has an invalid role or assistant content');
    if (
      message.tool_calls !== undefined &&
      (!Array.isArray(message.tool_calls) ||
        message.tool_calls.length === 0 ||
        message.tool_calls.length > MAX_TOOL_CALLS ||
        message.tool_calls.some((call) => !validCall(call)) ||
        new Set(message.tool_calls.map((call) => call.id)).size !== message.tool_calls.length)
    )
      throw new Error('Conversation transcript has invalid assistant tool calls');
    if (message.anthropic_content !== undefined && !anthropicContentMatchesAssistant(message.anthropic_content, message))
      throw new Error('Conversation transcript has invalid Anthropic assistant replay');
    return;
  }
  if (
    message.role === 'tool' &&
    validToolIdentifier(message.tool_call_id, 512) &&
    boundedText(message.content) &&
    (message.name === undefined || validToolIdentifier(message.name, 128))
  )
    return;
  throw new Error('Conversation transcript has an invalid message');
}
const isToolResultShape = (result) => {
  try {
    validateMessageShape(result);
    return result.role === 'tool';
  } catch {
    return false;
  }
};
function validateTranscript(source) {
  const accepted = [];
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    validateMessageShape(message);
    if (message.role === 'tool') throw new Error('Conversation transcript has an orphan tool result');
    if (message.role === 'system' || message.role === 'user') {
      accepted.push(message);
      continue;
    }
    if (message.role !== 'assistant') throw new Error('Conversation transcript has an invalid role or assistant content');
    if (message.tool_calls === undefined) {
      accepted.push(message);
      continue;
    }
    const ids = new Set(message.tool_calls.map((call) => call.id));
    const results = source.slice(index + 1, index + 1 + message.tool_calls.length);
    const wellFormed = results.every(isToolResultShape);
    const complete =
      results.length === message.tool_calls.length &&
      wellFormed &&
      results.every((result) => ids.has(result.tool_call_id)) &&
      new Set(results.map((result) => result.tool_call_id)).size === ids.size;
    if (complete) {
      accepted.push(message, ...results);
      index += results.length;
      continue;
    }
    const reachesEnd = index + 1 + results.length === source.length && wellFormed;
    if (reachesEnd) return { messages: accepted, trimmedIncomplete: true };
    throw new Error('Conversation transcript contains an incomplete tool-call transaction');
  }
  return { messages: accepted, trimmedIncomplete: false };
}
