/**
 * Output-cap diagnostics. A provider can stop a response at its output-token
 * cap partway through a tool call; the adapter drops the unexecutable fragment
 * and the loop sees only a `length` finish. The commonest cause is a worker
 * streaming one large file through a single write_file call, which the same
 * call on the next turn will hit again. These helpers classify that case for
 * the loop's one-shot recovery and describe it to the primary.
 */
import { INCREMENTAL_WRITE_BYTES, INCREMENTAL_WRITE_LINES } from './agent/tools.mjs';
import { MAX_TOOL_ARGUMENT_CHARS } from './transcript-limits.mjs';

// A dropped write whose arguments were already at least this long when the
// cap struck is treated as a whole-file-in-one-call attempt.
export const LARGE_TRUNCATED_WRITE_CHARS = INCREMENTAL_WRITE_BYTES;
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const STEERS = new Set(['write-in-parts', 'edit-in-parts', 'continue']);
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_TURN = 1_000_000;

export const LARGE_WRITE_CAPPED_REMINDER = `Your last write_file call was cut off by the response output cap and was not run: nothing from it was written. Do not resend the whole file in one call. Write it in parts: call write_file with a small first part of at most about ${INCREMENTAL_WRITE_LINES} lines or ${INCREMENTAL_WRITE_BYTES / 1024} KB, then call write_file with append true and the same path for each next part of that size, one part per tool call. When the work is complete, call finish as the sole tool call.`;
export const LARGE_EDIT_CAPPED_REMINDER = `Your last edit_file call was cut off by the response output cap and was not run: nothing from it was written. Do not resend it as one call. Split the change into several smaller edit_file calls of at most about ${INCREMENTAL_WRITE_LINES} lines or ${INCREMENTAL_WRITE_BYTES / 1024} KB of new_string each, reading the file again before each edit. When the work is complete, call finish as the sole tool call.`;

/** Shape check for an adapter's `truncatedToolCall` event field. */
export const validTruncatedToolCall = (value) =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof value.name === 'string' &&
  value.name.length >= 1 &&
  value.name.length <= 128 &&
  Number.isSafeInteger(value.chars) &&
  value.chars >= 0 &&
  value.chars <= MAX_TOOL_ARGUMENT_CHARS;

/** The steer for a capped, tool-less turn, given the advertised tool the dropped call named (if any). */
export function outputCapSteer(truncated) {
  if (!truncated || !WRITE_TOOLS.has(truncated.name) || truncated.chars < LARGE_TRUNCATED_WRITE_CHARS) return 'continue';
  return truncated.name === 'write_file' ? 'write-in-parts' : 'edit-in-parts';
}

export const outputCapReminder = (steer) =>
  steer === 'write-in-parts' ? LARGE_WRITE_CAPPED_REMINDER : steer === 'edit-in-parts' ? LARGE_EDIT_CAPPED_REMINDER : undefined;

/** The stored or reported diagnostic, or undefined when it is malformed. */
export function safeOutputCap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { turn, tool, chars, steer, recovered } = value;
  if (!Number.isSafeInteger(turn) || turn < 1 || turn > MAX_TURN || !STEERS.has(steer)) return undefined;
  if (recovered !== undefined && typeof recovered !== 'boolean') return undefined;
  const named = typeof tool === 'string' && TOOL_NAME.test(tool) ? tool : undefined;
  const sized = Number.isSafeInteger(chars) && chars >= 0 && chars <= MAX_TOOL_ARGUMENT_CHARS ? chars : undefined;
  // A write steer is only coherent with the call that earned it.
  if (steer !== 'continue' && (named === undefined || sized === undefined)) return undefined;
  return {
    turn,
    ...(named ? { tool: named } : {}),
    ...(sized !== undefined ? { chars: sized } : {}),
    steer,
    recovered: recovered !== false,
  };
}

const kb = (chars) => `${Math.max(1, Math.round(chars / 1024))} KB`;
const LIVE = new Set(['QUEUED', 'RUNNING', 'REPAIRING']);
const PARTS = `${INCREMENTAL_WRITE_BYTES / 1024} KB`;

/**
 * Fixed, server-chosen advice for the primary; no worker text reaches it.
 * `status` is the job's: advice about what may still happen is given only
 * while a round can act on it, and a finished job gets what happened.
 */
export function outputCapAdvice(cap, status = 'RUNNING') {
  const safe = safeOutputCap(cap);
  if (!safe) return undefined;
  const article = safe.tool === 'edit_file' ? 'an' : 'a';
  const what =
    safe.steer === 'continue'
      ? `Turn ${safe.turn} hit the provider output cap before any tool call ran${safe.tool ? ` (${article} ${safe.tool} call of about ${kb(safe.chars ?? 0)} was cut off and not run)` : ''}.`
      : `Turn ${safe.turn} hit the provider output cap inside ${article} ${safe.tool} call of about ${kb(safe.chars)}, which was not run.`;
  const steer =
    safe.steer === 'write-in-parts'
      ? `write that file in parts (a small first part, then write_file append chunks of at most about ${PARTS})`
      : safe.steer === 'edit-in-parts'
        ? `split the edit into smaller edit_file calls (chunks of at most about ${PARTS})`
        : undefined;
  const told = safe.recovered
    ? steer
      ? ` The worker was told to ${steer}.`
      : ' The worker was given one continuation.'
    : ' No recovery turn was available, so the round stopped there.';
  if (LIVE.has(status)) {
    if (!safe.recovered) return `${what}${told}`;
    return `${what}${told} A second cap fails the round with output-cap; ${steer ? 'if it does' : 'if it recurs'}, continue or rebrief asking for large files to be built incrementally rather than retrying the same brief.`;
  }
  if (status === 'FAILED')
    return `${what}${told} Continue or rebrief asking for large files to be built incrementally (a small first write_file, then append parts of at most about ${PARTS}) rather than retrying the same brief.`;
  return `${what}${told}`;
}

/** The diagnostic a caller should see, with advice for the job's status. */
export function outputCapView(job) {
  const safe = safeOutputCap(job?.outputCap);
  return safe ? { ...safe, advice: outputCapAdvice(safe, job?.status) } : undefined;
}

export function outputCapLine(job) {
  const view = outputCapView(job);
  return view ? `output cap: ${view.advice}` : '';
}
