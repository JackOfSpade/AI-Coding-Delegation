import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compactReport, terminalStatuses } from './report.mjs';
import { matchesAny, normalizePath, pathsOverlap } from './glob.mjs';
import { parseKeyRef } from './secrets.mjs';
import { diffTreeFiles, diffTrees, git as snapshotGit } from './git-snapshot.mjs';

const allowedEffort = new Set(['normal', 'high']);
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
const MAX_RESULT_TURNS = 1000,
  MAX_RESULT_COST = 10_000,
  MAX_USAGE = 1_000_000_000;
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheHitTokens', 'cacheMissTokens'];
const finiteCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_USAGE;
const validGitObjectId = (value) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
const validBranchName = (value) => typeof value === 'string' && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
/** Durable records, leases, CLI and MCP all share this identifier boundary. */
// This also names durable Git refs under refs/offload/jobs/<jobId>/….
// Keep the public/store/lease boundary compatible with Git's conservative
// component grammar rather than accepting IDs that later cannot be pinned.
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
function validExecutionProfile(value) {
  if (value == null) return true;
  const permitted = new Set(['type', 'baseUrl', 'keyRef', 'model', 'effort', 'pricing', 'pricingFile']);
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
    !cleanText(value.keyRef, 4096) ||
    (value.effort !== undefined && !allowedEffort.has(value.effort)) ||
    (value.pricing !== undefined && !cleanProviderText(value.pricing, 128)) ||
    (value.pricingFile !== undefined && (!cleanProviderText(value.pricingFile, 4096) || !isAbsolute(value.pricingFile)))
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
const writeScope = (job) => [...(job.ownedPaths || []), ...(job.extraWritable || [])];
const JOB_INPUT_KEYS = [
  'task',
  'acceptanceCriteria',
  'ownedPaths',
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
  const ownedPaths = canonicalPaths(input.ownedPaths);
  if (!ownedPaths) throw new Error('ownedPaths must be a non-empty array of relative paths/globs');
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
  for (const key of ['relevantPaths', 'extraWritable'])
    if (input[key] != null && !validPaths(input[key], false)) throw new Error(`${key} must be relative paths/globs`);
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
      Object.keys(input.budget).some((key) => !['maxUsd', 'maxTurns', 'timeoutMinutes'].includes(key)) ||
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
  }
  get isolated() {
    return !!(
      this.config.isolation &&
      typeof this.config.isolation.create === 'function' &&
      typeof this.config.isolation.open === 'function'
    );
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
    if (!this.isolated || !job?.workspacePath || typeof this.config.isolation.cleanup !== 'function') return true;
    try {
      const result = await this.config.isolation.cleanup({ repoPath: job.repoPath, workspacePath: job.workspacePath });
      // A helper may explicitly report a retained/failed private root. A
      // resolved promise alone is not proof that retryable cleanup happened.
      if (result?.retained === true) return false;
      if (result && result.removed === false && result.alreadyAbsent !== true && result.cleaned !== true) return false;
      return true;
    } catch {
      return false;
    }
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
      { requireLeaseRelease: true, expectedIdentity: this.#recoveryIdentity(job) },
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
          ? { workspaceCleanedAt: this.now().toISOString(), workspaceCleanupError: undefined }
          : { workspaceCleanupError: 'isolated workspace cleanup could not be completed' },
      );
    } catch {}
    return cleaned;
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
  async #recoveryMayClean(job, get, { allowLiveNoLease = false, preflight = false } = {}) {
    const ownerAlive = Number.isInteger(job.runnerPid) && pidAlive(job.runnerPid);
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
    // Never subsequently act through a persisted spelling. A symlinked
    // spelling that resolves to this manager is harmless, but retaining it
    // would reintroduce a time-of-check/time-of-use repository redirect.
    return { ...job, repoPath: this.repoPath };
  }
  async start(input, { launch = true } = {}) {
    this.validate(input);
    // One canonical spelling prevents an accepted scope from being interpreted
    // differently by leases, local tools, Git pathspecs, and sandbox rules.
    input = {
      ...input,
      ownedPaths: canonicalPaths(input.ownedPaths),
      ...(input.relevantPaths != null ? { relevantPaths: canonicalPaths(input.relevantPaths, false) } : {}),
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
      const leaseOwnerNonce = randomUUID();
      job = await this.store.create({
        ...jobInput(input),
        repoPath,
        branch,
        head,
        before,
        ...(workspace ? { workspacePath: workspace.path, workspaceBaseline: before, workspaceSeed: before, primaryIndexBefore } : {}),
        writePaths,
        concurrentScopes,
        attributionBoundaryAt,
        profile: input.profile || this.config.defaultProfile,
        maxRepairRounds: input.maxRepairRounds ?? 2,
        rounds: 0,
        status: 'QUEUED',
        wallStartedAt: this.now().toISOString(),
        leaseOwnerNonce,
        runnerPid: process.pid,
        runnerHeartbeatAt: this.now().toISOString(),
        handoffState: launch ? 'LOCAL' : 'PARENT_QUEUED',
      });
      if (workspace) await this.#pinTrees(job, { before });
      if (this.leases.acquire) {
        if (this.leases.acquire.length >= 2) await this.leases.acquire(job.id, writePaths, { ownerNonce: leaseOwnerNonce });
        else await this.leases.acquire({ jobId: job.id, repoPath, ownedPaths: writePaths });
      }
      if (this.leases.bind) await this.leases.bind(job.id);
      await this.store.event(job.id, { type: 'started' });
      if (launch) this._launch(job.id, 'start', undefined, job);
      return this.public(job);
    } catch (error) {
      if (job) await this.#finishOwnedTerminal(job, 'FAILED', { error: String(error.message || error) });
      let cleanupFailure;
      if (workspace && !job) {
        try {
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
      if (!this.leases.transfer && this.leases.acquire) {
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
      let job, ownerNonce, workspace, launchClaimed;
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
        const launchChanges = {
          // A detached child can observe its cancellation marker after the
          // parent assigned its pid but before this async launch starts. Do
          // not resurrect that queued handoff as RUNNING even transiently.
          status: cancelledBeforeLaunch ? 'FINALIZING' : reason === 'repair' ? 'REPAIRING' : 'RUNNING',
          ...(cancelledBeforeLaunch ? { finalStatus: 'CANCELLED' } : {}),
          startedAt: this.now().toISOString(),
          runnerPid: process.pid,
          leaseOwnerNonce: ownerNonce,
          runnerHeartbeatAt: this.now().toISOString(),
          handoffState: cancelledBeforeLaunch ? 'CANCELLED' : 'RUNNING',
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
        workspace = this.#workspace(job);
        const cancelledAfterLaunch = await this.store.cancelRequested?.(id);
        if (controller.signal.aborted || cancelledAfterLaunch) {
          if (!cancelledBeforeLaunch)
            job = await this.store.update(id, { status: 'FINALIZING', finalStatus: 'CANCELLED', handoffState: 'CANCELLED' });
          throw new Error('job cancelled before worker launch');
        }
        {
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
          const result = await this.worker.run(job, {
            signal: controller.signal,
            defects,
            progress: async (event) => {
              const progress = {};
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
              await this.store.update(id, progress);
              await this.store.event(id, { type: 'progress', ...progress });
            },
            appendMessage: (m) => this.store.messages(id, m),
            appendMessages: (messages) => this.store.messagesBatch(id, messages),
          });
          const allowedWorkerStatuses = new Set(['DONE', 'FAILED', 'TIMEOUT', 'BUDGET', 'CANCELLED']);
          const malformedResult = !result || typeof result !== 'object' || Array.isArray(result);
          const requestedStatus = malformedResult ? 'FAILED' : (result.status ?? 'DONE');
          const invalidStatus = !allowedWorkerStatuses.has(requestedStatus);
          let workerStatus = leaseLost
            ? 'FAILED'
            : controller.signal.aborted
              ? 'CANCELLED'
              : invalidStatus
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
          job = await this.store.update(id, {
            status: workerStatus === 'WORKER_DONE' ? 'WORKER_DONE' : 'FINALIZING',
            finalStatus: workerStatus === 'WORKER_DONE' ? undefined : workerStatus,
            summary: boundedString(result?.summary ?? result?.finish?.summary, 1500) ?? job.summary,
            concerns: boundedStrings(result?.concerns ?? result?.finish?.concerns) ?? job.concerns,
            turns: (job.turns || 0) + (badAccounting ? 0 : resultTurns),
            usage,
            costUsd: (job.costUsd || 0) + (badAccounting ? 0 : result?.costUsd || 0),
            model: boundedString(result?.model, 128),
            responseModel: boundedString(result?.responseModel, 128),
            pricingKnown: typeof result?.pricingKnown === 'boolean' ? result.pricingKnown : undefined,
            ...(leaseLost
              ? { error: `lease lost: ${leaseLost}` }
              : invalidStatus || badAccounting
                ? {
                    error: invalidStatus
                      ? `worker returned invalid status: ${String(requestedStatus)}`
                      : 'worker returned invalid result or accounting data',
                  }
                : budgetExceeded
                  ? { error: 'worker exceeded cumulative job budget' }
                  : result?.error && workerStatus !== 'WORKER_DONE'
                    ? { error: String(result.error).slice(0, 1500) }
                    : {}),
          });
          job = this.validatePersisted(job);
          if (!workspace && this.snapshots.create && this.snapshots.diff && job.before) {
            const after = await this.snapshots.create(job.repoPath);
            job = await this.store.update(id, { after });
          }
          if (!controller.signal.aborted && workerStatus === 'WORKER_DONE') {
            // Verification is trusted to read the result, not to silently
            // become another author of it. Capture a durable pre-verifier tree
            // before invoking a command that may have write access for normal
            // build/test scratch activity.
            if (workspace) {
              const workerAfter = workspace.snapshot();
              job = await this.store.update(id, { workerAfter });
              await this.#pinTrees(job, { before: job.before, workerAfter });
            }
            await this._verify(job);
          }
        } catch (error) {
          const aborted = controller.signal.aborted;
          job = await this.store.update(id, {
            status: 'FINALIZING',
            finalStatus: leaseLost ? 'FAILED' : aborted ? 'CANCELLED' : error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'FAILED',
            error: leaseLost ? `lease lost: ${leaseLost}` : String(error.message || error),
          });
        } finally {
          if (cancellationWatch) clearInterval(cancellationWatch);
          // Preserve partial changes even after cancellation, timeouts and worker failures.
          try {
            job = this.validatePersisted(await this.store.get(id));
            // A detached caller can set cancellation after the polling interval
            // is cleared but before publication. Honor the durable request here
            // so that finalization cannot accidentally publish DONE.
            if ((await this.store.cancelRequested?.(id)) && !final(job.status))
              job = await this.store.update(id, { status: 'FINALIZING', finalStatus: 'CANCELLED' });
            if (workspace) {
              const workspaceAfter = await workspace.snapshot();
              const audited = await this.#classifyIsolatedWorkspace(job, workspace, workspaceAfter);
              await this.store.writeArtifact(id, 'patch.diff', audited.allPatch);
              await this.store.writeArtifact(id, 'revert.diff', audited.revertPatch);
              job = await this.store.update(id, {
                workspaceAfter,
                after: workspaceAfter,
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
            } else if (this.snapshots.create && this.snapshots.diff && job.before) {
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
            await this.store.writeArtifact(id, 'report.md', this.report(done));
            await this.store.event(id, { type: 'finished', status: done.status });
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
                      })
                    : this.#sameRecoveryIdentity(current, await this.store.get(id))
                      ? await this.store.update(id, {
                          status: 'QUEUED',
                          rounds: (current.rounds || 0) + 1,
                          finishedAt: undefined,
                          leaseOwnerNonce,
                          handoffState: 'LOCAL',
                          autoRepairScheduled: false,
                        })
                      : null;
                if (!queued) return;
                const cancelledAfterQueue = await this.store.cancelRequested?.(id);
                if (controller.signal.aborted || cancelledAfterQueue) {
                  await this.#finishOwnedTerminal(await this.store.get(id), 'CANCELLED');
                  return;
                }
                const verifierText = String(done.verify?.result?.stderr || done.verify?.result?.stdout || 'test command failed').slice(
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
  async _verify(job) {
    job = this.validatePersisted(job);
    if (!job.testCommand) return this.store.update(job.id, { status: 'FINALIZING', finalStatus: 'DONE_UNVERIFIED' });
    const executionPath = job.workspacePath || job.repoPath;
    const verify = await this.runner.verify(job.testCommand, {
      cwd: executionPath,
      gitDir: this.config.gitDir
        ? await this.config.gitDir(executionPath)
        : resolve(executionPath, git(executionPath, ['rev-parse', '--git-dir'])),
      signal: this.controllers.get(job.id)?.signal,
      allowNetwork: !!job.allowNetwork,
      denyRead: job.denyRead || [],
      writablePaths: writeScope(job).map((p) => join(executionPath, p)),
      requireSandbox: job.requireSandbox === true,
    });
    const sandboxed = verifierUsedMacosSandbox(verify);
    // requireSandbox is an absolute caller/repository contract.  Defend it at
    // this boundary too so an injected or buggy Runner cannot claim PASS after
    // returning a policy-only (or no) execution result.
    const sandboxRequirementFailed = job.requireSandbox === true && !sandboxed;
    // A policy-only verifier can report a verified result only after the
    // caller explicitly opted into it, but can never authorize another model
    // turn. Unknown/missing result.sandbox fails closed for repair as well.
    const canRepair = verify.verdict !== 'PASS' && !sandboxRequirementFailed && sandboxed && (job.rounds || 0) < (job.maxRepairRounds ?? 2);
    const status = sandboxRequirementFailed
      ? 'VERIFY_FAILED'
      : verify.verdict === 'PASS'
        ? 'DONE_VERIFIED'
        : canRepair
          ? 'REPAIR_QUEUED'
          : 'VERIFY_FAILED';
    return this.store.update(job.id, { status: 'FINALIZING', finalStatus: status, verify });
  }
  public(job) {
    return {
      jobId: job.id,
      repo: job.repoPath,
      branch: job.branch,
      head: job.head,
      profile: job.profile,
      status: job.status,
      ...(job.unsafePolicyOnlyVerifier === true ? { unsafePolicyOnlyVerifier: true } : {}),
      // Cleanup status is operationally significant once a job reaches a
      // terminal result. Expose only the bounded persisted diagnosis, never
      // the private workspace path, so remote CLI/MCP callers can distinguish
      // a retryable cleanup failure from an explicit manual-cleanup decision.
      ...(typeof job.workspaceCleanupError === 'string' && job.workspaceCleanupError
        ? { workspaceCleanupError: job.workspaceCleanupError }
        : {}),
      ...(job.workspaceCleanupRequired === true ? { workspaceCleanupRequired: true } : {}),
    };
  }
  async wait(id, { timeoutSec = 40, signal } = {}) {
    const rawTimeout = Number(timeoutSec);
    timeoutSec = Math.min(55, Math.max(0, Number.isFinite(rawTimeout) ? rawTimeout : 40));
    const stop = Date.now() + timeoutSec * 1000;
    let job = await this.store.get(id);
    while (!final(job.status) && Date.now() < stop && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 100));
      job = await this.store.get(id);
    }
    if (signal?.aborted) throw new Error('request cancelled');
    // A local task keeps ownership through terminal publication and cleanup.
    // Do not expose its durable terminal status as fully complete while that
    // same task is still releasing its lease or cleaning its workspace:
    // callers commonly repair/read immediately after wait().
    if (final(job.status) && this.running.has(id)) {
      await this.running.get(id);
      job = await this.store.get(id);
    }
    return final(job.status)
      ? { ...this.public(job), report: this.report(job), done: true }
      : {
          ...this.public(job),
          done: false,
          progress: {
            turns: job.turns || 0,
            usage: job.usage,
            costUsd: job.costUsd,
            recentActions: job.recentActions || [],
            status: job.status,
          },
        };
  }
  async list(options = {}) {
    return (await this.store.list(options)).map((job) => this.public(job));
  }
  async job(id, { include = 'summary' } = {}) {
    if (!id) return { jobs: await this.list(), health: this.config.health ? await this.config.health() : { sandbox: 'unknown' } };
    const job = await this.store.get(id);
    if (!['summary', 'diff', 'files', 'log'].includes(include)) throw new Error('include must be summary, diff, files, or log');
    const result = { ...this.public(job), report: this.report(job) };
    if (include === 'diff') result.diff = await this.store.readArtifact(id, 'patch.diff');
    if (include === 'files') result.files = job.files || [];
    if (include === 'log') result.log = await this.store.readArtifact(id, 'events.jsonl');
    return result;
  }
  async cancel(id) {
    // A separate control-plane process must be able to leave the durable
    // cancellation marker after its provider credential was rotated.  This
    // uses the store's MAC-verified operational view only; it never resumes,
    // verifies, repairs, or otherwise consumes an execution profile.
    const get = this.store.getOperational?.bind(this.store) || this.store.get?.bind(this.store);
    const before = await get(id);
    if (!final(before.status)) await this.store.requestCancel?.(id);
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      await this.running.get(id);
    }
    let job = await get(id);
    if (!final(job.status) && controller) job = await this.#finishOwnedTerminal(job, 'CANCELLED');
    // Without a local controller this process is not the worker owner. Keep
    // only the durable cancellation marker written above; a queued detached
    // child may still be between handoff checks, and deleting its workspace
    // here would race its authenticated owner. Resume/assign/recovery consume
    // the marker and perform the owned terminal cleanup.
    if (!final(job.status) && !controller && ['QUEUED', 'REPAIR_QUEUED'].includes(job.status)) job = await get(id);
    return { ...this.public(job), report: this.report(job) };
  }
  async repair(id, defects, { launch = true } = {}) {
    if (
      !Array.isArray(defects) ||
      !defects.length ||
      defects.length > MAX_REPAIR_ITEMS ||
      !defects.every((x) => cleanText(x, MAX_REPAIR_ITEM)) ||
      defects.reduce((n, x) => n + x.length, 0) > MAX_REPAIR_CHARS
    )
      throw new Error('defects must be 1-32 non-empty bounded strings');
    let job = this.validatePersisted(await this.store.get(id));
    // A terminal durable state can be published just before its owning local
    // task performs final cleanup. Join that task first, then decide whether
    // a manual repair is eligible; otherwise the same request is needlessly
    // rejected as "still running" and can race replacement workspace setup.
    if (final(job.status) && this.running.has(id)) {
      await this.running.get(id);
      job = this.validatePersisted(await this.store.get(id));
    }
    if (!final(job.status) || this.running.has(id)) throw new Error('job is still running');
    if (job.applied === true) throw new Error('an applied job cannot be repaired; start a new job from the current primary tree');
    if (job.integrationIntent === true || job.revertIntent === true || job.integrationUncertain === true || job.revertUncertain === true)
      throw new Error('a job with an unresolved primary mutation outcome cannot be repaired; inspect the primary tree and start a new job');
    if (job.scopeViolations?.length || job.verifierMutations?.length)
      throw new Error('a job with scope or verifier-authorship violations cannot be repaired; start a fresh job');
    if (job.verify && !verifierUsedMacosSandbox(job.verify))
      throw new Error('jobs with a policy-only or unknown verifier result require a fresh start');
    if (await this.store.cancelRequested?.(id)) throw new Error('job was cancelled');
    if ((job.rounds || 0) >= (job.maxRepairRounds ?? 2)) throw new Error('maximum repair rounds reached');
    if (
      (job.budget?.maxTurns != null && (job.turns || 0) >= job.budget.maxTurns) ||
      (job.budget?.maxUsd != null && (job.costUsd || 0) >= job.budget.maxUsd)
    )
      throw new Error('cumulative job budget exhausted');
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
        finishedAt: undefined,
        autoRepairScheduled: false,
        leaseOwnerNonce,
        handoffState: launch ? 'LOCAL' : 'PARENT_QUEUED',
        runnerPid: process.pid,
        runnerHeartbeatAt: this.now().toISOString(),
        pendingDefects: defects,
        ...(workspace
          ? {
              workspacePath: workspace.path,
              workspaceBaseline: job.before,
              workspaceSeed: job.workspaceAfter || job.before,
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
      if (launch) this._launch(id, 'repair', defects, next);
      return this.public(next);
    } catch (error) {
      if (reservation)
        await this.#finishOwnedTerminal(job, 'FAILED', { error: `repair setup failed: ${error.message || error}` }, leaseOwnerNonce, {
          expectedIdentity: this.#recoveryIdentity(job),
        }).catch(() => {});
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
  async revert(id, { apply = false } = {}) {
    // This is a destructive boundary. JSON Schema metadata in an MCP client is
    // advisory, and embedded callers can bypass it entirely, so only a literal
    // boolean true may authorize applying a reverse patch.
    if (typeof apply !== 'boolean') throw new Error('apply must be boolean');
    let job = this.validatePersisted(await this.store.get(id));
    if (job.revertIntent === true) {
      const reconciliation = await this.#reconcileRevert(job);
      job = this.validatePersisted(await this.store.update(id, reconciliation));
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
      if (result?.applied) await this.store.update(id, { revertedAt: this.now().toISOString() });
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
      await this.store.update(id, reconciliation);
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
      await this.store.update(id, reconciliation);
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
      if (!(await this.#recoveryMayClean(staged, get))) return null;
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
    const except = new Set([...(options.exceptIds || []), ...this.running.keys()]);
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
      const hasJournal = job?.integrationIntent === true || job?.revertIntent === true;
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
      const alive = Number.isInteger(job.runnerPid) && pidAlive(job.runnerPid);
      // A terminal journal can retain a long-lived MCP server PID after a
      // post-apply record-write failure, so it must be reconciled promptly.
      // A live owner may still write any non-terminal lifecycle or unresolved
      // primary-mutation journal. A plain terminal cleanup retry is different:
      // below it may proceed only after proving this job has no lease.
      const terminalCleanupReservation = job.status === 'FINALIZING' && final(job.recoveryTerminalStatus);
      if (alive && ((!final(job.status) && !terminalCleanupReservation) || hasJournal)) continue;
      // A journal remains authoritative even after another error handler has
      // published a terminal status. Resolve it before generic crash
      // finalization so no record can falsely say the primary was untouched.
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
          const finalStatus = applied ? job.integrationFinalStatus : 'FAILED';
          const published = await publishRecoveredTerminal(
            job,
            finalStatus,
            {
              ...reconciliation,
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
        if (job.workspacePath && this.isolated) {
          const workspace = this.#workspace(job);
          const workspaceAfter = workspace.snapshot();
          const audited = await this.#classifyIsolatedWorkspace(job, workspace, workspaceAfter);
          await writeArtifact(job.id, 'patch.diff', audited.allPatch);
          await writeArtifact(job.id, 'revert.diff', audited.revertPatch);
          finalJob.workspaceAfter = workspaceAfter;
          finalJob.after = workspaceAfter;
          finalJob.files = audited.owned;
          finalJob.allFiles = audited.all;
          finalJob.revertFiles = audited.revertPaths;
          finalJob.scopeViolations = audited.violations;
          finalJob.discardedEphemeralOutputs = audited.discardedEphemeralOutputs;
          finalJob.verifierMutations = audited.verifierMutations;
          await this.#pinTrees(job, { before: job.before, ...(job.workerAfter ? { workerAfter: job.workerAfter } : {}), workspaceAfter });
        } else if (this.snapshots.create && this.snapshots.diff && job.before) {
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
