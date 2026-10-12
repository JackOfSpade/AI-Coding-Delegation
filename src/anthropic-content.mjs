// Anthropic requires thinking blocks to be replayed byte-for-byte on the
// assistant turn that precedes a tool-result message.  Keep that provider
// protocol state separate from Offload's portable text/tool-call transcript:
// DeepSeek can ignore it, while the Anthropic adapter can reconstruct its
// native content array without exposing arbitrary provider objects.
export const MAX_ANTHROPIC_CONTENT_BLOCKS = 128;
export const MAX_ANTHROPIC_TOOL_INPUT_CHARS = 512_000;

const MAX_TEXT_CHARS = 1_000_000;
const plainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const validText = (value, limit = MAX_TEXT_CHARS) => typeof value === 'string' && value.length <= limit && !/[\0\x0b\x0c\x7f]/.test(value);
const validIdentifier = (value, limit) =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\0-\x1f\x7f]/.test(value);
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));

function validToolInput(value) {
  if (!validText(value, MAX_ANTHROPIC_TOOL_INPUT_CHARS)) return false;
  try {
    return plainObject(JSON.parse(value || '{}'));
  } catch {
    return false;
  }
}

function validBlock(value) {
  if (!plainObject(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text') return onlyKeys(value, ['type', 'text']) && validText(value.text);
  if (value.type === 'thinking')
    return (
      onlyKeys(value, ['type', 'thinking', 'signature']) &&
      validText(value.thinking) &&
      validText(value.signature) &&
      value.signature.length > 0
    );
  if (value.type === 'redacted_thinking') return onlyKeys(value, ['type', 'data']) && validText(value.data) && value.data.length > 0;
  return (
    value.type === 'tool_use' &&
    onlyKeys(value, ['type', 'id', 'name', 'input']) &&
    validIdentifier(value.id, 512) &&
    validIdentifier(value.name, 128) &&
    validToolInput(value.input)
  );
}

export function validAnthropicContent(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_ANTHROPIC_CONTENT_BLOCKS && value.every(validBlock);
}

export function cloneAnthropicContent(value) {
  if (!validAnthropicContent(value)) throw new TypeError('invalid Anthropic content');
  return value.map((block) => ({ ...block }));
}

export function anthropicContentChars(value) {
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, block) => {
    if (!block || typeof block !== 'object') return total;
    if (block.type === 'text') return total + String(block.text ?? '').length;
    if (block.type === 'thinking') return total + String(block.thinking ?? '').length + String(block.signature ?? '').length;
    if (block.type === 'redacted_thinking') return total + String(block.data ?? '').length;
    if (block.type === 'tool_use')
      return total + String(block.id ?? '').length + String(block.name ?? '').length + String(block.input ?? '').length;
    return total;
  }, 0);
}

// The portable fields are still the source of truth for tool execution.  A
// native replay record is accepted only when it describes exactly that same
// assistant response, preventing an injected provider-only block from
// changing which tool results the next Anthropic request binds to.
export function anthropicContentMatchesAssistant(value, { content, tool_calls: toolCalls } = {}) {
  if (!validAnthropicContent(value) || !validText(content ?? '')) return false;
  const text = value
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (text !== (content ?? '')) return false;
  const nativeCalls = value.filter((block) => block.type === 'tool_use');
  if (toolCalls === undefined) return nativeCalls.length === 0;
  if (!Array.isArray(toolCalls) || nativeCalls.length !== toolCalls.length) return false;
  return nativeCalls.every(
    (block, index) =>
      block.id === toolCalls[index]?.id &&
      block.name === toolCalls[index]?.function?.name &&
      block.input === toolCalls[index]?.function?.arguments,
  );
}
