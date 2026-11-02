import { createHash } from 'node:crypto';

/**
 * The MCP view of a large diff. A tools/call result carries its value twice (as
 * text and as structuredContent), and the text is JSON inside JSON, so this leaves
 * room for the worst-case escaping inside the transport's 2 MB frame.
 */
export const DIFF_WINDOW_BYTES = 300_000;
const MIN_WINDOW_BYTES = 2_000;

// Offsets count characters of the displayed diff, which is the same on every read.
function windowEnd(text, offset, maxBytes) {
  let end = Math.min(text.length, offset + maxBytes);
  for (let bytes = Buffer.byteLength(text.slice(offset, end)); bytes > maxBytes; bytes = Buffer.byteLength(text.slice(offset, end)))
    end = offset + Math.max(1, Math.floor(((end - offset) * maxBytes) / bytes) - 1);
  if (end >= text.length) return text.length;
  // Whole lines when one fits; never half of a surrogate pair when none does.
  const newline = text.lastIndexOf('\n', end - 1);
  if (newline >= offset) return newline + 1;
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff && end - offset > 1 ? end - 1 : end;
}

/** One window of `diff`, with what a caller needs to fetch the rest and to tie the pages together. */
export function diffWindow(diff, { offset = 0, maxBytes = DIFF_WINDOW_BYTES } = {}) {
  if (offset > diff.length) throw new Error(`offset ${offset} is past the end of the ${diff.length} character diff`);
  const end = windowEnd(diff, offset, maxBytes);
  return {
    diff: diff.slice(offset, end),
    diffWindow: {
      offset,
      returnedChars: end - offset,
      totalChars: diff.length,
      truncated: end < diff.length,
      ...(end < diff.length ? { nextOffset: end } : {}),
      sha256: createHash('sha256').update(diff).digest('hex'),
    },
  };
}

/** A whole diff when it fits and no window was asked for; otherwise a window. */
export function windowedDiffResult(result, { offset, maxBytes } = {}) {
  if (typeof result?.diff !== 'string') return result;
  // detail "full" carries the report and job fields beside the diff, also twice over.
  const beside = Buffer.byteLength(JSON.stringify({ ...result, diff: '' }));
  const room = Math.max(MIN_WINDOW_BYTES, DIFF_WINDOW_BYTES - beside * 2);
  const requested = offset !== undefined || maxBytes !== undefined;
  if (!requested && Buffer.byteLength(result.diff) <= room) return result;
  return { ...result, ...diffWindow(result.diff, { offset, maxBytes: Math.min(maxBytes ?? room, room) }) };
}
