import { redactText, stripTerminalControls } from './redact.mjs';

/**
 * Pure helpers for `offload_apply`'s `applyThenVerify`: the primary names a
 * command, the server applies the job-owned diff, runs the command in the
 * primary checkout, and reverts the diff when the command does not pass. The
 * stateful parts (journal, lease, revert, recovery) live in JobManager; nothing
 * here touches a repository, a store, or a process.
 */
export const APPLY_VERIFY_DEFAULT_TIMEOUT_SEC = 300;
export const APPLY_VERIFY_MIN_TIMEOUT_SEC = 5;
export const APPLY_VERIFY_MAX_TIMEOUT_SEC = 900;
export const MAX_APPLY_VERIFY_COMMAND = 8_192;
// The journaled (display) form of the command; the run itself uses the full text.
export const APPLY_VERIFY_RECORD_COMMAND = 500;
export const MAX_APPLY_VERIFY_TAIL_CHARS = 8_000;
export const MAX_APPLY_VERIFY_TAIL_LINES = 40;
// Tail extraction works on this much raw output at most, so a pathological
// run (megabytes of unterminated escape sequences) cannot make the cleaning
// regular expressions quadratic. The runner already caps output at 256 KiB.
const TAIL_SCAN_CHARS = 64 * 1024;
const OSC_BODY_MAX = 2048;
const OSC_SEQUENCE = new RegExp(`\\x1B\\][^\\x07\\x1B]{0,${OSC_BODY_MAX}}(?:\\x07|\\x1B\\\\)?`, 'g');
export const APPLY_VERIFY_PHASES = new Set(['applying', 'verifying', 'reverting']);
export const APPLY_VERIFY_OUTCOMES = new Set(['PASSED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'NOT_RUN', 'PRIMARY_CHANGED', 'INTERRUPTED']);

/**
 * Validate the three apply-time options together. Returns `null` when no
 * command was requested (after proving the dependent options are absent too),
 * otherwise `{ command, timeoutSec, policyOnly }`.
 */
export function normalizeApplyVerify({ applyThenVerify, applyThenVerifyTimeoutSec, unsafePolicyOnlyVerifier } = {}) {
  if (applyThenVerify === undefined) {
    if (applyThenVerifyTimeoutSec !== undefined || unsafePolicyOnlyVerifier !== undefined)
      throw new Error('applyThenVerifyTimeoutSec and unsafePolicyOnlyVerifier require applyThenVerify');
    return null;
  }
  if (
    typeof applyThenVerify !== 'string' ||
    applyThenVerify.length > MAX_APPLY_VERIFY_COMMAND ||
    !applyThenVerify.trim() ||
    /[\0\r]/.test(applyThenVerify)
  )
    throw new Error(
      `applyThenVerify must be a non-empty string of at most ${MAX_APPLY_VERIFY_COMMAND} characters without NUL or carriage returns`,
    );
  if (
    applyThenVerifyTimeoutSec !== undefined &&
    (!Number.isInteger(applyThenVerifyTimeoutSec) ||
      applyThenVerifyTimeoutSec < APPLY_VERIFY_MIN_TIMEOUT_SEC ||
      applyThenVerifyTimeoutSec > APPLY_VERIFY_MAX_TIMEOUT_SEC)
  )
    throw new Error(`applyThenVerifyTimeoutSec must be an integer from ${APPLY_VERIFY_MIN_TIMEOUT_SEC} to ${APPLY_VERIFY_MAX_TIMEOUT_SEC}`);
  if (unsafePolicyOnlyVerifier !== undefined && typeof unsafePolicyOnlyVerifier !== 'boolean')
    throw new Error('unsafePolicyOnlyVerifier must be boolean');
  return {
    command: applyThenVerify.trim(),
    timeoutSec: applyThenVerifyTimeoutSec ?? APPLY_VERIFY_DEFAULT_TIMEOUT_SEC,
    policyOnly: unsafePolicyOnlyVerifier === true,
  };
}

/**
 * Reduce one command run to an outcome. `run` is a Runner.verify result, a
 * `{ thrown }` wrapper for an exception, or null. Only an exit-0 run that was
 * not cancelled, not timed out, and (when a sandbox was required) really ran
 * under the macOS sandbox is PASSED: an injected or buggy runner must not be
 * able to turn a policy-only execution into a pass the caller believes is
 * confined.
 */
export function classifyApplyVerifyRun(run, { requireSandbox = true, aborted = false } = {}) {
  const result = run?.result && typeof run.result === 'object' ? run.result : undefined;
  const base = {
    exitCode: Number.isInteger(result?.code) ? result.code : undefined,
    timedOut: result?.timedOut === true,
    cancelled: result?.cancelled === true || aborted === true,
    sandbox: typeof result?.sandbox === 'string' ? result.sandbox.slice(0, 32) : undefined,
    durationMs: Number.isFinite(result?.durationMs) && result.durationMs >= 0 ? Math.round(result.durationMs) : undefined,
  };
  if (base.cancelled) return { ...base, outcome: 'CANCELLED' };
  if (run?.thrown !== undefined || !result) {
    const message = run?.thrown?.message ?? run?.thrown;
    return { ...base, outcome: 'NOT_RUN', error: String(message || 'the command did not run').slice(0, 500) };
  }
  if (requireSandbox && result.sandbox !== 'macos')
    return { ...base, outcome: 'NOT_RUN', error: 'the command did not run under the required macOS sandbox' };
  if (base.timedOut) return { ...base, outcome: 'TIMED_OUT' };
  if (run.verdict === 'PASS' && result.code === 0) return { ...base, outcome: 'PASSED' };
  return { ...base, outcome: 'FAILED' };
}

/**
 * The evidence kept for the primary: the end of the output (stderr last), with
 * terminal controls stripped and secrets redacted, cut on a line boundary. The
 * full output is never persisted.
 */
export function applyVerifyTail(result) {
  if (!result || typeof result !== 'object') return '';
  const joined = [result.stdout, result.stderr].filter((part) => typeof part === 'string' && part).join('\n');
  if (!joined) return '';
  let scan = joined.length > TAIL_SCAN_CHARS ? joined.slice(-TAIL_SCAN_CHARS) : joined;
  // A slice may start inside a line (or inside a credential); drop that fragment.
  if (scan.length < joined.length) scan = scan.slice(scan.indexOf('\n') + 1);
  // stripTerminalControls' OSC pattern rescans to the end of the text for every
  // unterminated introducer; remove OSC sequences here with a bounded form (an
  // unterminated one swallows at most OSC_BODY_MAX characters) so the cost stays
  // linear, and leave the rest of the cleaning to it.
  const lines = redactText(stripTerminalControls(scan.replace(OSC_SEQUENCE, ''))).split(/\r?\n/);
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  let tail = lines.slice(-MAX_APPLY_VERIFY_TAIL_LINES);
  let text = tail.join('\n');
  while (text.length > MAX_APPLY_VERIFY_TAIL_CHARS && tail.length > 1) {
    tail = tail.slice(1);
    text = tail.join('\n');
  }
  // A single enormous line: keep its end.
  return text.length > MAX_APPLY_VERIFY_TAIL_CHARS ? text.slice(-MAX_APPLY_VERIFY_TAIL_CHARS) : text;
}

const text = (value, limit) => redactText(stripTerminalControls(String(value))).slice(0, limit);
const names = (value) =>
  Array.isArray(value)
    ? value
        .filter((name) => typeof name === 'string')
        .slice(0, 20)
        .map((name) => text(name, 200))
    : undefined;

/** The bounded, output-free projection placed on the public job view. */
export function publicApplyVerify(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const out = {};
  if (typeof record.command === 'string') out.command = text(record.command, 500);
  for (const key of ['outcome', 'commandOutcome']) if (APPLY_VERIFY_OUTCOMES.has(record[key])) out[key] = record[key];
  if (APPLY_VERIFY_PHASES.has(record.phase)) out.phase = record.phase;
  if (Number.isInteger(record.timeoutSec)) out.timeoutSec = record.timeoutSec;
  for (const key of ['sandbox', 'ranUnder']) if (typeof record[key] === 'string') out[key] = text(record[key], 32);
  if (Number.isInteger(record.exitCode)) out.exitCode = record.exitCode;
  if (Number.isFinite(record.durationMs)) out.durationMs = record.durationMs;
  for (const key of ['startedAt', 'finishedAt']) if (typeof record[key] === 'string') out[key] = text(record[key], 40);
  for (const key of ['reverted', 'revertVerified', 'primaryRestoredExactly']) if (typeof record[key] === 'boolean') out[key] = record[key];
  for (const key of ['autoRevertError', 'error']) if (typeof record[key] === 'string') out[key] = text(record[key], 500);
  if (Number.isInteger(record.attempts)) out.attempts = record.attempts;
  for (const key of ['changed', 'primaryChangedDuringVerify']) {
    const list = names(record[key]);
    if (list?.length) out[key] = list;
  }
  return out;
}
