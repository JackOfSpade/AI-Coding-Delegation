// The OpenAI Responses API returns encrypted reasoning items that must be
// replayed (without their ids) ahead of the function calls they produced when
// requests are stateless (store: false).  Keep that provider protocol state
// separate from Offload's portable text/tool-call transcript, exactly like
// Anthropic thinking blocks: other adapters ignore it, and the Responses
// adapter can rebuild its native input items without accepting arbitrary
// provider objects.
export const MAX_OPENAI_REASONING_ITEMS = 32;

const MAX_TEXT_CHARS = 1_000_000;
const MAX_SUMMARY_PARTS = 64;
const plainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const exactKeys = (value, keys) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

function validSummaryPart(value) {
  return (
    plainObject(value) &&
    exactKeys(value, ['type', 'text']) &&
    value.type === 'summary_text' &&
    typeof value.text === 'string' &&
    value.text.length <= MAX_TEXT_CHARS
  );
}

function validItem(value) {
  return (
    plainObject(value) &&
    exactKeys(value, ['type', 'encrypted_content', 'summary']) &&
    value.type === 'reasoning' &&
    typeof value.encrypted_content === 'string' &&
    value.encrypted_content.length > 0 &&
    value.encrypted_content.length <= MAX_TEXT_CHARS &&
    !/[\0-\x1f\x7f]/.test(value.encrypted_content) &&
    Array.isArray(value.summary) &&
    value.summary.length <= MAX_SUMMARY_PARTS &&
    value.summary.every(validSummaryPart)
  );
}

export function validOpenAIReasoning(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_OPENAI_REASONING_ITEMS && value.every(validItem);
}

export function cloneOpenAIReasoning(value) {
  if (!validOpenAIReasoning(value)) throw new TypeError('invalid OpenAI reasoning');
  return value.map((item) => ({
    type: item.type,
    encrypted_content: item.encrypted_content,
    summary: item.summary.map((part) => ({ type: part.type, text: part.text })),
  }));
}

export function openAIReasoningChars(value) {
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, item) => {
    if (!item || typeof item !== 'object') return total;
    const summary = Array.isArray(item.summary)
      ? item.summary.reduce((n, part) => n + (part && typeof part === 'object' ? String(part.text ?? '').length : 0), 0)
      : 0;
    return total + String(item.encrypted_content ?? '').length + summary;
  }, 0);
}
