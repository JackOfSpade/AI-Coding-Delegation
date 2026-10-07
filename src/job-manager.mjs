import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compactReport, terminalStatuses } from './report.mjs';
import { matchesAny, normalizePath, pathsOverlap } from './glob.mjs';
import { parseKeyRef } from './secrets.mjs';
import { modelPolicyViolation } from './model-policy.mjs';
import { diffTreeFiles, diffTrees, git as snapshotGit } from './git-snapshot.mjs';
import { copyReportInputs, prepareReportInputsForCleanup, reportInputRoots, validateReportInputFiles } from './report-inputs.mjs';
import { redactText, redactTokenShapes, redactedSummary } from './redact.mjs';
import { jobLogWindow, resolveLogWindow } from './diagnostics.mjs';
import { MAX_RETROSPECTIVE_JOBS } from './retrospective.mjs';
import {
  APPLY_ELIGIBLE_STATUSES,
  FAILURE_ERRORS,
  FAILURE_KINDS,
  continuableFailure,
  failedApplyRefusal,
  failureContinueDefect,
  loopedAgain,
  reportToolFailure,
  safeFailureKind,
  safeToolFailure,
} from './failure.mjs';
import { isolatedDependencyReadPaths } from './worktree.mjs';
import { classifyVerifierEnvironment } from './verify-env.mjs';
import {
  interpreterPathsOption,
  normalizeInterpreterDeclaration,
  publicVerifierInterpreter,
  validateInterpreterRoots,
} from './verify-interpreter.mjs';
import {
  APPLY_VERIFY_PHASES,
  APPLY_VERIFY_RECORD_COMMAND,
  MAX_APPLY_VERIFY_COMMAND,
  applyVerifyTail,
  classifyApplyVerifyRun,
  normalizeApplyVerify,
  publicApplyVerify,
} from './apply-verify.mjs';
import { PathPolicy } from './policy.mjs';
import {
  buildBudgetSizing,
  measureFiles,
  recommendTurns,
  resolveTurnBudget,
  raiseBudgetSizing,
  safeBudgetSizing,
  splitRelevantPath,
} from './budget-sizing.mjs';
import { RoundClock, assessStall, mergeRound, sanitizeActivity, sanitizeTiming } from './timing.mjs';
import {
  commandStopsEarly,
  compareFailureRuns,
  createFailureCollector,
  describeBaseline,
  outputWasTruncated,
  repairDefectText,
} from './verify-baseline.mjs';

const allowedEffort = new Set(['normal', 'high']);
const VERIFIER_MODES = new Set(['standard', 'baseline-diff']);
const MIN_VERIFIER_TIMEOUT_SEC = 5,
  MAX_VERIFIER_TIMEOUT_SEC = 1800,
  // Each of the two baseline-diff runs gets this unless the caller says otherwise;
  // a full suite routinely outlasts the one-minute default of a standard verifier.
  BASELINE_VERIFIER_TIMEOUT_SEC = 300,
  MAX_BASELINE_CACHE = 32;
const final = (status) => terminalStatuses.has(status);
// Lifecycle Git probes never need a provider credential. Reuse the snapshot
// helper so every branch/head/index query receives the same scrubbed
// environment, inert hooks, disabled filters, and fsmonitor hardening.
const git = (repo, args) => snapshotGit(repo, args).trim();
const MAX_PATHS = 128,
  MAX_PATH_LENGTH = 1024,
  MAX_TASK = 32_000,
  MAX_CRITERIA = 100,
  MAX_CRITERION = 4_000,
  MAX_REPAIR_ITEMS = 32,
  MAX_REPAIR_ITEM = 4_000,
  MAX_REPAIR_CHARS = 16_000;
const assertDetail = (detail) => {
  if (detail !== 'compact' && detail !== 'full') throw new Error('detail must be compact or full');
};
const PRE_MUTATION_ERRORS = new Set([
  'E_WORKTREE_CONFLICT',
  'E_WORKTREE_APPLY_CHECK',
  'E_WORKTREE_DIFF',
  'E_WORKTREE_VERIFY',
  'E_WORKTREE_PRIMARY_SNAPSHOT',
  'E_WORKTREE_TREE',
  'E_WORKTREE_REPO',
  'E_WORKTREE_PATHS',
]);
// A verifier result and its pre-verifier worker snapshot describe one round.
// Carried into the next round they make the verifier-authorship audit diff that
// round's own edits against a stale snapshot, so a round that stops on a cap
// (and never reaches the verifier) would be failed for its own work. A reverted
// applyThenVerify record is the same kind of thing: only a job that is not
// applied can be repaired or continued, so the record describes an attempt the
// new round supersedes. Left in place it would contradict a DONE_VERIFIED,
// auto-integrated result (and tell the reader to apply again).
const ROUND_SCOPED_VERIFIER_STATE = Object.freeze({
  verify: undefined,
  workerAfter: undefined,
  verifyEnvironment: undefined,
  applyVerify: undefined,
});
// A terminal `error` describes the round that just ended (a BUDGET cap, a
// verifier-adjacent failure). A queued repair or continuation starts a new
// round, and a round that later succeeds only sets `error` when it has its own,
// so an unreset value would survive onto a DONE_VERIFIED job as a false
// failure (and keep it flagged as needing diagnosis). The failure kind and the
// failing call travel with the error: a stale continuable marker must never
// outlive the round it described.
const ROUND_SCOPED_ERROR_STATE = Object.freeze({ error: undefined, budgetStop: undefined, failureKind: undefined, toolFailure: undefined });
const APPLY_ELIGIBLE = new Set(APPLY_ELIGIBLE_STATUSES);
const MIN_VERIFIED_BY = 8,
  MAX_VERIFIED_BY = 1000;
// What a clean automatic revert puts back so the job is exactly as apply-eligible
// as before the attempt. `after` is restored separately from the pre-apply record.
const APPLY_RESET = Object.freeze({
  applied: false,
  revertedAt: undefined,
  revertAfter: undefined,
  revertOutcome: undefined,
  revertIntent: false,
  revertUncertain: false,
  revertIntentAt: undefined,
  revertPaths: undefined,
  revertExpectedTree: undefined,
  integrationOutcome: undefined,
  primaryAfter: undefined,
  integrationFiles: undefined,
});
const MAX_CONTINUE_TURNS = 500,
  MAX_CONTINUE_USD = 50;
// The no-argument job list: active jobs plus this server session's, newest first.
const DEFAULT_LIST_JOBS = 20,
  MAX_LIST_JOBS = 100,
  LIST_TASK_CHARS = 100;
// Waiting for a worker to claim the round: `startedAt` still names an earlier round, if any.
const QUEUED_STATUSES = new Set(['QUEUED', 'REPAIR_QUEUED']);
// A job that has not finished a round or reported usage yet has no costUsd: it
// has spent nothing so far, which is not an unknown cost. Only a malformed
// value, or a finished job that never recorded one, is unknown.
const costOf = (job) => {
  // Rounded so a running total of many small calls never prints as 0.12000000000000001.
  if (Number.isFinite(job?.costUsd) && job.costUsd >= 0) return Number(job.costUsd.toFixed(6));
  return job?.costUsd === undefined && job?.status && !final(job.status) ? 0 : null;
};
// Rounded so 0.1 + 0.2 never reaches a report as 0.30000000000000004.
const sumCost = (jobs) => Number(jobs.reduce((total, job) => total + (costOf(job) ?? 0), 0).toFixed(6));
const CONTINUE_DEFECT =
  'Your previous pass stopped at its turn, cost, or time cap before you finished; that is not a verdict on your approach. Your partial work is already in the workspace (inspect it with git status / git diff or by reading the files). Do not restart, redo, or discard it. Complete the remaining acceptance criteria, then finish.';
const MAX_RESULT_TURNS = 1000,
  MAX_RESULT_COST = 10_000,
  MAX_USAGE = 1_000_000_000,
  MAX_REPORT_TEXT = 256_000;
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheHitTokens', 'cacheMissTokens'];
const finiteCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_USAGE;
const filenameTokenCharacter = '[\\p{L}\\p{N}._-]';
const escapeRegExp = (value) => value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
const validGitObjectId = (value) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
const validBranchName = (value) => typeof value === 'string' && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
/** Durable records, leases, CLI and MCP all share this identifier boundary. */
// This also names durable Git refs under refs/offload/jobs/<jobId>/….
// Keep the public/store/lease boundary compatible with Git's conservative
// component grammar rather than accepting IDs that later cannot be pinned.
const listingHint = (omittedByScope, omittedByLimit) =>
  [
    omittedByScope ? 'older terminal jobs are hidden; call offload_job with all:true to list them' : '',
    omittedByLimit ? `raise maxJobs (up to ${MAX_LIST_JOBS}) to list more` : '',
  ]
    .filter(Boolean)
    .join('; ');

/**
 * Merge per-repository listings into one. Each input already honors maxJobs
 * for its own repository, so the merge keeps every active job and the newest
 * terminal ones up to the same cap once, and recomputes the counts from the
 * rows that survive.
 */
export function mergeListings(listings, { maxJobs = DEFAULT_LIST_JOBS } = {}) {
  const rows = listings.flatMap(({ jobs }) => jobs).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const active = rows.filter((row) => !final(row.status)).length;
  let room = Math.max(0, Math.max(maxJobs, active) - active);
  const jobs = rows.filter((row) => (final(row.status) ? room-- > 0 : true));
  const sum = (key) => listings.reduce((total, { listing }) => total + (listing[key] || 0), 0);
  const omittedByScope = sum('omittedByScope'),
    omittedByLimit = sum('omittedByLimit') + (rows.length - jobs.length);
  const unknown = jobs.filter((row) => row.costUsd === null).length;
  return {
    jobs,
    totals: {
      shown: jobs.length,
      omitted: omittedByScope + omittedByLimit,
      omittedByScope,
      omittedByLimit,
      totalCostUsd: Number(jobs.reduce((total, row) => total + (row.costUsd ?? 0), 0).toFixed(6)),
      storeCostUsd: Number(sum('storeCostUsd').toFixed(6)),
      ...(unknown ? { costUnknownJobs: unknown } : {}),
      ...(omittedByScope || omittedByLimit ? { hint: listingHint(omittedByScope, omittedByLimit) } : {}),
    },
  };
}

export const validJobId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export function validateJobId(value) {
  if (!validJobId(value)) throw new Error('valid job id is required');
  return value;
}
const validUsage = (value) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => USAGE_KEYS.includes(key)) &&
  USAGE_KEYS.every((key) => value[key] === undefined || finiteCount(value[key])) &&
  (value.inputTokens === undefined || (value.cacheHitTokens ?? 0) + (value.cacheMissTokens ?? 0) === value.inputTokens);
const boundedString = (value, cap) => (typeof value === 'string' && value.length <= cap ? value : undefined);
/** Take a UTF-8 byte prefix without turning a supplementary-plane character
 * into an unpaired surrogate. Redaction can enlarge short credential values,
 * so this bound must run after sanitizing and redacting external text. */
function truncateUtf8(value, maxBytes) {
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += codePoint.length;
  }
  return value.slice(0, end);
}
function safeReportString(value, maxChars = MAX_REPORT_TEXT) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars || Buffer.byteLength(value, 'utf8') > MAX_REPORT_TEXT)
    return undefined;
  const sanitized = redactText(
    value
      .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, ''),
  );
  // Lists use their existing 1,500-character contract as a tighter byte
  // budget; full reports retain the documented global result limit.
  const bounded = truncateUtf8(sanitized, Math.min(MAX_REPORT_TEXT, maxChars));
  return bounded || undefined;
}
const safeReportText = (value) => safeReportString(value);
const safeReportError = (value) =>
  safeReportString(typeof value === 'string' ? value : String(value || ''), 1500) || 'report worker failed';
const PROVIDER_FAILURE_KINDS = new Set(['request', 'http', 'transport', 'attempt_timeout', 'redirect', 'sse_protocol', 'sse_limit']);
const PROVIDER_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter', 'other']);
const CAPPED_FINISH_RECOVERY_STATES = new Set(['queued', 'consumed', 'settled']);
const BUDGET_FINISH_RECOVERY_STATES = new Set(['queued', 'consumed']);
const safeProviderFinishReason = (value) => {
  if (typeof value !== 'string') return undefined;
  return PROVIDER_FINISH_REASONS.has(value) ? value : 'other';
};
const BUDGET_RESERVATION_PROJECTIONS = new Set(['raw', 'tool-elision', 'deep-tool-elision']);
const MAX_BUDGET_RESERVATION_NUMBER = 10_000_000_000;
const safeBudgetReservationNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_BUDGET_RESERVATION_NUMBER ? value : undefined;
// This record deliberately contains arithmetic only.  It is attached to a
// public job/event, so reject rather than coerce anything that could carry a
// transcript, path, provider response, or unbounded size.
const safeBudgetReservation = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = [
    'conservativeInputTokens',
    'conservativeInputUsd',
    'minOutputTokens',
    'minOutputUsd',
    'remainingUsd',
    'requiredUsd',
    'shortfallUsd',
    'projection',
    'elidedToolResults',
  ];
  if (Object.keys(value).some((key) => !keys.includes(key))) return undefined;
  if (
    !Number.isSafeInteger(value.conservativeInputTokens) ||
    value.conservativeInputTokens < 0 ||
    value.conservativeInputTokens > MAX_USAGE ||
    value.minOutputTokens !== 16 ||
    !Number.isSafeInteger(value.elidedToolResults) ||
    value.elidedToolResults < 0 ||
    value.elidedToolResults > MAX_USAGE ||
    !BUDGET_RESERVATION_PROJECTIONS.has(value.projection)
  )
    return undefined;
  for (const key of ['conservativeInputUsd', 'minOutputUsd', 'remainingUsd', 'requiredUsd', 'shortfallUsd'])
    if (safeBudgetReservationNumber(value[key]) === undefined) return undefined;
  if (
    Math.abs(value.requiredUsd - (value.conservativeInputUsd + value.minOutputUsd)) > 1e-12 ||
    Math.abs(value.shortfallUsd - Math.max(0, value.requiredUsd - value.remainingUsd)) > 1e-12
  )
    return undefined;
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
};
const BUDGET_CAPS = new Set(['turns', 'usd', 'reservation', 'other']);
const MAX_BUDGET_STOP_USD = 10_000;
// Which cap ended a BUDGET round and what had been spent against it. Numbers
// only: it reaches public views, events and the report.
const safeBudgetStop = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !BUDGET_CAPS.has(value.cap)) return undefined;
  const turn = (number) => Number.isSafeInteger(number) && number >= 0 && number <= MAX_RESULT_TURNS;
  const usd = (number) => Number.isFinite(number) && number >= 0 && number <= MAX_BUDGET_STOP_USD;
  if (!turn(value.turns) || !turn(value.maxTurns) || !usd(value.costUsd) || !usd(value.maxUsd)) return undefined;
  return { cap: value.cap, turns: value.turns, maxTurns: value.maxTurns, costUsd: value.costUsd, maxUsd: value.maxUsd };
};
// A worker names the cap it tripped, but the manager is the accounting
// authority: a custom or forged label falls back to comparing the totals.
function budgetStopFor({ reported, turns, costUsd, budget }) {
  const stop = {
    cap: BUDGET_CAPS.has(reported)
      ? reported
      : turns >= (budget?.maxTurns ?? Infinity)
        ? 'turns'
        : costUsd >= (budget?.maxUsd ?? Infinity)
          ? 'usd'
          : 'other',
    turns,
    maxTurns: budget?.maxTurns,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    maxUsd: budget?.maxUsd,
  };
  return safeBudgetStop(stop);
}
// The closed, bounded, re-sanitized view of why a worker round FAILED. Only a
// FAILED job shows it: a continued round that ends otherwise has reset it.
const failureView = (job) => {
  const failureKind = safeFailureKind(job?.failureKind);
  const toolFailure = safeToolFailure(job?.toolFailure);
  return { ...(failureKind ? { failureKind } : {}), ...(toolFailure ? { toolFailure } : {}) };
};
const safeProviderFailure = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !PROVIDER_FAILURE_KINDS.has(value.kind)) return undefined;
  const failure = { kind: value.kind };
  if (Number.isSafeInteger(value.attempts) && value.attempts > 0 && value.attempts <= 16) failure.attempts = value.attempts;
  if (value.kind === 'http' && Number.isSafeInteger(value.status) && value.status >= 100 && value.status <= 599)
    failure.status = value.status;
  if (value.kind === 'attempt_timeout' && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 30_000 && value.timeoutMs <= 600_000)
    failure.timeoutMs = value.timeoutMs;
  return failure;
};
const providerFailureMessage = (failure) => {
  switch (failure?.kind) {
    case 'attempt_timeout':
      return failure.timeoutMs ? `Provider request timed out after ${Math.floor(failure.timeoutMs / 1000)}s` : 'Provider request timed out';
    case 'redirect':
      return 'Provider redirect rejected';
    case 'http':
      return failure.status ? `Provider request failed (HTTP ${failure.status})` : 'Provider request failed';
    case 'sse_protocol':
      return 'Provider response stream was invalid';
    case 'sse_limit':
      return 'Provider response stream exceeded a safety limit';
    default:
      return 'Provider request failed';
  }
};
const safeReportList = (value) =>
  Array.isArray(value)
    ? value
        .map((item) => safeReportString(item, 1500))
        .filter(Boolean)
        .slice(0, 100)
    : [];
const boundedStrings = (value, count = 100, cap = 1500) =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length <= cap).slice(0, count) : undefined;
function cleanText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r]/.test(value);
}
/** Validate only a caller-supplied repository hint. Undefined means the
 * caller intentionally left routing to Core; an empty/relative hint must
 * never silently select the server's cwd or a client environment fallback. */
export function validateExplicitRepoPath(value) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0-\x1f\x7f]/.test(value) || !isAbsolute(value))
    throw new Error('repoPath must be a non-empty absolute path');
}
function canonicalPaths(paths, required = true) {
  if (!Array.isArray(paths) || paths.length > MAX_PATHS || (required && paths.length === 0)) return null;
  try {
    const normalized = paths.map((path) => {
      // Backslashes are deliberately never scope syntax. On POSIX they name
      // a different file, so accepting them here would create path aliases.
      if (!cleanText(path, MAX_PATH_LENGTH) || path.includes('\\')) throw new Error('invalid path');
      const normalizedPath = normalizePath(path);
      if (normalizedPath !== path) throw new Error('non-canonical path');
      return normalizedPath;
    });
    return new Set(normalized).size === normalized.length ? normalized : null;
  } catch {
    return null;
  }
}
function validPaths(paths, required = true) {
  return canonicalPaths(paths, required) !== null;
}
// relevantPaths entries are advisory reading hints, so unlike a scope they may
// carry a ":START-END" 1-based inclusive line range. Each path part is held to
// exactly the canonicalPaths rules and the range must round-trip (no leading
// zeros), so one spelling means one thing at every validation boundary.
function canonicalRelevantPaths(paths) {
  if (!Array.isArray(paths) || paths.length > MAX_PATHS) return null;
  const entries = [];
  for (const entry of paths) {
    if (!cleanText(entry, MAX_PATH_LENGTH)) return null;
    const split = splitRelevantPath(entry);
    if (split.invalid) return null;
    const plain = canonicalPaths([split.path]);
    if (!plain) return null;
    const canonical = split.range ? `${plain[0]}:${split.range.start}-${split.range.end}` : plain[0];
    if (canonical !== entry) return null;
    entries.push(canonical);
  }
  return new Set(entries).size === entries.length ? entries : null;
}
function validExecutionProfile(value) {
  if (value == null) return true;
  const permitted = new Set(['type', 'baseUrl', 'keyRef', 'model', 'effort', 'pricing', 'pricingFile', 'attemptTimeoutMs']);
  const cleanProviderText = (text, maximum) =>
    typeof text === 'string' && text.length > 0 && text.length <= maximum && !/[\x00-\x1f\x7f]/.test(text);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !permitted.has(key)) ||
    value.type !== 'openai-chat' ||
    !cleanProviderText(value.baseUrl, 2048) ||
    !cleanText(value.model, 128) ||
    modelPolicyViolation(value) ||
    !cleanText(value.keyRef, 4096) ||
    (value.effort !== undefined && !allowedEffort.has(value.effort)) ||
    (value.pricing !== undefined && !cleanProviderText(value.pricing, 128)) ||
    (value.pricingFile !== undefined && (!cleanProviderText(value.pricingFile, 4096) || !isAbsolute(value.pricingFile))) ||
    (value.attemptTimeoutMs !== undefined &&
      (!Number.isSafeInteger(value.attemptTimeoutMs) || value.attemptTimeoutMs < 30_000 || value.attemptTimeoutMs > 600_000))
  )
    return false;
  try {
    parseKeyRef(value.keyRef);
    const url = new URL(value.baseUrl);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
// `writePaths` is a convenience snapshot written alongside a job, never an
// authority. Derive the operative scope from fields validated at every
// persisted-job boundary so a modified record cannot widen a lease or sandbox.
// Bounded diagnostic only: why a verifier can or cannot import the primary's
// installed dependencies. Never an authority; reads come from the live link.
const DEPENDENCY_STATES = new Set([
  'linked',
  'absent',
  'not-a-directory',
  'wrong-owner',
  'unresolvable',
  'not-canonical',
  'tracked',
  'link-failed',
  'not-linked',
]);
const VERIFY_ENV_KINDS = new Set(['missing-package', 'command-not-found', 'permission-denied', 'temp-dir-denied']);
const safeVerifyEnvironment = (value) =>
  VERIFY_ENV_KINDS.has(value?.kind)
    ? {
        kind: value.kind,
        detail: String(value.detail ?? '').slice(0, 240),
        ...(value.specifier ? { specifier: String(value.specifier).slice(0, 214) } : {}),
      }
    : undefined;
const BASELINE_STATUSES = new Set(['compared', 'skipped', 'inconclusive']);
const baselineCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0);
const baselineRunSummary = (value, { cached = false } = {}) =>
  value && typeof value === 'object'
    ? {
        code: Number.isSafeInteger(value.code) ? value.code : null,
        failures: baselineCount(value.failures),
        distinct: baselineCount(value.distinct),
        durationMs: baselineCount(value.durationMs),
        ...(cached ? { cached: value.cached === true } : {}),
        ...(Number.isSafeInteger(value.summaryFailed) && value.summaryFailed >= 0 ? { summaryFailed: value.summaryFailed } : {}),
      }
    : undefined;
// A bounded projection of the baseline-diff comparison. Failing test names come
// from the worker-influenced test output, so they are control-stripped and capped.
const safeVerifyBaseline = (value) => {
  if (value?.mode !== 'baseline-diff' || !BASELINE_STATUSES.has(value.status)) return undefined;
  const text = (item, max) =>
    String(item ?? '')
      .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
      .replace(/[\x00-\x1F\x7F-\x9F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, ' ')
      .trim()
      .slice(0, max);
  const baseline = baselineRunSummary(value.baseline, { cached: true });
  const result = baselineRunSummary(value.result);
  return {
    mode: 'baseline-diff',
    status: value.status,
    ...(typeof value.reason === 'string' && /^[a-z][a-z-]{0,59}$/.test(value.reason) ? { reason: value.reason } : {}),
    ...(typeof value.format === 'string' && /^[a-z+-]{1,60}$/.test(value.format) ? { format: value.format } : {}),
    ...(baseline ? { baseline } : {}),
    ...(result ? { result } : {}),
    preexisting: baselineCount(value.preexisting),
    fixed: baselineCount(value.fixed),
    newFailureCount: baselineCount(value.newFailureCount),
    newFailures: (Array.isArray(value.newFailures) ? value.newFailures : []).slice(0, 50).map((name) => text(name, 160)),
    ...(value.regression === true ? { regression: true } : {}),
  };
};
const publicVerifierDeps = (job) => {
  const recorded = safeVerifierDeps(job.workspaceVerifierDeps);
  if (recorded)
    return {
      verifierDeps: recorded.verifierDeps,
      ...(recorded.reason ? { verifierDepsReason: recorded.reason } : {}),
      ...(recorded.nestedCount ? { verifierDepsNested: recorded.nestedCount } : {}),
    };
  // Records created before the readiness probe only know the link outcome.
  if (!DEPENDENCY_STATES.has(job.workspaceDependencies)) return {};
  return job.workspaceDependencies === 'linked'
    ? { verifierDeps: 'ok' }
    : { verifierDeps: 'missing', verifierDepsReason: job.workspaceDependencies };
};
const VERIFIER_DEPS = new Set(['ok', 'partial', 'missing', 'not-applicable']);
const safeVerifierDeps = (value) =>
  VERIFIER_DEPS.has(value?.verifierDeps)
    ? {
        verifierDeps: value.verifierDeps,
        ...(typeof value.reason === 'string' && /^[a-z-]{1,40}$/.test(value.reason) ? { reason: value.reason } : {}),
        ...(Number.isSafeInteger(value.nestedCount) && value.nestedCount > 0 ? { nestedCount: value.nestedCount } : {}),
      }
    : undefined;
const workspaceDependencyState = (workspace) => ({
  ...(DEPENDENCY_STATES.has(workspace?.dependencies?.nodeModules) ? { workspaceDependencies: workspace.dependencies.nodeModules } : {}),
  ...(safeVerifierDeps(workspace?.dependencies?.verifierDeps)
    ? { workspaceVerifierDeps: safeVerifierDeps(workspace.dependencies.verifierDeps) }
    : {}),
});
const writeScope = (job) => [...(job.ownedPaths || []), ...(job.extraWritable || [])];
const JOB_INPUT_KEYS = [
  'task',
  'mode',
  'acceptanceCriteria',
  'ownedPaths',
  'inputFiles',
  'relevantPaths',
  'testCommand',
  'testCommandSource',
  'requireSandbox',
  'unsafePolicyOnlyVerifier',
  'profile',
  'effort',
  'maxRepairRounds',
  'budget',
  'allowNetwork',
  'extraWritable',
  'repoPath',
  'denyRead',
  'configuredModel',
  'executionProfile',
  'pricingId',
  'pricingFetchedAt',
  'pricingSnapshot',
  'sandboxMode',
  'verifierMode',
  'verifierTimeoutSec',
  'verifierInterpreter',
  'verifierInterpreterRoots',
];
const jobInput = (input) =>
  Object.fromEntries(JOB_INPUT_KEYS.flatMap((key) => (input[key] === undefined ? [] : [[key, structuredClone(input[key])]])));
function changedFiles(patch) {
  // Real snapshots always supply an authoritative NUL file list. This parser
  // remains solely for legacy injected test/adapters, and rejects a raw patch
  // that cannot be represented as text instead of manufacturing paths from a
  // lossy U+FFFD conversion.
  const text =
    typeof patch === 'string'
      ? patch
      : Buffer.isBuffer(patch)
        ? new TextDecoder('utf-8', { fatal: true }).decode(patch)
        : (() => {
            throw new TypeError('patch must be a string or Buffer');
          })();
  const files = [];
  for (const line of text.split('\n')) {
    const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
    if (match) files.push({ path: match[2], status: 'M' });
    else if (line.startsWith('new file mode ') && files.at(-1)) files.at(-1).status = 'A';
    else if (line.startsWith('deleted file mode ') && files.at(-1)) files.at(-1).status = 'D';
  }
  return files;
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves that a process exists even when this user cannot signal it.
    return error?.code === 'EPERM';
  }
}

