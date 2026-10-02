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
    this.messages = checked.messages.map(cloneMessage);
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
    const candidate = [...this.messages.map((value) => cloneMessage(value, { includeElided: true })), cloneMessage(message)];
    elideMessages(candidate, this.maxToolChars, this.keepRecentToolResults);
    if (candidate.reduce((total, value) => total + messageChars(value), 0) > this.maxTranscriptChars)
      throw new Error('Conversation transcript exceeds size limit');
    const stored = candidate.at(-1);
    const inbound = cloneMessage(message, { includeElided: true });
    // A single append is also a durability boundary.  Do not make it visible
    // in memory until its callback succeeds: otherwise a failed disk write
    // leaves a later provider call with state it can never resume from.
    const action = async () => {
      // Re-stage against the committed transcript after prior queued appends.
      // This retains ordering when callers enqueue multiple records before a
      // flush, while a failed predecessor never leaks into live state.
      const next = [
        ...this.messages.map((value) => cloneMessage(value, { includeElided: true })),
        cloneMessage(inbound, { includeElided: true }),
      ];
      elideMessages(next, this.maxToolChars, this.keepRecentToolResults);
      if (next.reduce((total, value) => total + messageChars(value), 0) > this.maxTranscriptChars)
        throw new Error('Conversation transcript exceeds size limit');
      const durable = cloneMessage(next.at(-1), { includeElided: true });
      if (this.onAppend) await this.onAppend(cloneMessage(durable, { includeElided: true }));
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
      if (candidate.reduce((total, value) => total + messageChars(value), 0) > this.maxTranscriptChars)
        throw new Error('Conversation transcript exceeds size limit');
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
    return this.messages.reduce((total, message) => total + messageChars(message), 0);
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
}
function messageChars(message) {
  return typeof message?.content === 'string'
    ? message.content.length +
        (typeof message.reasoning_content === 'string' ? message.reasoning_content.length : 0) +
        (Array.isArray(message.tool_calls)
          ? message.tool_calls.reduce((n, call) => n + String(call?.function?.arguments ?? '').length, 0)
          : 0)
    : typeof message?.reasoning_content === 'string'
      ? message.reasoning_content.length
      : 0;
}
function elideMessages(messages, maxToolChars, keepRecentToolResults) {
  const tools = messages.map((message, index) => [message, index]).filter(([message]) => message.role === 'tool' && !message.elided);
  let chars = tools.reduce((total, [message]) => total + (message.content?.length ?? 0), 0);
  for (const [message] of tools.slice(0, Math.max(0, tools.length - keepRecentToolResults))) {
    if (chars <= maxToolChars) break;
    const original = message.content ?? '';
    message.content = `[tool output elided: ${original.length} chars; request a narrower read if needed]`;
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
const MAX_MESSAGE_CHARS = 1_000_000;
const MAX_TOOL_CALLS = 64;
const MAX_TOOL_ARGUMENT_CHARS = 512_000;
const boundedText = (value, max = MAX_MESSAGE_CHARS) => typeof value === 'string' && value.length <= max;
const safeIdentifier = (value, max) => boundedText(value, max) && value.length > 0 && !/[\x00-\x1F\x7F]/.test(value);
function cloneMessage(message, { includeElided = false } = {}) {
  if (message.role === 'system' || message.role === 'user') return { role: message.role, content: message.content };
  if (message.role === 'assistant')
    return {
      role: 'assistant',
      content: message.content,
      ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}),
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
    safeIdentifier(call.id, 512) &&
    safeIdentifier(call.function?.name, 128) &&
    boundedText(call.function?.arguments, MAX_TOOL_ARGUMENT_CHARS)
  );
}
function validateMessageShape(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.role !== 'string')
    throw new Error('Conversation transcript contains an invalid message');
  if (message.role === 'system' || message.role === 'user') {
    if (!boundedText(message.content)) throw new Error('Conversation transcript has invalid content');
    return;
  }
  if (message.role === 'assistant') {
    if (!boundedText(message.content) || (message.reasoning_content !== undefined && !boundedText(message.reasoning_content)))
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
    return;
  }
  if (
    message.role === 'tool' &&
    safeIdentifier(message.tool_call_id, 512) &&
    boundedText(message.content) &&
    (message.name === undefined || safeIdentifier(message.name, 128))
  )
    return;
  throw new Error('Conversation transcript has an invalid message');
}
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
    const complete =
      results.length === message.tool_calls.length &&
      results.every((result) => {
        try {
          validateMessageShape(result);
          return result.role === 'tool';
        } catch {
          return false;
        }
      }) &&
      results.every((result) => ids.has(result.tool_call_id)) &&
      new Set(results.map((result) => result.tool_call_id)).size === ids.size;
    if (complete) {
      accepted.push(message, ...results);
      index += results.length;
      continue;
    }
    const reachesEnd =
      index + 1 + results.length === source.length &&
      results.every((result) => {
        try {
          validateMessageShape(result);
          return result.role === 'tool';
        } catch {
          return false;
        }
      });
    if (reachesEnd) return { messages: accepted, trimmedIncomplete: true };
    throw new Error('Conversation transcript contains an incomplete tool-call transaction');
  }
  return { messages: accepted, trimmedIncomplete: false };
}
