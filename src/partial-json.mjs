// Recover one top-level string field from JSON text that an output cap cut
// off mid-document (a report worker's `finish` arguments). Pure, bounded
// scanning: nothing is evaluated, nested values are skipped, and only a key
// at the top level of the outermost object can match, so a `"report"` that
// appears inside another string or nested value is never mistaken for it.
// Leaf module.

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const SIMPLE_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

const skipWhitespace = (text, index) => {
  while (index < text.length && WHITESPACE.has(text[index])) index++;
  return index;
};

/**
 * Decode the JSON string whose opening quote is at `start`. Returns
 * `{ value, end, complete }`; an incomplete string decodes up to the cut,
 * dropping a trailing partial escape and a trailing lone high surrogate.
 * Undefined for an invalid escape.
 */
function readString(text, start) {
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') return { value, end: index + 1, complete: true };
    if (char !== '\\') {
      value += char;
      index++;
      continue;
    }
    if (index + 1 >= text.length) break;
    const escape = text[index + 1];
    if (Object.hasOwn(SIMPLE_ESCAPES, escape)) {
      value += SIMPLE_ESCAPES[escape];
      index += 2;
      continue;
    }
    if (escape !== 'u') return undefined;
    const hex = text.slice(index + 2, index + 6);
    if (hex.length < 4) break;
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
    value += String.fromCharCode(Number.parseInt(hex, 16));
    index += 6;
  }
  const last = value.charCodeAt(value.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) value = value.slice(0, -1);
  return { value, end: text.length, complete: false };
}

/** The index just past the complete JSON value at `start`, or -1 when it is cut or invalid. */
function skipValue(text, start) {
  const opener = text[start];
  if (opener === '"') {
    const string = readString(text, start);
    return string?.complete ? string.end : -1;
  }
  if (opener === '{' || opener === '[') {
    let depth = 0;
    let index = start;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        const string = readString(text, index);
        if (!string?.complete) return -1;
        index = string.end;
        continue;
      }
      if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) return index + 1;
      }
      index++;
    }
    return -1;
  }
  // A number, true, false or null runs to the next delimiter; one cut at the
  // end of the text cannot be told apart from a complete one, so it is not.
  let index = start;
  while (index < text.length && !WHITESPACE.has(text[index]) && text[index] !== ',' && text[index] !== '}') index++;
  return index < text.length && index > start ? index : -1;
}

/**
 * The decoded text of top-level string field `field` in possibly truncated
 * JSON object text, up to the cut when the string itself was cut. Undefined
 * when the field is absent before the cut, is not a string, or is blank.
 */
export function extractPartialStringField(text, field) {
  if (typeof text !== 'string' || typeof field !== 'string') return undefined;
  let index = skipWhitespace(text, 0);
  if (text[index] !== '{') return undefined;
  index++;
  while (index < text.length) {
    index = skipWhitespace(text, index);
    if (text[index] === '}') return undefined;
    if (text[index] !== '"') return undefined;
    const key = readString(text, index);
    if (!key?.complete) return undefined;
    index = skipWhitespace(text, key.end);
    if (text[index] !== ':') return undefined;
    index = skipWhitespace(text, index + 1);
    if (index >= text.length) return undefined;
    if (key.value === field) {
      if (text[index] !== '"') return undefined;
      const value = readString(text, index);
      return value && value.value.trim().length > 0 ? value.value : undefined;
    }
    index = skipValue(text, index);
    if (index < 0) return undefined;
    index = skipWhitespace(text, index);
    if (text[index] === ',') index++;
    else return undefined;
  }
  return undefined;
}