/** Validate an untrusted caller request without touching a repository, store,
 * provider, or lease. Core and CLI use this before state initialization. */
export function validateJobRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype)
    throw new Error('job request must be a plain object');
  if (Object.keys(input).some((key) => !JOB_INPUT_KEYS.includes(key))) throw new Error('job request contains an unknown property');
  if (!input || !cleanText(input.task, MAX_TASK) || !input.task.trim())
    throw new Error('task is required and must be at most 32000 characters');
  if (input.mode != null && input.mode !== 'write' && input.mode !== 'report') throw new Error('mode must be write or report');
  const mode = input.mode || 'write';
  const ownedPaths = canonicalPaths(input.ownedPaths ?? (mode === 'report' ? [] : undefined), mode !== 'report');
  if (!ownedPaths)
    throw new Error(
      mode === 'report'
        ? 'ownedPaths must be an array of relative paths/globs'
        : 'ownedPaths must be a non-empty array of relative paths/globs',
    );
  if (mode === 'report' && ownedPaths.length) throw new Error('report jobs must not declare ownedPaths');
  validateReportInputFiles(input.inputFiles);
  if (mode !== 'report' && input.inputFiles != null) throw new Error('inputFiles are available only to report jobs');
  if (mode === 'report' && input.inputFiles?.length) {
    const durableText = [
      input.task,
      ...(Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : []),
      ...(Array.isArray(input.relevantPaths) ? input.relevantPaths : []),
      ...(Array.isArray(input.denyRead) ? input.denyRead : []),
    ];
    const repeatsRawInput = input.inputFiles.some((path) => {
      const name = basename(path);
      const filename = name
        ? new RegExp(`(?<!${filenameTokenCharacter})${escapeRegExp(name)}(?!${filenameTokenCharacter})`, 'u')
        : undefined;
      return durableText.some((text) => typeof text === 'string' && (text.includes(path) || filename?.test(text)));
    });
    if (repeatsRawInput)
      throw new Error('report jobs must not repeat raw inputFiles paths or basenames; use input ordinals or generic private paths');
  }
  if (mode === 'report' && input.testCommand != null) throw new Error('report jobs do not run testCommand');
  if (mode === 'report' && input.extraWritable !== undefined && (!Array.isArray(input.extraWritable) || input.extraWritable.length))
    throw new Error('report jobs must not declare writable paths');
  if (mode === 'report' && Object.hasOwn(input, 'allowNetwork')) throw new Error('report jobs do not allow network access');
  if (
    mode === 'report' &&
    (Object.hasOwn(input, 'requireSandbox') ||
      Object.hasOwn(input, 'unsafePolicyOnlyVerifier') ||
      input.verifierMode !== undefined ||
      input.verifierTimeoutSec !== undefined ||
      input.verifierInterpreter !== undefined)
  )
    throw new Error('report jobs do not use verifier sandbox options');
  if (
    input.acceptanceCriteria != null &&
    (!Array.isArray(input.acceptanceCriteria) ||
      input.acceptanceCriteria.length > MAX_CRITERIA ||
      !input.acceptanceCriteria.every((x) => cleanText(x, MAX_CRITERION)))
  )
    throw new Error('acceptanceCriteria must be bounded non-empty strings');
  if (input.effort != null && !allowedEffort.has(input.effort)) throw new Error('effort must be normal or high');
  if (input.maxRepairRounds != null && (!Number.isInteger(input.maxRepairRounds) || input.maxRepairRounds < 0 || input.maxRepairRounds > 4))
    throw new Error('maxRepairRounds must be an integer from 0 to 4');
  if (input.relevantPaths != null && !canonicalRelevantPaths(input.relevantPaths))
    throw new Error('relevantPaths must be relative paths/globs, optionally suffixed :START-END (1-based lines, START <= END)');
  if (input.extraWritable != null && !validPaths(input.extraWritable, false)) throw new Error('extraWritable must be relative paths/globs');
  const extraWritable = input.extraWritable == null ? [] : canonicalPaths(input.extraWritable, false);
  // Extra-writable paths are intentionally discarded at finalization while
  // owned paths can be integrated and reverted. Any possible intersection
  // makes the authority ambiguous (and owned-first classification would
  // otherwise retain it), so reject conservatively at every raw/persisted
  // validation boundary rather than guessing a precedence.
  if (pathsOverlap(ownedPaths, extraWritable))
    throw new Error('extraWritable must not duplicate or overlap ownedPaths; scopes must be demonstrably disjoint');
  if (input.testCommand != null && !cleanText(input.testCommand, 8192))
    throw new Error('testCommand must be a non-empty string up to 8192 characters');
  if (input.testCommandSource != null && !['caller', 'repo'].includes(input.testCommandSource))
    throw new Error('testCommandSource is invalid');
  if (input.profile != null && !cleanText(input.profile, 128)) throw new Error('profile is invalid');
  if (input.denyRead != null && !validPaths(input.denyRead, false)) throw new Error('denyRead must be relative paths/globs');
  if (input.allowNetwork != null && typeof input.allowNetwork !== 'boolean') throw new Error('allowNetwork must be boolean');
  if (input.requireSandbox != null && typeof input.requireSandbox !== 'boolean') throw new Error('requireSandbox must be boolean');
  if (input.unsafePolicyOnlyVerifier != null && typeof input.unsafePolicyOnlyVerifier !== 'boolean')
    throw new Error('unsafePolicyOnlyVerifier must be boolean');
  if (input.unsafePolicyOnlyVerifier === true && input.testCommandSource === 'repo')
    throw new Error('repository testCommand cannot use unsafe policy-only verification');
  if (input.verifierMode != null && !VERIFIER_MODES.has(input.verifierMode))
    throw new Error('verifierMode must be standard or baseline-diff');
  if (
    input.verifierTimeoutSec != null &&
    (!Number.isInteger(input.verifierTimeoutSec) ||
      input.verifierTimeoutSec < MIN_VERIFIER_TIMEOUT_SEC ||
      input.verifierTimeoutSec > MAX_VERIFIER_TIMEOUT_SEC)
  )
    throw new Error('verifierTimeoutSec must be an integer from 5 to 1800');
  // The baseline run exists to tolerate failures a snapshot already had, which
  // is only meaningful under a real sandbox and an authenticated private copy.
  if (input.verifierMode === 'baseline-diff' && input.unsafePolicyOnlyVerifier === true)
    throw new Error('baseline-diff verification requires the macOS sandbox and cannot use unsafePolicyOnlyVerifier');
  if (input.verifierInterpreter != null) normalizeInterpreterDeclaration(input.verifierInterpreter);
  if (input.verifierInterpreterRoots != null) validateInterpreterRoots(input.verifierInterpreterRoots);
  validateExplicitRepoPath(input.repoPath);
  if (!validExecutionProfile(input.executionProfile)) throw new Error('executionProfile is invalid');
  // A spelling error in a safety cap must never be silently ignored and
  // replaced by a looser configured default. Keep this central check for
  // MCP/library callers as well as the CLI's pre-Core validation.
  if (
    input.budget != null &&
    (!input.budget ||
      typeof input.budget !== 'object' ||
      Array.isArray(input.budget) ||
      Object.getPrototypeOf(input.budget) !== Object.prototype ||
      Object.keys(input.budget).some((key) => !['maxUsd', 'maxTurns', 'timeoutMinutes', 'turnPolicy'].includes(key)) ||
      (Object.hasOwn(input.budget, 'turnPolicy') && !['auto', 'fixed'].includes(input.budget.turnPolicy)) ||
      (Object.hasOwn(input.budget, 'maxUsd') &&
        (!Number.isFinite(input.budget.maxUsd) || input.budget.maxUsd < 0 || input.budget.maxUsd > 10_000)) ||
      (Object.hasOwn(input.budget, 'maxTurns') &&
        (!Number.isInteger(input.budget.maxTurns) || input.budget.maxTurns < 1 || input.budget.maxTurns > 1000)) ||
      (Object.hasOwn(input.budget, 'timeoutMinutes') &&
        (!Number.isFinite(input.budget.timeoutMinutes) || input.budget.timeoutMinutes < 1 || input.budget.timeoutMinutes > 1440)))
  )
    throw new Error('budget is invalid');
}

// A job's initial host probe is not evidence that a particular verifier was
// confined: a profile can fail to apply between start and execution.  Repair
// is a privileged new model turn, so accept only the verifier's own exact
// execution result and fail closed on a missing or unfamiliar value.
const verifierUsedMacosSandbox = (verify) => verify?.result?.sandbox === 'macos';
// git-snapshot's literal-path boundary deliberately rejects control bytes.
// Keep such paths visible in review metadata, but never turn them into an
// executable reverse-patch pathspec.
const safeRevertPath = (path) =>
  typeof path === 'string' && path.length > 0 && path.length <= MAX_PATH_LENGTH && !/[\x00-\x1f\x7f\\]/.test(path);
const safeRevertPaths = (paths) =>
  Array.isArray(paths) &&
  paths.length > 0 &&
  paths.length <= MAX_PATHS &&
  paths.every(safeRevertPath) &&
  new Set(paths).size === paths.length;
// The primary worktree snapshot intentionally includes index content, but a
// staged-only concurrent edit leaves working-tree bytes unchanged. Keep an
// independent index tree and compare only exact owned paths immediately
// before integration.
const primaryIndexTree = (repoPath) => git(repoPath, ['write-tree']);
const primaryIndexChanged = (repoPath, before, paths) => {
  if (!validGitObjectId(before) || !paths.length || paths.some((path) => !safeRevertPath(path))) return !paths.length ? false : true;
  try {
    git(repoPath, ['diff', '--cached', '--quiet', before, '--', ...paths.map((path) => `:(top,literal)${path}`)]);
    return false;
  } catch {
    return true;
  }
};

/**
 * Repository roots are an authority boundary, but their textual spelling is
 * not stable on Windows: Git, Node, and the filesystem can disagree about
 * slash direction, drive-letter case, and the extended-path prefix. Compare
 * canonical filesystem identities instead of the serialization used by one
 * particular tool.
 */
export function sameRepositoryPath(left, right, { platform = process.platform } = {}) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const canonical = (value) => {
    try {
      return (realpathSync.native || realpathSync)(resolve(value));
    } catch {
      return resolve(value);
    }
  };
  const normalizeWindows = (value) =>
    value
      .replaceAll('\\', '/')
      .replace(/^\/\/?\?\//, '')
      .toLowerCase();
  const a = canonical(left),
    b = canonical(right);
  return platform === 'win32' ? normalizeWindows(a) === normalizeWindows(b) : a === b;
}

