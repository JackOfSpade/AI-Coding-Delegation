import { createHash } from 'node:crypto';
import { redact, redactText, stripTerminalControls } from './redact.mjs';

/**
 * Why a worker round ended FAILED, in a form that is safe to persist, show a
 * primary and (for a few worker-side kinds) act on. Pure and dependency-free
 * (no job-manager import) so the loop, the manager and the report share one
 * definition and cannot drift.
 *
 * The kinds below are the only FAILED causes a continuation may resume: the
 * worker, not the provider, the sandbox or the repository, ran out of road (or
 * broke the finish protocol twice, which the server corrected once already).
 * Everything else (a provider failure, a protocol fault, a scope violation, a
 * moved branch, a lost lease, ...) never receives a `failureKind` and so stays
 * default-deny.
 */
export const FAILURE_ERRORS = Object.freeze({
  'tool-loop': 'Loop detected: identical failing tool calls repeated 3 times',
  'no-finish': 'Worker ended without mandatory finish call',
  'output-cap': 'Worker exhausted output-cap recovery without an allowed tool call',
  // The one in-loop correction was already spent: see FINISH_ALONE_CORRECTION in agent/loop.mjs.
  'finish-protocol': 'finish must be the sole valid tool call in a turn',
});
export const FAILURE_KINDS = Object.freeze(Object.keys(FAILURE_ERRORS));

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const ERROR_CODE = /^E[A-Z0-9_]{2,40}$/;
const SIGNATURE = /^[0-9a-f]{16}$/;
const FIELD_CHARS = 300;
const VALUE_CHARS = 120;
const MAX_ARG_KEYS = 8;
const MAX_TURN = 1000;
const MAX_REPEATS = 16;
// Arguments that carry a file body or a patch say how big they were, never what
// they said: the primary needs the shape of the call, not another copy of the diff.
const BODY_KEYS = new Set(['content', 'old_string', 'new_string', 'text', 'patch', 'body']);

const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/**
 * `[[absolutePrefix, label], ...]`, longest prefix first, so a worktree path
 * becomes `<worktree>/x` rather than leaking a temp directory or a home dir.
 */
function applyAliases(text, aliases) {
  let out = text;
  for (const [prefix, label] of [...aliases].sort((a, b) => b[0].length - a[0].length))
    // A prefix ends at a path boundary: /Users/jack must not rewrite /Users/jackson.
    if (typeof prefix === 'string' && prefix.length > 1 && prefix !== '/')
      out = out.replace(new RegExp(`${prefix.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')}(?![A-Za-z0-9._-])`, 'g'), () => label);
  return out;
}
// Redact before clipping so a secret is never cut into an unrecognizable prefix.
const sanitize = (value, limit, aliases = []) =>
  clip(
    stripTerminalControls(redactText(applyAliases(String(value), aliases)))
      .replace(/[\r\n\t]+/g, ' ')
      .trim(),
    limit,
  );

function summarizeArgs(parsed, aliases) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}';
  const reduced = {};
  for (const [key, value] of Object.entries(parsed).slice(0, MAX_ARG_KEYS)) {
    const label = sanitize(key, 40);
    if (typeof value === 'string') reduced[label] = BODY_KEYS.has(key) ? `<${value.length} chars>` : sanitize(value, VALUE_CHARS, aliases);
    else if (value === null || typeof value === 'number' || typeof value === 'boolean') reduced[label] = value;
    else reduced[label] = Array.isArray(value) ? '<array>' : '<object>';
  }
  // Key-aware pass: a `token`/`password` argument is masked wholesale.
  return sanitize(JSON.stringify(redact(reduced)), FIELD_CHARS, aliases);
}

