import { lstat } from 'node:fs/promises';
import { DEFAULT_OUTPUT_CAP } from './agent/tools.mjs';

// Turn-budget sizing. The worker reads a file one read_file page at a time, so
// the number of turns it needs is dominated by file size, not by how many
// files there are. This module only measures (stat, never content) and does
// arithmetic; it holds no job state and is not a spending authority. USD
// remains the real ceiling and the reservation/estimator logic is untouched.

/** One read_file page: the rendered-character cap, which is the effective segment. */
export const READ_SEGMENT = DEFAULT_OUTPUT_CAP;
/** What one page actually carries: the cap includes the "[truncated; next offset N]" marker (about 33 characters). */
export const PAGE_PAYLOAD = READ_SEGMENT - 40;
/** Run tests, call finish, and slack for one retry (write jobs). */
export const TURN_BASE_WRITE = 6;
/** Call finish and slack (report jobs). */
export const TURN_BASE_REPORT = 2;
/** A few list_dir/glob/grep turns before the first read. */
export const TURN_EXPLORE = 4;
/** One write plus one fix-up per owned entry. */
export const TURN_WRITE_PER_PATH = 2;
/** Multiplier applied to the raw estimate. */
export const TURN_HEADROOM = 1.25;
/** Average source line length used to turn a :START-END range into bytes. */
export const LINE_BYTES_ESTIMATE = 80;
/** Hard ceiling for a server-chosen cap; an explicit caller cap may go to 1000. */
export const AUTO_TURNS_MAX = 200;
/** Conservative seconds per worker turn (field report: 30-40 turns took about 32 minutes); only used to warn that the wall clock may run out first. */
export const TURN_SECONDS_ESTIMATE = 45;
/** Ceiling for a server-scaled wall-clock allowance; an explicit caller timeout may go to 1440. */
export const AUTO_TIMEOUT_MAX_MINUTES = 120;
export const MAX_SIZED_FILES = 64;
/** Equals read_file's prefix-scan cap: a larger file is unreadable anyway, so clamp rather than count. */
export const MAX_SIZED_BYTES = 8 * 1024 * 1024;
export const MAX_OWNED_ENTRIES_COUNTED = 16;
const MAX_SAFE_TURNS = 1000;
const MAX_SAFE_RECOMMENDATION = 100_000;
const MAX_SAFE_BYTES = 64 * MAX_SIZED_BYTES;
const MAX_ECHOED_FILES = 8;
const MAX_ECHOED_WARNINGS = 4;
const MAX_WARNING_CHARS = 400;
const TURN_SOURCES = new Set(['default', 'scaled', 'caller', 'raised']);
const TURN_POLICIES = new Set(['auto', 'fixed']);
const GLOB_CHARACTERS = /[*?[\]{}!]/;
const RANGE_SUFFIX = /^(.+):(\d{1,7})-(\d{1,7})$/;

/**
 * Split a relevantPaths entry into its path and optional 1-based inclusive line
 * range. An entry that looks like a range but is not valid (start < 1 or
 * end < start) is reported rather than silently turned into a plain path.
 * Anything else, including a lone ":N" suffix, is a plain path. A POSIX file
 * literally named "a:1-2" is indistinguishable from a range; entries are
 * advisory, so that ambiguity is accepted.
 */
export function splitRelevantPath(entry) {
  const match = typeof entry === 'string' ? RANGE_SUFFIX.exec(entry) : null;
  if (!match) return { path: entry };
  const start = Number(match[2]),
    end = Number(match[3]);
  if (start < 1 || end < start) return { invalid: true };
  return { path: match[1], range: { start, end } };
}

/** Reads needed to scan `bytes`; a range bounds it (one window read fingerprints the whole file for edit_file). */
export function readSegments(bytes, range) {
  const whole = Math.max(1, Math.ceil(bytes / PAGE_PAYLOAD));
  if (!range) return whole;
  return Math.min(whole, 1 + Math.ceil(((range.end - range.start + 1) * LINE_BYTES_ESTIMATE) / PAGE_PAYLOAD));
}

/**
 * Stat the files a worker will likely read. Paths go through the same
 * PathPolicy authority as the worker's own tools (deny rules, secret names,
 * symlink escape); anything unreadable, missing, not a regular file, or a glob
 * is skipped silently and never echoed.
 */
