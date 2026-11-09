import { createHash } from 'node:crypto';
import { revertPathsProblem } from './revert-paths.mjs';
import { applyPathAliases, redact, redactText, stripTerminalControls } from './redact.mjs';

/**
 * Why a worker round ended FAILED, in a form that is safe to persist, show a
 * primary and (for a few worker-side kinds) act on. Pure and dependency-free
 * (no job-manager import) so the loop, the manager and the report share one
 * definition and cannot drift.
 *
 * The kinds below are the only FAILED causes a continuation may resume: the
 * worker, not the provider, the sandbox or the repository, ran out of road (or
 * broke the finish protocol twice, which the server corrected once already).
 * Specific transcript-corruption failures also qualify through a separate gate.
 * Everything else (other provider failures, a protocol fault, a scope violation, a
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

export const LOCAL_TRANSCRIPT_CORRUPTION = 'corrupt transcript: invalid interior JSON';
export const retryableTranscriptFailure = (job) =>
  job?.status === 'FAILED' &&
  ((!job.providerFailure && job.error === LOCAL_TRANSCRIPT_CORRUPTION) ||
    (job.providerFailure?.kind === 'transcript_corruption' && job.error === 'Provider transcript was corrupt'));

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

// Redact before clipping so a secret is never cut into an unrecognizable prefix.
const sanitize = (value, limit, aliases = [], secrets = []) =>
  clip(
    redactText(applyPathAliases(redactText(stripTerminalControls(String(value)), secrets), aliases), secrets)
      .replace(/[\r\n\t]+/g, ' ')
      .trim(),
    limit,
  );

function summarizeArgs(parsed, aliases, secrets) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}';
  const reduced = {};
  for (const [key, value] of Object.entries(parsed).slice(0, MAX_ARG_KEYS)) {
    const label = sanitize(key, 40, [], secrets);
    if (typeof value === 'string')
      reduced[label] = BODY_KEYS.has(key) ? `<${value.length} chars>` : sanitize(value, VALUE_CHARS, aliases, secrets);
    else if (value === null || typeof value === 'number' || typeof value === 'boolean') reduced[label] = value;
    else reduced[label] = Array.isArray(value) ? '<array>' : '<object>';
  }
  // Key-aware pass: a `token`/`password` argument is masked wholesale.
  return sanitize(JSON.stringify(redact(reduced, secrets)), FIELD_CHARS, aliases, secrets);
}

function summarizeError(error, aliases, secrets) {
  const message = typeof error === 'string' ? error : String(error?.message ?? '');
  const first = redactText(stripTerminalControls(message), secrets)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return 'Tool execution failed';
  const code = typeof error?.code === 'string' && ERROR_CODE.test(error.code) && !first.includes(error.code) ? `${error.code}: ` : '';
  return sanitize(`${code}${first}`, FIELD_CHARS, aliases, secrets);
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
export function summarizeToolFailure({ calls, parsed = [], values, errors = [], turn, repeats, pathAliases = [], secrets = [] }) {
  const index = values.findIndex((value) => typeof value === 'string' && value.startsWith('TOOL_ERROR:'));
  if (index < 0) return undefined;
  const name = String(calls[index]?.name ?? '');
  const tool = TOOL_NAME.test(name) ? name : 'unknown';
  const args = summarizeArgs(parsed[index], pathAliases, secrets);
  return {
    tool,
    args,
    error: summarizeError(errors[index], pathAliases, secrets),
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
export function safeToolFailure(value, { secrets = [] } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (typeof value.tool !== 'string' || !TOOL_NAME.test(value.tool)) return undefined;
  if (!Number.isSafeInteger(value.turn) || value.turn < 0 || value.turn > MAX_TURN) return undefined;
  if (!Number.isSafeInteger(value.repeats) || value.repeats < 1 || value.repeats > MAX_REPEATS) return undefined;
  const out = { tool: value.tool, turn: value.turn, repeats: value.repeats };
  for (const key of ['args', 'error']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > 4 * FIELD_CHARS) return undefined;
    out[key] = sanitize(value[key], FIELD_CHARS, [], secrets);
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
 * one of ours AND `error` is still exactly that kind's canonical text, or it
 * matches the specific transcript-corruption gate below, so a
 * later scope, snapshot or repair-setup failure that overwrote `error` cannot
 * be resumed by accident.
 */