function summarizeError(error, aliases) {
  const message = typeof error === 'string' ? error : String(error?.message ?? '');
  const first = stripTerminalControls(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return 'Tool execution failed';
  const code = typeof error?.code === 'string' && ERROR_CODE.test(error.code) && !first.includes(error.code) ? `${error.code}: ` : '';
  return sanitize(`${code}${first.slice(0, 4_000)}`, FIELD_CHARS, aliases);
}

// Key-sorted JSON, so the same call hashes the same whatever order the model wrote its keys in.
const canonical = (value, depth = 0) => {
  if (depth > 16 || value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`)
    .join(',')}}`;
};

/**
 * Identity of the call that looped, over its FULL arguments. The displayed `args`
 * clip every value and reduce file bodies to a length, so hashing those would call
 * two different edits "the same call" and wrongly refuse a continuation. Only the
 * 16-hex digest is kept; the raw arguments are never stored.
 */
function callSignature(tool, parsedArgs, rawArguments, summary) {
  let body;
  try {
    if (parsedArgs !== undefined) body = canonical(parsedArgs);
  } catch {}
  body ??= typeof rawArguments === 'string' ? rawArguments : summary;
  return createHash('sha256').update(`${tool}\0${body}`).digest('hex').slice(0, 16);
}

/**
 * The first failing call of the turn that tripped the loop guard: its tool,
 * a bounded argument summary and the real (redacted, path-aliased) error. The
 * worker is never shown this error (see toolErrorHint); a primary needs it to
 * tell a bad brief from a bad worker.
 */
export function summarizeToolFailure({ calls, parsed = [], values, errors = [], turn, repeats, pathAliases = [] }) {
  const index = values.findIndex((value) => typeof value === 'string' && value.startsWith('TOOL_ERROR:'));
  if (index < 0) return undefined;
  const name = String(calls[index]?.name ?? '');
  const tool = TOOL_NAME.test(name) ? name : 'unknown';
  const args = summarizeArgs(parsed[index], pathAliases);
  return {
    tool,
    args,
    error: summarizeError(errors[index], pathAliases),
    turn,
    repeats,
    signature: callSignature(tool, parsed[index], calls[index]?.arguments, args),
  };
}

/**
 * Closed-shape validator and re-sanitizer for a persisted/echoed failure. Used
 * on every read path (public view, report, log digest, event), so a record that
 * was tampered with or written by a custom worker cannot widen what is shown.
 * `args`, `error` and `signature` are optional: a report job keeps only
 * `{tool, turn, repeats}` because its transcripts are deliberately ephemeral.
 */
export function safeToolFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (typeof value.tool !== 'string' || !TOOL_NAME.test(value.tool)) return undefined;
  if (!Number.isSafeInteger(value.turn) || value.turn < 0 || value.turn > MAX_TURN) return undefined;
  if (!Number.isSafeInteger(value.repeats) || value.repeats < 1 || value.repeats > MAX_REPEATS) return undefined;
  const out = { tool: value.tool, turn: value.turn, repeats: value.repeats };
  for (const key of ['args', 'error']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > 4 * FIELD_CHARS) return undefined;
    out[key] = sanitize(value[key], FIELD_CHARS);
  }
  if (value.signature !== undefined) {
    if (typeof value.signature !== 'string' || !SIGNATURE.test(value.signature)) return undefined;
    out.signature = value.signature;
  }
  return out;
}

export const safeFailureKind = (value) => (typeof value === 'string' && Object.hasOwn(FAILURE_ERRORS, value) ? value : undefined);

/** A report job's tool arguments and errors can echo untrusted external bodies; keep only the shape. */
export const reportToolFailure = (value) => {
  const safe = safeToolFailure(value);
  return safe && { tool: safe.tool, turn: safe.turn, repeats: safe.repeats };
};

/**
 * The single gate shared by `JobManager.repair()` (which enforces it) and the
 * report (which advertises `continue` only when it would be accepted). It is
 * default-deny: a FAILED job qualifies only when its durable `failureKind` is
 * one of ours AND `error` is still exactly that kind's canonical text, so a
 * later scope, snapshot or repair-setup failure that overwrote `error` cannot
 * be resumed by accident.
 */
export function continuableFailure(job) {
  if (!job || typeof job !== 'object' || job.mode === 'report' || job.status !== 'FAILED') return false;
  const kind = safeFailureKind(job.failureKind);
  if (!kind || job.error !== FAILURE_ERRORS[kind]) return false;
  if (job.providerFailure || job.branchChanged || job.integrationConflict || job.integrationUncertain || job.revertUncertain) return false;
  if (job.workspaceCleanupRequired || job.applied === true) return false;
  if (job.scopeViolations?.length || job.verifierMutations?.length) return false;
  // A filtered response is deterministic: re-sending the same conversation spends another round for the same stop.
  if (job.providerFinishReason === 'content_filter') return false;
  return !loopedAgain(job);
}

/**
 * Statuses whose diff is kept un-integrated and may be applied by the primary
 * with its own evidence. A FAILED job joins them only through
 * `failedApplyRefusal`, never by status alone; CANCELLED never does (the
 * primary stopped it on purpose).
 */