export async function measureFiles({ policy, relevantPaths = [], ownedPaths = [], inputManifest = [] } = {}) {
  const candidates = new Map();
  const add = (entry, ranged) => {
    if (candidates.size >= MAX_SIZED_FILES * 2) return;
    const split = splitRelevantPath(entry);
    if (split.invalid || typeof split.path !== 'string' || GLOB_CHARACTERS.test(split.path)) return;
    const previous = candidates.get(split.path);
    if (!previous) {
      candidates.set(split.path, { range: split.range, whole: ranged && !split.range });
      return;
    }
    // A range narrows the read, but a plain relevantPaths entry is an explicit
    // whole-file read hint and widens it for good, in either order. A plain
    // mention in ownedPaths only says the file is writable and never widens
    // it. Several ranges are sized as the one window that covers them all,
    // which can only over-count.
    if (ranged && !split.range) candidates.set(split.path, { range: undefined, whole: true });
    else if (ranged && !previous.whole)
      candidates.set(split.path, {
        range: previous.range
          ? { start: Math.min(previous.range.start, split.range.start), end: Math.max(previous.range.end, split.range.end) }
          : split.range,
        whole: false,
      });
  };
  for (const entry of relevantPaths) add(entry, true);
  for (const entry of ownedPaths) add(entry, false);
  const files = [];
  for (const [file, { range }] of candidates) {
    if (files.length >= MAX_SIZED_FILES) break;
    try {
      const canonical = policy.assertReadable(file);
      const details = await lstat(canonical);
      if (!details.isFile() || details.isSymbolicLink()) continue;
      files.push({ path: file, bytes: Math.min(details.size, MAX_SIZED_BYTES), ...(range ? { range } : {}) });
    } catch {
      /* denied, missing, or unreadable paths simply are not sized */
    }
  }
  for (const input of inputManifest) {
    if (files.length >= MAX_SIZED_FILES) break;
    if (typeof input?.path === 'string' && Number.isSafeInteger(input.bytes) && input.bytes >= 0)
      files.push({ path: input.path, bytes: Math.min(input.bytes, MAX_SIZED_BYTES) });
  }
  return files;
}

/** Turns the worker likely needs: base + explore + reads + per-owned-path writes, with headroom. */
export function recommendTurns({ files = [], ownedCount = 0, mode = 'write' } = {}) {
  const report = mode === 'report';
  const readTurns = files.reduce((sum, file) => sum + readSegments(file.bytes, file.range), 0);
  const writeTurns = report ? 0 : TURN_WRITE_PER_PATH * Math.min(ownedCount, MAX_OWNED_ENTRIES_COUNTED);
  const rawTurns = (report ? TURN_BASE_REPORT : TURN_BASE_WRITE + TURN_EXPLORE) + readTurns + writeTurns;
  return { rawTurns, recommendedTurns: Math.ceil(rawTurns * TURN_HEADROOM), readTurns };
}

/**
 * Decide the stored turn cap.
 *  - auto (default when maxTurns is omitted): the configured default is a floor
 *    that scales up to the recommendation, never past AUTO_TURNS_MAX. An
 *    explicit maxTurns with an explicit "auto" is a floor in the same way.
 *  - fixed (default when maxTurns is given): the value is honored exactly.
 * A cap below the recommendation always produces a warning so the primary sees
 * why a job may stop on BUDGET before spending anything. Likewise, when the
 * turns the job is expected to use would outlast `timeoutMinutes` at the
 * conservative per-turn latency, the primary is told the job will probably end
 * on TIMEOUT first (the cap itself is never changed for it). When the caller
 * left the timeout unset (`timeoutScalable`), the allowance is instead scaled up
 * to what the sizing needs, bounded by AUTO_TIMEOUT_MAX_MINUTES, and returned
 * as `timeoutMinutes`; a timeout the caller chose is never changed.
 */
export function resolveTurnBudget({
  requested,
  configured,
  policy,
  recommended,
  readTurns = 0,
  timeoutMinutes,
  timeoutScalable = false,
} = {}) {
  const given = requested !== undefined;
  const mode = policy ?? (given ? 'fixed' : 'auto');
  const base = given ? requested : configured;
  const scaled = mode === 'auto' ? Math.max(base, Math.min(recommended, AUTO_TURNS_MAX)) : base;
  const maxTurns = Math.min(scaled, MAX_SAFE_TURNS);
  const turnsSource = maxTurns !== base ? (given ? 'raised' : 'scaled') : given ? 'caller' : 'default';
  const warnings = [];
  if (maxTurns < recommended) {
    warnings.push(
      mode === 'auto'
        ? `recommended ${recommended} turns exceeds the automatic ceiling ${AUTO_TURNS_MAX}; split the package, add :START-END line ranges to relevantPaths, or continue with extraTurns after a BUDGET stop.`
        : `maxTurns ${maxTurns} is below the recommended ${recommended} (reading the sized files needs about ${readTurns} turns at ${READ_SEGMENT}-character read_file segments). The cap is honored. ${given ? 'Omit maxTurns or pass' : 'Pass'} budget.turnPolicy:"auto" to let the server scale it, and use budget.maxUsd as the ceiling.`,
    );
  }
  const expected = Math.min(maxTurns, recommended);
  let scaledTimeout;
  if (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 && expected * TURN_SECONDS_ESTIMATE > timeoutMinutes * 60) {
    const needed = Math.ceil((expected * TURN_SECONDS_ESTIMATE) / 60);
    // A caller who never chose a timeout gets the allowance the sizing says the
    // job needs, up to a bounded ceiling; a chosen timeout is never touched.
    if (timeoutScalable && needed <= AUTO_TIMEOUT_MAX_MINUTES) {
      scaledTimeout = needed;
      warnings.push(
        `budget.timeoutMinutes was not set: scaled from ${timeoutMinutes} to ${needed} minutes because about ${expected} turns at ~${TURN_SECONDS_ESTIMATE}s each need roughly that long.`,
      );
    } else if (timeoutScalable) {
      scaledTimeout = AUTO_TIMEOUT_MAX_MINUTES;
      warnings.push(
        `about ${expected} turns at ~${TURN_SECONDS_ESTIMATE}s each need roughly ${needed} minutes; budget.timeoutMinutes was not set and was scaled from ${timeoutMinutes} to the automatic ceiling ${AUTO_TIMEOUT_MAX_MINUTES}, so the job may still end TIMEOUT (offload_continue recovers it, or pass a larger budget.timeoutMinutes).`,
      );
    } else {
      warnings.push(
        `about ${expected} turns at ~${TURN_SECONDS_ESTIMATE}s each need roughly ${needed} minutes but budget.timeoutMinutes is ${timeoutMinutes}; the job will probably end TIMEOUT before its turn cap (offload_continue recovers it, or pass a larger budget.timeoutMinutes).`,
      );
    }
  }
  return { maxTurns, turnsSource, turnPolicy: mode, warnings, ...(scaledTimeout ? { timeoutMinutes: scaledTimeout } : {}) };
}