export function continuableFailure(job) {
  if (!job || typeof job !== 'object' || job.mode === 'report' || job.status !== 'FAILED') return false;
  const kind = safeFailureKind(job.failureKind);
  const transcriptFailure = retryableTranscriptFailure(job);
  if (!transcriptFailure && (!kind || job.error !== FAILURE_ERRORS[kind])) return false;
  if (
    (!transcriptFailure && job.providerFailure) ||
    job.branchChanged ||
    job.integrationConflict ||
    job.integrationUncertain ||
    job.revertUncertain
  )
    return false;
  if (job.workspaceCleanupRequired || job.applied === true) return false;
  if (job.scopeViolations?.length || job.verifierMutations?.length) return false;
  // A filtered response is deterministic: re-sending the same conversation spends another round for the same stop.
  if (job.providerFinishReason === 'content_filter') return false;
  return !loopedAgain(job);
}

const WALL_TIMEOUT_CODE = 'OFFLOAD_WALL_TIMEOUT';
/** The abort reason JobManager's watchdog gives a round that outlived limits.timeoutMinutes. */
export const wallTimeoutError = () =>
  Object.assign(new Error('job wall-clock limit (timeoutMinutes) exceeded'), { code: WALL_TIMEOUT_CODE });
/** True when a job signal was aborted by the wall-clock watchdog rather than by a cancel. */
export const isWallTimeout = (reason) => reason?.code === WALL_TIMEOUT_CODE;
/**
 * Statuses whose diff is kept un-integrated and may be applied by the primary
 * with its own evidence. A FAILED job joins them only through
 * `failedApplyRefusal`, never by status alone; CANCELLED only through
 * `cancelledRepairApplyRefusal`, for a repair round the server queued and the
 * primary cancelled over a failure the verifier blamed on the environment.
 */
export const APPLY_ELIGIBLE_STATUSES = Object.freeze(['VERIFY_ENV_FAILED', 'VERIFY_FAILED', 'BUDGET', 'TIMEOUT']);

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * The checks every late apply shares: nothing about the job may be
 * outstanding, and its capture must describe a whole, reviewable diff that the
 * scope audit let through. Returns why the retained diff must not be offered to
 * `offload_apply`, or undefined when these checks pass; each gate below adds
 * its own status and round-identity conditions on top.
 */
function lateApplyRefusal(job) {
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
  const pathsProblem = revertPathsProblem(job.revertFiles);
  if (pathsProblem) return pathsProblem;
  return undefined;
}

/**
 * The gate `JobManager.apply()` enforces and the report advertises `apply` with
 * for a job whose status is FAILED. Returns why its retained diff must not be
 * offered to `offload_apply`, or undefined when it may be. Any failure cause
 * qualifies (a finish-protocol or loop stop is no verdict on a diff the scope
 * audit passed), but only when the shared checks pass and the capture belongs
 * to the final round; the manager adds the I/O half, binding the stored
 * `revert.diff` to the recorded snapshots, and every conflict, lease,
 * branch/HEAD and index check of the other apply statuses still runs.
 */
export function failedApplyRefusal(job) {
  const shared = lateApplyRefusal(job);
  if (shared) return shared;
  // The capture is stamped with the round that made it. A failure after a
  // repair or continuation that never reached its own capture would otherwise
  // leave an earlier round's diff looking like the failed round's.
  const round = Number.isSafeInteger(job.rounds) ? job.rounds : 0;
  if (Number.isSafeInteger(job.patchRound) ? job.patchRound !== round : round !== 0)
    return `its retained diff is not from its final round (round ${round}), so it does not describe the failed state; start a fresh job`;
  return undefined;
}

/**
 * The one exception to "a CANCELLED job is never applied": the server queued an
 * automatic repair round on its own, the primary cancelled that round because
 * the verifier failure was not the diff's fault, and the repair left the diff
 * exactly as the primary reviewed it in round N. `repairBase` keeps that round's
 * verify result and tree id because ROUND_SCOPED_VERIFIER_STATE resets the live
 * ones, and a content-identical tree keeps the same id. Returns the reason it is
 * refused, or undefined when the round-N diff may be applied.
 */