export const APPLY_ELIGIBLE_STATUSES = Object.freeze(['VERIFY_ENV_FAILED', 'VERIFY_FAILED', 'BUDGET', 'TIMEOUT']);

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * The single gate shared by `JobManager.apply()` (which enforces it) and the
 * report (which advertises `apply` only when it would pass), for a job whose
 * status is FAILED. Returns why its retained diff must not be offered to
 * `offload_apply`, or undefined when it may be. Any failure cause qualifies (a
 * finish-protocol or loop stop is no verdict on a diff the scope audit passed),
 * but only when everything below holds; the manager adds the I/O half, binding
 * the stored `revert.diff` to the recorded snapshots, and every conflict,
 * lease, branch/HEAD and index check of the other apply statuses still runs.
 */
export function failedApplyRefusal(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return 'no job record';
  if (job.mode === 'report') return 'report jobs never integrate into the primary checkout';
  if (job.applied === true) return 'its diff is already integrated (offload_revert undoes it)';
  if (job.revertedAt) return 'its diff was integrated and then reverted; start a fresh job';
  if (
    job.integrationUncertain ||
    job.revertUncertain ||
    job.integrationIntent === true ||
    job.revertIntent === true ||
    job.applyVerifyIntent === true
  )
    return 'an integration or revert of it has an unresolved outcome; inspect the primary checkout first';
  if (job.workspaceCleanupRequired === true || job.workspaceCleanupError)
    return 'its isolated workspace still needs cleanup (workspaceCleanupRequired/workspaceCleanupError); resolve that first';
  const error = typeof job.error === 'string' ? job.error : '';
  if (/^lease lost:/.test(error)) return 'it lost its write lease while running, so its result cannot be trusted; start a fresh job';
  if (/patch containing configured secret/.test(error))
    return 'its diff contained a configured secret and was not retained; start a fresh job';
  const violations = [
    ...(Array.isArray(job.scopeViolations) ? job.scopeViolations : []),
    ...(Array.isArray(job.verifierMutations) ? job.verifierMutations : []),
  ];
  if (violations.length)
    return `it has scope or verifier-authorship violations (${violations.slice(0, 5).map(String).join(', ')}${violations.length > 5 ? ', ...' : ''}); a job that wrote outside its scope is never applied, so start a fresh job`;
  if (!Array.isArray(job.scopeViolations)) return 'no scope audit was recorded, so its diff was never captured; start a fresh job';
  if (!GIT_OBJECT_ID.test(job.before ?? '') || !GIT_OBJECT_ID.test(job.workspaceAfter ?? ''))
    return 'no result snapshot was recorded for it, so its diff was never captured; start a fresh job';
  if (!Array.isArray(job.revertFiles) || !job.revertFiles.length)
    return 'it has no in-scope changes to apply (its retained diff is empty); start a fresh job with a better brief';
  // The capture is stamped with the round that made it. A failure after a
  // repair or continuation that never reached its own capture would otherwise
  // leave an earlier round's diff looking like the failed round's.
  const round = Number.isSafeInteger(job.rounds) ? job.rounds : 0;
  if (Number.isSafeInteger(job.patchRound) ? job.patchRound !== round : round !== 0)
    return `its retained diff is not from its final round (round ${round}), so it does not describe the failed state; start a fresh job`;
  return undefined;
}

/** The same call already looped once after a continuation or repair: another one will not help. */
export const loopedAgain = (job) =>
  !!(
    safeFailureKind(job?.failureKind) === 'tool-loop' &&
    typeof job.toolFailure?.signature === 'string' &&
    job.toolFailure.signature === job.priorLoopSignature
  );

const DEFECT_LEAD = {
  'finish-protocol':
    'Your previous pass was stopped because you called finish in the same turn as other tool calls (or with invalid arguments) twice; the server ran none of the calls in those turns, so re-issue any that you still need. Your partial work is already in the workspace (inspect it with git status / git diff or by reading the files). Do not restart, redo, or discard it. Finish any remaining work with ordinary tool calls first, then call finish ALONE: finish must be the only tool call in its turn, with a valid summary.',
  'no-finish':
    'Your previous pass ended without calling the finish tool, so the server stopped it. Your partial work is already in the workspace (inspect it with git status / git diff or by reading the files). Do not restart, redo, or discard it. Complete the remaining acceptance criteria, then call finish as the sole tool call.',
  'output-cap':
    'Your previous pass kept hitting the response-size cap without making a tool call, so the server stopped it. Your partial work is already in the workspace (inspect it with git status / git diff or by reading the files). Do not restart, redo, or discard it. Keep each response short, write one complete file per response, call a tool immediately, and call finish when the acceptance criteria are met.',
};