/** The persisted/echoed record for one job: arithmetic and sanitized file names only. */
export function buildBudgetSizing({ resolved, recommendation, files = [] }) {
  return safeBudgetSizing({
    maxTurns: resolved.maxTurns,
    turnsSource: resolved.turnsSource,
    turnPolicy: resolved.turnPolicy,
    timeoutMinutes: resolved.timeoutMinutes,
    recommendedTurns: recommendation?.recommendedTurns,
    readTurns: recommendation?.readTurns,
    segmentChars: READ_SEGMENT,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files: files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      readTurns: readSegments(file.bytes, file.range),
      ranged: !!file.range,
    })),
    warnings: resolved.warnings,
  });
}

/**
 * The sizing record after offload_continue raises the turn cap. The stored
 * record describes the cap chosen at start; leaving it would keep reporting
 * (and warning about) a cap the job no longer has. The recommendation is
 * unchanged, so only the cap, its source and the below-recommendation warning
 * are recomputed.
 */
export function raiseBudgetSizing(sizing, maxTurns) {
  const stored = safeBudgetSizing(sizing);
  if (!stored || !Number.isSafeInteger(maxTurns)) return stored;
  const below = Number.isSafeInteger(stored.recommendedTurns) && maxTurns < stored.recommendedTurns;
  return safeBudgetSizing({
    ...stored,
    maxTurns,
    turnsSource: 'raised',
    warnings: below
      ? [
          `maxTurns ${maxTurns} (raised by offload_continue) is still below the recommended ${stored.recommendedTurns}; continue with more extraTurns if it stops on the turn cap.`,
        ]
      : [],
  });
}

const boundedInteger = (value, max) => (Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined);
const cleanString = (value, max) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)
    ? value
    : undefined;

/**
 * Allowlist and bound every field of a stored or about-to-be-stored sizing
 * record. It is attached to public job views, so anything unexpected is
 * dropped rather than coerced. Undefined when the required fields are bad.
 */
export function safeBudgetSizing(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const maxTurns = boundedInteger(value.maxTurns, MAX_SAFE_TURNS);
  if (!maxTurns || !TURN_SOURCES.has(value.turnsSource) || !TURN_POLICIES.has(value.turnPolicy)) return undefined;
  const files = Array.isArray(value.files)
    ? value.files
        .flatMap((file) => {
          const path = cleanString(file?.path, 1024),
            bytes = boundedInteger(file?.bytes, MAX_SAFE_BYTES),
            readTurns = boundedInteger(file?.readTurns, MAX_SAFE_RECOMMENDATION);
          return path !== undefined && bytes !== undefined && readTurns !== undefined && typeof file.ranged === 'boolean'
            ? [{ path, bytes, readTurns, ranged: file.ranged }]
            : [];
        })
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, MAX_ECHOED_FILES)
    : [];
  const warnings = Array.isArray(value.warnings)
    ? value.warnings
        .flatMap((warning) => {
          const text = cleanString(warning, MAX_WARNING_CHARS);
          return text === undefined ? [] : [text];
        })
        .slice(0, MAX_ECHOED_WARNINGS)
    : [];
  const optional = (key, max) => {
    const number = boundedInteger(value[key], max);
    return number === undefined ? {} : { [key]: number };
  };
  return {
    maxTurns,
    turnsSource: value.turnsSource,
    turnPolicy: value.turnPolicy,
    ...optional('timeoutMinutes', 1440),
    ...optional('recommendedTurns', MAX_SAFE_RECOMMENDATION),
    ...optional('readTurns', MAX_SAFE_RECOMMENDATION),
    ...optional('segmentChars', MAX_SAFE_BYTES),
    ...optional('fileCount', MAX_SIZED_FILES),
    ...optional('totalBytes', MAX_SAFE_BYTES),
    files,
    warnings,
  };
}