/** Lifecycle manager. Its worker/snapshot/lease collaborators are intentionally injected. */
export class JobManager {
  constructor({
    store,
    worker,
    runner,
    snapshots = {},
    leases = {},
    now = () => new Date(),
    config = {},
    report = compactReport,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    if (!store || typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function')
      throw new TypeError('store and timer functions are required');
    this.store = store;
    this.worker = worker;
    this.runner = runner;
    this.snapshots = snapshots;
    this.leases = leases;
    this.now = now;
    this.config = config;
    this.report = report;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.repoPath = config.repoPath ? (realpathSync.native || realpathSync)(resolve(config.repoPath)) : undefined;
    this.running = new Map();
    this.controllers = new Map();
    this.lastWaitSignature = new Map();
    // Baseline-diff verifier runs of the untouched snapshot, kept in memory only:
    // a restart or a manual repair simply recomputes, so there is no durable
    // baseline to tamper with or leave stale.
    this.baselineRuns = new Map();
  }
  get isolated() {
    return !!(
      this.config.isolation &&
      typeof this.config.isolation.create === 'function' &&
      typeof this.config.isolation.open === 'function'
    );
  }
  /** The injected clock as epoch milliseconds, whatever it returns. */
  #nowMs() {
    const value = this.now();
    const ms = value instanceof Date ? +value : typeof value === 'number' ? value : Date.parse(String(value));
    return Number.isFinite(ms) ? Math.floor(ms) : Date.now();
  }
  /** When a round entered the queue and how long its setup took first (see RoundClock). */
  #roundQueue(setupStartedMs) {
    const queuedAt = this.#nowMs();
    return { at: new Date(queuedAt).toISOString(), setupMs: Math.max(0, queuedAt - setupStartedMs) };
  }
  #workspace(job) {
    if (!this.isolated || !job.workspacePath) return null;
    return this.config.isolation.open({
      repoPath: job.repoPath,
      workspacePath: job.workspacePath,
      baselineTree: job.before,
      seedTree: job.workspaceSeed || job.before,
    });
  }
  async #cleanupWorkspace(job) {
    if (!this.isolated || typeof this.config.isolation.cleanup !== 'function') return true;
    let cleaned = true;
    // The baseline-diff verifier's private copy is removed with the job's own
    // workspace, so a crash between its creation and its removal is retried by
    // the same recovery path.
    for (const workspacePath of [job?.verifyBaselineWorkspacePath, job?.workspacePath]) {
      if (!workspacePath) continue;
      try {
        if (job.mode === 'report' && workspacePath === job.workspacePath) await prepareReportInputsForCleanup(workspacePath);
        const result = await this.config.isolation.cleanup({ repoPath: job.repoPath, workspacePath });
        // A helper may explicitly report a retained/failed private root. A
        // resolved promise alone is not proof that retryable cleanup happened.
        if (result?.retained === true) cleaned = false;
        else if (result && result.removed === false && result.alreadyAbsent !== true && result.cleaned !== true) cleaned = false;
      } catch {
        cleaned = false;
      }
    }
    return cleaned;
  }
  /** Keep a terminal state private until this owner's lease/workspace cleanup
   * attempt is durably recorded. Recovery can retry a retained workspace from
   * FINALIZING, whereas publishing first makes callers race cleanup. */
  async #finishOwnedTerminal(job, status, extra = {}, releaseOwnerNonce, { requireLeaseRelease = false, expectedIdentity } = {}) {
    let staged = job;
    let stageError;
    try {
      const changes = {
        ...extra,
        status: 'FINALIZING',
        finalStatus: status,
        ...(releaseOwnerNonce ? { leaseOwnerNonce: releaseOwnerNonce } : {}),
      };
      if (job.mode === 'report' && Object.hasOwn(changes, 'error')) changes.error = safeReportError(changes.error);
      if (expectedIdentity) {
        if (typeof this.store.updateOperationalIf === 'function')
          staged = await this.store.updateOperationalIf(job.id, expectedIdentity, changes);
        else {
          const current = await this.store.get(job.id);
          staged = this.#sameRecoveryIdentity({ ...job, ...expectedIdentity }, current) ? await this.store.update(job.id, changes) : null;
        }
        // A lost conditional claim means another lifecycle owns this record.
        // Do not release its lease, clean its workspace, or publish over it.
        if (!staged) return null;
      } else staged = await this.store.update(job.id, changes);
    } catch (error) {
      // Detached authority depends on that durable stage: without it an
      // old handoff owner must not delete a workspace it may no longer own.
      if (requireLeaseRelease) throw error;
      stageError = error;
    }
    try {
      const released = await this.leases.release?.(job.id, {
        ownerNonce: releaseOwnerNonce || staged.leaseOwnerNonce || job.leaseOwnerNonce,
      });
      if (requireLeaseRelease && released !== true) throw new Error('detached lease release was not confirmed');
    } catch (error) {
      // A detached handoff must prove it still owns the exact transferred
      // lease before it removes the private workspace. A stale nonce is not
      // an authorization failure we can safely ignore.
      if (requireLeaseRelease) throw error;
    }
    await this.cleanupWorkspace(job.id);
    if (stageError) throw stageError;
    return this.store.update(job.id, {
      status,
      activity: undefined,
      finishedAt: this.now().toISOString(),
      finalizedAt: this.now().toISOString(),
    });
  }
  /**
   * Consume a parent/child handoff outcome while holding the handoff lease.
   * This is deliberately narrower than `cancel`: a process that merely
   * writes a cancellation marker is not entitled to remove a detached
   * worker's workspace. Core calls this only after it has authenticated the
   * handoff and, when applicable, transferred that exact lease nonce.
   */
  async finishDetachedTerminal(id, { ownerNonce, expectedOwnerNonce, status = 'FAILED', error } = {}) {
    if (!['FAILED', 'CANCELLED'].includes(status)) throw new Error('detached terminal status is invalid');
    if (typeof ownerNonce !== 'string' || !ownerNonce || typeof expectedOwnerNonce !== 'string' || !expectedOwnerNonce)
      throw new Error('detached lease owner is invalid');
    const job = this.validatePersisted(await this.store.get(id));
    // Once CHILD_ASSIGNED is durable, the child can already be in resume().
    // The parent must never share finalization/cleanup authority with it.
    if (final(job.status) || job.status !== 'QUEUED' || job.handoffState !== 'PARENT_QUEUED') return this.public(job);
    if (job.leaseOwnerNonce !== expectedOwnerNonce) throw new Error('detached lease ownership changed');
    const cancelled = await this.store.cancelRequested?.(id);
    const finalStatus = cancelled ? 'CANCELLED' : status;
    const settled = await this.#finishOwnedTerminal(
      job,
      finalStatus,
      {
        handoffState: finalStatus === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
        ...(finalStatus === 'FAILED' && error ? { error } : {}),
      },
      ownerNonce,
      { requireLeaseRelease: writeScope(job).length > 0, expectedIdentity: this.#recoveryIdentity(job) },
    );
    return this.public(settled || this.validatePersisted(await this.store.get(id)));
  }
  async #pinTrees(job, trees) {
    if (!this.isolated || typeof this.config.isolation.pin !== 'function') return;
    await this.config.isolation.pin({ repoPath: job.repoPath, jobId: job.id, trees });
  }
  async #primaryState(job, paths) {
    if (!this.snapshots.create || !safeRevertPaths(paths)) throw new Error('primary state cannot be safely reconciled');
    const primaryTree = await this.snapshots.create(job.repoPath);
    const branch = this.config.git ? await this.config.git.branch(job.repoPath) : git(job.repoPath, ['branch', '--show-current']);
    const head = this.config.git ? await this.config.git.head(job.repoPath) : git(job.repoPath, ['rev-parse', 'HEAD']);
    return {
      primaryTree,
      branch,
      head,
      // `git apply` deliberately leaves the primary index alone. A selected
      // index drift therefore makes a crash result ambiguous even where the
      // worktree bytes happen to look like one side of the patch.
      indexUnchanged: !primaryIndexChanged(job.repoPath, job.primaryIndexBefore, paths),
    };
  }
  #sameSelectedTreePaths(repoPath, left, right, paths) {
    if (!validGitObjectId(left) || !validGitObjectId(right) || !safeRevertPaths(paths)) return false;
    try {
      return diffTrees(repoPath, left, right, { paths, literalPaths: true }).length === 0;
    } catch {
      return false;
    }
  }
  /**
   * Git worktree application and durable-record publication cannot share one
   * atomic transaction. An intent therefore records the exact selected paths
   * first; this reconciliation only calls a result "applied" when the live
   * primary tree, branch/HEAD, and selected index state prove it. Any third
   * state is surfaced as uncertain and is never offered for automatic revert.
   */
  async #reconcileIntegration(job) {
    const paths = job.integrationPaths || job.revertFiles;
    if (!safeRevertPaths(paths) || !validGitObjectId(job.before) || !validGitObjectId(job.workspaceAfter)) {
      return { integrationIntent: false, integrationOutcome: 'uncertain', integrationUncertain: true };
    }
    try {
      const state = await this.#primaryState(job, paths);
      const stable = state.branch === job.branch && state.head === job.head && state.indexUnchanged;
      const applied = this.#sameSelectedTreePaths(job.repoPath, job.workspaceAfter, state.primaryTree, paths);
      const absent = this.#sameSelectedTreePaths(job.repoPath, job.before, state.primaryTree, paths);
      if (stable && applied && !absent) {
        return {
          integrationIntent: false,
          integrationOutcome: 'applied',
          integrationUncertain: false,
          applied: true,
          noChanges: false,
          primaryAfter: state.primaryTree,
          after: state.primaryTree,
        };
      }
      if (stable && absent && !applied) {
        return {
          integrationIntent: false,
          integrationOutcome: 'not-applied',
          integrationUncertain: false,
          primaryAfter: state.primaryTree,
        };
      }
      return {
        integrationIntent: false,
        integrationOutcome: 'uncertain',
        integrationUncertain: true,
        primaryAfter: state.primaryTree,
        ...(state.branch !== job.branch || state.head !== job.head
          ? { branchChanged: true, currentBranch: state.branch, currentHead: state.head }
          : {}),
      };
    } catch {
      return { integrationIntent: false, integrationOutcome: 'uncertain', integrationUncertain: true };
    }
  }
  async #reconcileRevert(job) {
    const paths = job.revertPaths || job.revertFiles;
    const expectedAppliedTree = job.revertExpectedTree || job.primaryAfter || job.after || job.workspaceAfter;
    if (!safeRevertPaths(paths) || !validGitObjectId(job.before) || !validGitObjectId(expectedAppliedTree)) {
      return { revertIntent: false, revertOutcome: 'uncertain', revertUncertain: true };
    }
    try {
      const state = await this.#primaryState(job, paths);
      const stable = state.branch === job.branch && state.head === job.head && state.indexUnchanged;
      const reverted = this.#sameSelectedTreePaths(job.repoPath, job.before, state.primaryTree, paths);
      const stillApplied = this.#sameSelectedTreePaths(job.repoPath, expectedAppliedTree, state.primaryTree, paths);
      if (stable && reverted && !stillApplied) {
        return {
          revertIntent: false,
          revertOutcome: 'reverted',
          revertUncertain: false,
          revertedAt: this.now().toISOString(),
          revertAfter: state.primaryTree,
        };
      }
      if (stable && stillApplied && !reverted) {
        return { revertIntent: false, revertOutcome: 'not-reverted', revertUncertain: false };
      }
      return {
        revertIntent: false,
        revertOutcome: 'uncertain',
        revertUncertain: true,
        ...(state.branch !== job.branch || state.head !== job.head
          ? { branchChangedAfterIntegration: true, currentBranch: state.branch, currentHead: state.head }
          : {}),
      };
    } catch {
      return { revertIntent: false, revertOutcome: 'uncertain', revertUncertain: true };
    }
  }
  async #classifyIsolatedWorkspace(job, workspace, workspaceAfter) {
    const change = workspace.changes(workspaceAfter);
    const all = change.files;
    const inScope = (path, scopes) => {
      if (typeof path !== 'string' || path.includes('\\')) return false;
      try {
        return matchesAny(path, scopes);
      } catch {
        return false;
      }
    };
    const owned = all.filter((file) => inScope(file?.path, job.ownedPaths || []));
    const ephemeralChanges = all.filter(
      (file) => !inScope(file?.path, job.ownedPaths || []) && inScope(file?.path, job.extraWritable || []),
    );
    const ignored = workspace.ignoredPaths();
    const discardedIgnored = ignored.filter((path) => !inScope(path, job.ownedPaths || []) && inScope(path, job.extraWritable || []));
    const invalidIgnored = ignored.filter((path) => !discardedIgnored.includes(path));
    const ownedPaths = owned.map((file) => file.path);
    const revertPaths = ownedPaths.filter(safeRevertPath);
    const unrevertibleOwned = ownedPaths.filter((path) => !safeRevertPath(path));
    // A successful verifier must not alter production files after the worker
    // completed. Its separately-authorized extraWritable output remains
    // ephemeral, while out-of-scope changes are handled by the ordinary scope
    // audit below.
    let verifierMutations = [];
    // A failed verifier is no more authorized to author source than a
    // passing one. Otherwise its writes would be retained in the automatic
    // repair seed and eventually integrated as model output.
    if (job.verify || ['DONE_VERIFIED', 'DONE_UNVERIFIED'].includes(job.finalStatus)) {
      if (!validGitObjectId(job.workerAfter)) verifierMutations = ['<missing worker completion snapshot>'];
      else {
        try {
          verifierMutations = diffTreeFiles(job.repoPath, job.workerAfter, workspaceAfter)
            .map((file) => file.path)
            .filter((path) => inScope(path, job.ownedPaths || []));
        } catch {
          verifierMutations = ['<could not compare verifier result>'];
        }
      }
    }
    const violations = [
      ...new Set([
        ...all
          .filter((file) => !inScope(file?.path, job.ownedPaths || []) && !inScope(file?.path, job.extraWritable || []))
          .map((file) => file.path),
        ...invalidIgnored,
        ...unrevertibleOwned,
        ...verifierMutations,
      ]),
    ];
    const discardedEphemeralOutputs = [...new Set([...ephemeralChanges.map((file) => file.path), ...discardedIgnored])];
    const revertPatch = revertPaths.length
      ? await this.snapshots.diff(job.repoPath, job.before, workspaceAfter, { paths: revertPaths, literalPaths: true })
      : Buffer.alloc(0);
    return {
      workspaceAfter,
      allPatch: change.patch,
      all,
      owned,
      ownedPaths,
      revertPaths,
      revertPatch,
      violations,
      discardedEphemeralOutputs,
      verifierMutations,
    };
  }
  async cleanupWorkspace(id) {
    const get = this.store.getOperational?.bind(this.store) || this.store.get?.bind(this.store);
    const update = this.store.updateOperational?.bind(this.store) || this.store.update.bind(this.store);
    const job = await get(id);
    const cleaned = await this.#cleanupWorkspace(job);
    try {
      await update(
        id,
        cleaned
          ? { workspaceCleanedAt: this.now().toISOString(), workspaceCleanupError: undefined, verifyBaselineWorkspacePath: undefined }
          : { workspaceCleanupError: 'isolated workspace cleanup could not be completed' },
      );
    } catch {}
    return cleaned;
  }
  /**
   * A queued budget-finish recovery is the sole crash state that can safely
   * resume a worker here. It is distinct from capped implementation recovery:
   * its AgentLoop request is a fixed finish-only projection, authorized by
   * the authenticated lifecycle marker; ordinary queued jobs remain
   * deliberately non-resumable here.
   */
  async #recoverQueuedBudgetFinish(job, get) {
    const scope = writeScope(job);
    const ownerNonce = randomUUID();
    let acquired = false;
    if (scope.length) {
      // A write-capable restart must own a fresh lease before it changes the
      // durable owner tuple. Missing/unavailable lease authority is a defer,
      // not permission to publish a terminal result or clean a workspace.
      if (typeof this.leases.acquire !== 'function') return false;
      try {
        if (this.leases.acquire.length >= 2) await this.leases.acquire(job.id, scope, { pid: process.pid, ownerNonce });
        else await this.leases.acquire({ jobId: job.id, repoPath: job.repoPath, ownedPaths: scope, pid: process.pid, ownerNonce });
        acquired = true;
      } catch {
        return false;
      }
    }
    let claimed;
    try {
      const changes = {
        // Keep the active lifecycle status. The private handoff marker is
        // intentionally not a generic QUEUED/CHILD_ASSIGNED state.
        handoffState: 'BUDGET_FINISH_RECOVERY',
        leaseOwnerNonce: ownerNonce,
        runnerPid: process.pid,
        runnerHeartbeatAt: this.now().toISOString(),
      };
      if (typeof this.store.updateOperationalIf === 'function')
        claimed = await this.store.updateOperationalIf(job.id, this.#recoveryIdentity(job), changes);
      else {
        const current = await get(job.id);
        claimed = this.#sameRecoveryIdentity(job, current) ? await this.store.update(job.id, changes) : null;
      }
    } catch {
      claimed = null;
    }
    if (!claimed) {
      // This process acquired only N. A conditional-claim loser must never
      // release/clean the new owner, or touch the stale owner's workspace.
      if (acquired) {
        try {
          await this.leases.release?.(job.id, { ownerNonce });
        } catch {}
      }
      return false;
    }
    this._launch(job.id, job.status === 'REPAIRING' || job.pendingDefects ? 'repair' : 'start', job.pendingDefects, claimed);
    return true;
  }
  #recoveryIdentity(job) {
    // These durable fields jointly identify the lifecycle owner a recovery
    // pass observed. In particular, leaseOwnerNonce and handoffState separate
    // the parent from a just-assigned detached child.
    return {
      status: job.status,
      handoffState: job.handoffState,
      leaseOwnerNonce: job.leaseOwnerNonce,
      runnerPid: job.runnerPid,
      runnerHeartbeatAt: job.runnerHeartbeatAt,
    };
  }
  #sameRecoveryIdentity(left, right) {
    const expected = this.#recoveryIdentity(left);
    return Object.entries(expected).every(([key, value]) => Object.is(right?.[key], value));
  }
  /**
   * Recovery is not the live worker. It may clean an isolated workspace only
   * after it removed the exact lease owner it staged, or proved there is no
   * lease and the durable ownership tuple has not changed. The latter covers
   * a crash after a prior release without treating a stale nonce after a
   * parent-to-child transfer as cleanup permission.
   */
  async #recoveryMayClean(job, get, { allowLiveNoLease = false, preflight = false, orphan = false } = {}) {
    // `orphan`: this process's own abandoned applyThenVerify journal, whose
    // owner is gone although its pid is (our own) and alive.
    const ownerAlive = Number.isInteger(job.runnerPid) && pidAlive(job.runnerPid) && !orphan;
    // A terminal status can outlive a CLI/MCP server process which no longer
    // owns a lease. Retrying that recorded cleanup is safe only after a fresh
    // no-lease proof; never call ordinary release against a live PID.
    if (ownerAlive) {
      if (!allowLiveNoLease || typeof this.leases.list !== 'function') return false;
      try {
        const current = await get(job.id);
        if (!this.#sameRecoveryIdentity(job, current)) return false;
        const leases = await this.leases.list({ reclaimStale: false });
        return Array.isArray(leases) && !leases.some((lease) => lease?.jobId === job.id);
      } catch {
        return false;
      }
    }
    // The preflight leaves a dead owner's lease intact until the durable
    // terminal reservation succeeds. It only rejects an immediately unsafe
    // live-owner case; the post-CAS call below performs exact release.
    if (preflight) return true;
    if (typeof this.leases.release !== 'function') return true;
    try {
      const released = await this.leases.release(job.id, { ownerNonce: job.leaseOwnerNonce });
      if (released === true) return true;
    } catch {
      // A nonce mismatch is the normal indication that a live handoff won.
      // Fall through only to the explicit no-lease proof below.
    }
    if (typeof this.leases.list !== 'function') return false;
    try {
      const current = await get(job.id);
      if (!this.#sameRecoveryIdentity(job, current)) return false;
      const leases = await this.leases.list({ reclaimStale: false });
      return Array.isArray(leases) && !leases.some((lease) => lease?.jobId === job.id);
    } catch {
      return false;
    }
  }
  validate(input) {
    return validateJobRequest(input);
  }
  validatePersisted(job) {
    // Durable records deliberately carry lifecycle, Git, lease, and report
    // metadata in addition to caller request fields. Revalidate just the
    // preserved request projection here; treating that metadata as a fresh
    // public request would either weaken the raw boundary or reject every
    // legitimate persisted job.
    this.validate(jobInput(job));
    if (
      job.verifyBaselineWorkspacePath !== undefined &&
      (typeof job.verifyBaselineWorkspacePath !== 'string' || !job.verifyBaselineWorkspacePath)
    )
      throw new Error('stored job has invalid baseline workspace metadata');
    if (job.cappedFinishRecovery !== undefined && !CAPPED_FINISH_RECOVERY_STATES.has(job.cappedFinishRecovery))
      throw new Error('stored job has invalid capped implementation recovery state');
    if (job.budgetFinishRecovery !== undefined && !BUDGET_FINISH_RECOVERY_STATES.has(job.budgetFinishRecovery))
      throw new Error('stored job has invalid budget finish recovery state');
    // A configured Core store authenticates the entire durable record before
    // any of its endpoint, credential-reference, policy, budget, or lifecycle
    // fields can be consumed.  Plain injected stores intentionally remain
    // usable for isolated collaborators/tests that do not run a provider.
    if (this.store.integrityRequired?.(job) && !this.store.verifyJob(job)) throw new Error('stored job integrity check failed');
    let repoPath;
    try {
      repoPath = typeof job.repoPath === 'string' ? realpathSync(resolve(job.repoPath)) : undefined;
    } catch {
      repoPath = undefined;
    }
    if (!this.repoPath || !sameRepositoryPath(repoPath, this.repoPath))
      throw new Error('stored job repository does not match this manager');
    if (
      !validBranchName(job.branch) ||
      !validGitObjectId(job.head) ||
      (job.before != null && !validGitObjectId(job.before)) ||
      (job.after != null && !validGitObjectId(job.after))
    )
      throw new Error('stored job has invalid Git metadata');
    if (
      job.workspacePath !== undefined &&
      (typeof job.workspacePath !== 'string' ||
        !job.workspacePath ||
        !validGitObjectId(job.workspaceBaseline) ||
        !validGitObjectId(job.workspaceSeed) ||
        !validGitObjectId(job.primaryIndexBefore) ||
        job.workspaceBaseline !== job.before ||
        (job.workerAfter !== undefined && !validGitObjectId(job.workerAfter)) ||
        (job.workspaceAfter !== undefined && !validGitObjectId(job.workspaceAfter)) ||
        (job.primaryAfter !== undefined && !validGitObjectId(job.primaryAfter)))
    )
      throw new Error('stored job has invalid isolated workspace metadata');
    if (
      job.integrationIntent === true &&
      (!safeRevertPaths(job.integrationPaths) ||
        !validGitObjectId(job.workspaceAfter) ||
        !['DONE_VERIFIED', 'DONE_UNVERIFIED'].includes(job.integrationFinalStatus))
    )
      throw new Error('stored job has invalid integration journal');
    if (
      job.revertIntent === true &&
      (!safeRevertPaths(job.revertPaths) || !validGitObjectId(job.revertExpectedTree || job.workspaceAfter || job.after))
    )
      throw new Error('stored job has invalid revert journal');
    // The journaled command is already redacted and clipped to
    // APPLY_VERIFY_RECORD_COMMAND characters, and the store's own redaction can
    // only grow that by a small factor, so this bound is far above any record
    // this code writes: rejecting a real record would strand a job whose
    // primary checkout this journal is the only account of.
    if (
      job.applyVerifyIntent === true &&
      (!job.applyVerify ||
        typeof job.applyVerify !== 'object' ||
        Array.isArray(job.applyVerify) ||
        !APPLY_VERIFY_PHASES.has(job.applyVerify.phase) ||
        typeof job.applyVerify.command !== 'string' ||
        job.applyVerify.command.length > MAX_APPLY_VERIFY_COMMAND * 2 ||
        !Number.isInteger(job.applyVerify.timeoutSec) ||
        !safeRevertPaths(job.revertFiles) ||
        !validGitObjectId(job.workspaceAfter))
    )
      throw new Error('stored job has invalid applyThenVerify journal');
    // Never subsequently act through a persisted spelling. A symlinked
    // spelling that resolves to this manager is harmless, but retaining it
    // would reintroduce a time-of-check/time-of-use repository redirect.
    return { ...job, repoPath: this.repoPath };
  }
  async start(input, { launch = true, turnBudget } = {}) {
    this.validate(input);
    const setupStartedMs = this.#nowMs();
    // `turnBudget` is the trusted, out-of-band result of Core resolving the
    // caller's turn policy against its configuration; it is not a request
    // field. A policy that reaches a manager without it would be silently
    // ignored, which is worse than refusing.
    if (input.budget?.turnPolicy !== undefined && !turnBudget)
      throw new Error('budget.turnPolicy is resolved by Core; pass resolved numbers to JobManager');
    // One canonical spelling prevents an accepted scope from being interpreted
    // differently by leases, local tools, Git pathspecs, and sandbox rules.
    input = {
      ...input,
      mode: input.mode || 'write',
      ownedPaths: canonicalPaths(input.ownedPaths ?? (input.mode === 'report' ? [] : undefined), input.mode !== 'report'),
      ...(input.relevantPaths != null ? { relevantPaths: canonicalRelevantPaths(input.relevantPaths) } : {}),
      ...(input.extraWritable != null ? { extraWritable: canonicalPaths(input.extraWritable, false) } : {}),
      ...(input.denyRead != null ? { denyRead: canonicalPaths(input.denyRead, false) } : {}),
    };
    // JobManager is also a public/programmatic boundary.  Do not let callers
    // bypass Core's strict verifier default merely by constructing a manager
    // directly.  The sole exception remains a caller-provided verifier with
    // explicit durable policy-only consent.
    if (input.testCommand)
      input = {
        ...input,
        requireSandbox: input.requireSandbox === true || input.unsafePolicyOnlyVerifier !== true,
      };
    let repoPath = resolve(input.repoPath || this.config.repoPath || process.cwd());
    try {
      repoPath = this.config.repoRoot ? await this.config.repoRoot(repoPath) : git(repoPath, ['rev-parse', '--show-toplevel']);
      repoPath = (realpathSync.native || realpathSync)(resolve(repoPath));
    } catch {
      throw new Error('repoPath must be inside a git working tree');
    }
    if (this.repoPath && !sameRepositoryPath(repoPath, this.repoPath)) throw new Error('repoPath does not match this manager');
    this.repoPath ||= repoPath;
    if (this.config.disabled) throw new Error('offload is disabled for this repository');
    if (input.mode === 'report' && !this.isolated) throw new Error('report jobs require an isolated private worktree');
    if (input.verifierMode === 'baseline-diff') {
      if (!input.testCommand)
        throw new Error('baseline-diff verification requires a testCommand (supply one or configure the repository testCommand)');
      if (!this.isolated) throw new Error('baseline-diff verification requires an isolated private worktree');
    }
    if (input.profile && this.config.profiles && !this.config.profiles[input.profile]) throw new Error(`unknown profile: ${input.profile}`);
    const branch = this.config.git ? await this.config.git.branch(repoPath) : git(repoPath, ['branch', '--show-current']);
    const head = this.config.git ? await this.config.git.head(repoPath) : git(repoPath, ['rev-parse', 'HEAD']);
    // The built-in LeaseManager takes (jobId, paths); lightweight test/custom
    // managers may instead accept one descriptive object.
    let job, workspace;
    try {
      const writePaths = [...input.ownedPaths, ...(input.extraWritable || [])];
      // Capture active peers before our baseline snapshot. A peer that was
      // already running can otherwise change files after the snapshot and
      // release before a later lease scan, making its changes look like ours.
      // Jobs that begin after this boundary are retained by their durable
      // lifecycle timestamps at finalization below.
      const attributionBoundaryAt = this.now().toISOString();
      const concurrentScopes = this.leases.list
        ? (await this.leases.list({ reclaimStale: true })).flatMap((lease) => lease.ownedPaths || [])
        : [];
      const before = this.snapshots.create ? await this.snapshots.create(repoPath) : null;
      const primaryIndexBefore = this.isolated ? primaryIndexTree(repoPath) : undefined;
      if (this.isolated) {
        if (!validGitObjectId(before)) throw new Error('could not create an isolated baseline snapshot');
        workspace = await this.config.isolation.create({ repoPath, baselineTree: before });
        if (!workspace?.path || typeof workspace.path !== 'string') throw new Error('could not create an isolated workspace');
      }
      const inputManifest =
        input.mode === 'report' && input.inputFiles?.length
          ? await copyReportInputs({
              inputFiles: input.inputFiles,
              workspacePath: workspace?.path,
              roots: await reportInputRoots(this.config.reportInputRoots || []),
            })
          : [];
      const sizing = turnBudget
        ? await this.#sizeTurnBudget({ input, turnBudget, root: workspace?.path ?? repoPath, inputManifest })
        : undefined;
      const leaseOwnerNonce = randomUUID();
      // Input paths name caller-controlled scratch locations. Recovery needs
      // only the private manifest after copying, never those host paths.
      const persistedInput = jobInput(input);
      if (input.mode === 'report') delete persistedInput.inputFiles;
      if (sizing && persistedInput.budget)
        persistedInput.budget = {
          ...persistedInput.budget,
          maxTurns: sizing.resolved.maxTurns,
          ...(sizing.resolved.timeoutMinutes ? { timeoutMinutes: sizing.resolved.timeoutMinutes } : {}),
        };
      if (persistedInput.budget) delete persistedInput.budget.turnPolicy;
      job = await this.store.create({
        ...persistedInput,
        ...(sizing?.budgetSizing ? { budgetSizing: sizing.budgetSizing } : {}),
        repoPath,
        branch,
        head,
        before,
        ...(inputManifest.length ? { inputManifest } : {}),
        ...(workspace
          ? {
              workspacePath: workspace.path,
              workspaceBaseline: before,
              workspaceSeed: before,
              primaryIndexBefore,
              ...workspaceDependencyState(workspace),
            }
          : {}),
        writePaths,
        concurrentScopes,
        attributionBoundaryAt,
        profile: input.profile || this.config.defaultProfile,
        maxRepairRounds: input.maxRepairRounds ?? 2,
        rounds: 0,
        status: 'QUEUED',
        // Snapshot, worktree and input setup above is the round's setup time;
        // the queue clock starts when the record exists.
        roundQueue: this.#roundQueue(setupStartedMs),
        wallStartedAt: this.now().toISOString(),
        leaseOwnerNonce,
        runnerPid: process.pid,
        runnerHeartbeatAt: this.now().toISOString(),
        handoffState: launch ? 'LOCAL' : 'PARENT_QUEUED',
      });
      // Report jobs never diff, integrate, repair, or revert. Their live
      // isolated-worktree pins cover cleanup; a durable per-job tree pin
      // would retain an otherwise unreachable snapshot indefinitely.
      if (workspace && input.mode !== 'report') await this.#pinTrees(job, { before });
      if (writePaths.length && this.leases.acquire) {
        if (this.leases.acquire.length >= 2) await this.leases.acquire(job.id, writePaths, { ownerNonce: leaseOwnerNonce });
        else await this.leases.acquire({ jobId: job.id, repoPath, ownedPaths: writePaths });
      }
      if (this.leases.bind) await this.leases.bind(job.id);
      await this.store.event(job.id, { type: 'started', reason: 'start', round: 0, status: job.status });
      if (launch) this._launch(job.id, 'start', undefined, job);
      return this.public(job);
    } catch (error) {
      if (job) await this.#finishOwnedTerminal(job, 'FAILED', { error: String(error.message || error) });
      let cleanupFailure;
      if (workspace && !job) {
        try {
          // Report inputs are deliberately copied into a non-writable
          // directory. A failure before durable record creation has no job
          // lifecycle to perform the ordinary cleanup, so restore only that
          // private directory before asking Git to remove the worktree.
          if (input.mode === 'report') await prepareReportInputsForCleanup(workspace.path);
          await workspace.cleanup?.();
        } catch (cleanupError) {
          cleanupFailure = cleanupError;
        }
      }
      if (cleanupFailure && !job) {
        throw new Error(`${String(error.message || error)}; isolated workspace cleanup failed at ${workspace.path} and must be retried`);
      }
      throw error;
    }
  }
  /**
   * Size the turn cap from the files the worker will read (see
   * budget-sizing.mjs). Sizing is advisory: any failure falls back to the
   * unscaled cap with a warning rather than blocking the job.
   */
  async #sizeTurnBudget({ input, turnBudget, root, inputManifest }) {
    const { requested, configured, policy, timeoutScalable } = turnBudget;
    let recommendation, files;
    try {
      const pathPolicy = new PathPolicy({
        repoPath: root,
        ownedPaths: input.ownedPaths,
        extraWritable: input.extraWritable || [],
        denyRead: input.denyRead || [],
      });
      files = await measureFiles({
        policy: pathPolicy,
        relevantPaths: input.relevantPaths || [],
        ownedPaths: input.ownedPaths,
        inputManifest,
      });
      recommendation = recommendTurns({ files, ownedCount: input.ownedPaths.length, mode: input.mode });
    } catch {
      files = undefined;
    }
    const resolved = resolveTurnBudget({
      requested,
      configured,
      policy,
      recommended: recommendation?.recommendedTurns ?? 0,
      readTurns: recommendation?.readTurns,
      timeoutMinutes: input.budget?.timeoutMinutes,
      timeoutScalable: timeoutScalable === true,
    });
    if (!recommendation) resolved.warnings.push('turn sizing unavailable; the unscaled turn cap was used');
    return { resolved, budgetSizing: buildBudgetSizing({ resolved, recommendation, files }) };
  }
  /** Claim a durably queued CLI job in its detached worker process. */
  async resume(id) {
    const job = this.validatePersisted(await this.store.get(id));
    // Persisted jobs are an untrusted crash-recovery boundary. Validate before
    // their stored endpoint, scopes, or credential reference reach a worker.
    if (this.running.has(id)) return this.public(job);
    if (job.status !== 'QUEUED' || job.handoffState !== 'CHILD_ASSIGNED') throw new Error(`job ${id} cannot be resumed from ${job.status}`);
    if (await this.store.cancelRequested?.(id)) {
      return this.public(await this.#finishOwnedTerminal(job, 'CANCELLED', { handoffState: 'CANCELLED' }));
    }
    try {
      // The CLI parent transfers the live lease to this child before it can
      // launch. Fallback acquisition supports custom/older lease adapters.
      if (writeScope(job).length && !this.leases.transfer && this.leases.acquire) {
        if (this.leases.release) await this.leases.release(id, { ownerNonce: job.leaseOwnerNonce });
        if (this.leases.acquire.length >= 2) await this.leases.acquire(id, writeScope(job), { ownerNonce: job.leaseOwnerNonce });
        else await this.leases.acquire({ jobId: id, repoPath: job.repoPath, ownedPaths: writeScope(job) });
      }
      await this.store.event(id, { type: 'worker-claimed', pid: process.pid });
      this._launch(id, job.pendingDefects ? 'repair' : 'start', job.pendingDefects, job);
      return this.public(await this.store.get(id));
    } catch (error) {
      await this.#finishOwnedTerminal(
        job,
        'FAILED',
        { error: `worker could not claim job: ${error.message || error}` },
        job.leaseOwnerNonce,
        { expectedIdentity: this.#recoveryIdentity(job) },
      );
      throw error;
    }
  }
  async _launch(id, reason, defects, expectedJob) {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    // Keep the task registered through report publication, lease release, and
    // workspace cleanup. Shutdown is an ownership boundary: dropping it
    // earlier lets a caller exit while those durable transitions are pending.
    let task;
    const unregister = () => {
      if (this.running.get(id) === task) this.running.delete(id);
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
    };
    task = (async () => {
      let heartbeat, cancellationWatch, leaseLost;
      let job, ownerNonce, workspace, launchClaimed, clock;
      try {
        // A detached resume can read a queued handoff, then be delayed before
        // it enters this task. Do not re-read that record and blindly revive
        // it: recovery may already have claimed, released, and cleaned the
        // workspace. Every launch source supplies the durable tuple it saw;
        // the conditional update below is the sole QUEUED -> active claim.
        const observed = this.validatePersisted(expectedJob || (await this.store.get(id)));
        ownerNonce = observed.leaseOwnerNonce || randomUUID();
        const cancelledBeforeLaunch = await this.store.cancelRequested?.(id);
        if (cancelledBeforeLaunch) controller.abort(new Error('job was cancelled before worker launch'));
        const claimedAtMs = this.#nowMs();
        const launchChanges = {
          // A detached child can observe its cancellation marker after the
          // parent assigned its pid but before this async launch starts. Do
          // not resurrect that queued handoff as RUNNING even transiently.
          status: cancelledBeforeLaunch ? 'FINALIZING' : reason === 'repair' ? 'REPAIRING' : 'RUNNING',
          ...(cancelledBeforeLaunch ? { finalStatus: 'CANCELLED' } : {}),
          startedAt: new Date(claimedAtMs).toISOString(),
          runnerPid: process.pid,
          leaseOwnerNonce: ownerNonce,
          runnerHeartbeatAt: this.now().toISOString(),
          handoffState: cancelledBeforeLaunch ? 'CANCELLED' : 'RUNNING',
          // What the round is doing, for a poller's stall check; cleared at the terminal write.
          activity: { phase: 'startup', since: new Date(claimedAtMs).toISOString(), lastEventAt: new Date(claimedAtMs).toISOString() },
        };
        if (typeof this.store.updateOperationalIf === 'function')
          job = await this.store.updateOperationalIf(id, this.#recoveryIdentity(observed), launchChanges);
        else {
          const current = await this.store.get(id);
          job = this.#sameRecoveryIdentity(observed, current) ? await this.store.update(id, launchChanges) : null;
        }
        // Lost claims are expected under cross-process recovery. This task no
        // longer owns the lease/workspace, so it must not enter the ordinary
        // error finalizer (which releases, cleans, or publishes another
        // owner's record).
        if (!job) {
          unregister();
          return;
        }
        launchClaimed = true;
        job = this.validatePersisted(job);
        // This round's wall clock. `priorTiming` is every earlier round's record
        // (a repair round appends to it); the queue figure is claim minus the
        // moment the round was queued, so a detached child's spawn handoff counts.
        // A round recovered from a dead owner was already active: it was never
        // queued again, so what the earlier owner recorded is carried over and
        // the time nobody observed (since its last transition) is other time.
        const priorTiming = sanitizeTiming(job.timing);
        const recovered = ['RUNNING', 'REPAIRING'].includes(observed.status);
        const earlier = recovered ? priorTiming?.rounds.find((entry) => entry.round === (job.rounds || 0)) : undefined;
        const lastSeenMs = Date.parse(sanitizeActivity(observed.activity)?.since || '');
        const queuedMs = Date.parse(job.roundQueue?.at || (job.rounds ? '' : job.createdAt) || '');
        clock = new RoundClock({
          round: job.rounds || 0,
          reason: reason === 'repair' ? 'repair' : 'start',
          claimedAtMs,
          ...(earlier
            ? { carry: { record: earlier, gapMs: Number.isFinite(lastSeenMs) ? Math.max(0, claimedAtMs - lastSeenMs) : 0 } }
            : recovered
              ? {}
              : {
                  queueMs: Number.isFinite(queuedMs) ? Math.max(0, claimedAtMs - queuedMs) : undefined,
                  setupMs: job.roundQueue?.setupMs,
                }),
        });
        const stamp = (phase, detail) => {
          const at = this.#nowMs();
          clock.enter(phase, at, detail);
          return { timing: mergeRound(priorTiming, clock.snapshot(at)), activity: clock.activity };
        };
        await this.store.event(id, { type: 'run_started', reason, round: job.rounds || 0, status: job.status });
        workspace = this.#workspace(job);
        const cancelledAfterLaunch = await this.store.cancelRequested?.(id);
        if (controller.signal.aborted || cancelledAfterLaunch) {
          if (!cancelledBeforeLaunch)
            job = await this.store.update(id, { status: 'FINALIZING', finalStatus: 'CANCELLED', handoffState: 'CANCELLED' });
          throw new Error('job cancelled before worker launch');
        }
        if (writeScope(job).length) {
          const every = Number.isFinite(this.leases.heartbeatIntervalMs) ? this.leases.heartbeatIntervalMs : 30_000;
          const beat = () =>
            Promise.resolve(this.leases.heartbeat?.(id, { ownerNonce }))
              .then(() => this.store.update(id, { runnerHeartbeatAt: this.now().toISOString() }))
              .catch((error) => {
                leaseLost = error?.message || 'lease heartbeat failed';
                controller.abort(new Error(`lease lost: ${leaseLost}`));
              });
          heartbeat = setInterval(beat, Math.max(1, every));
          heartbeat.unref?.();
        }
        // A separate CLI/MCP process has no local AbortController.  The durable
        // flag makes cancellation reach the owner process and its provider/tool
        // signal without putting credentials or IPC endpoints in the command.
        cancellationWatch = setInterval(
          () =>
            this.store
              .cancelRequested?.(id)
              .then((cancelled) => {
                if (cancelled) controller.abort();
              })
              .catch(() => {}),
          100,
        );
        cancellationWatch.unref?.();
        try {
          if (!this.worker?.run) throw new Error('no worker configured');
          // A stored assistant reasoning trace is provider protocol state, not
          // display text.  If durability redacted it, only the live process
          // that still holds the original context may continue; a resumed or
          // repair worker must never replay the placeholder as though it were
          // the provider's original reasoning.  Older records did not carry
          // the positive marker, so fail closed only when they actually have
          // reasoning to replay.
          if (job.mode !== 'report') {
            const transcript = await this.store.readMessages?.(id);
            const hasReasoning = Array.isArray(transcript)
              ? transcript.some((message) => message?.role === 'assistant' && Object.hasOwn(message, 'reasoning_content'))
              : false;
            if (job.transcriptReplayable === false || (job.transcriptReplayable !== true && hasReasoning))
              throw new Error('durable transcript reasoning is unavailable for safe provider replay; start a fresh job');
          }
          // Keep lifecycle transitions in this worker claim rather than
          // deriving them from arbitrary transcript prose. `store.update` is
          // authenticated for real Core stores and awaited before AgentLoop is
          // allowed to cross the provider POST boundary.
          let cappedFinishRecoveryState = job.cappedFinishRecovery;
          let budgetFinishRecoveryState = job.budgetFinishRecovery;
          const result = await this.worker.run(job, {
            signal: controller.signal,
            defects,
            progress: async (event) => {
              const progress = {};
              if (Object.hasOwn(event || {}, 'cappedFinishRecovery')) {
                const requested = event.cappedFinishRecovery;
                const permitted =
                  (cappedFinishRecoveryState === undefined && requested === 'queued') ||
                  (cappedFinishRecoveryState === 'queued' && requested === 'consumed') ||
                  (cappedFinishRecoveryState === 'consumed' && requested === 'settled');
                if (!permitted) throw new Error('invalid capped implementation recovery state transition');
                progress.cappedFinishRecovery = requested;
                cappedFinishRecoveryState = requested;
              }
              if (Object.hasOwn(event || {}, 'budgetFinishRecovery')) {
                const requested = event.budgetFinishRecovery;
                const permitted =
                  (budgetFinishRecoveryState === undefined && requested === 'queued') ||
                  (budgetFinishRecoveryState === 'queued' && requested === 'consumed');
                if (!permitted) throw new Error('invalid budget finish recovery state transition');
                progress.budgetFinishRecovery = requested;
                budgetFinishRecoveryState = requested;
              }
              if (
                Number.isSafeInteger(event?.turn) &&
                event.turn >= 0 &&
                event.turn <= MAX_RESULT_TURNS &&
                finiteCount((job.turns || 0) + event.turn)
              )
                progress.turns = (job.turns || 0) + event.turn;
              if (validUsage(event?.usage)) {
                const nextUsage = Object.fromEntries(USAGE_KEYS.map((key) => [key, (job.usage?.[key] || 0) + (event.usage[key] || 0)]));
                if (
                  Object.values(nextUsage).every(finiteCount) &&
                  nextUsage.cacheHitTokens + nextUsage.cacheMissTokens === nextUsage.inputTokens
                )
                  progress.usage = nextUsage;
              }
              if (
                Number.isFinite(event?.costUsd) &&
                event.costUsd >= 0 &&
                event.costUsd <= MAX_RESULT_COST &&
                Number.isFinite((job.costUsd || 0) + event.costUsd) &&
                (job.costUsd || 0) + event.costUsd <= MAX_RESULT_COST
              )
                progress.costUsd = (job.costUsd || 0) + event.costUsd;
              // Only the documented pending-request event shape may clear a
              // previous diagnostic. A bare null is not accepted as state,
              // and null itself is never persisted.
              const clearsProviderFinishReason =
                event?.action === 'provider_request_pending' &&
                Object.hasOwn(event, 'providerFinishReason') &&
                event.providerFinishReason === null;
              const providerFinishReason = safeProviderFinishReason(event?.providerFinishReason);
              if (clearsProviderFinishReason) progress.providerFinishReason = undefined;
              else if (providerFinishReason !== undefined) progress.providerFinishReason = providerFinishReason;
              const budgetReservation = safeBudgetReservation(event?.budgetReservation);
              if (budgetReservation) progress.budgetReservation = budgetReservation;
              if (Array.isArray(event?.recentActions))
                progress.recentActions = event.recentActions
                  .filter((value) => typeof value === 'string')
                  .slice(-8)
                  .map((value) => value.slice(0, 300));
              else if (Array.isArray(event?.actions))
                progress.recentActions = event.actions
                  .filter((value) => typeof value === 'string')
                  .slice(-8)
                  .map((value) => value.slice(0, 300));
              else if (typeof event?.action === 'string') progress.recentActions = [event.action.slice(0, 300)];
              // Wall-clock accounting. Every event refreshes the activity marker
              // (a poller's proof of life); only a phase change or per-call tool
              // timings rewrite the round's record. The event's phase fields are
              // validated inside the clock, never trusted from the worker.
              const at = this.#nowMs();
              const transition = clock.observe(event, at);
              progress.activity = clock.activity;
              if (transition || Array.isArray(event?.toolTimings)) progress.timing = mergeRound(priorTiming, clock.snapshot(at));
              await this.store.update(id, progress);
              // Keep an explicit reset in the append-only event history while
              // omitting it from the durable/public job state above.
              const { timing: _timing, activity: _activity, ...logged } = progress;
              await this.store.event(id, {
                type: 'progress',
                round: job.rounds || 0,
                status: job.status,
                ...logged,
                // `prevMs` is how long the phase just left lasted: after a
                // provider_usage event it is that provider call's latency.
                ...(transition ? { phase: transition.phase, prevPhase: transition.prevPhase, prevMs: transition.prevMs } : {}),
                ...(clearsProviderFinishReason ? { providerFinishReason: null } : {}),
              });
            },
            // Report transcripts can contain bodies returned from untrusted
            // external inputs. Custom/injected workers receive harmless no-op
            // callbacks too, so they cannot bypass the configured worker's
            // ephemeral AgentContext policy.
            ...(job.mode === 'report'
              ? { appendMessage: async () => {}, appendMessages: async () => {} }
              : {
                  appendMessage: (m) => this.store.messages(id, m),
                  appendMessages: (messages) => this.store.messagesBatch(id, messages),
                }),
          });
          const allowedWorkerStatuses = new Set(['DONE', 'FAILED', 'TIMEOUT', 'BUDGET', 'CANCELLED']);
          const malformedResult = !result || typeof result !== 'object' || Array.isArray(result);
          const requestedStatus = malformedResult ? 'FAILED' : (result.status ?? 'DONE');
          const invalidStatus = !allowedWorkerStatuses.has(requestedStatus);
          const reportText = safeReportText(result?.report ?? result?.finish?.report);
          const missingReport = job.mode === 'report' && requestedStatus === 'DONE' && !reportText;
          let workerStatus = leaseLost
            ? 'FAILED'
            : controller.signal.aborted
              ? 'CANCELLED'
              : invalidStatus
                ? 'FAILED'
                : missingReport
                  ? 'FAILED'
                  : requestedStatus === 'DONE'
                    ? 'WORKER_DONE'
                    : requestedStatus;
          const badUsage = result?.usage != null && !validUsage(result.usage);
          const resultTurns = result?.turns ?? result?.turn ?? 0;
          const badResult =
            malformedResult ||
            !Number.isSafeInteger(resultTurns) ||
            resultTurns < 0 ||
            resultTurns > MAX_RESULT_TURNS ||
            !Number.isFinite(result?.costUsd ?? 0) ||
            (result?.costUsd ?? 0) < 0 ||
            (result?.costUsd ?? 0) > MAX_RESULT_COST ||
            badUsage;
          const safeUsage = badUsage ? {} : result?.usage || {};
          const providerFailure = safeProviderFailure(result?.providerFailure);
          const providerFinishReason = safeProviderFinishReason(result?.providerFinishReason);
          const budgetReservation = safeBudgetReservation(result?.budgetReservation);
          // A structured provider failure is terminal worker evidence, not a
          // warning a custom worker can attach to an otherwise successful
          // result. Cancellation keeps precedence below because it reflects
          // the caller's outer control signal rather than provider ownership.
          if (providerFailure && workerStatus === 'WORKER_DONE')
            workerStatus = providerFailure.kind === 'attempt_timeout' ? 'TIMEOUT' : 'FAILED';
          const candidateUsage = Object.fromEntries(USAGE_KEYS.map((key) => [key, (job.usage?.[key] || 0) + (safeUsage[key] || 0)]));
          const badAccounting =
            badResult ||
            !finiteCount((job.turns || 0) + resultTurns) ||
            !Number.isFinite((job.costUsd || 0) + (result?.costUsd || 0)) ||
            (job.costUsd || 0) + (result?.costUsd || 0) > MAX_RESULT_COST ||
            !Object.values(candidateUsage).every(finiteCount) ||
            candidateUsage.cacheHitTokens + candidateUsage.cacheMissTokens !== candidateUsage.inputTokens;
          // The worker enforces its remaining allowance before each request,
          // but the durable manager is the final accounting authority. This
          // keeps a buggy/custom worker from turning an over-budget result into
          // DONE (and from running verification after the cap was exceeded).
          const cumulativeTurns = (job.turns || 0) + resultTurns;
          const cumulativeCost = (job.costUsd || 0) + (result?.costUsd || 0);
          const budgetExceeded =
            !badAccounting &&
            ((job.budget?.maxTurns != null && cumulativeTurns > job.budget.maxTurns) ||
              (job.budget?.maxUsd != null && cumulativeCost > job.budget.maxUsd));
          if (badAccounting) workerStatus = 'FAILED';
          else if (budgetExceeded) workerStatus = 'BUDGET';
          const usage = badAccounting ? job.usage || {} : candidateUsage;
          // A FAILED round is continuable only for the worker-side causes the
          // loop itself names. Anything the manager decided (bad accounting,
          // a lost lease, a provider failure, a missing report) outranks a
          // label a custom worker may have attached to its result.
          const failureKind =
            workerStatus === 'FAILED' &&
            !providerFailure &&
            !leaseLost &&
            !badAccounting &&
            !invalidStatus &&
            !missingReport &&
            !budgetExceeded
              ? safeFailureKind(result?.failureKind)
              : undefined;
          // A report job keeps only the call's shape: its transcript is
          // deliberately ephemeral and its arguments can echo untrusted bodies.
          const toolFailure =
            failureKind === 'tool-loop'
              ? job.mode === 'report'
                ? reportToolFailure(result?.toolFailure)
                : safeToolFailure(result?.toolFailure)
              : undefined;
          job = await this.store.update(id, {
            status: workerStatus === 'WORKER_DONE' ? 'WORKER_DONE' : 'FINALIZING',
            finalStatus: workerStatus === 'WORKER_DONE' ? undefined : workerStatus,
            summary:
              (job.mode === 'report'
                ? safeReportString(result?.summary ?? result?.finish?.summary, 1500)
                : boundedString(result?.summary ?? result?.finish?.summary, 1500)) ?? job.summary,
            ...(job.mode === 'report' ? { reportText: reportText ?? job.reportText } : {}),
            concerns:
              (job.mode === 'report'
                ? safeReportList(result?.concerns ?? result?.finish?.concerns)
                : boundedStrings(result?.concerns ?? result?.finish?.concerns)) ?? job.concerns,
            testsRun:
              (job.mode === 'report'
                ? safeReportList(result?.testsRun ?? result?.finish?.testsRun)
                : boundedStrings(result?.testsRun ?? result?.finish?.testsRun)) ?? job.testsRun,
            turns: (job.turns || 0) + (badAccounting ? 0 : resultTurns),
            usage,
            costUsd: (job.costUsd || 0) + (badAccounting ? 0 : result?.costUsd || 0),
            model: boundedString(result?.model, 128),
            responseModel: boundedString(result?.responseModel, 128),
            providerFinishReason,
            ...(budgetReservation ? { budgetReservation } : {}),
            ...(workerStatus === 'BUDGET' && !badAccounting
              ? {
                  budgetStop: budgetStopFor({
                    reported: result?.budgetCap,
                    turns: cumulativeTurns,
                    costUsd: cumulativeCost,
                    budget: job.budget,
                  }),
                }
              : {}),
            pricingKnown: typeof result?.pricingKnown === 'boolean' ? result.pricingKnown : undefined,
            ...(providerFailure ? { providerFailure } : {}),
            ...(failureKind ? { failureKind } : {}),
            ...(toolFailure ? { toolFailure } : {}),
            ...(leaseLost
              ? { error: `lease lost: ${leaseLost}` }
              : invalidStatus || badAccounting || missingReport
                ? {
                    error: invalidStatus
                      ? `worker returned invalid status: ${String(requestedStatus)}`
                      : missingReport
                        ? 'report worker completed without a detailed report'
                        : 'worker returned invalid result or accounting data',
                  }
                : budgetExceeded
                  ? { error: 'worker exceeded cumulative job budget' }
                  : providerFailure
                    ? { error: providerFailureMessage(providerFailure) }
                    : failureKind
                      ? // The canonical text is what the continue gate compares against.
                        { error: FAILURE_ERRORS[failureKind] }
                      : result?.error && workerStatus !== 'WORKER_DONE'
                        ? { error: job.mode === 'report' ? safeReportError(result.error) : String(result.error).slice(0, 1500) }
                        : {}),
          });
          job = this.validatePersisted(job);
          if (!workspace && this.snapshots.create && this.snapshots.diff && job.before) {
            const after = await this.snapshots.create(job.repoPath);
            job = await this.store.update(id, { after });
          }
          if (!controller.signal.aborted && workerStatus === 'WORKER_DONE') {
            // The verifier phase includes the pre-verifier snapshot below.
            await this.store.update(id, stamp('verify'));
            // Verification is trusted to read the result, not to silently
            // become another author of it. Capture a durable pre-verifier tree
            // before invoking a command that may have write access for normal
            // build/test scratch activity.
            if (workspace && job.mode !== 'report') {
              const workerAfter = workspace.snapshot();
              job = await this.store.update(id, { workerAfter });
              await this.#pinTrees(job, { before: job.before, workerAfter });
            }
            await this._verify(job);
          }
        } catch (error) {
          const aborted = controller.signal.aborted;
          const providerFailure = safeProviderFailure(error);
          job = await this.store.update(id, {
            status: 'FINALIZING',
            finalStatus: leaseLost ? 'FAILED' : aborted ? 'CANCELLED' : providerFailure?.kind === 'attempt_timeout' ? 'TIMEOUT' : 'FAILED',
            ...(providerFailure ? { providerFailure } : {}),
            error:
              job.mode === 'report'
                ? safeReportError(leaseLost ? `lease lost: ${leaseLost}` : error.message || error)
                : leaseLost
                  ? `lease lost: ${leaseLost}`
                  : providerFailure
                    ? providerFailureMessage(providerFailure)
                    : String(error.message || error),
          });
        } finally {
          if (cancellationWatch) clearInterval(cancellationWatch);
          // Also closes a worker that threw mid-request into the phase it was in.
          await this.store.update(id, stamp('finalize')).catch(() => {});
          // Preserve partial changes even after cancellation, timeouts and worker failures.
          try {
            job = this.validatePersisted(await this.store.get(id));
            // A detached caller can set cancellation after the polling interval
            // is cleared but before publication. Honor the durable request here
            // so that finalization cannot accidentally publish DONE.
            if ((await this.store.cancelRequested?.(id)) && !final(job.status))
              job = await this.store.update(id, { status: 'FINALIZING', finalStatus: 'CANCELLED' });
            if (workspace && job.mode !== 'report') {
              const workspaceAfter = await workspace.snapshot();
              const audited = await this.#classifyIsolatedWorkspace(job, workspace, workspaceAfter);
              await this.store.writeArtifact(id, 'patch.diff', audited.allPatch);
              await this.store.writeArtifact(id, 'revert.diff', audited.revertPatch);
              job = await this.store.update(id, {
                workspaceAfter,
                after: workspaceAfter,
                // Stamps this record as this round's capture (see failedApplyRefusal).
                patchRound: job.rounds || 0,
                files: audited.owned,
                allFiles: audited.all,
                scopeViolations: audited.violations,
                revertFiles: audited.revertPaths,
                discardedEphemeralOutputs: audited.discardedEphemeralOutputs,
                verifierMutations: audited.verifierMutations,
              });
              await this.#pinTrees(job, {
                before: job.before,
                ...(job.workerAfter ? { workerAfter: job.workerAfter } : {}),
                workspaceAfter,
              });
              if (audited.violations.length)
                job = await this.store.update(id, {
                  status: 'FINALIZING',
                  finalStatus: 'FAILED',
                  error: audited.verifierMutations.length
                    ? 'verifier changed worker-owned output after worker completion'
                    : 'isolated workspace contains out-of-scope or non-ephemeral ignored output',
                });
              // Only verified/unverified successful outcomes may cross the
              // isolation boundary.  The worktree helper preserves unrelated
              // primary edits and rejects an exact same-path race.
              if (!audited.violations.length && ['DONE_VERIFIED', 'DONE_UNVERIFIED'].includes(job.finalStatus)) {
                const currentBranch = this.config.git
                  ? await this.config.git.branch(job.repoPath)
                  : git(job.repoPath, ['branch', '--show-current']);
                const currentHead = this.config.git ? await this.config.git.head(job.repoPath) : git(job.repoPath, ['rev-parse', 'HEAD']);
                if (currentBranch !== job.branch || currentHead !== job.head)
                  job = await this.store.update(id, {
                    status: 'FINALIZING',
                    finalStatus: 'FAILED',
                    branchChanged: true,
                    currentBranch,
                    currentHead,
                    error: 'primary branch or HEAD changed during isolated job',
                  });
                else if (primaryIndexChanged(job.repoPath, job.primaryIndexBefore, audited.revertPaths))
                  job = await this.store.update(id, {
                    status: 'FINALIZING',
                    finalStatus: 'FAILED',
                    integrationConflict: true,
                    error: 'primary index changed on a worker-touched path; isolated changes were not applied',
                  });
                else if (!audited.revertPaths.length)
                  job = await this.store.update(id, { applied: false, noChanges: true, integrationOutcome: 'no-changes' });
                else if (await this.store.cancelRequested?.(id))
                  job = await this.store.update(id, {
                    status: 'FINALIZING',
                    finalStatus: 'CANCELLED',
                    error: 'job cancelled before isolated integration',
                  });
                else {
                  try {
                    // The durable intent precedes the only primary mutation.
                    // If a process dies in the following window, recovery can
                    // distinguish proven application from an ambiguous race.
                    await this.store.update(id, {
                      integrationIntent: true,
                      integrationIntentAt: this.now().toISOString(),
                      integrationPaths: audited.revertPaths,
                      integrationFinalStatus: job.finalStatus,
                    });
                    // This is the final cancellable point before Git mutates
                    // primary. A marker arriving immediately after this check
                    // is covered by the intent/reconciliation protocol.
                    if (await this.store.cancelRequested?.(id)) {
                      job = await this.store.update(id, {
                        integrationIntent: false,
                        integrationOutcome: 'not-applied',
                        status: 'FINALIZING',
                        finalStatus: 'CANCELLED',
                        error: 'job cancelled before isolated integration',
                      });
                    } else {
                      const integrated = workspace.integrate(workspaceAfter, { paths: audited.revertPaths });
                      const pending = await this.store.get(id);
                      const reconciliation = await this.#reconcileIntegration(pending);
                      // A freshly synthesized primary snapshot has no active
                      // worktree pin. Retain it before publishing a durable field
                      // that depends on that otherwise-unreachable tree.
                      if (reconciliation.integrationOutcome === 'applied') {
                        await this.#pinTrees(pending, {
                          before: pending.before,
                          ...(pending.workerAfter ? { workerAfter: pending.workerAfter } : {}),
                          workspaceAfter: pending.workspaceAfter,
                          primaryAfter: reconciliation.primaryAfter,
                        });
                      }
                      job = await this.store.update(id, { ...reconciliation, integrationFiles: integrated.files || [] });
                      if (reconciliation.integrationOutcome !== 'applied') {
                        job = await this.store.update(id, {
                          status: 'FINALIZING',
                          finalStatus: 'FAILED',
                          integrationConflict: reconciliation.integrationOutcome === 'not-applied',
                          error:
                            reconciliation.integrationOutcome === 'uncertain'
                              ? 'isolated integration outcome is uncertain; inspect primary changes manually'
                              : 'isolated changes were not applied',
                        });
                      }
                    }
                  } catch (error) {
                    // `git apply` may already have succeeded when a later
                    // metadata write/snapshot fails. Reconcile rather than
                    // claiming that the primary was left untouched.
                    const current = await this.store.get(id);
                    const reconciliation = current.integrationIntent
                      ? await this.#reconcileIntegration(current)
                      : {
                          integrationOutcome: current.applied === true ? 'applied' : 'uncertain',
                          integrationUncertain: current.applied !== true,
                        };
                    if (reconciliation.integrationOutcome === 'applied' && reconciliation.primaryAfter) {
                      await this.#pinTrees(current, {
                        before: current.before,
                        ...(current.workerAfter ? { workerAfter: current.workerAfter } : {}),
                        workspaceAfter: current.workspaceAfter,
                        primaryAfter: reconciliation.primaryAfter,
                      });
                    }
                    job = await this.store.update(id, reconciliation);
                    const conflict = error?.code === 'E_WORKTREE_CONFLICT' || reconciliation.integrationOutcome === 'not-applied';
                    if (reconciliation.integrationOutcome !== 'applied')
                      job = await this.store.update(id, {
                        status: 'FINALIZING',
                        finalStatus: 'FAILED',
                        integrationConflict: conflict,
                        error:
                          reconciliation.integrationOutcome === 'uncertain'
                            ? 'isolated integration outcome is uncertain; inspect primary changes manually'
                            : conflict
                              ? 'primary working tree changed on a worker-touched path; isolated changes were not applied'
                              : 'could not safely integrate isolated workspace changes',
                      });
                  }
                }
              }
            } else if (job.mode !== 'report' && this.snapshots.create && this.snapshots.diff && job.before) {
              const after = await this.snapshots.create(job.repoPath);
              const allPatch = await this.snapshots.diff(job.repoPath, job.before, after);
              const all = this.snapshots.files ? await this.snapshots.files(job.repoPath, job.before, after) : changedFiles(allPatch);
              const others = this.leases.list ? await this.leases.list({ reclaimStale: true }) : [];
              // A disjoint peer can finish and release its lease before this job's
              // final snapshot. Its paths still belong to that peer, not to this
              // job; retain its declared scope for attribution/revert filtering.
              const peers = this.store.list ? await this.store.list({ limit: Number.MAX_SAFE_INTEGER }) : [];
              // Creation order is not execution order: another caller can create
              // a queued job, then acquire and run it only after this job's
              // initial lease scan. Retain a peer that started during this job as
              // well as one created during it, even when it has released before
              // our final scan.
              // Legacy records have no explicit boundary; their creation time is
              // the best available conservative fallback.
              const attributionBoundaryAt = job.attributionBoundaryAt || job.createdAt;
              const attributionBoundary = Date.parse(attributionBoundaryAt || '');
              const peerScopes = peers
                .filter(
                  (peer) =>
                    peer.id !== id &&
                    (peer.createdAt >= attributionBoundaryAt ||
                      (Number.isFinite(attributionBoundary) &&
                        Number.isFinite(Date.parse(peer.startedAt || '')) &&
                        Date.parse(peer.startedAt) >= attributionBoundary)),
                )
                .flatMap((peer) => writeScope(this.validatePersisted(peer)));
              const liveOtherScopes = [
                ...(job.concurrentScopes || []),
                ...peerScopes,
                ...others.filter((lease) => lease.jobId !== id).flatMap((lease) => lease.ownedPaths || []),
              ];
              const inScope = (file, scopes) => !file.path.includes('\\') && matchesAny(file.path, scopes);
              const owned = all.filter((file) => inScope(file, writeScope(job)));
              const violations = all
                .filter((file) => !inScope(file, writeScope(job)) && !inScope(file, liveOtherScopes))
                .map((file) => file.path);
              // The review diff must show every observed change, including a
              // concurrent or unleased outside-scope edit.  Reverting has a
              // different safety boundary: retain a separate patch containing
              // only paths this job was authorized to write.  In particular,
              // scope violations must never become reversible merely because no
              // peer lease happened to claim them.
              const revertPaths = owned.map((file) => file.path).filter(safeRevertPath);
              const revertPatch = revertPaths.length
                ? await this.snapshots.diff(job.repoPath, job.before, after, { paths: revertPaths, literalPaths: true })
                : Buffer.alloc(0);
              await this.store.writeArtifact(id, 'patch.diff', allPatch);
              await this.store.writeArtifact(id, 'revert.diff', revertPatch);
              job = await this.store.update(id, {
                after,
                files: owned,
                allFiles: all,
                scopeViolations: violations,
                revertFiles: revertPaths,
              });
            }
            if (job.scopeViolations?.length) job = await this.store.update(id, { status: 'FINALIZING', finalStatus: 'FAILED' });
            job = this.validatePersisted(job);
            const currentBranch = this.config.git
              ? await this.config.git.branch(job.repoPath)
              : git(job.repoPath, ['branch', '--show-current']);
            const currentHead = this.config.git ? await this.config.git.head(job.repoPath) : git(job.repoPath, ['rev-parse', 'HEAD']);
            if (currentBranch !== job.branch || currentHead !== job.head) {
              // A branch switch after a proven primary application is important
              // diagnostic metadata, but it cannot retroactively make the
              // already-applied patch disappear. Do not publish the false
              // "not applied" state by rewriting its verified terminal result.
              job =
                job.applied === true
                  ? await this.store.update(id, { branchChangedAfterIntegration: true, currentBranch, currentHead })
                  : await this.store.update(id, {
                      status: 'FINALIZING',
                      finalStatus: 'FAILED',
                      branchChanged: true,
                      currentBranch,
                      currentHead,
                    });
            }
            job = await this.store.get(id);
          } catch (snapshotError) {
            await this.store.update(id, {
              // Cleanup/release is still pending below. Keep the durable
              // lifecycle non-terminal until that ownership work completes.
              status: 'FINALIZING',
              finalStatus: 'FAILED',
              error: String(snapshotError.message || snapshotError),
            });
          }
          let done;
          let terminalCleanupComplete = false;
          try {
            const prePublish = await this.store.get(id);
            done =
              prePublish.status === 'FINALIZING'
                ? {
                    ...prePublish,
                    status: prePublish.finalStatus || 'FAILED',
                    finishedAt: this.now().toISOString(),
                    finalizedAt: this.now().toISOString(),
                  }
                : prePublish;
            // A durable terminal status is the public completion barrier.
            // Complete the final round's lease/workspace ownership work while
            // still FINALIZING, then re-read its cleanup metadata before the
            // report/event/status publication sequence below. REPAIR_QUEUED
            // deliberately retains its lease and workspace for the next turn.
            if (prePublish.status === 'FINALIZING' && done.status !== 'REPAIR_QUEUED') {
              if (heartbeat) clearInterval(heartbeat);
              try {
                await this.leases.release?.(id, { ownerNonce });
              } catch {}
              await this.cleanupWorkspace(done.id);
              const cleaned = await this.store.get(id);
              done = { ...done, workspaceCleanedAt: cleaned.workspaceCleanedAt, workspaceCleanupError: cleaned.workspaceCleanupError };
              terminalCleanupComplete = true;
            }
            // The record is complete once the lease and workspace work above is
            // done; a repair round appends its own to it.
            const timing = mergeRound(priorTiming, clock.finish(this.#nowMs()));
            await this.store.update(id, { timing, activity: undefined });
            done = { ...done, timing, activity: undefined };
            await this.store.writeArtifact(id, 'report.md', this.report(done));
            // Persist only the closed safe provider-failure shape in the log:
            // kind/status/attempts, never remote error text or an endpoint.
            const providerFailure = safeProviderFailure(done.providerFailure);
            const providerFinishReason = safeProviderFinishReason(done.providerFinishReason);
            const budgetReservation = safeBudgetReservation(done.budgetReservation);
            await this.store.event(id, {
              type: 'finished',
              status: done.status,
              round: done.rounds || 0,
              ...(providerFailure ? { providerFailure } : {}),
              ...(providerFinishReason ? { providerFinishReason } : {}),
              ...(budgetReservation ? { budgetReservation } : {}),
              ...(safeBudgetStop(done.budgetStop) && done.status === 'BUDGET' ? { budgetStop: safeBudgetStop(done.budgetStop) } : {}),
              // The failing call also sits in the non-progress tail of the log.
              ...(done.status === 'FAILED' ? failureView(done) : {}),
            });
            if (prePublish.status === 'FINALIZING')
              await this.store.update(id, { status: done.status, finishedAt: done.finishedAt, finalizedAt: done.finalizedAt });
          } catch (publicationError) {
            // A report/event failure must never strand a wait caller in FINALIZING.
            const error = `finalization publication failed: ${publicationError.message || publicationError}`;
            try {
              if (terminalCleanupComplete) {
                await this.store.update(id, {
                  status: 'FAILED',
                  finalStatus: 'FAILED',
                  error,
                  finishedAt: this.now().toISOString(),
                  finalizedAt: this.now().toISOString(),
                });
              } else {
                await this.#finishOwnedTerminal(await this.store.get(id), 'FAILED', { error });
                terminalCleanupComplete = true;
              }
            } catch {}
            done = { status: 'FAILED', error };
          }
          if (done.status === 'REPAIR_QUEUED' && !done.autoRepairScheduled) {
            await this.store.update(id, { autoRepairScheduled: true });
            // Start the next round before resolving the current worker task.
            // A detached CLI worker awaits that task; a microtask-only handoff
            // leaves a real exit gap where the child can disappear at
            // REPAIR_QUEUED.
            await (async () => {
              let leaseOwnerNonce = ownerNonce;
              try {
                const cancelledBeforeRepair = await this.store.cancelRequested?.(id);
                if (controller.signal.aborted || cancelledBeforeRepair) {
                  await this.#finishOwnedTerminal(await this.store.get(id), 'CANCELLED');
                  return;
                }
                const current = await this.store.get(id);
                const cancelledBeforeQueue = await this.store.cancelRequested?.(id);
                if (controller.signal.aborted || cancelledBeforeQueue) {
                  await this.#finishOwnedTerminal(current, 'CANCELLED');
                  return;
                }
                if (current.status !== 'REPAIR_QUEUED') {
                  try {
                    await this.leases.release?.(id, { ownerNonce: leaseOwnerNonce });
                  } catch {}
                  if (final(current.status)) await this.cleanupWorkspace(current.id);
                  return;
                }
                // Retain the current authenticated lease across automatic repair;
                // releasing here creates a cross-process conflict window.
                leaseOwnerNonce = current.leaseOwnerNonce || ownerNonce;
                // This marker suppresses duplicate scheduling for the completed
                // round only. Clear it before the next round so another failed
                // verifier can consume the remaining authorized repair budget.
                const queued =
                  typeof this.store.updateOperationalIf === 'function'
                    ? await this.store.updateOperationalIf(id, this.#recoveryIdentity(current), {
                        status: 'QUEUED',
                        rounds: (current.rounds || 0) + 1,
                        finishedAt: undefined,
                        leaseOwnerNonce,
                        handoffState: 'LOCAL',
                        autoRepairScheduled: false,
                        providerFinishReason: undefined,
                        budgetReservation: undefined,
                        roundQueue: this.#roundQueue(this.#nowMs()),
                        activity: undefined,
                        ...ROUND_SCOPED_VERIFIER_STATE,
                        ...ROUND_SCOPED_ERROR_STATE,
                      })
                    : this.#sameRecoveryIdentity(current, await this.store.get(id))
                      ? await this.store.update(id, {
                          status: 'QUEUED',
                          rounds: (current.rounds || 0) + 1,
                          finishedAt: undefined,
                          leaseOwnerNonce,
                          handoffState: 'LOCAL',
                          autoRepairScheduled: false,
                          providerFinishReason: undefined,
                          budgetReservation: undefined,
                          roundQueue: this.#roundQueue(this.#nowMs()),
                          activity: undefined,
                          ...ROUND_SCOPED_VERIFIER_STATE,
                          ...ROUND_SCOPED_ERROR_STATE,
                        })
                      : null;
                if (!queued) return;
                const cancelledAfterQueue = await this.store.cancelRequested?.(id);
                if (controller.signal.aborted || cancelledAfterQueue) {
                  await this.#finishOwnedTerminal(await this.store.get(id), 'CANCELLED');
                  return;
                }
                // A baseline-diff failure names only the new failures: the
                // snapshot's own failures are never repair targets.
                const verifierText =
                  repairDefectText(done.verify, MAX_REPAIR_ITEM - 32) ??
                  String(done.verify?.result?.stderr || done.verify?.result?.stdout || 'test command failed').slice(
                    0,
                    MAX_REPAIR_ITEM - 32,
                  );
                // Install the replacement only after this task deliberately
                // relinquishes its map entry. The conditional unregister
                // below cannot delete that replacement when this task exits.
                unregister();
                this._launch(id, 'repair', [`Verifier failed:\n${verifierText}`], queued);
              } catch (error) {
                await this.#finishOwnedTerminal(await this.store.get(id), 'FAILED', {
                  error: `automatic repair could not start: ${error.message || error}`,
                });
              } finally {
                if (heartbeat) clearInterval(heartbeat);
              }
            })();
          } else {
            if (heartbeat) clearInterval(heartbeat);
            if (!terminalCleanupComplete) {
              try {
                await this.leases.release?.(id, { ownerNonce });
              } catch {}
              await this.cleanupWorkspace(done.id);
            }
          }
          unregister();
        }
      } catch (initialError) {
        // A failure before the conditional launch claim carries no cleanup
        // authority. In particular, a delayed resume may have lost to
        // recovery while reading a marker or persisted record; releasing or
        // finalizing from this path would interfere with that winner.
        if (!launchClaimed) {
          unregister();
          return;
        }
        if (heartbeat) clearInterval(heartbeat);
        if (cancellationWatch) clearInterval(cancellationWatch);
        let releaseNonce = ownerNonce;
        try {
          const current = await this.store.get(id);
          releaseNonce ||= current.leaseOwnerNonce;
          const cancelled = controller.signal.aborted;
          await this.store.update(id, {
            status: 'FINALIZING',
            finalStatus: cancelled ? 'CANCELLED' : 'FAILED',
            activity: undefined,
            ...(cancelled ? {} : { error: `worker initialization failed: ${initialError.message || initialError}` }),
          });
        } catch {
        } finally {
          try {
            await this.leases.release?.(id, { ownerNonce: releaseNonce });
          } catch {}
        }
        if (job?.id) await this.cleanupWorkspace(job.id);
        try {
          const pending = await this.store.get(id);
          if (pending.status === 'FINALIZING')
            await this.store.update(id, {
              status: pending.finalStatus || 'FAILED',
              finishedAt: this.now().toISOString(),
              finalizedAt: this.now().toISOString(),
            });
        } catch {}
        unregister();
      }
    })();
    this.running.set(id, task);
    task.catch(() => {});
    return task;
  }
  /** The sandbox every verifier run of a job receives; the baseline-diff run of the untouched snapshot reuses it with its own worktree. */
  async #verifierOptions(job, executionPath) {
    return {
      cwd: executionPath,
      gitDir: this.config.gitDir
        ? await this.config.gitDir(executionPath)
        : resolve(executionPath, git(executionPath, ['rev-parse', '--git-dir'])),
      signal: this.controllers.get(job.id)?.signal,
      allowNetwork: !!job.allowNetwork,
      denyRead: job.denyRead || [],
      writablePaths: writeScope(job).map((p) => join(executionPath, p)),
      // A verifier of an isolated job can only traverse the authenticated
      // server-created worktree parent. It never receives this extra read
      // capability for a primary/non-isolated checkout, and it has no write
      // permission outside its declared scope.
      // The only additional read root is the primary's own node_modules, when
      // the server linked it beside this worktree at creation (see
      // isolatedDependencyReadPaths); it is never writable.
      ...(this.isolated && job.workspacePath
        ? { readablePaths: [dirname(executionPath), ...isolatedDependencyReadPaths(executionPath, job.repoPath)] }
        : {}),
      // A declared interpreter/virtualenv (verifierInterpreter): read and exec
      // only, for the verifier alone; never the worker's own run_command.
      ...interpreterPathsOption(job),
      requireSandbox: job.requireSandbox === true,
    };
  }
  /** Failure-name roots for one worktree: both the lexical and the physical spelling. */
  #collectorRoots(path) {
    const roots = [path];
    try {
      roots.push((realpathSync.native || realpathSync)(path));
    } catch {}
    return roots;
  }
  /** Reduce one verifier run (and what its streaming collector saw) to the comparison's input. */
  #parsedRun(verify, collector) {
    const result = verify?.result || {};
    let truncated = false;
    // An injected runner never streams; fall back to its retained text. That
    // text is a head+tail excerpt when large, so a cut makes the parse unusable.
    if (!collector.received()) {
      collector.push(String(result.stdout ?? ''), 'stdout');
      collector.push(String(result.stderr ?? ''), 'stderr');
      truncated = outputWasTruncated(result.stdout) || outputWasTruncated(result.stderr);
    }
    return {
      code: result.code,
      signal: result.signal || undefined,
      timedOut: result.timedOut === true,
      cancelled: result.cancelled === true,
      sandboxed: verifierUsedMacosSandbox(verify),
      truncated,
      parsed: collector.finish(),
    };
  }
  /**
   * Run the testCommand once on a pristine copy of the snapshot this job began
   * from (`job.before`, dirty primary state included). `job.before` never
   * changes across repair rounds, so one run serves the whole job. A baseline
   * that cannot be obtained is reported as unavailable, never as a pass.
   */
  async #baselineRun(job, { timeoutSec }) {
    const key = [job.id, job.before, job.testCommand, timeoutSec].join('\0');
    const cached = this.baselineRuns.get(key);
    if (cached) return { ...cached, cached: true };
    const unavailable = (cancelled = false) => ({
      run: { code: null, cancelled, timedOut: false, sandboxed: false },
      durationMs: 0,
      cached: false,
    });
    const signal = this.controllers.get(job.id)?.signal;
    if (signal?.aborted) return unavailable(true);
    let workspace;
    try {
      workspace = await this.config.isolation.create({ repoPath: job.repoPath, baselineTree: job.before });
      if (!workspace?.path || typeof workspace.path !== 'string') throw new Error('could not create a baseline workspace');
    } catch {
      return unavailable();
    }
    let outcome;
    try {
      // Record the copy before running anything in it, so a crash leaves a
      // path recovery cleanup can find.
      await this.store.update(job.id, { verifyBaselineWorkspacePath: workspace.path });
      await this.#verifyPhase(job.id, { phase: 'baseline', status: 'started' });
      const collector = createFailureCollector({
        roots: this.#collectorRoots(workspace.path),
        stopsEarly: commandStopsEarly(job.testCommand),
      });
      const verify = await this.runner.verify(job.testCommand, {
        ...(await this.#verifierOptions(job, workspace.path)),
        timeoutSec,
        onOutput: collector.push,
      });
      const run = this.#parsedRun(verify, collector);
      const environment =
        verify.verdict !== 'PASS' && run.sandboxed
          ? classifyVerifierEnvironment(verify, { workspacePath: workspace.path, writeScope: writeScope(job) })
          : null;
      outcome = { run, environment, durationMs: Number.isFinite(verify?.result?.durationMs) ? verify.result.durationMs : 0, cached: false };
    } catch {
      outcome = unavailable(signal?.aborted === true);
    } finally {
      let removed = false;
      try {
        await workspace.cleanup?.();
        removed = true;
      } catch {
        // The persisted path stays so the job's own cleanup retries it.
        await this.#verifyPhase(job.id, { phase: 'baseline', status: 'cleanup-failed' });
      }
      if (removed) await this.store.update(job.id, { verifyBaselineWorkspacePath: undefined }).catch(() => {});
    }
    // Only a run that finished under the sandbox can stand for the snapshot.
    if (outcome.run.sandboxed && !outcome.run.timedOut && !outcome.run.cancelled && outcome.run.code != null) {
      this.baselineRuns.set(key, outcome);
      while (this.baselineRuns.size > MAX_BASELINE_CACHE) this.baselineRuns.delete(this.baselineRuns.keys().next().value);
    }
    return outcome;
  }
  async #verifyPhase(id, event) {
    try {
      await this.store.event(id, { type: 'verify-phase', ...event });
    } catch {}
  }
  async _verify(job) {
    // Progress callbacks can durably advance a safety lifecycle while the
    // worker is running.  The object supplied by the caller predates those
    // callbacks, so verification must use the authenticated current record
    // rather than accidentally queueing another worker round from stale
    // state.
    job = this.validatePersisted(await this.store.get(job.id));
    if (!job.testCommand) return this.store.update(job.id, { status: 'FINALIZING', finalStatus: 'DONE_UNVERIFIED' });
    const executionPath = job.workspacePath || job.repoPath;
    const baselineMode = job.verifierMode === 'baseline-diff' && this.isolated && !!job.workspacePath;
    const timeoutSec = job.verifierTimeoutSec ?? (baselineMode ? BASELINE_VERIFIER_TIMEOUT_SEC : undefined);
    const resultCollector = baselineMode
      ? createFailureCollector({ roots: this.#collectorRoots(executionPath), stopsEarly: commandStopsEarly(job.testCommand) })
      : undefined;
    let verify = await this.runner.verify(job.testCommand, {
      ...(await this.#verifierOptions(job, executionPath)),
      // Left out entirely in the standard mode so its behavior is unchanged.
      ...(timeoutSec ? { timeoutSec } : {}),
      ...(resultCollector ? { onOutput: resultCollector.push } : {}),
    });
    const sandboxed = verifierUsedMacosSandbox(verify);
    // requireSandbox is an absolute caller/repository contract.  Defend it at
    // this boundary too so an injected or buggy Runner cannot claim PASS after
    // returning a policy-only (or no) execution result.
    const sandboxRequirementFailed = job.requireSandbox === true && !sandboxed;
    let baselineRun;
    let baselineDecision;
    if (baselineMode) {
      const skipped = (reason) => ({ mode: 'baseline-diff', status: 'skipped', reason });
      const result = verify.result;
      // Only a real non-zero exit under the sandbox is worth a baseline run: a
      // pass needs none, and a timeout/cancel/unsandboxed run proves nothing.
      const reason =
        verify.verdict === 'PASS'
          ? 'result-passed'
          : result?.cancelled
            ? 'cancelled'
            : result?.timedOut
              ? 'result-timed-out'
              : sandboxRequirementFailed || !sandboxed
                ? 'sandbox-unavailable'
                : undefined;
      if (reason) verify = { ...verify, baseline: skipped(reason) };
      else {
        const resultRun = this.#parsedRun(verify, resultCollector);
        baselineRun = await this.#baselineRun(job, { timeoutSec });
        const decision = (baselineDecision = compareFailureRuns({ baseline: baselineRun.run, result: resultRun }));
        const baseline = describeBaseline(decision, {
          baseline: baselineRun.run,
          result: resultRun,
          baselineMs: baselineRun.durationMs,
          resultMs: verify.result?.durationMs,
          cached: baselineRun.cached,
        });
        await this.#verifyPhase(job.id, {
          phase: 'compare',
          status: decision.status,
          newFailureCount: baseline.newFailureCount,
          baselineMs: baselineRun.durationMs,
          resultMs: Number.isFinite(verify.result?.durationMs) ? verify.result.durationMs : 0,
        });
        // The result's real exit status stays in `verify.result.code`; only the
        // verdict reflects "no new failures", so a report cannot be mistaken for
        // a green suite.
        verify = { ...verify, ...(decision.pass ? { verdict: 'PASS' } : {}), baseline };
      }
    }
    // A policy-only verifier can report a verified result only after the
    // caller explicitly opted into it, but can never authorize another model
    // turn. Unknown/missing result.sandbox fails closed for repair as well.
    // A queued recovery has a deliberately constrained transcript; a consumed
    // recovery may already have issued a billable implementation-continuation
    // request. Neither state is safe to reopen automatically after
    // verification. A settled recovery has durably recorded its complete
    // response transaction and is ordinary resolved history.
    const cappedFinishRecoveryUnresolved = job.cappedFinishRecovery === 'queued' || job.cappedFinishRecovery === 'consumed';
    const budgetFinishRecoveryUnresolved = job.budgetFinishRecovery !== undefined;
    const finishRecoveryUnresolved = cappedFinishRecoveryUnresolved || budgetFinishRecoveryUnresolved;
    // An environmental failure (missing package/command, path the worker may
    // not write) cannot be repaired by another model turn: the worker has no
    // network, cannot install, and cannot write outside its scope. Never spend
    // a repair round or cumulative budget on it; keep the diff reviewable and
    // let the primary decide. Classification is advisory about *cause*, not a
    // judgement of the worker's code.
    let environment =
      verify.verdict !== 'PASS' && !sandboxRequirementFailed
        ? classifyVerifierEnvironment(verify, { workspacePath: job.workspacePath ? executionPath : undefined, writeScope: writeScope(job) })
        : null;
    // The same environmental noise in the untouched snapshot is not what made
    // the new failures: the worker can still fix those.
    const baselineEnvironment = baselineRun?.environment;
    if (
      environment &&
      baselineEnvironment?.kind === environment.kind &&
      baselineEnvironment.specifier === environment.specifier &&
      baselineDecision?.status === 'compared' &&
      baselineDecision.newFailures?.length
    )
      environment = null;
    // A baseline that could not prove "no new failures" is a failure that no
    // repair round can address; ending here spends no further worker budget.
    const baselineInconclusive = verify.baseline?.status === 'inconclusive';
    const canRepair =
      verify.verdict !== 'PASS' &&
      !environment &&
      !sandboxRequirementFailed &&
      !finishRecoveryUnresolved &&
      !baselineInconclusive &&
      sandboxed &&
      (job.rounds || 0) < (job.maxRepairRounds ?? 2);
    const status = sandboxRequirementFailed
      ? 'VERIFY_FAILED'
      : verify.verdict === 'PASS'
        ? 'DONE_VERIFIED'
        : environment
          ? 'VERIFY_ENV_FAILED'
          : canRepair
            ? 'REPAIR_QUEUED'
            : 'VERIFY_FAILED';
    return this.store.update(job.id, {
      status: 'FINALIZING',
      finalStatus: status,
      verify,
      // Always written: a later verification must not inherit an earlier round's classification.
      verifyEnvironment: environment || undefined,
      ...(finishRecoveryUnresolved && verify.verdict !== 'PASS'
        ? {
            error: cappedFinishRecoveryUnresolved
              ? 'automatic repair suppressed: unresolved capped implementation recovery; start a fresh job'
              : 'automatic repair suppressed: unresolved budget finish recovery; start a fresh job',
          }
        : {}),
    });
  }
  public(job) {
    return {
      jobId: job.id,
      repo: job.repoPath,
      branch: job.branch,
      head: job.head,
      profile: job.profile,
      status: job.status,
      ...(job.mode === 'report'
        ? {
            mode: 'report',
            reportResult: {
              text: safeReportText(job.reportText) || safeReportString(job.summary, 1500) || '',
              concerns: safeReportList(job.concerns),
              testsRun: safeReportList(job.testsRun),
              inputs: Array.isArray(job.inputManifest) ? job.inputManifest.map(({ path, bytes }) => ({ path, bytes })) : [],
            },
          }
        : {}),
      ...(job.unsafePolicyOnlyVerifier === true ? { unsafePolicyOnlyVerifier: true } : {}),
      ...(job.verifierMode === 'baseline-diff' ? { verifierMode: 'baseline-diff' } : {}),
      ...(safeVerifyBaseline(job.verify?.baseline) ? { verifyBaseline: safeVerifyBaseline(job.verify.baseline) } : {}),
      // Readiness of the verifier's dependencies, visible at start so a
      // primary can cancel before spending budget on a testCommand that
      // imports a package the worktree cannot resolve.
      ...(job.mode !== 'report' ? publicVerifierDeps(job) : {}),
      ...(job.mode !== 'report' ? publicVerifierInterpreter(job) : {}),
      ...(safeVerifyEnvironment(job.verifyEnvironment) ? { verifyEnvironment: safeVerifyEnvironment(job.verifyEnvironment) } : {}),
      ...(job.appliedUnverified ? { appliedUnverified: true } : {}),
      ...(publicApplyVerify(job.applyVerify) ? { applyThenVerify: publicApplyVerify(job.applyVerify) } : {}),
      // Cleanup status is operationally significant once a job reaches a
      // terminal result. Expose only the bounded persisted diagnosis, never
      // the private workspace path, so remote CLI/MCP callers can distinguish
      // a retryable cleanup failure from an explicit manual-cleanup decision.
      ...(typeof job.workspaceCleanupError === 'string' && job.workspaceCleanupError
        ? { workspaceCleanupError: job.workspaceCleanupError }
        : {}),
      ...(job.workspaceCleanupRequired === true ? { workspaceCleanupRequired: true } : {}),
      ...(safeProviderFailure(job.providerFailure) ? { providerFailure: safeProviderFailure(job.providerFailure) } : {}),
      ...(safeProviderFinishReason(job.providerFinishReason)
        ? { providerFinishReason: safeProviderFinishReason(job.providerFinishReason) }
        : {}),
      ...(safeBudgetReservation(job.budgetReservation) ? { budgetReservation: safeBudgetReservation(job.budgetReservation) } : {}),
      ...(safeBudgetSizing(job.budgetSizing) ? { budgetSizing: safeBudgetSizing(job.budgetSizing) } : {}),
      ...(job.status === 'BUDGET' && safeBudgetStop(job.budgetStop) ? { budgetStop: safeBudgetStop(job.budgetStop) } : {}),
      ...(job.status === 'FAILED' ? failureView(job) : {}),
    };
  }
  async wait(id, { timeoutSec = 40, signal, detail = 'compact' } = {}) {
    assertDetail(detail);
    const rawTimeout = Number(timeoutSec);
    timeoutSec = Math.min(55, Math.max(0, Number.isFinite(rawTimeout) ? rawTimeout : 40));
    const stop = Date.now() + timeoutSec * 1000;
    let job = await this.#settleOrphanedApplyVerify(await this.store.get(id));
    // An applyThenVerify run holds a terminal job's status for as long as its
    // command runs (up to 15 minutes). That is progress, not completion, and
    // joining it would break this call's bounded-wait contract.
    while ((!final(job.status) || this.#applyInFlight(job)) && Date.now() < stop && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 100));
      job = await this.store.get(id);
    }
    if (signal?.aborted) throw new Error('request cancelled');
    job = await this.#settleOrphanedApplyVerify(job);
    const applying = this.#applyInFlight(job);
    // A local task keeps ownership through terminal publication and cleanup.
    // Do not expose its durable terminal status as fully complete while that
    // same task is still releasing its lease or cleaning its workspace:
    // callers commonly repair/read immediately after wait().
    if (!applying && final(job.status) && this.running.has(id)) {
      await this.running.get(id);
      job = await this.store.get(id);
    }
    if (final(job.status) && !applying) {
      this.lastWaitSignature.delete(id);
      const timing = detail === 'full' ? sanitizeTiming(job.timing) : undefined;
      return { ...this.public(job), report: await this.#interactiveReport(job, { detail }), done: true, ...(timing ? { timing } : {}) };
    }
    // A running round that has outlived its own limits. Its (kind, level) is part
    // of the change signature below: a new or worsened stall is returned once in
    // full, and the elapsed seconds that keep growing are deliberately not.
    const nowMs = this.#nowMs();
    const stall = applying ? undefined : assessStall(job, nowMs);
    const activity = applying ? undefined : sanitizeActivity(job.activity);
    const progress = {
      turns: job.turns || 0,
      usage: job.usage,
      costUsd: job.costUsd,
      recentActions: job.recentActions || [],
      status: job.status,
      ...(activity
        ? {
            phase: {
              kind: activity.phase,
              sinceSec: Math.max(0, Math.round((nowMs - Date.parse(activity.since)) / 1000)),
              ...(activity.turn !== undefined ? { turn: activity.turn } : {}),
              ...(activity.tool ? { tool: activity.tool } : {}),
            },
          }
        : {}),
      ...(stall ? { stall } : {}),
      ...(applying ? { applyThenVerify: publicApplyVerify(job.applyVerify) } : {}),
    };
    // A primary that polls a long job would otherwise pay input tokens for the
    // same progress payload every time. When nothing observable changed since
    // the last payload this process handed out for the job, say so in a few
    // tokens instead of repeating it. `detail: "full"` always repeats.
    const signature = JSON.stringify([
      progress.status,
      progress.turns,
      progress.costUsd,
      progress.recentActions,
      job.applyVerify?.phase,
      stall ? [stall.kind, stall.level] : null,
    ]);
    if (detail !== 'full' && this.lastWaitSignature.get(id) === signature)
      return {
        jobId: job.id,
        status: job.status,
        done: false,
        unchanged: true,
        progress: { turns: progress.turns, costUsd: progress.costUsd, ...(stall ? { stalledSec: stall.sinceSec } : {}) },
      };
    this.lastWaitSignature.set(id, signature);
    return { ...this.public(job), done: false, progress };
  }
  /**
   * An applyThenVerify run still owns this job. Liveness is the journal owner's
   * pid, so a run in this process and one in a peer process look the same, and
   * a dead one is left for recovery rather than waited on forever.
   */
  #applyInFlight(job) {
    if (job?.applyVerifyIntent !== true || !APPLY_VERIFY_PHASES.has(job.applyVerify?.phase)) return false;
    return Number.isInteger(job.runnerPid) && pidAlive(job.runnerPid) && !this.#orphanedApplyVerify(job);
  }
  /**
   * A journal this very process owns while no run of it is registered: the run
   * ended (a store failure while settling it) and left the journal behind. The
   * process's own pid is always alive, so liveness alone would call it a live
   * run forever; only a restart would clear it.
   */
  #orphanedApplyVerify(job) {
    return job?.applyVerifyIntent === true && job.runnerPid === process.pid && !this.controllers.has(job.id);
  }
  /** Settle this process's own orphaned applyThenVerify journal from the live tree, then re-read the job. */
  async #settleOrphanedApplyVerify(job, { callerRuns = false } = {}) {
    if (!this.#orphanedApplyVerify(job)) return job;
    // An apply call is registered as running while it makes this very check.
    await this.recover(callerRuns ? { ownerIds: [job.id] } : {});
    return this.validatePersisted(await this.store.get(job.id));
  }
  async list(options = {}) {
    return (await this.store.list(options)).map((job) => this.public(job));
  }
  /**
   * Jobs for the no-argument list. A job is in the session when it was created
   * or last touched at or after `config.sessionStartedAt`; active jobs are
   * always listed. Without a session boundary (direct use) every job is listed.
   * Nothing is hidden silently: `listing` counts what was left out and totals
   * the provider spend of the rows returned (each job's cumulative cost counted
   * once; jobs cut by maxJobs or scope are in `storeCostUsd` only).
   */
  async listing({ all = false, maxJobs = DEFAULT_LIST_JOBS } = {}) {
    if (typeof all !== 'boolean') throw new Error('all must be a boolean');
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > MAX_LIST_JOBS)
      throw new Error(`maxJobs must be an integer from 1 to ${MAX_LIST_JOBS}`);
    const stored = await this.store.list({ limit: Number.MAX_SAFE_INTEGER });
    const sessionMs = this.#sessionStartMs();
    const scoped = all || sessionMs === undefined ? stored : stored.filter((job) => !final(job.status) || this.#inSession(job, sessionMs));
    // Active jobs are never truncated: hiding a running job is worse than a long list.
    const active = scoped.filter((job) => !final(job.status));
    const room = Math.max(0, Math.max(maxJobs, active.length) - active.length);
    const quiet = scoped.filter((job) => final(job.status)).slice(0, room);
    const shownIds = new Set([...active, ...quiet].map((job) => job.id));
    const shown = scoped.filter((job) => shownIds.has(job.id));
    const omittedByScope = stored.length - scoped.length,
      omittedByLimit = scoped.length - shown.length;
    const unknown = shown.filter((job) => costOf(job) === null).length;
    const sessionScoped = !all && sessionMs !== undefined;
    const hint = listingHint(omittedByScope, omittedByLimit);
    const nowMs = this.#nowMs();
    return {
      jobs: shown.map((job) => ({
        ...this.public(job),
        createdAt: job.createdAt,
        ...this.#listingDetail(job, nowMs),
        costUsd: costOf(job),
        rounds: job.rounds || 0,
      })),
      listing: {
        scope: sessionScoped ? 'session' : 'all',
        ...(sessionScoped ? { sessionStartedAt: this.config.sessionStartedAt } : {}),
        shown: shown.length,
        omitted: omittedByScope + omittedByLimit,
        omittedByScope,
        omittedByLimit,
        totalCostUsd: sumCost(shown),
        storeCostUsd: sumCost(stored),
        ...(unknown ? { costUnknownJobs: unknown } : {}),
        ...(hint ? { hint } : {}),
      },
    };
  }
  /**
   * What a list row says beyond status and cost: a one-line redacted summary of
   * the brief (never the brief) and the latest round's clock. `startedAt` is
   * the worker's claim of that round, so a job still waiting in the queue has
   * none (a queued repair would otherwise show the previous round's). A
   * terminal job's `finishedAt` closes the duration; an active one's duration
   * is elapsed so far and carries `running: true`.
   */
  #listingDetail(job, nowMs) {
    const task = redactedSummary(job.task, { max: LIST_TASK_CHARS, secrets: this.store?.secrets || [] });
    const started = QUEUED_STATUSES.has(job.status) ? NaN : Date.parse(job.startedAt ?? '');
    const done = final(job.status);
    const finished = done ? Date.parse(job.finishedAt ?? '') : NaN;
    const iso = (ms) => new Date(ms).toISOString();
    const end = done ? finished : nowMs;
    return {
      ...(task ? { task } : {}),
      ...(Number.isFinite(started) ? { startedAt: iso(started) } : {}),
      ...(Number.isFinite(finished) ? { finishedAt: iso(finished) } : {}),
      ...(Number.isFinite(started) && Number.isFinite(end)
        ? { durationSec: Math.max(0, Math.round((end - started) / 1000)), ...(done ? {} : { running: true }) }
        : {}),
    };
  }
  /**
   * The raw records a retrospective reads (retrospective.mjs keeps only its
   * closed fields of them): the named `ids`, the newest `last` of the whole
   * store, or by default the jobs created or touched this server session.
   * Newest first, at most `limit`; `omitted` counts the rest. Nothing here is
   * returned to a caller as it is.
   */
  async retrospectiveSource({ ids, last, limit = MAX_RETROSPECTIVE_JOBS } = {}) {
    const get = (this.store.getOperational || this.store.get).bind(this.store);
    let jobs;
    if (ids) jobs = await Promise.all(ids.map((id) => get(id)));
    else {
      const list = (this.store.listOperational || this.store.list).bind(this.store);
      const stored = await list({ limit: Number.MAX_SAFE_INTEGER });
      const sessionMs = this.#sessionStartMs();
      jobs = last !== undefined || sessionMs === undefined ? stored : stored.filter((job) => this.#inSession(job, sessionMs));
    }
    jobs = jobs.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    // `last` is a request for that many, so what it leaves out was never in scope; only the digest's own cap omits.
    const cap = last ?? limit;
    const omitted = last === undefined ? Math.max(0, jobs.length - cap) : 0;
    return { jobs: jobs.slice(0, cap), omitted, secrets: this.store?.secrets || [], nowMs: this.#nowMs() };
  }
  #sessionStartMs() {
    const start = Date.parse(this.config.sessionStartedAt ?? '');
    return Number.isFinite(start) ? start : undefined;
  }
  #inSession(job, sessionMs) {
    const touched = Date.parse(job.updatedAt || job.createdAt || '');
    return Number.isFinite(touched) && touched >= sessionMs;
  }
  /**
   * Spend across this session's jobs, for the interactive compact report only.
   * It is time-varying, so it never reaches the integrity-digested report.md.
   * A report must not fail because this scan did.
   */
  async #sessionSpend() {
    const sessionMs = this.#sessionStartMs();
    if (sessionMs === undefined) return undefined;
    try {
      const list = (this.store.listOperational || this.store.list).bind(this.store);
      const jobs = (await list({ limit: Number.MAX_SAFE_INTEGER })).filter((job) => this.#inSession(job, sessionMs));
      return { jobs: jobs.length, costUsd: sumCost(jobs), unknown: jobs.filter((job) => costOf(job) === null).length };
    } catch {
      return undefined;
    }
  }
  async #interactiveReport(job, { detail = 'compact', ...rest } = {}) {
    const spend = detail === 'compact' ? await this.#sessionSpend() : undefined;
    return this.report(job, { detail, ...rest, ...(spend ? { spend } : {}) });
  }
  async job(id, { include = 'summary', detail = 'compact', tail, limit, all, maxJobs } = {}) {
    // Validate the window before any lookup so a bad value never reads a job.
    const window = resolveLogWindow({ tail, limit });
    const windowed = tail !== undefined || limit !== undefined;
    if (windowed && !id) throw new Error('tail and limit require a jobId and include "log"');
    if (id && (all !== undefined || maxJobs !== undefined)) throw new Error('all and maxJobs apply only to the job list; omit jobId');
    if (!id)
      return {
        ...(await this.listing({ ...(all !== undefined ? { all } : {}), ...(maxJobs !== undefined ? { maxJobs } : {}) })),
        health: this.config.health ? await this.config.health() : { sandbox: 'unknown' },
      };
    const job = await this.store.get(id);
    if (!['summary', 'diff', 'files', 'log'].includes(include)) throw new Error('include must be summary, diff, files, or log');
    if (windowed && include !== 'log') throw new Error('tail and limit apply only to include "log"');
    assertDetail(detail);
    // Asking for the diff (or files, or log) is asking for that artifact, not
    // for the report again: the caller has normally just read it. The full
    // legacy envelope stays available with detail: "full".
    if (include !== 'summary' && detail !== 'full') {
      const lean = { jobId: job.id, status: job.status };
      if (include === 'diff') return { ...lean, diff: await this.store.readArtifact(id, 'patch.diff') };
      if (include === 'files') return { ...lean, files: job.files || [] };
      return { ...lean, ...(await this.#jobLog(job, window)) };
    }
    const stall = assessStall(job, this.#nowMs());
    const result = {
      ...this.public(job),
      report: await this.#interactiveReport(job, { detail, ...(stall ? { stall } : {}) }),
      ...(stall ? { stall } : {}),
    };
    const timing = detail === 'full' && include === 'summary' ? sanitizeTiming(job.timing) : undefined;
    if (timing) result.timing = timing;
    if (include === 'diff') result.diff = await this.store.readArtifact(id, 'patch.diff');
    if (include === 'files') result.files = job.files || [];
    if (include === 'log') Object.assign(result, await this.#jobLog(job, window));
    return result;
  }
  /** The bounded, redacted log window and what it left out. */
  async #jobLog(job, window) {
    const { text, info } = jobLogWindow(job, await this.store.readArtifact(job.id, 'events.jsonl'), window, this.store?.secrets || []);
    return { log: text, logInfo: info };
  }
  async cancel(id) {
    // A separate control-plane process must be able to leave the durable
    // cancellation marker after its provider credential was rotated.  This
    // uses the store's MAC-verified operational view only; it never resumes,
    // verifies, repairs, or otherwise consumes an execution profile.
    const get = this.store.getOperational?.bind(this.store) || this.store.get?.bind(this.store);
    const before = await get(id);
    // A terminal job whose applyThenVerify command is running is still being
    // acted on: its owner (possibly another process) polls this marker.
    const applyRunning = before.applyVerifyIntent === true;
    if (!final(before.status) || applyRunning) await this.store.requestCancel?.(id);
    const controller = this.controllers.get(id);
    // Local cancellation is deliberately marker-first and asynchronous. The
    // owner task publishes the terminal state only after its normal cleanup;
    // waiting here would make a control-plane cancel block on an uncooperative
    // worker and falsely imply that cancellation is already complete.
    if (controller) controller.abort();
    let job = await get(id);
    // The run may have ended between the read above and the marker: nothing is
    // left to consume it, and a stale marker would refuse the next apply.
    if (applyRunning && job.applyVerifyIntent !== true && !this.controllers.has(id)) await this.store.clearCancel?.(id).catch(() => {});
    // Without a local controller this process is not the worker owner. Keep
    // only the durable cancellation marker written above; a queued detached
    // child may still be between handoff checks, and deleting its workspace
    // here would race its authenticated owner. Resume/assign/recovery consume
    // the marker and perform the owned terminal cleanup.
    if (!final(job.status) && !controller && ['QUEUED', 'REPAIR_QUEUED'].includes(job.status)) job = await get(id);
    return { ...this.public(job), report: this.report(job) };
  }
  async continue(id, { extraTurns, extraUsd, note, launch = true } = {}) {
    if (extraTurns !== undefined && (!Number.isInteger(extraTurns) || extraTurns < 1 || extraTurns > MAX_CONTINUE_TURNS))
      throw new Error(`extraTurns must be an integer from 1 to ${MAX_CONTINUE_TURNS}`);
    if (extraUsd !== undefined && (!Number.isFinite(extraUsd) || extraUsd < 0.01 || extraUsd > MAX_CONTINUE_USD))
      throw new Error(`extraUsd must be a number from 0.01 to ${MAX_CONTINUE_USD}`);
    if (note !== undefined && !cleanText(note, MAX_REPAIR_ITEM - 400))
      throw new Error('note must be a non-empty string up to 3600 characters');
    return this.repair(id, [CONTINUE_DEFECT, ...(note ? [`Primary's note: ${note}`] : [])], {
      launch,
      continuation: { extraTurns, extraUsd },
    });
  }
  async repair(id, defects, { launch = true, continuation } = {}) {
    if (
      !Array.isArray(defects) ||
      !defects.length ||
      defects.length > MAX_REPAIR_ITEMS ||
      !defects.every((x) => cleanText(x, MAX_REPAIR_ITEM)) ||
      defects.reduce((n, x) => n + x.length, 0) > MAX_REPAIR_CHARS
    )
      throw new Error('defects must be 1-32 non-empty bounded strings');
    const repairEnteredMs = this.#nowMs();
    let job = this.validatePersisted(await this.store.get(id));
    if (job.mode === 'report') throw new Error('report jobs are read-only and cannot be repaired; start a new report job');
    // A terminal durable state can be published just before its owning local
    // task performs final cleanup. Join that task first, then decide whether
    // a manual repair is eligible; otherwise the same request is needlessly
    // rejected as "still running" and can race replacement workspace setup.
    if (final(job.status) && this.running.has(id)) {
      await this.running.get(id);
      job = this.validatePersisted(await this.store.get(id));
    }
    if (!final(job.status) || this.running.has(id)) throw new Error('job is still running');
    if (continuation) {
      // Continuation exists so a worker that ran out of turns/cost/time keeps
      // its work. A verifier failure is a different problem with a different
      // tool (offload_repair names the defects), and a job with nothing in
      // scope has nothing worth keeping. A FAILED round is resumable only for
      // the worker-side causes the loop names (default-deny, see failure.mjs):
      // a provider, protocol, scope or integrity failure is not the worker
      // running out of road.
      if (job.status === 'FAILED' && loopedAgain(job))
        throw new Error(
          'the same tool call looped again after an earlier round; use offload_repair with a concrete change of approach, or start a fresh job',
        );
      if (!['BUDGET', 'TIMEOUT'].includes(job.status) && !continuableFailure(job))
        throw new Error(
          `only a job that stopped on BUDGET or TIMEOUT, or that FAILED in a continuable worker-side way (${FAILURE_KINDS.join(', ')}), can be continued (this one is ${job.status}); use offload_repair for defects`,
        );
      if (!Array.isArray(job.files) || !job.files.length)
        throw new Error('job has no in-scope changes to continue from; start a fresh job');
      // A cap stop can happen below the nominal cap (a request reservation the
      // remaining budget cannot cover), so "not yet exhausted" is not proof
      // that another round would get further.
      if (job.status === 'BUDGET' && continuation.extraTurns === undefined && continuation.extraUsd === undefined)
        throw new Error('a BUDGET stop needs extraTurns and/or extraUsd for the cap that stopped the job');
    }
    // A queued recovery has an intentionally constrained transcript and a
    // consumed recovery may already have issued a billable provider POST.
    // Never append a repair task to either ambiguity boundary.
    if (job.cappedFinishRecovery === 'queued' || job.cappedFinishRecovery === 'consumed')
      throw new Error('job has an unresolved capped implementation recovery; start a fresh job');
    if (job.budgetFinishRecovery !== undefined) throw new Error('job has an unresolved budget finish recovery; start a fresh job');
    if (job.applied === true) throw new Error('an applied job cannot be repaired; start a new job from the current primary tree');
    if (job.integrationIntent === true || job.revertIntent === true || job.integrationUncertain === true || job.revertUncertain === true)
      throw new Error('a job with an unresolved primary mutation outcome cannot be repaired; inspect the primary tree and start a new job');
    if (job.scopeViolations?.length || job.verifierMutations?.length)
      throw new Error('a job with scope or verifier-authorship violations cannot be repaired; start a fresh job');
    if (job.verify && !verifierUsedMacosSandbox(job.verify))
      throw new Error('jobs with a policy-only or unknown verifier result require a fresh start');
    if (await this.store.cancelRequested?.(id)) throw new Error('job was cancelled');
    if ((job.rounds || 0) >= (job.maxRepairRounds ?? 2)) throw new Error('maximum repair rounds reached');
    // A continuation raises the cumulative caps by an explicit, bounded amount
    // and is otherwise subject to every limit a repair is: it consumes one of
    // the job's rounds, and turns/cost stay cumulative across the whole job.
    const budget = continuation ? this.#raisedBudget(job, continuation) : job.budget;
    if (
      (budget?.maxTurns != null && (job.turns || 0) >= budget.maxTurns) ||
      (budget?.maxUsd != null && (job.costUsd || 0) >= budget.maxUsd)
    )
      throw new Error(
        continuation
          ? 'cumulative job budget still exhausted after the requested increase; pass extraTurns and/or extraUsd for the cap that stopped the job'
          : 'cumulative job budget exhausted',
      );
    // A worker-side FAILED continuation tells the worker what actually went
    // wrong (the loop guard's failing call); the primary's note is kept.
    const effective = continuation && job.status === 'FAILED' ? [failureContinueDefect(job), ...defects.slice(1)] : defects;
    const leaseOwnerNonce = randomUUID();
    let workspace, reservation;
    try {
      // Reserve the terminal lifecycle before inspecting or removing its old
      // workspace. Two repair callers can otherwise both read the same final
      // record, and the losing caller's cleanupWorkspace() would re-read and
      // delete the winner's replacement workspace.
      const reservationChanges = {
        status: 'REPAIRING',
        handoffState: 'REPAIR_SETUP',
        leaseOwnerNonce,
        runnerPid: process.pid,
        runnerHeartbeatAt: this.now().toISOString(),
        // Recreating the workspace can be slow on a big repo; a poller's stall
        // check measures it from here. The QUEUED write below clears it.
        activity: { phase: 'setup', since: new Date(repairEnteredMs).toISOString(), lastEventAt: new Date(repairEnteredMs).toISOString() },
      };
      reservation =
        typeof this.store.updateOperationalIf === 'function'
          ? await this.store.updateOperationalIf(id, this.#recoveryIdentity(job), reservationChanges)
          : this.#sameRecoveryIdentity(job, await this.store.get(id))
            ? await this.store.update(id, reservationChanges)
            : null;
      if (!reservation) throw new Error('job lifecycle ownership changed during repair setup');
      job = this.validatePersisted(reservation);
      if (this.isolated) {
        if (!validGitObjectId(job.before) || !validGitObjectId(job.workspaceAfter || job.before))
          throw new Error('isolated repair baseline is unavailable');
        if (!(await this.cleanupWorkspace(job.id))) throw new Error('could not clean the prior isolated workspace for repair');
        workspace = await this.config.isolation.create({
          repoPath: job.repoPath,
          baselineTree: job.before,
          seedTree: job.workspaceAfter || job.before,
        });
        if (!workspace?.path || typeof workspace.path !== 'string') throw new Error('could not recreate isolated workspace for repair');
      }
      if (this.leases.acquire) {
        if (this.leases.acquire.length >= 2) await this.leases.acquire(job.id, writeScope(job), { ownerNonce: leaseOwnerNonce });
        else await this.leases.acquire({ jobId: job.id, repoPath: job.repoPath, ownedPaths: writeScope(job) });
      }
      const repairChanges = {
        status: 'QUEUED',
        rounds: (job.rounds || 0) + 1,
        // The workspace recreation above is this round's setup time.
        roundQueue: this.#roundQueue(repairEnteredMs),
        activity: undefined,
        finishedAt: undefined,
        autoRepairScheduled: false,
        leaseOwnerNonce,
        handoffState: launch ? 'LOCAL' : 'PARENT_QUEUED',
        runnerPid: process.pid,
        runnerHeartbeatAt: this.now().toISOString(),
        pendingDefects: effective,
        ...ROUND_SCOPED_VERIFIER_STATE,
        ...ROUND_SCOPED_ERROR_STATE,
        // Remembered across the reset above: if the next round loops on this
        // very call again, another round will not help.
        ...(job.toolFailure?.signature ? { priorLoopSignature: job.toolFailure.signature } : {}),
        ...(continuation ? { budget, continuations: (job.continuations || 0) + 1 } : {}),
        // The sizing record describes the cap at start; keep it in step with
        // the raised cap so a report never shows the pre-continuation one.
        ...(continuation && job.budgetSizing && budget?.maxTurns !== job.budget?.maxTurns
          ? { budgetSizing: raiseBudgetSizing(job.budgetSizing, budget.maxTurns) }
          : {}),
        providerFailure: undefined,
        providerFinishReason: undefined,
        budgetReservation: undefined,
        ...(workspace
          ? {
              workspacePath: workspace.path,
              workspaceBaseline: job.before,
              workspaceSeed: job.workspaceAfter || job.before,
              ...workspaceDependencyState(workspace),
              workspaceCleanedAt: undefined,
              workspaceCleanupError: undefined,
            }
          : {}),
      };
      const next =
        typeof this.store.updateOperationalIf === 'function'
          ? await this.store.updateOperationalIf(id, this.#recoveryIdentity(job), repairChanges)
          : this.#sameRecoveryIdentity(job, await this.store.get(id))
            ? await this.store.update(id, repairChanges)
            : null;
      if (!next) throw new Error('job lifecycle ownership changed during repair setup');
      // Record acceptance before launching asynchronously. A worker that
      // returns without model/tool progress is still distinguishable from a
      // repair request that was never accepted.
      await this.store.event(id, { type: 'started', reason: 'repair', round: next.rounds || 0, status: next.status });
      await this.store.event(id, {
        type: 'progress',
        status: next.status,
        round: next.rounds || 0,
        turns: next.turns || 0,
        usage: next.usage || {},
        costUsd: next.costUsd || 0,
        recentActions: ['repair_queued'],
      });
      if (launch) this._launch(id, 'repair', effective, next);
      return this.public(next);
    } catch (error) {
      if (reservation)
        // `failureKind` is cleared so a half-set-up round cannot leave a
        // continuable marker; the old call stays as diagnostics.
        await this.#finishOwnedTerminal(
          job,
          'FAILED',
          { error: `repair setup failed: ${error.message || error}`, failureKind: undefined },
          leaseOwnerNonce,
          {
            expectedIdentity: this.#recoveryIdentity(job),
          },
        ).catch(() => {});
      let cleanupFailure;
      try {
        await workspace?.cleanup?.();
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
      if (cleanupFailure)
        throw new Error(
          `${String(error.message || error)}; replacement isolated workspace cleanup failed at ${workspace.path} and must be retried`,
        );
      throw error;
    }
  }
  /**
   * Integrate a finished job's diff into the primary checkout although the
   * server never verified it (the verifier could not run, failed, or the
   * worker stopped on a cap, or ended FAILED with an intact in-scope diff:
   * see failedApplyRefusal). The primary vouches for it with `verifiedBy`,
   * which is recorded and shown on every later report, or has the server check
   * it with `applyThenVerify`: a command run in the primary right after the
   * apply, whose failure reverts the diff. Everything that protects automatic
   * integration still applies: primary conflict check on every touched path,
   * owned-path-only patch, branch/HEAD and index drift checks, a write-scope
   * lease against concurrent jobs, a durable intent journal reconciled against
   * the live tree, and `offload_revert` afterwards. `apply: false` is a
   * side-effect-free dry run.
   */
  async apply(id, { apply = false, verifiedBy, applyThenVerify, applyThenVerifyTimeoutSec, unsafePolicyOnlyVerifier, signal } = {}) {
    if (typeof apply !== 'boolean') throw new Error('apply must be boolean');
    const plan = normalizeApplyVerify({ applyThenVerify, applyThenVerifyTimeoutSec, unsafePolicyOnlyVerifier });
    const evidence = typeof verifiedBy === 'string' ? verifiedBy.trim() : '';
    // A command is an alternative to the primary's own evidence, so `verifiedBy`
    // is optional beside it; a malformed one is still refused rather than ignored.
    const evidenceSupplied = verifiedBy !== undefined && verifiedBy !== '';
    const evidenceValid = evidence.length >= MIN_VERIFIED_BY && !!cleanText(evidence, MAX_VERIFIED_BY);
    if (apply && !(plan && !evidenceSupplied) && !evidenceValid)
      throw new Error(
        `verifiedBy must state the check you ran yourself in the primary checkout (${MIN_VERIFIED_BY}-${MAX_VERIFIED_BY} characters) or applyThenVerify must give a command the server runs after applying (it is reverted if that fails); an unverified diff is never applied silently`,
      );
    // A terminal status can be published just before its owning task finishes
    // cleanup; join it, then refuse if anything else still owns the job.
    if (this.running.has(id)) await this.running.get(id).catch(() => {});
    if (this.running.has(id)) throw new Error('job is busy');
    // No await between the check above and the registration below, so two
    // callers in this process cannot both pass.
    const task = this.#applyRecorded(id, { apply, evidence, plan, signal });
    // Other callers join this promise to wait for the owner to finish; only the
    // owner may see the owner's error.
    const joinable = task.then(
      () => {},
      () => {},
    );
    this.running.set(id, joinable);
    try {
      return await task;
    } finally {
      if (this.running.get(id) === joinable) this.running.delete(id);
    }
  }
  /**
   * The command runs through the same Runner as a testCommand, with the primary
   * checkout READ-ONLY: it can write only its per-run temp directory. That is
   * what makes the automatic revert exact (the command cannot dirty what must
   * be restored) and is why it fails closed on a policy-only host: without OS
   * isolation nothing stops the command from writing anywhere, so it needs the
   * same explicit unsafePolicyOnlyVerifier consent as a testCommand.
   */
  #assertApplyVerifySandbox(plan) {
    if (typeof this.runner?.verify !== 'function') throw new Error('applyThenVerify is unavailable: this manager has no command runner');
    if (plan.policyOnly) return;
    const status = typeof this.runner.sandboxStatus === 'function' ? this.runner.sandboxStatus() : undefined;
    const available = status ? status.available === true : this.runner.sandboxAvailable?.();
    if (available === false)
      throw new Error(
        `applyThenVerify requires a macOS sandbox and this host is policy-only (${status?.reason || 'sandbox unavailable'}). Run the check yourself in the primary checkout and pass verifiedBy instead; only if the user specifically authorized the unsafePolicyOnlyVerifier exception may you pass unsafePolicyOnlyVerifier: true`,
      );
  }
  /**
   * Why a FAILED job ended, as it travels with a diff applied from it: the
   * closed worker-side kind (if any) and the bounded reason. `error` is cleared
   * once the apply succeeds, and an applyThenVerify message never describes
   * the job's own failure.
   */
  #failureOrigin(job) {
    const kind = safeFailureKind(job.failureKind);
    const error = typeof job.error === 'string' && !job.error.startsWith('applyThenVerify ') ? job.error : '';
    const reason = (error || (kind ? FAILURE_ERRORS[kind] : '') || 'no failure reason was recorded').slice(0, 300);
    return { ...(kind ? { kind } : {}), reason };
  }
  /**
   * The apply itself integrates the recorded trees, not the stored patch, so
   * a FAILED job proves they agree first: `revert.diff` must pass the store's
   * digest check, be non-empty, and equal the diff between the job's recorded
   * baseline and result snapshots over its owned paths. Whatever the primary
   * reviewed is then what lands.
   */
  async #assertRetainedPatch(job, paths) {
    const unverifiable = (why) =>
      new Error(
        `this FAILED job's retained diff cannot be verified against its recorded snapshots (${why}); nothing was applied. Start a fresh job, or review the diff and apply it by hand`,
      );
    if (typeof this.snapshots?.diff !== 'function' || typeof this.store.readArtifactBytes !== 'function')
      throw unverifiable('no snapshot differ or artifact reader is available');
    let retained;
    try {
      retained = await this.store.readArtifactBytes(job.id, 'revert.diff');
    } catch {
      throw unverifiable('the stored revert.diff is unreadable or failed its integrity check');
    }
    if (!retained?.length) throw unverifiable('the stored revert.diff is empty');
    let recorded;
    try {
      recorded = await this.snapshots.diff(job.repoPath, job.before, job.workspaceAfter, { paths, literalPaths: true });
    } catch {
      throw unverifiable('a recorded snapshot is missing');
    }
    if (!Buffer.from(recorded).equals(Buffer.from(retained)))
      throw unverifiable('the stored revert.diff differs from the recorded snapshots');
  }
  async #applyRecorded(id, { apply, evidence, plan = null, signal }) {
    let job = this.validatePersisted(await this.store.get(id));
    if (job.mode === 'report') throw new Error('report jobs never integrate into the primary checkout');
    if (!final(job.status)) throw new Error('job is still running');
    job = await this.#settleOrphanedApplyVerify(job, { callerRuns: true });
    // Checked before the integration journal below: reconciling that journal
    // would rewrite the record of a run another process is still executing.
    if (job.applyVerifyIntent === true)
      throw new Error(
        this.#applyInFlight(job)
          ? 'an applyThenVerify run is already in progress for this job'
          : 'an interrupted applyThenVerify run has not been recovered yet; restart the offload server (recovery runs at startup) before retrying',
      );
    if (job.revertIntent === true || job.revertUncertain === true || job.integrationUncertain === true)
      throw new Error('a job with an unresolved primary mutation outcome cannot be applied; inspect the primary tree');
    if (job.integrationIntent === true) {
      const reconciliation = await this.#reconcileIntegration(job);
      job = this.validatePersisted(await this.store.update(id, reconciliation));
      if (reconciliation.integrationOutcome === 'applied') return { dryRun: false, applied: true, alreadyApplied: true };
      if (reconciliation.integrationOutcome === 'uncertain')
        throw new Error('integration outcome is uncertain; inspect primary changes manually');
    }
    if (job.applied === true) throw new Error('job is already applied (use offload_revert to undo it)');
    // A FAILED job qualifies only through the gate the report shares, whatever
    // made it fail (see failedApplyRefusal); CANCELLED never does.
    if (job.status === 'FAILED') {
      const refusal = failedApplyRefusal(job);
      if (refusal) throw new Error(`a FAILED job cannot be applied this way: ${refusal}`);
    } else if (!APPLY_ELIGIBLE.has(job.status))
      throw new Error(
        `a ${job.status} job cannot be applied this way; eligible: ${[...APPLY_ELIGIBLE].join(', ')}, or FAILED with an intact in-scope diff (a verified or unverified-success job integrates automatically; a CANCELLED job was stopped on purpose)`,
      );
    if (job.scopeViolations?.length || job.verifierMutations?.length)
      throw new Error('a job with scope or verifier-authorship violations is never applied; start a fresh job');
    if (await this.store.cancelRequested?.(id)) throw new Error('job was cancelled');
    const integrateRecorded = this.config.isolation?.integrateRecorded;
    if (!this.isolated || !job.workspacePath || typeof integrateRecorded !== 'function')
      throw new Error('late integration is unavailable for this job (it did not run in an isolated worktree)');
    if (!validGitObjectId(job.before) || !validGitObjectId(job.workspaceAfter)) throw new Error('job has no recorded result to apply');
    const paths = job.revertFiles;
    if (!safeRevertPaths(paths) || !paths.length) throw new Error('job has no in-scope changes to apply');
    if (plan) this.#assertApplyVerifySandbox(plan);
    // Origin of the applied diff: only a FAILED job needs it spelled out, as it
    // is the one whose worker did not end cleanly.
    const failure = job.status === 'FAILED' ? this.#failureOrigin(job) : undefined;
    if (job.status === 'FAILED') await this.#assertRetainedPatch(job, paths);
    const currentBranch = this.config.git ? await this.config.git.branch(job.repoPath) : git(job.repoPath, ['branch', '--show-current']);
    const currentHead = this.config.git ? await this.config.git.head(job.repoPath) : git(job.repoPath, ['rev-parse', 'HEAD']);
    if (currentBranch !== job.branch || currentHead !== job.head)
      throw new Error('job patch is stale; primary branch or HEAD changed since the job started');
    if (primaryIndexChanged(job.repoPath, job.primaryIndexBefore, paths))
      throw new Error('job patch is stale; primary index changed on a job-owned file');
    const target = { repoPath: job.repoPath, baselineTree: job.before, afterTree: job.workspaceAfter, paths };
    const mapConflict = (error) => {
      if (error?.code === 'E_WORKTREE_CONFLICT')
        return new Error(
          'primary working tree changed on a job-touched path; nothing was applied. Reconcile the primary or start a fresh job',
        );
      return error;
    };
    // The same conflict and `git apply --check` gates the real apply runs,
    // without writing. A refusal here leaves no journal and no lease behind.
    let preview;
    try {
      preview = integrateRecorded({ ...target, dryRun: true });
    } catch (error) {
      throw mapConflict(error);
    }
    if (!apply)
      return {
        dryRun: true,
        applied: false,
        files: (preview.files || []).map((file) => file.path),
        fromStatus: job.status,
        ...(failure ? { failure } : {}),
        ...(plan
          ? {
              applyThenVerify: {
                command: plan.command,
                timeoutSec: plan.timeoutSec,
                sandbox: plan.policyOnly ? 'policy-only-authorized' : 'required',
              },
            }
          : {}),
      };
    // Serialize against jobs that may write the same scope, exactly as a
    // repair round reacquires its write lease. The lease is held through the
    // command and any revert: nothing else may claim this scope meanwhile.
    const leaseOwnerNonce = randomUUID();
    if (this.leases.acquire) {
      if (this.leases.acquire.length >= 2) await this.leases.acquire(job.id, writeScope(job), { ownerNonce: leaseOwnerNonce });
      else await this.leases.acquire({ jobId: job.id, repoPath: job.repoPath, ownedPaths: writeScope(job) });
    }
    // Registered like a worker's controller so offload_cancel, a client's
    // request cancellation and server shutdown all stop the command (and so
    // trigger the revert) instead of waiting out its timeout.
    const controller = plan ? new AbortController() : undefined;
    let detachSignal;
    let cancellationWatch;
    if (controller) {
      this.controllers.set(id, controller);
      // Another process's cancel only leaves the durable marker, as it does
      // for a worker round (and it writes one for a job whose apply is running).
      cancellationWatch = setInterval(
        () =>
          this.store
            .cancelRequested?.(id)
            .then((cancelled) => {
              if (cancelled) controller.abort();
            })
            .catch(() => {}),
        100,
      );
      cancellationWatch.unref?.();
      if (signal?.aborted) controller.abort();
      else if (signal) {
        const onAbort = () => controller.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        detachSignal = () => signal.removeEventListener('abort', onAbort);
      }
    }
    try {
      const record = plan
        ? {
            phase: 'applying',
            command: this.#recordedCommand(plan.command),
            timeoutSec: plan.timeoutSec,
            sandbox: plan.policyOnly ? 'policy-only-authorized' : 'required',
            startedAt: this.now().toISOString(),
            previousStatus: job.status,
            attempts: (Number.isInteger(job.applyVerify?.attempts) ? job.applyVerify.attempts : 0) + 1,
          }
        : undefined;
      // Undoes the journal of a failure that provably left the primary alone.
      const clearApplyVerify = plan ? { applyVerifyIntent: false, applyVerify: job.applyVerify } : {};
      const intent = {
        integrationIntent: true,
        integrationIntentAt: this.now().toISOString(),
        integrationPaths: paths,
        integrationFinalStatus: 'DONE_UNVERIFIED',
        applyPreviousStatus: job.status,
        applyVerifiedBy: evidence,
        ...(plan ? { applyVerifyIntent: true, applyVerify: record } : {}),
        // A live applier is skipped by another process's recovery pass, and a
        // dead one is recovered through the journal like any crashed owner.
        runnerPid: process.pid,
        runnerHeartbeatAt: this.now().toISOString(),
        leaseOwnerNonce,
      };
      const claimed =
        typeof this.store.updateOperationalIf === 'function'
          ? await this.store.updateOperationalIf(id, this.#recoveryIdentity(job), intent)
          : this.#sameRecoveryIdentity(job, await this.store.get(id))
            ? await this.store.update(id, intent)
            : null;
      if (!claimed) throw new Error('job lifecycle ownership changed during apply');
      let integrated;
      try {
        if ((await this.store.cancelRequested?.(id)) || controller?.signal.aborted) {
          await this.store.update(id, { integrationIntent: false, integrationOutcome: 'not-applied', ...clearApplyVerify });
          throw new Error('job was cancelled');
        }
        integrated = integrateRecorded(target);
      } catch (error) {
        const current = await this.store.get(id);
        if (!current.integrationIntent) throw error;
        // These all fail before `git apply` writes anything: the primary is
        // provably untouched, so a primary that merely differs from the
        // baseline must not be read back as an "uncertain" outcome.
        if (PRE_MUTATION_ERRORS.has(error?.code)) {
          await this.store.update(id, { integrationIntent: false, integrationOutcome: 'not-applied', ...clearApplyVerify });
          throw mapConflict(error);
        }
        const reconciliation = await this.#reconcileIntegration(current);
        await this.store.update(id, { ...reconciliation, ...(reconciliation.integrationOutcome === 'applied' ? {} : clearApplyVerify) });
        if (reconciliation.integrationOutcome === 'applied') integrated = { files: [] };
        else if (reconciliation.integrationOutcome === 'uncertain') {
          await this.store.update(id, {
            integrationConflict: false,
            error: 'integration outcome is uncertain; inspect primary changes manually',
          });
          throw new Error('integration outcome is uncertain; inspect primary changes manually');
        } else throw mapConflict(error);
      }
      // From here the primary may hold the diff. An exception nobody planned
      // for (a store write, a pin) must be settled from the live tree rather
      // than leave a journal that claims a live run which never started.
      let reconciliation;
      try {
        const pending = await this.store.get(id);
        reconciliation = await this.#reconcileIntegration(pending);
        if (reconciliation.integrationOutcome === 'applied') {
          await this.#pinTrees(pending, {
            before: pending.before,
            ...(pending.workerAfter ? { workerAfter: pending.workerAfter } : {}),
            workspaceAfter: pending.workspaceAfter,
            primaryAfter: reconciliation.primaryAfter,
          });
        }
      } catch (error) {
        if (!plan) throw error;
        throw await this.#abandonApplyVerify(id, error);
      }
      if (reconciliation.integrationOutcome !== 'applied') {
        await this.store.update(id, { ...reconciliation, ...clearApplyVerify });
        throw new Error(
          reconciliation.integrationOutcome === 'uncertain'
            ? 'integration outcome is uncertain; inspect primary changes manually'
            : 'the diff was not applied',
        );
      }
      if (plan) {
        // The diff is in the primary but no status is published: it stays what
        // it was until the command decides, and the journal (applyVerifyIntent
        // plus its phase) is what a crash from here on is recovered from.
        const verifying = { ...record, phase: 'verifying', verifyStartedAt: this.now().toISOString() };
        try {
          await this.store.update(id, { ...reconciliation, integrationFiles: integrated.files || [], applyVerify: verifying });
          await this.store.event(id, { type: 'apply-verify-started', command: record.command.slice(0, 200), timeoutSec: plan.timeoutSec });
        } catch (error) {
          throw await this.#abandonApplyVerify(id, error);
        }
        return await this.#runApplyVerify(job, { plan, paths, evidence, record: verifying, reconciliation, integrated, controller });
      }
      const appliedAt = this.now().toISOString();
      const done = await this.store.update(id, {
        ...reconciliation,
        integrationFiles: integrated.files || [],
        status: 'DONE_UNVERIFIED',
        finalStatus: 'DONE_UNVERIFIED',
        // `error` is cleared below, so a FAILED job's cause is kept here.
        appliedUnverified: { at: appliedAt, previousStatus: job.status, verifiedBy: evidence, ...(failure ? { failure } : {}) },
        // The primary has acted on an earlier applyThenVerify outcome (it fixed
        // the cause, or vouches for the diff itself): it no longer describes
        // the job, and "reverted, apply again" would contradict the apply.
        applyVerify: undefined,
        error: undefined,
        integrationConflict: undefined,
      });
      await this.store.writeArtifact(id, 'report.md', this.report(done));
      await this.store.event(id, { type: 'applied-unverified', previousStatus: job.status, files: (integrated.files || []).length });
      return {
        dryRun: false,
        applied: true,
        files: paths,
        previousStatus: job.status,
        status: 'DONE_UNVERIFIED',
        ...(failure ? { failure } : {}),
      };
    } finally {
      detachSignal?.();
      if (cancellationWatch) clearInterval(cancellationWatch);
      if (controller && this.controllers.get(id) === controller) {
        this.controllers.delete(id);
        // The marker was addressed to this run and must not refuse the next apply.
        await this.store.clearCancel?.(id).catch(() => {});
      }
      try {
        await this.leases.release?.(id, { ownerNonce: leaseOwnerNonce });
      } catch {}
    }
  }
  /**
   * Run the caller's command against the just-applied primary and decide: pass
   * leaves the job DONE_UNVERIFIED with the command, exit status and output
   * tail as the primary's own check (never "server-verified"); anything else
   * reverts the diff through the ordinary revert machinery, proves the revert
   * from the live tree, and puts the job back as apply-eligible as it was.
   * Whatever cannot be restored cleanly is published and thrown loudly: the
   * apply never leaves a half state that only a lost response could explain.
   * The caller holds the lease and owns the controller for the whole call.
   */
  async #runApplyVerify(job, { plan, paths, evidence, record, reconciliation, integrated, controller }) {
    const id = job.id;
    const requireSandbox = !plan.policyOnly;
    const startedMs = Date.now();
    try {
      let run;
      let thrown;
      if (!controller.signal.aborted) {
        try {
          const gitDir = this.config.gitDir
            ? await this.config.gitDir(job.repoPath)
            : resolve(job.repoPath, git(job.repoPath, ['rev-parse', '--git-dir']));
          run = await this.runner.verify(plan.command, {
            cwd: job.repoPath,
            gitDir,
            signal: controller.signal,
            // Never the job's own network grant: this runs worker-authored code
            // against the whole primary checkout, including gitignored local
            // data the isolated-worktree verifier never saw.
            allowNetwork: false,
            denyRead: job.denyRead || [],
            // Read-only primary: only the per-run temp directory is writable.
            writablePaths: [],
            ...interpreterPathsOption(job),
            requireSandbox,
            timeoutMs: plan.timeoutSec * 1000,
          });
        } catch (error) {
          thrown = error;
        }
      }
      const classified = classifyApplyVerifyRun(thrown !== undefined ? { thrown } : (run ?? null), {
        requireSandbox,
        aborted: controller.signal.aborted,
      });
      const finishedAt = this.now().toISOString();
      const { phase: _phase, ...base } = record;
      const result = {
        ...base,
        outcome: classified.outcome,
        ...(classified.exitCode !== undefined ? { exitCode: classified.exitCode } : {}),
        durationMs: classified.durationMs ?? Date.now() - startedMs,
        ...(classified.sandbox ? { ranUnder: classified.sandbox } : {}),
        ...(classified.error ? { error: classified.error } : {}),
        outputTail: this.#storedText(applyVerifyTail(run?.result)),
        finishedAt,
      };
      // The command, a policy-only write, or a person may have touched the
      // primary while it ran. Job-owned drift (or a branch/HEAD/index move)
      // makes a reverse patch unsafe and a pass untrustworthy; edits to other
      // files are tolerated, reported, and left alone.
      let drift;
      let others = [];
      try {
        const state = await this.#primaryState(job, paths);
        const intact = this.#sameSelectedTreePaths(job.repoPath, reconciliation.primaryAfter, state.primaryTree, paths);
        const stable = state.branch === job.branch && state.head === job.head && state.indexUnchanged;
        let changed = [];
        if (this.snapshots.files) {
          try {
            changed = (await this.snapshots.files(job.repoPath, reconciliation.primaryAfter, state.primaryTree)).map((file) => file.path);
          } catch {}
        }
        const owned = new Set(paths);
        others = changed.filter((path) => !owned.has(path)).slice(0, 20);
        if (!intact || !stable) {
          const touched = changed.filter((path) => owned.has(path));
          drift = {
            reason: !stable
              ? 'branch, HEAD, or the index of a job-owned file changed'
              : `job-owned path changed${touched.length ? `: ${touched.slice(0, 10).join(', ')}` : ''}`,
            changed: touched.slice(0, 20),
          };
        }
      } catch {
        drift = { reason: 'the primary state could not be re-read', changed: [] };
      }
      if (!drift && classified.outcome === 'PASSED') {
        const passed = { ...result, ...(others.length ? { primaryChangedDuringVerify: others } : {}) };
        const failure = job.status === 'FAILED' ? this.#failureOrigin(job) : undefined;
        const done = await this.store.update(id, {
          applyVerifyIntent: false,
          applyVerify: passed,
          status: 'DONE_UNVERIFIED',
          finalStatus: 'DONE_UNVERIFIED',
          appliedUnverified: {
            at: finishedAt,
            previousStatus: job.status,
            verifiedBy: evidence,
            applyThenVerify: { command: passed.command, outcome: 'PASSED', exitCode: passed.exitCode },
            ...(failure ? { failure } : {}),
          },
          error: undefined,
          integrationConflict: undefined,
        });
        await this.store.writeArtifact(id, 'report.md', this.report(done));
        await this.store.event(id, {
          type: 'applied-unverified',
          previousStatus: job.status,
          files: paths.length,
          applyThenVerify: 'PASSED',
        });
        return {
          dryRun: false,
          applied: true,
          files: paths,
          previousStatus: job.status,
          status: 'DONE_UNVERIFIED',
          ...(failure ? { failure } : {}),
          applyThenVerify: this.#applyVerifyResult(passed),
        };
      }
      if (drift) {
        const unresolved = {
          ...result,
          outcome: 'PRIMARY_CHANGED',
          commandOutcome: classified.outcome,
          reverted: false,
          autoRevertError: `no automatic revert was attempted because ${drift.reason}; reverting could overwrite those changes`,
          ...(drift.changed.length ? { changed: drift.changed } : {}),
        };
        throw await this.#publishApplyVerifyUnresolved(job, unresolved, evidence);
      }
      // Anything that is not a pass, with the primary exactly as applied.
      await this.store.update(id, { applyVerify: { ...result, phase: 'reverting' } });
      try {
        await this.#revert(id, { apply: true, auto: true });
      } catch (error) {
        throw await this.#publishApplyVerifyUnresolved(
          job,
          { ...result, reverted: false, autoRevertError: String(error?.message || error).slice(0, 500) },
          evidence,
        );
      }
      let primaryRestoredExactly;
      if (!others.length && validGitObjectId(integrated?.primaryBefore) && this.snapshots.create) {
        try {
          primaryRestoredExactly = (await this.snapshots.create(job.repoPath)) === integrated.primaryBefore;
        } catch {}
      } else if (others.length) primaryRestoredExactly = false;
      const restored = {
        ...result,
        reverted: true,
        revertVerified: true,
        ...(primaryRestoredExactly !== undefined ? { primaryRestoredExactly } : {}),
        ...(others.length ? { primaryChangedDuringVerify: others } : {}),
      };
      const done = await this.store.update(id, {
        ...APPLY_RESET,
        after: job.after,
        noChanges: job.noChanges,
        integrationUncertain: job.integrationUncertain,
        applyVerifyIntent: false,
        applyVerify: restored,
      });
      await this.store.writeArtifact(id, 'report.md', this.report(done));
      await this.store.event(id, { type: 'apply-verify-reverted', outcome: result.outcome, exitCode: result.exitCode });
      return {
        dryRun: false,
        applied: false,
        reverted: true,
        files: paths,
        previousStatus: job.status,
        status: job.status,
        applyThenVerify: this.#applyVerifyResult(restored),
        message:
          `applyThenVerify ${result.outcome}; the diff was REVERTED and the primary's job-owned paths are verified identical to before` +
          (primaryRestoredExactly === false ? ' (other primary files changed during verification and were left alone)' : ''),
      };
    } catch (error) {
      if (error?.applyVerifyReported) throw error;
      throw await this.#abandonApplyVerify(id, error);
    }
  }
  /**
   * Text exactly as the store will persist it (its key/shape redaction, then
   * the literal secrets), so what the apply call returns and what is stored
   * and reported can never differ by a credential the lighter text redactor
   * does not recognize.
   */
  #storedText(text) {
    return redactText(redactTokenShapes(text), this.store?.secrets || []);
  }
  /**
   * The command as journaled: redacted and clipped, so the stored record is
   * bounded however much the store's redaction would grow a long command.
   * The command that runs is always the caller's own text, never this display.
   */
  #recordedCommand(command) {
    const stored = this.#storedText(command);
    return stored.length > APPLY_VERIFY_RECORD_COMMAND ? `${stored.slice(0, APPLY_VERIFY_RECORD_COMMAND)}…` : stored;
  }
  /** What the apply call itself returns: the bounded view plus the evidence tail. */
  #applyVerifyResult(record) {
    return { ...publicApplyVerify(record), outputTail: record.outputTail || '' };
  }
  /**
   * The command finished (or the revert failed) and the diff is STILL in the
   * primary: publish that as the durable truth (status DONE_UNVERIFIED, applied,
   * a report that says the verification did not pass) and return the error the
   * caller must throw. Never returns normally without having tried to record it.
   */
  async #publishApplyVerifyUnresolved(job, record, evidence) {
    const id = job.id;
    const label = record.outcome === 'PRIMARY_CHANGED' ? record.commandOutcome : record.outcome;
    const reason =
      record.outcome === 'PRIMARY_CHANGED'
        ? `${record.autoRevertError}${label === 'PASSED' ? '; the command passed but is not trusted' : ''}`
        : record.autoRevertError;
    const message = `applyThenVerify ${label} and the automatic revert did NOT complete (${reason}). The diff is STILL APPLIED to the primary checkout (job ${id}); inspect it and run offload_revert (dry run first).`;
    let published = '';
    try {
      const failure = job.status === 'FAILED' ? this.#failureOrigin(job) : undefined;
      const done = await this.store.update(id, {
        applyVerifyIntent: false,
        applyVerify: record,
        status: 'DONE_UNVERIFIED',
        finalStatus: 'DONE_UNVERIFIED',
        appliedUnverified: {
          at: record.finishedAt,
          previousStatus: job.status,
          verifiedBy: evidence,
          applyThenVerify: { command: record.command, outcome: record.outcome },
          ...(failure ? { failure } : {}),
        },
        error: message.slice(0, 1500),
        integrationConflict: undefined,
      });
      await this.store.writeArtifact(id, 'report.md', this.report(done));
      await this.store.event(id, { type: 'apply-verify-revert-failed', outcome: record.outcome, commandOutcome: record.commandOutcome });
    } catch (error) {
      published = ` The durable record could not be updated (${String(error?.message || error).slice(0, 200)}); it is left for recovery.`;
    }
    const tail = String(record.outputTail || '').slice(-1500);
    return Object.assign(new Error(`${message}${published}${tail ? ` Output tail:\n${tail}` : ''}`), { applyVerifyReported: true });
  }
  /**
   * An exception nobody planned for after the primary was mutated. The live
   * tree, not the exception, says whether the diff is still applied.
   */
  async #abandonApplyVerify(id, cause) {
    const detail = String(cause?.message || cause).slice(0, 300);
    let applied = true;
    try {
      const current = await this.store.get(id);
      const reconciliation = await this.#reconcileIntegration(current);
      const settled = this.#applyVerifySettlement(current, reconciliation, { outcome: 'INTERRUPTED', error: detail });
      applied = settled.applied;
      const done = await this.store.update(id, { ...settled.changes, status: settled.finalStatus, finalStatus: settled.finalStatus });
      await this.store.writeArtifact(id, 'report.md', this.report(done));
    } catch {}
    return new Error(
      `applyThenVerify stopped unexpectedly (${detail}); ${applied ? `the diff may STILL BE APPLIED to the primary checkout (job ${id}): inspect it and run offload_revert (dry run first)` : 'the diff is not applied'}`,
    );
  }
  /**
   * Decide the record of an interrupted applyThenVerify run from the live tree
   * (a reconciliation of the integration journal): crash recovery and an
   * unexpected exception share this. It never claims PASSED.
   */
  #applyVerifySettlement(job, reconciliation, { outcome = 'INTERRUPTED', error } = {}) {
    const journal = job.applyVerify && typeof job.applyVerify === 'object' ? job.applyVerify : {};
    const { phase: _phase, ...rest } = journal;
    const applied = reconciliation.integrationOutcome === 'applied';
    const previousStatus = final(journal.previousStatus)
      ? journal.previousStatus
      : final(job.applyPreviousStatus)
        ? job.applyPreviousStatus
        : 'FAILED';
    const at = this.now().toISOString();
    const clear = { applyVerifyIntent: false, revertIntent: false, integrationIntent: false };
    if (applied) {
      const record = { ...rest, outcome, reverted: false, finishedAt: at, ...(error ? { autoRevertError: error } : {}) };
      // The record is read before anything cleared its error, so it still names the FAILED cause.
      const failure = previousStatus === 'FAILED' && job.status === 'FAILED' ? this.#failureOrigin(job) : undefined;
      return {
        applied: true,
        finalStatus: 'DONE_UNVERIFIED',
        changes: {
          ...reconciliation,
          ...clear,
          revertOutcome: undefined,
          revertUncertain: false,
          applyVerify: record,
          appliedUnverified: {
            at,
            previousStatus,
            verifiedBy: typeof job.applyVerifiedBy === 'string' ? job.applyVerifiedBy.slice(0, MAX_VERIFIED_BY) : '',
            applyThenVerify: { command: record.command, outcome },
            ...(failure ? { failure } : {}),
          },
        },
      };
    }
    if (reconciliation.integrationOutcome === 'uncertain')
      return {
        applied: false,
        finalStatus: 'FAILED',
        changes: {
          ...reconciliation,
          ...clear,
          applyVerify: { ...rest, outcome, reverted: false, finishedAt: at },
          error: 'applyThenVerify outcome is uncertain; inspect primary changes manually',
        },
      };
    return {
      applied: false,
      finalStatus: previousStatus,
      changes: {
        ...APPLY_RESET,
        ...clear,
        integrationOutcome: undefined,
        integrationUncertain: false,
        applyVerify: { ...rest, outcome, reverted: true, finishedAt: at },
      },
    };
  }
  #raisedBudget(job, { extraTurns, extraUsd }) {
    const budget = { ...(job.budget || {}) };
    if (extraTurns !== undefined && budget.maxTurns != null) budget.maxTurns += extraTurns;
    if (extraUsd !== undefined && budget.maxUsd != null) budget.maxUsd = Math.round((budget.maxUsd + extraUsd) * 1e6) / 1e6;
    if (budget.maxTurns > MAX_RESULT_TURNS)
      throw new Error(
        `raised maxTurns ${budget.maxTurns} exceeds the cumulative ceiling of ${MAX_RESULT_TURNS}; use a smaller extraTurns or start a fresh job`,
      );
    if (budget.maxUsd > MAX_RESULT_COST)
      throw new Error(
        `raised maxUsd ${budget.maxUsd} exceeds the cumulative ceiling of ${MAX_RESULT_COST}; use a smaller extraUsd or start a fresh job`,
      );
    // The raised caps must still satisfy the request validator that guards
    // every persisted record (ceilings on turns and cost).
    this.validate({ ...jobInput(job), budget });
    return budget;
  }
  async revert(id, { apply = false } = {}) {
    return this.#revert(id, { apply });
  }
  /**
   * Record changes that retire an applyThenVerify outcome once the primary has
   * reverted the job by hand: the record, the "STILL APPLIED" error it left
   * behind, and the report's pointer to it. Nothing for a job with none.
   */
  #supersededApplyVerify(job) {
    const stale = job?.applyVerify !== undefined || (typeof job?.error === 'string' && job.error.startsWith('applyThenVerify '));
    if (!stale) return {};
    const { applyThenVerify: _gone, ...applied } =
      job.appliedUnverified && typeof job.appliedUnverified === 'object' ? job.appliedUnverified : {};
    return {
      applyVerify: undefined,
      ...(typeof job.error === 'string' && job.error.startsWith('applyThenVerify ') ? { error: undefined } : {}),
      ...(job.appliedUnverified ? { appliedUnverified: applied } : {}),
    };
  }
  /**
   * `auto` is applyThenVerify reverting its own diff while it still owns the
   * job; every other caller is refused while such a run is in progress, so a
   * manual revert can never race the command or the automatic revert.
   */
  async #revert(id, { apply = false, auto = false } = {}) {
    // This is a destructive boundary. JSON Schema metadata in an MCP client is
    // advisory, and embedded callers can bypass it entirely, so only a literal
    // boolean true may authorize applying a reverse patch.
    if (typeof apply !== 'boolean') throw new Error('apply must be boolean');
    let job = this.validatePersisted(await this.store.get(id));
    if (job.mode === 'report') throw new Error('report jobs never integrate into the primary checkout and cannot be reverted');
    if (!auto) job = await this.#settleOrphanedApplyVerify(job);
    if (!auto && job.applyVerifyIntent === true)
      throw new Error(
        this.#applyInFlight(job)
          ? 'an applyThenVerify run is in progress for this job; wait for it to finish'
          : 'an interrupted applyThenVerify run has not been recovered yet; restart the offload server (recovery runs at startup) before retrying',
      );
    // A manual revert is the primary acting on an earlier applyThenVerify
    // outcome (typically "STILL APPLIED"); it is superseded in the same write
    // that records the revert, so no record claims otherwise afterwards.
    const supersede = (state) => (auto ? {} : this.#supersededApplyVerify(state));
    if (job.revertIntent === true) {
      const reconciliation = await this.#reconcileRevert(job);
      job = this.validatePersisted(
        await this.store.update(id, { ...reconciliation, ...(reconciliation.revertOutcome === 'reverted' ? supersede(job) : {}) }),
      );
      if (reconciliation.revertOutcome === 'reverted') {
        return apply ? { dryRun: false, applied: true, alreadyReverted: true } : { dryRun: true, applied: false, alreadyReverted: true };
      }
      if (reconciliation.revertOutcome === 'uncertain')
        throw new Error('reverse patch outcome is uncertain; inspect primary changes manually');
    }
    if (job.integrationIntent === true) {
      const reconciliation = await this.#reconcileIntegration(job);
      job = this.validatePersisted(await this.store.update(id, reconciliation));
      if (reconciliation.integrationOutcome !== 'applied') throw new Error('cannot revert a job with an unresolved integration outcome');
    }
    if (!final(job.status)) throw new Error('cannot revert a running job');
    // Until worktree isolation guarantees the outside-scope edits were never
    // applied in this checkout, any attribution violation makes every revert
    // unsafe, including a dry run.
    if (Array.isArray(job.scopeViolations) && job.scopeViolations.length) throw new Error('cannot revert a job with scope violations');
    if (job.applied !== true) throw new Error('cannot revert a job that was not applied to the primary working tree');
    if (job.revertUncertain === true) throw new Error('cannot revert a job whose prior reverse-application outcome is uncertain');
    const revertPaths = job.revertFiles || job.files?.map((file) => file.path) || [];
    if (!safeRevertPaths(revertPaths)) throw new Error('job has no safe owned patch to revert');
    if (job.workspacePath && primaryIndexChanged(job.repoPath, job.primaryIndexBefore, revertPaths))
      throw new Error('job patch is stale; primary index changed on a job-owned file');
    if (job.workspacePath) {
      const currentBranch = this.config.git ? await this.config.git.branch(job.repoPath) : git(job.repoPath, ['branch', '--show-current']);
      const currentHead = this.config.git ? await this.config.git.head(job.repoPath) : git(job.repoPath, ['rev-parse', 'HEAD']);
      if (currentBranch !== job.branch || currentHead !== job.head)
        throw new Error('job patch is stale; primary branch or HEAD changed since job started');
    }
    if (this.snapshots.create && job.after) {
      const current = await this.snapshots.create(job.repoPath);
      if (current !== job.after) {
        if (!this.snapshots.files) throw new Error('job patch is stale; working tree changed since job finished');
        const changed = await this.snapshots.files(job.repoPath, job.after, current);
        const touched = new Set(revertPaths);
        if (changed.some((file) => touched.has(file.path)))
          throw new Error('job patch is stale; a job-owned file changed since completion');
      }
    }
    if (job.revertedAt) throw new Error('job patch has already been reverted');
    const patch = this.store.readArtifactBytes
      ? await this.store.readArtifactBytes(id, 'revert.diff')
      : await this.store.readArtifact(id, 'revert.diff');
    if ((typeof patch !== 'string' && !Buffer.isBuffer(patch)) || patch.length === 0) throw new Error('job has no owned patch to revert');
    if (!this.config.applyPatch) throw new Error('patch applier unavailable');
    if (!apply) return this.config.applyPatch(job.repoPath, patch, { reverse: true, check: true });
    // Legacy/injected non-isolated managers have no private-worktree
    // baseline/index contract from which a post-crash state can be proven.
    // Real Core jobs are isolated; retain this compatibility path rather than
    // inventing a false reconciliation for adapter-only callers.
    if (!job.workspacePath) {
      const result = await this.config.applyPatch(job.repoPath, patch, { reverse: true, check: false });
      if (result?.applied) await this.store.update(id, { revertedAt: this.now().toISOString(), ...supersede(job) });
      return result;
    }
    // As with integration, journal the destructive boundary before it runs.
    // `primaryAfter` is the expected pre-revert state on the selected paths;
    // keep the workspace tree fallback for older but otherwise valid jobs.
    await this.store.update(id, {
      revertIntent: true,
      revertIntentAt: this.now().toISOString(),
      revertPaths,
      revertExpectedTree: job.primaryAfter || job.after || job.workspaceAfter,
    });
    try {
      const result = await this.config.applyPatch(job.repoPath, patch, { reverse: true, check: false });
      const pending = await this.store.get(id);
      const reconciliation = await this.#reconcileRevert(pending);
      await this.store.update(id, { ...reconciliation, ...(reconciliation.revertOutcome === 'reverted' ? supersede(pending) : {}) });
      if (reconciliation.revertOutcome === 'reverted') return { ...result, dryRun: false, applied: true };
      if (reconciliation.revertOutcome === 'not-reverted') throw new Error('reverse patch did not apply');
      throw new Error('reverse patch outcome is uncertain; inspect primary changes manually');
    } catch (error) {
      // A custom applier or the post-apply record write can throw after the
      // reverse patch has modified the working tree. Reconcile the journal
      // before reporting failure so a later call cannot falsely offer it
      // again as an unapplied/revertible patch.
      let pending;
      try {
        pending = await this.store.get(id);
      } catch {
        throw error;
      }
      if (!pending.revertIntent) throw error;
      const reconciliation = await this.#reconcileRevert(pending);
      await this.store.update(id, { ...reconciliation, ...(reconciliation.revertOutcome === 'reverted' ? supersede(pending) : {}) });
      if (reconciliation.revertOutcome === 'reverted') return { dryRun: false, applied: true };
      if (reconciliation.revertOutcome === 'uncertain')
        throw new Error('reverse patch outcome is uncertain; inspect primary changes manually');
      throw error;
    }
  }
  async recover(options = {}) {
    // Recovery finalizes an already authenticated durable lifecycle; it must
    // not be blocked by a rotated provider credential, and it must never pass
    // the record's execution profile to a resolver or worker.
    const list = this.store.listOperational?.bind(this.store) || this.store.list.bind(this.store);
    const get = this.store.getOperational?.bind(this.store) || this.store.get?.bind(this.store);
    const update = this.store.updateOperational?.bind(this.store) || this.store.update.bind(this.store);
    const writeArtifact = this.store.writeArtifactOperational?.bind(this.store) || this.store.writeArtifact.bind(this.store);
    const updateRecoveredIfCurrent = async (job, changes) => {
      // JobStore provides a same-lock CAS. Keep a guarded fallback for small
      // injected test/adaptor stores, which have no cross-process authority.
      if (typeof this.store.updateOperationalIf === 'function')
        return this.store.updateOperationalIf(job.id, this.#recoveryIdentity(job), changes);
      const current = await get(job.id);
      if (!this.#sameRecoveryIdentity(job, current)) return null;
      return update(job.id, changes);
    };
    const stageRecoveredTerminal = async (job, status, changes) => {
      return updateRecoveredIfCurrent(job, { ...changes, status: 'FINALIZING', finalStatus: status });
    };
    const publishRecoveredTerminal = async (job, status, changes, event) => {
      const staged = await stageRecoveredTerminal(job, status, changes);
      if (!staged) return null;
      if (!(await this.#recoveryMayClean(staged, get, { orphan: this.#orphanedApplyVerify(job) }))) return null;
      await this.cleanupWorkspace(job.id);
      const cleaned = await get(job.id);
      const done = {
        ...cleaned,
        status,
        finishedAt: cleaned.finishedAt || this.now().toISOString(),
        finalizedAt: cleaned.finalizedAt || this.now().toISOString(),
      };
      await writeArtifact(job.id, 'report.md', this.report(done));
      await this.store.event(job.id, event);
      return update(job.id, { status, finishedAt: done.finishedAt, finalizedAt: done.finalizedAt });
    };
    const settleTerminalCleanupReservation = async (job, event = { type: 'recovered-cleanup', status: job.recoveryTerminalStatus }) => {
      const terminalStatus = job.recoveryTerminalStatus;
      if (!final(terminalStatus)) return false;
      if (await this.#recoveryMayClean(job, get, { allowLiveNoLease: true })) {
        await this.cleanupWorkspace(job.id);
        const cleaned = await get(job.id);
        const done = {
          ...cleaned,
          status: terminalStatus,
          finishedAt: cleaned.finishedAt || this.now().toISOString(),
          finalizedAt: cleaned.finalizedAt || this.now().toISOString(),
        };
        // Keep the report aligned with the cleanup metadata that recovery just
        // persisted. If either publication fails, retain the FINALIZING
        // reservation so a later recovery retries rather than publishing a
        // terminal record with a permanently stale report artifact.
        await writeArtifact(job.id, 'report.md', this.report(done));
        await this.store.event(job.id, event);
        return !!(await updateRecoveredIfCurrent(job, {
          status: terminalStatus,
          finalStatus: terminalStatus,
          finishedAt: done.finishedAt,
          finalizedAt: done.finalizedAt,
          recoveryTerminalStatus: undefined,
        }));
      }
      // Do not strand a terminal record merely because a lease reappeared
      // while this recovery pass was reserving cleanup. The exact-CAS restore
      // leaves its new owner untouched and permits a later safe retry.
      await updateRecoveredIfCurrent(job, {
        status: terminalStatus,
        finalStatus: terminalStatus,
        recoveryTerminalStatus: undefined,
      });
      return false;
    };
    // An applyThenVerify run in this process is registered by its controller.
    // `ownerIds` are jobs whose running entry is the caller's own call.
    const except = new Set([
      ...(options.exceptIds || []),
      ...[...this.running.keys()].filter((id) => !options.ownerIds?.includes(id)),
      ...this.controllers.keys(),
    ]);
    const jobs = await list({ limit: Number.MAX_SAFE_INTEGER });
    let recovered = 0;
    for (let job of jobs) {
      // An active local/detached owner is expressly excluded from recovery;
      // even harmless-looking publication healing must not lock or mutate it.
      if (except.has(job.id)) continue;
      // A transcript/artifact journal is independent from the lifecycle
      // journal below.  Resolve it first so repeated recovery converges on
      // one committed record rather than retaining a valid-but-stale intent.
      try {
        if (typeof this.store.healPublications === 'function') job = await this.store.healPublications(job.id);
      } catch {
        continue;
      }
      const hasJournal = job?.integrationIntent === true || job?.revertIntent === true || job?.applyVerifyIntent === true;
      const cleanupPending =
        job?.workspaceCleanupRequired !== true && !!job?.workspacePath && (!job.workspaceCleanedAt || job.workspaceCleanupError);
      if (
        !hasJournal &&
        !cleanupPending &&
        !['QUEUED', 'RUNNING', 'REPAIRING', 'WORKER_DONE', 'FINALIZING', 'REPAIR_QUEUED'].includes(job.status)
      )
        continue;
      try {
        job = this.validatePersisted(job);
      } catch {
        // This record cannot safely supply a workspace path or lease nonce to
        // recovery. Automated cleanup is impossible, but record that bounded
        // manual-cleanup decision explicitly instead of retrying forever.
        await update(job.id, {
          status: 'FAILED',
          finalStatus: 'FAILED',
          error: 'stored job failed validation',
          workspaceCleanupError: 'stored job validation failed; manual workspace cleanup is required',
          workspaceCleanupRequired: true,
          finishedAt: this.now().toISOString(),
          finalizedAt: this.now().toISOString(),
        });
        recovered += 1;
        continue;
      }
      // Do not fence a suspended worker merely because its heartbeat is old.
      // It can resume with the same lease nonce; treating that as dead would
      // let recovery delete its workspace and be overwritten afterwards.
      const alive = Number.isInteger(job.runnerPid) && pidAlive(job.runnerPid) && !this.#orphanedApplyVerify(job);
      // A terminal journal can retain a long-lived MCP server PID after a
      // post-apply record-write failure, so it must be reconciled promptly.
      // A live owner may still write any non-terminal lifecycle or unresolved
      // primary-mutation journal. A plain terminal cleanup retry is different:
      // below it may proceed only after proving this job has no lease.
      const terminalCleanupReservation = job.status === 'FINALIZING' && final(job.recoveryTerminalStatus);
      if (alive && ((!final(job.status) && !terminalCleanupReservation) || hasJournal)) continue;
      // Do not broaden crash recovery into auto-resume. Only the authenticated
      // one-shot budget terminalization state can restart, and only while its
      // owner is absent/dead. A consumed state may already have crossed the
      // billable POST boundary and must fall through to fail-closed handling.
      const queuedBudgetFinishRecovery =
        job.budgetFinishRecovery === 'queued' &&
        job.cappedFinishRecovery === undefined &&
        ['RUNNING', 'REPAIRING'].includes(job.status) &&
        ['RUNNING', 'BUDGET_FINISH_RECOVERY'].includes(job.handoffState) &&
        Number.isInteger(job.runnerPid) &&
        job.runnerPid > 0 &&
        !hasJournal &&
        !alive;
      if (queuedBudgetFinishRecovery) {
        if (await this.#recoverQueuedBudgetFinish(job, get)) recovered += 1;
        // Lease/CAS failures deliberately defer this narrow recovery. Do not
        // convert a potentially resumable queued finish into generic failure.
        continue;
      }
      // A journal remains authoritative even after another error handler has
      // published a terminal status. Resolve it before generic crash
      // finalization so no record can falsely say the primary was untouched.
      // An applyThenVerify run that died is settled from the live tree too, but
      // never as a pass: the command's result was lost with the process. This
      // also covers a crash after the integration journal cleared (while the
      // command ran) and one in the middle of its automatic revert.
      if (job.applyVerifyIntent === true) {
        try {
          // A cancel aimed at the dead run has nothing left to consume it.
          await this.store.clearCancel?.(job.id).catch(() => {});
          const reconciliation = await this.#reconcileIntegration(job);
          if (reconciliation.integrationOutcome === 'applied' && reconciliation.primaryAfter) {
            await this.#pinTrees(job, {
              before: job.before,
              ...(job.workerAfter ? { workerAfter: job.workerAfter } : {}),
              workspaceAfter: job.workspaceAfter,
              primaryAfter: reconciliation.primaryAfter,
            });
          }
          const settled = this.#applyVerifySettlement(job, reconciliation);
          const published = await publishRecoveredTerminal(job, settled.finalStatus, settled.changes, {
            type: 'recovered-integration',
            outcome: reconciliation.integrationOutcome,
            applyThenVerify: 'INTERRUPTED',
          });
          if (published) recovered += 1;
        } catch (error) {
          try {
            await publishRecoveredTerminal(
              job,
              'FAILED',
              {
                integrationUncertain: true,
                applyVerifyIntent: false,
                revertIntent: false,
                error: `applyThenVerify recovery could not prove primary state: ${error.message || error}`,
              },
              { type: 'recovered-integration', outcome: 'uncertain', applyThenVerify: 'INTERRUPTED' },
            );
          } catch {}
        }
        continue;
      }
      if (job.integrationIntent === true) {
        try {
          const reconciliation = await this.#reconcileIntegration(job);
          if (reconciliation.integrationOutcome === 'applied' && reconciliation.primaryAfter) {
            await this.#pinTrees(job, {
              before: job.before,
              ...(job.workerAfter ? { workerAfter: job.workerAfter } : {}),
              workspaceAfter: job.workspaceAfter,
              primaryAfter: reconciliation.primaryAfter,
            });
          }
          const applied = reconciliation.integrationOutcome === 'applied';
          // A late apply of an already-final job must fall back to the status
          // it had, not to a generic FAILED, when the patch never landed.
          const finalStatus = applied ? job.integrationFinalStatus : final(job.applyPreviousStatus) ? job.applyPreviousStatus : 'FAILED';
          const published = await publishRecoveredTerminal(
            job,
            finalStatus,
            {
              ...reconciliation,
              ...(applied && final(job.applyPreviousStatus)
                ? {
                    appliedUnverified: {
                      at: this.now().toISOString(),
                      previousStatus: job.applyPreviousStatus,
                      verifiedBy: typeof job.applyVerifiedBy === 'string' ? job.applyVerifiedBy.slice(0, MAX_VERIFIED_BY) : '',
                    },
                  }
                : {}),
              ...(applied
                ? {}
                : {
                    integrationConflict: reconciliation.integrationOutcome === 'not-applied',
                    error:
                      reconciliation.integrationOutcome === 'uncertain'
                        ? 'isolated integration outcome is uncertain; inspect primary changes manually'
                        : 'isolated changes were not applied',
                  }),
            },
            { type: 'recovered-integration', outcome: reconciliation.integrationOutcome },
          );
          if (published) recovered += 1;
        } catch (error) {
          // Keep a failed/uncertain marker, but deliberately leave the intent
          // untouched when persistence itself failed so later recovery will
          // not mistake an unproven primary mutation for a clean failure.
          try {
            await publishRecoveredTerminal(
              job,
              'FAILED',
              {
                integrationUncertain: true,
                error: `integration recovery could not prove primary state: ${error.message || error}`,
              },
              { type: 'recovered-integration', outcome: 'uncertain' },
            );
          } catch {}
        }
        continue;
      }
      if (job.revertIntent === true) {
        try {
          const reconciliation = await this.#reconcileRevert(job);
          // Reconciliation alone leaves a terminal record repairable.  Fence
          // it before proving/releasing its old lease: a repair which wins in
          // the release-to-cleanup gap can otherwise publish a replacement
          // workspace that cleanupWorkspace() would re-read and delete.
          const terminalStatus = final(job.finalStatus) ? job.finalStatus : final(job.status) ? job.status : 'FAILED';
          const staged = await stageRecoveredTerminal(job, terminalStatus, {
            ...reconciliation,
            recoveryTerminalStatus: terminalStatus,
          });
          if (!staged) continue;
          if (
            await settleTerminalCleanupReservation(staged, {
              type: 'recovered-revert',
              outcome: reconciliation.revertOutcome,
            })
          )
            recovered += 1;
        } catch {
          // Retain the intent if its durable reconciliation cannot be stored.
        }
        continue;
      }
      // Resume a recovery-owned terminal cleanup reservation without feeding
      // it into generic crash finalization (which would turn a prior DONE
      // status into FAILED). This is also the only live-PID path permitted to
      // retry cleanup, and it still requires an explicit no-lease proof.
      if (terminalCleanupReservation) {
        if (await settleTerminalCleanupReservation(job)) recovered += 1;
        continue;
      }
      // The primary integration was already proven and durably recorded, but
      // the process died before the ordinary publication block could turn
      // FINALIZING into its success status. Preserve that truth rather than
      // overwriting it with generic "server restarted" failure handling.
      if (
        job.status === 'FINALIZING' &&
        job.applied === true &&
        !job.integrationUncertain &&
        ['DONE_VERIFIED', 'DONE_UNVERIFIED'].includes(job.finalStatus)
      ) {
        if (await publishRecoveredTerminal(job, job.finalStatus, {}, { type: 'recovered-publication', status: job.finalStatus }))
          recovered += 1;
        continue;
      }
      if (final(job.status)) {
        // A legacy/partially-published terminal record is not proof that its
        // recorded owner has stopped. Release (or prove no lease) before
        // touching the private workspace; otherwise stale recovery can race a
        // child which inherited the lease after this pass took its snapshot.
        // Reserve the exact terminal tuple before the no-lease proof. Without
        // this CAS, a manual repair can publish its replacement workspace in
        // the gap and cleanupWorkspace(), which re-reads the record, would
        // delete that replacement instead of this terminal workspace.
        const terminalStatus = final(job.finalStatus) ? job.finalStatus : job.status;
        if (!(await this.#recoveryMayClean(job, get, { allowLiveNoLease: true, preflight: true }))) continue;
        const staged = await stageRecoveredTerminal(job, terminalStatus, { recoveryTerminalStatus: terminalStatus });
        if (!staged) continue;
        if (await settleTerminalCleanupReservation(staged)) recovered += 1;
        continue;
      }
      const finalJob = {
        ...job,
        error: 'server restarted',
      };
      try {
        if (job.workspacePath && this.isolated && job.mode !== 'report') {
          const workspace = this.#workspace(job);
          const workspaceAfter = workspace.snapshot();
          const audited = await this.#classifyIsolatedWorkspace(job, workspace, workspaceAfter);
          await writeArtifact(job.id, 'patch.diff', audited.allPatch);
          await writeArtifact(job.id, 'revert.diff', audited.revertPatch);
          finalJob.workspaceAfter = workspaceAfter;
          finalJob.after = workspaceAfter;
          finalJob.patchRound = job.rounds || 0;
          finalJob.files = audited.owned;
          finalJob.allFiles = audited.all;
          finalJob.revertFiles = audited.revertPaths;
          finalJob.scopeViolations = audited.violations;
          finalJob.discardedEphemeralOutputs = audited.discardedEphemeralOutputs;
          finalJob.verifierMutations = audited.verifierMutations;
          await this.#pinTrees(job, { before: job.before, ...(job.workerAfter ? { workerAfter: job.workerAfter } : {}), workspaceAfter });
        } else if (job.mode !== 'report' && this.snapshots.create && this.snapshots.diff && job.before) {
          const after = await this.snapshots.create(job.repoPath);
          const patch = await this.snapshots.diff(job.repoPath, job.before, after);
          // Recovery has no trustworthy live-worker attribution. Preserve the
          // complete review diff, and permit a reverse patch only for files
          // plainly inside this job's declared write scope.
          const all = this.snapshots.files ? await this.snapshots.files(job.repoPath, job.before, after) : changedFiles(patch);
          const inScope = (file) => {
            if (typeof file?.path !== 'string' || file.path.includes('\\')) return false;
            try {
              return matchesAny(file.path, writeScope(job));
            } catch {
              return false;
            }
          };
          const owned = all.filter(inScope);
          const violations = all.filter((file) => !inScope(file)).map((file) => file.path);
          const revertFiles = owned.map((file) => file.path).filter(safeRevertPath);
          const revertPatch = revertFiles.length
            ? await this.snapshots.diff(job.repoPath, job.before, after, { paths: revertFiles, literalPaths: true })
            : Buffer.alloc(0);
          await writeArtifact(job.id, 'patch.diff', patch);
          await writeArtifact(job.id, 'revert.diff', revertPatch);
          finalJob.after = after;
          // Real Git snapshots use NUL-delimited paths; parsing diff headers is
          // only a compatibility fallback for injected test adapters.
          finalJob.files = owned;
          finalJob.allFiles = all;
          finalJob.scopeViolations = violations;
          finalJob.revertFiles = revertFiles;
        }
        if (await publishRecoveredTerminal(job, 'FAILED', finalJob, { type: 'recovered', message: 'server restarted' })) recovered += 1;
      } catch (error) {
        try {
          await publishRecoveredTerminal(
            job,
            'FAILED',
            {
              error: `recovery finalization failed: ${error.message || error}`,
            },
            { type: 'recovered', message: 'server restarted' },
          );
        } catch {}
      }
    }
    return recovered;
  }
  async transferLease(id, owner) {
    return this.leases.transfer?.(id, owner);
  }
  async releaseLease(id, owner) {
    return this.leases.release?.(id, owner);
  }
  /** Abort only jobs this process owns; persisted jobs owned by a detached
   * worker are intentionally absent from `running` and must be left alone. */
  async shutdown({ timeoutMs = 5_000 } = {}) {
    for (const controller of this.controllers.values()) controller.abort();
    const pending = Promise.allSettled([...this.running.values()]);
    const delay = Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 5_000;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.setTimeout(resolve, delay);
      // A timeout only bounds a still-active lifecycle; it must not keep an
      // otherwise-idle CLI/doctor process alive after `pending` settles.
      timer?.unref?.();
    });
    try {
      await Promise.race([pending, timeout]);
    } finally {
      if (timer !== undefined) this.clearTimeout(timer);
    }
  }
}
