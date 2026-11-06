// Size limits and the identifier rule for the portable tool-call transcript.
// The agent loop validates provider events, the context validates persisted
// messages, and each provider adapter validates its wire format; they must all
// agree or a response one accepts could be refused by another. Leaf module.

export const MAX_MESSAGE_CHARS = 1_000_000;
export const MAX_TOOL_CALLS = 64;
export const MAX_TOOL_ARGUMENT_CHARS = 512_000;

/** A non-empty string of at most `max` characters with no C0 or DEL control character. */
export const validToolIdentifier = (value, max) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1F\x7F]/.test(value);

// The largest tool call an output cap cut off, reported by provider adapters
// (never executed) so the loop can steer its one-shot recovery away from
// resending the same oversized call.
export const largerTruncation = (current, name, chars) =>
  typeof name === 'string' && name.length >= 1 && name.length <= 128 && (!current || chars > current.chars) ? { name, chars } : current;
