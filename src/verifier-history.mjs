import { posix } from 'node:path';
import { normalizePath } from './glob.mjs';
import { isVerifierEnvironmentKind } from './verify-env.mjs';
import { preflightVerifier } from './verifier-preflight.mjs';

export function verifierFiles(files) {
  if (!Array.isArray(files)) return [];
  return [
    ...new Set(
      files.filter((file) => {
        try {
          return typeof file === 'string' && file.length <= 1024 && normalizePath(file) === file;
        } catch {
          return false;
        }
      }),
    ),
  ].slice(0, 24);
}

/** Attribute only files named in failing environment output, never every static
 * warning: a suite can contain unrelated expected denials and ordinary failures. */
export function verifierFailureFiles(verify, resolvedFiles = []) {
  // The scan can resolve more than the public result's 24-file cap.
  const all = [...new Set(resolvedFiles.filter((file) => verifierFiles([file]).length))].slice(0, 256);
  const output = [verify?.result?.stderr, verify?.result?.stdout].map((text) => String(text ?? '').slice(-64 * 1024)).join('\n');
  let text;
  try {
    text = decodeURIComponent(output);
  } catch {
    text = output;
  }
  const files = new Set();
  for (const block of text.split(/(?=^\s*FAIL\s)/m)) {
    if (
      !/\bEPERM\b|\bEACCES\b|permission denied|operation not permitted|Cannot find (?:package|module)|command not found|Fatal Python error/i.test(
        block,
      )
    )
      continue;
    const name = /^\s*FAIL\s+(\S+\.(?:[cm]?[jt]sx?|py))\s*(?:::|:|\s)/m.exec(block)?.[1];
    const named = all.filter((file) => file === name || posix.basename(file) === name);
    if (named.length === 1) {
      files.add(named[0]);
      continue;
    }
    for (const file of all) {
      // Stack frames and runner paths, with a boundary before the whole path.
      const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?:^|[\\s/("'])${escaped}(?=[:\\s)"']|$)`, 'm').test(block)) files.add(file);
    }
  }
  return verifierFiles([...files]);
}

/** Durable records also work across detached worker processes. Legacy records
 * are re-scanned only on a failure, so their old three-file advisory is usable. */
export function sessionVerifierFailures(jobs, { sessionStartedAt, repoPath } = {}) {
  const session = Date.parse(sessionStartedAt ?? '');
  const failures = [];
  for (const job of jobs) {
    const history = Array.isArray(job.verifyEnvironmentHistory) ? job.verifyEnvironmentHistory : [];
    const observations = history.length
      ? history
      : job.verifyEnvironment
        ? [
            {
              ...job.verifyEnvironment,
              observedAt: job.finishedAt || job.updatedAt || job.createdAt,
            },
          ]
        : [];
    for (const observation of observations) {
      if (!isVerifierEnvironmentKind(observation?.kind)) continue;
      const at = Date.parse(observation.observedAt ?? '');
      if (Number.isFinite(session) && (!Number.isFinite(at) || at < session)) continue;
      let files = verifierFiles(observation.files);
      if (!files.length && !history.length && repoPath && job.testCommand) {
        const scan = preflightVerifier({ repoPath, testCommand: job.testCommand, denyRead: job.denyRead });
        files = verifierFailureFiles(job.verify, scan?.resolvedFiles);
      }
      failures.push({
        jobId: job.id,
        kind: observation.kind,
        files,
        advice: files.length
          ? 'Exclude these files from the next testCommand and verify them in the primary checkout before spending again.'
          : 'Offending files could not be resolved; inspect the verifier output and narrow testCommand before spending again.',
      });
      if (failures.length >= 24) return failures;
    }
  }
  return failures;
}

const RECENT_PASSES = 5;
const finiteMs = (value) => (Number.isFinite(value) && value >= 0 ? value : undefined);

/**
 * How long this testCommand takes when it really runs: the median of the most
 * recent sandboxed passing result runs of the same command in the same
 * repository, other than `excludeId`. Undefined when there is no such run.
 */
export function expectedVerifierMs(jobs, { repoPath, testCommand, excludeId } = {}) {
  if (!Array.isArray(jobs) || !repoPath || !testCommand) return undefined;
  const passes = jobs
    .filter(
      (job) =>
        job?.id !== excludeId &&
        job?.repoPath === repoPath &&
        job?.testCommand === testCommand &&
        job.verify?.result?.code === 0 &&
        job.verify.result.sandbox === 'macos' &&
        job.verify.result.timedOut !== true &&
        finiteMs(job.verify.result.durationMs) !== undefined,
    )
    .sort((a, b) => String(b.finishedAt || b.updatedAt || '').localeCompare(String(a.finishedAt || a.updatedAt || '')))
    .slice(0, RECENT_PASSES)
    .map((job) => job.verify.result.durationMs)
    .sort((a, b) => a - b);
  return passes.length ? passes[Math.floor(passes.length / 2)] : undefined;
}

/**
 * Per-run duration sanity check: a run that finished in under `minFraction` of
 * the time this command is expected to take may not have run the suite at all.
 * `runs` is `[{ run, durationMs }]`; `expectations` is `[{ source, ms }]` and
 * the longest applicable one is used (a run is never weighed against itself).
 */
export function verifierDurationWarnings(runs, expectations, minFraction) {
  if (!(minFraction > 0)) return [];
  const warnings = [];
  for (const { run, durationMs } of runs) {
    const ms = finiteMs(durationMs);
    if (ms === undefined) continue;
    const expected = expectations
      .filter((entry) => entry.source !== run && finiteMs(entry.ms) > 0)
      .reduce((best, entry) => (!best || entry.ms > best.ms ? entry : best), undefined);
    if (expected && ms < expected.ms * minFraction)
      warnings.push({ run, durationMs: Math.round(ms), expectedMs: Math.round(expected.ms), source: expected.source, minFraction });
  }
  return warnings;
}