/**
 * The first line of a continuation's task for a worker-side FAILED round. The
 * worker only ever saw "Tool execution failed", so for a loop it is told which
 * call failed (bounded and redacted, in `toolFailure`) and the same fixed hint
 * toolErrorHint would have given it, never the recorded error itself.
 */
export function failureContinueDefect(job) {
  const kind = safeFailureKind(job?.failureKind);
  if (kind !== 'tool-loop') return DEFECT_LEAD[kind] ?? DEFECT_LEAD['no-finish'];
  const failure = safeToolFailure(job.toolFailure);
  // Only the closed hint, never the recorded error: a policy refusal (denied,
  // escaping) would otherwise reach the worker through the primary's continue.
  const hint = failure?.error && toolErrorHint(failure.error.replace(/^E[A-Z0-9_]{2,40}: /, ''));
  const call = failure
    ? ` Last failing call (turn ${failure.turn}): ${failure.tool}${failure.args ? ` ${failure.args}` : ''}${hint ? `; hint: ${hint}` : ''}.`
    : '';
  return `Your previous pass was stopped by the server's loop guard: an identical tool call failed 3 times (you were only shown "Tool execution failed").${call} Do NOT repeat that call or a trivial variation. First work out why it fails (re-read the file for its current text, check the path and exact arguments, or choose a different tool or approach), then proceed differently. Your partial work is already in the workspace (inspect it with git status / git diff or by reading the files). Do not restart, redo, or discard it. Complete the remaining acceptance criteria, then finish.`;
}

// A closed table over OUR OWN tool messages (anchored), plus a few error codes.
// The worker sees one of these fixed strings and never any part of the message,
// so a path, a command's output or a secret in an error cannot reach the model.
// Deliberately absent: hints for a missing path, an out-of-scope or Git-ignored
// write, and the read-denied, path-escape and write-denied codes. Policy refuses
// before any filesystem access, so a hint on "missing" (or on "scope") but none on
// "denied" would let a worker tell the two apart and probe for protected paths.
// Every entry below fires only after the path passed policy.
const MESSAGE_HINTS = [
  [/^Refusing edit without prior read/, 'read_file the file again first; every successful edit or write clears the earlier read'],
  [/^Refusing overwrite without prior complete read/, 'read_file the existing file first, or use edit_file for a small change'],
  [/^Refusing stale /, 'the file changed since you read it; read_file it again'],
  [/^old_string was not found/, 'old_string is not in the file; read_file it again and copy the exact current text'],
  [/^old_string must match exactly once/, 'old_string matches more than once; add surrounding lines or set replace_all'],
  [/^old_string must not be empty/, 'old_string must not be empty'],
  [/^edit arguments are invalid/, 'edit_file needs string path, old_string and new_string and a boolean replace_all'],
  [/^content must be a string up to/, 'content is too large for one write; split it across files or use edit_file'],
  [/^Refusing (?:edit|overwrite) of file larger than/, 'that file is over the in-place edit size limit; do not retry it'],
  [/^Refusing read: requested/, 'that offset is too deep; use grep to locate the lines or read from a smaller offset'],
  // The one digit run echoed is the tool's own byte cap, matched in full: no path or file text can reach the worker.
  [
    /^limit must be an integer between 0 and (\d{1,7})$/,
    ([, cap]) => `read_file limit is at most ${cap} bytes per call; omit limit or pass a smaller one, then continue from the next offset`,
  ],
  [
    /^offset must be an integer between 0 and \d{1,16}$/,
    'read_file offset must lie inside the file; omit offset to start at the beginning, or use the next offset from the last page',
  ],
];

export function toolErrorHint(error) {
  const message = typeof error === 'string' ? error : error?.message;
  if (typeof message === 'string')
    for (const [pattern, hint] of MESSAGE_HINTS) {
      const match = pattern.exec(message);
      if (match) return typeof hint === 'function' ? hint(match) : hint;
    }
  return undefined;
}