export function cancelledRepairApplyRefusal(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return 'no job record';
  // A job the primary cancelled on purpose keeps its diff unless the cancel
  // hit a repair round the server started by itself.
  if (job.status !== 'CANCELLED')
    return `only a job CANCELLED during its automatic repair is applied this way, not a ${job.status ?? 'non-terminal'} one`;
  const shared = lateApplyRefusal(job);
  if (shared) return shared;
  const base = job.repairBase && typeof job.repairBase === 'object' && !Array.isArray(job.repairBase) ? job.repairBase : undefined;
  if (base?.auto !== true || !Number.isSafeInteger(base.round) || !GIT_OBJECT_ID.test(base.workspaceAfter ?? ''))
    return 'it was not cancelled during an automatic repair, so no reviewed round-N diff was kept; start a fresh job';
  if (job.workspaceAfter !== base.workspaceAfter)
    return `the cancelled repair round changed the diff after round ${base.round}, so it is not the reviewed round-${base.round} diff; start a fresh job`;
  return undefined;
}

/**
 * Why a finished job with changes could not be applied, from the same check the
 * apply itself makes, so the report and job view cannot promise what it refuses.
 */
export function applyBlocker(job) {
  if (!job || job.mode === 'report' || job.applied === true || job.revertedAt) return undefined;
  // A job cancelled during an automatic repair is offered only through its own
  // gate; when that gate refuses it (usually because the repair round changed
  // the diff) the report says why instead of silently dropping the apply offer.
  if (job.status === 'CANCELLED') return job.repairBase?.auto === true ? cancelledRepairApplyRefusal(job) : undefined;
  if (job.status !== 'FAILED' && !APPLY_ELIGIBLE_STATUSES.includes(job.status)) return undefined;
  if (!Array.isArray(job.files) || !job.files.length || !Array.isArray(job.revertFiles)) return undefined;
  return revertPathsProblem(job.revertFiles);
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
    'Your previous pass was stopped because you kept calling finish in the same turn as other tool calls or with invalid arguments; the server ran none of the calls in those turns, so re-issue any that you still need. Keep summary to 1-2 sentences, and make concerns and testsRun arrays of strings. Your partial work is already in the workspace (inspect it with git status / git diff or by reading the files). Do not restart, redo, or discard it. Finish any remaining work with ordinary tool calls first, then call finish ALONE: finish must be the only tool call in its turn, with a valid summary.',
  'no-finish':
    'Your previous pass ended without calling the finish tool, so the server stopped it. Your partial work is already in the workspace (inspect it with git status / git diff or by reading the files). Do not restart, redo, or discard it. Complete the remaining acceptance criteria, then call finish as the sole tool call.',
  'output-cap':
    'Your previous pass kept hitting the response-size cap without making a tool call, so the server stopped it. Your partial work is already in the workspace (inspect it with git status / git diff or by reading the files). Do not restart, redo, or discard it. Keep each response short and call a tool immediately. Never put a whole large file in one tool call: write a small first part (at most about 150 lines or 6 KB), then add each next part with write_file append true, one part per call. Call finish when the acceptance criteria are met.',
};

/**
 * The first line of a continuation's task for a worker-side FAILED round. The
 * worker only ever saw "Tool execution failed", so for a loop it is told which
 * call failed (bounded and redacted, in `toolFailure`) and the same fixed hint
 * toolErrorHint would have given it, never the recorded error itself.
 */
export function failureContinueDefect(job) {
  if (retryableTranscriptFailure(job))
    return 'The previous pass stopped on transcript corruption. Your partial work is already in the workspace. Inspect each owned path against the original task and acceptance criteria, complete the remaining work, then finish. Do not discard or redo completed work.';
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
  [
    /^content must be a string up to/,
    'content is too large for one write; write a small first part, then add the rest with write_file append true',
  ],
  [/^Refusing (?:edit|overwrite|append) of file larger than/, 'that file is over the in-place edit size limit; do not retry it'],
  [
    /^Refusing append to missing file/,
    'append needs an existing file; write_file a small first part without append, then append the next part',
  ],
  [/^Refusing append without prior read or write/, 'read_file that file first (any window), then append'],
  [/^append must be a boolean/, 'write_file append must be true or false'],
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
