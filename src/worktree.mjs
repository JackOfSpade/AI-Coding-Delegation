import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { diffTreeFiles, diffTrees, git, snapshotGitEnv, snapshotWorkingTree } from './git-snapshot.mjs';

const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const nativeRealpath = realpathSync.native || realpathSync;

/** A stable, caller-actionable error boundary for isolated worktree operations. */
export class WorktreeIsolationError extends Error {
  constructor(message, code = 'E_WORKTREE') {
    super(message);
    this.name = 'WorktreeIsolationError';
    this.code = code;
  }
}

/**
 * Create a private linked worktree whose files exactly match `seedTree`.
 *
 * `baselineTree` is normally produced by snapshotWorkingTree(primaryRepo), so
 * it includes the caller's staged, unstaged, and non-ignored untracked state.
 * `seedTree` defaults to it, but allows a manual-repair/retry tree to populate
 * the worker workspace while all conflict and integration comparisons remain
 * anchored to the original baseline.
 * Neither this function nor the returned object changes the primary index or
 * HEAD. `tempRoot`, if supplied by a server, is only a parent for mkdtemp;
 * callers never choose the worktree path itself.
 */
export function createIsolatedWorktree({
  repoPath,
  baselineTree,
  seedTree = baselineTree,
  tempRoot = tmpdir(),
  mkdtemp = mkdtempSync,
} = {}) {
  const primaryPath = canonicalRepo(repoPath);
  assertTree(baselineTree);
  assertTreeExists(primaryPath, baselineTree, 'E_WORKTREE_BASELINE');
  assertTree(seedTree, 'seedTree');
  assertTreeExists(primaryPath, seedTree, 'E_WORKTREE_SEED');
  const privateRoot = makePrivateRoot(tempRoot, mkdtemp);
  const privateBase = canonicalTempRoot(tempRoot);
  const privateRootProof = capturePrivateRoot(privateRoot, privateBase);
  const workspacePath = join(privateRoot, 'workspace');

  try {
    // Snapshot trees are otherwise unreachable temporary objects. Pin them
    // before creating the linked worktree so a concurrent `git gc --prune`
    // cannot invalidate an active or freshly persisted job.
    pinTrees(primaryPath, privateRoot, baselineTree, seedTree);
    // --no-checkout avoids materializing HEAD first. read-tree then writes
    // precisely the supplied tree to the linked worktree's own index/files.
    run(primaryPath, ['worktree', 'add', '--detach', '--no-checkout', workspacePath, 'HEAD'], 'E_WORKTREE_CREATE');
    run(workspacePath, ['read-tree', '--reset', '-u', seedTree], 'E_WORKTREE_SEED');
  } catch (error) {
    safeRemove(primaryPath, workspacePath, privateRoot, { ownPrivateRoot: true, privateBase, privateRootProof });
    if (error instanceof WorktreeIsolationError) throw error;
    throw new WorktreeIsolationError('Could not create isolated worktree', 'E_WORKTREE_CREATE');
  }

  return isolatedHandle({
    primaryPath,
    workspacePath,
    baselineTree,
    seedTree,
    privateRoot,
    privateBase,
    privateRootProof,
    ownPrivateRoot: true,
  });
}

/**
 * Recover a persisted isolated worktree without changing its files or index.
 * The path must be the exact registered worktree created below an offload
 * mkdtemp directory for this primary repository; arbitrary worktrees and
 * deletion targets are never accepted.
 */
export function openIsolatedWorktree({ repoPath, workspacePath, baselineTree, seedTree = baselineTree, tempRoot = tmpdir() } = {}) {
  const primaryPath = canonicalRepo(repoPath);
  assertTree(baselineTree);
  assertTreeExists(primaryPath, baselineTree, 'E_WORKTREE_BASELINE');
  // Persisted lifecycle records should carry both authenticated tree IDs when
  // a repair workspace was seeded from a tree other than its conflict baseline.
  assertTree(seedTree, 'seedTree');
  assertTreeExists(primaryPath, seedTree, 'E_WORKTREE_SEED');
  const location = privateWorkspaceLocation(workspacePath, tempRoot, { requireExisting: true });
  if (!isRegisteredWorktree(primaryPath, location.workspacePath))
    throw new WorktreeIsolationError('workspacePath is not a registered linked worktree for this repository', 'E_WORKTREE_RECOVERY');
  if (commonGitDir(primaryPath) !== commonGitDir(location.workspacePath))
    throw new WorktreeIsolationError('workspacePath does not share the primary repository object database', 'E_WORKTREE_RECOVERY');
  assertPinnedTrees(primaryPath, location.privateRoot, baselineTree, seedTree);
  return isolatedHandle({
    primaryPath,
    workspacePath: location.workspacePath,
    baselineTree,
    seedTree,
    privateRoot: location.privateRoot,
    privateBase: location.base,
    privateRootProof: capturePrivateRoot(location.privateRoot, location.base),
    ownPrivateRoot: false,
  });
}

/**
 * Recovery cleanup for a persisted path when no live handle remains. A path
 * outside the server-created layout, or one not registered by this repository,
 * is rejected; an already-cleaned safe path is a no-op.
 */
export function cleanupIsolatedWorktree({ repoPath, workspacePath, tempRoot = tmpdir() } = {}) {
  const primaryPath = canonicalRepo(repoPath);
  const location = privateWorkspaceLocation(workspacePath, tempRoot, { requireExisting: false });
  const safeOrphanRoot = privateRootIsSafe(location.privateRoot, location.base);
  if (privateRootExists(location.privateRoot) && !safeOrphanRoot)
    throw new WorktreeIsolationError(
      'private worktree root changed or is unsafe; cleanup is retained for manual inspection',
      'E_WORKTREE_REMOVE',
    );
  const result = safeRemove(primaryPath, location.workspacePath, location.privateRoot, {
    removeOrphanRoot: safeOrphanRoot,
    releaseOrphanPins: safeOrphanRoot || hasTreePins(primaryPath, location.privateRoot),
    privateBase: location.base,
    ...(safeOrphanRoot ? { privateRootProof: capturePrivateRoot(location.privateRoot, location.base) } : {}),
  });
  if (result.retained)
    throw new WorktreeIsolationError('Could not remove isolated worktree; it remains registered and can be retried', 'E_WORKTREE_REMOVE');
  return { removed: result.removed, pruned: result.pruned, alreadyAbsent: result.alreadyAbsent === true, cleaned: true };
}

function isolatedHandle({
  primaryPath,
  workspacePath,
  baselineTree,
  seedTree,
  privateRoot,
  privateBase,
  privateRootProof,
  ownPrivateRoot,
}) {
  let closed = false;

  const ensureOpen = () => {
    if (closed) throw new WorktreeIsolationError('Worktree has already been cleaned up', 'E_WORKTREE_CLOSED');
  };
  const assertWorkspaceTree = (tree) => {
    assertTree(tree);
    assertTreeExists(primaryPath, tree, 'E_WORKTREE_TREE');
    return tree;
  };
  const changesFor = (afterTree, paths) => {
    assertWorkspaceTree(afterTree);
    const allFiles = diffTreeFiles(primaryPath, baselineTree, afterTree);
    const files = selectChangedFiles(allFiles, paths);
    return {
      baselineTree,
      afterTree,
      files,
      patch:
        paths === undefined
          ? diffTrees(primaryPath, baselineTree, afterTree)
          : files.length
            ? diffTrees(primaryPath, baselineTree, afterTree, { paths: files.map((file) => file.path), literalPaths: true })
            : Buffer.alloc(0),
    };
  };

  const api = {
    repoPath: primaryPath,
    path: workspacePath,
    baselineTree,
    seedTree,

    /** Snapshot all non-ignored workspace files without modifying its index. */
    snapshot() {
      ensureOpen();
      try {
        const tree = snapshotWorkingTree(workspacePath);
        // A single rolling after-tree pin is enough for the lifecycle's next
        // comparison/integration step and stays bounded during a live job.
        pinTree(primaryPath, treePinRef(privateRoot, 'after'), tree);
        return tree;
      } catch {
        throw new WorktreeIsolationError('Could not snapshot isolated worktree', 'E_WORKTREE_SNAPSHOT');
      }
    },

    /** Return an authoritative NUL-derived changed file list and binary patch. */
    changes(afterTree) {
      ensureOpen();
      try {
        return changesFor(afterTree);
      } catch (error) {
        if (error instanceof WorktreeIsolationError) throw error;
        throw new WorktreeIsolationError('Could not calculate isolated worktree changes', 'E_WORKTREE_DIFF');
      }
    },

    /** List ignored, untracked workspace paths (including ignored generated output). */
    ignoredPaths() {
      ensureOpen();
      try {
        const raw = run(workspacePath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], 'E_WORKTREE_IGNORED');
        return raw.split('\0').filter(Boolean);
      } catch (error) {
        if (error instanceof WorktreeIsolationError) throw error;
        throw new WorktreeIsolationError('Could not inspect ignored workspace files', 'E_WORKTREE_IGNORED');
      }
    },

    /**
     * Ensure the primary working tree still equals the baseline on every path
     * the worker patch would touch. Unrelated primary edits deliberately pass.
     */
    verifyPrimary(afterTree, { paths: requestedPaths } = {}) {
      ensureOpen();
      let change;
      try {
        change = changesFor(afterTree, requestedPaths);
      } catch (error) {
        if (error instanceof WorktreeIsolationError) throw error;
        throw new WorktreeIsolationError('Could not inspect changed paths', 'E_WORKTREE_DIFF');
      }
      const paths = change.files.map((file) => file.path);
      let primaryTree;
      try {
        primaryTree = snapshotWorkingTree(primaryPath);
      } catch {
        throw new WorktreeIsolationError('Could not snapshot primary working tree', 'E_WORKTREE_PRIMARY_SNAPSHOT');
      }
      if (paths.length === 0) return { ok: true, baselineTree, primaryTree, conflicts: [] };
      let conflictFiles;
      try {
        conflictFiles = diffTreeFilesForPaths(primaryPath, baselineTree, primaryTree, paths);
      } catch {
        throw new WorktreeIsolationError('Could not compare primary working tree', 'E_WORKTREE_VERIFY');
      }
      return { ok: conflictFiles.length === 0, baselineTree, primaryTree, conflicts: conflictFiles };
    },

    /**
     * Dry-run then apply the binary patch to the primary working tree. The
     * primary index is intentionally never supplied to git apply.
     */
    integrate(afterTree, { paths: requestedPaths } = {}) {
      ensureOpen();
      const verification = api.verifyPrimary(afterTree, { paths: requestedPaths });
      if (!verification.ok) {
        throw new WorktreeIsolationError(
          `Primary working tree changed on ${verification.conflicts.length} worker-touched path(s)`,
          'E_WORKTREE_CONFLICT',
        );
      }
      let change;
      try {
        // Finish every fallible diff calculation before mutating the primary
        // checkout.  A caller can then treat a successful `git apply` as the
        // sole primary-write boundary and journal it without a later
        // best-effort computation obscuring whether the patch landed.
        change = changesFor(afterTree, requestedPaths);
      } catch (error) {
        if (error instanceof WorktreeIsolationError) throw error;
        throw new WorktreeIsolationError('Could not create integration patch', 'E_WORKTREE_DIFF');
      }
      const { patch } = change;
      if (patch.length === 0) return { applied: false, dryRun: true, files: [] };
      try {
        // Feed both Git operations the exact generated bytes. A private file
        // still leaves a check/apply TOCTOU window if it is opened twice.
        // `--check` remains a separate required gate before mutation.
        run(primaryPath, ['apply', '--check', '--whitespace=nowarn'], 'E_WORKTREE_APPLY_CHECK', { input: patch });
        run(primaryPath, ['apply', '--whitespace=nowarn'], 'E_WORKTREE_APPLY', { input: patch });
      } catch (error) {
        if (error instanceof WorktreeIsolationError) throw error;
        throw new WorktreeIsolationError('Could not integrate isolated worktree patch', 'E_WORKTREE_APPLY');
      }
      return { applied: true, dryRun: false, files: change.files, primaryBefore: verification.primaryTree };
    },

    /** Remove this private linked worktree and prune stale Git administration. */
    cleanup() {
      if (closed) return { removed: false, pruned: false, alreadyAbsent: true, cleaned: true };
      const result = safeRemove(primaryPath, workspacePath, privateRoot, { ownPrivateRoot, privateBase, privateRootProof });
      if (result.retained)
        throw new WorktreeIsolationError('Could not remove isolated worktree; cleanup can be retried', 'E_WORKTREE_REMOVE');
      closed = true;
      return { removed: result.removed, pruned: result.pruned, alreadyAbsent: result.alreadyAbsent === true, cleaned: true };
    },
  };
  return Object.freeze(api);
}

/** Convenience for the normal JobManager baseline capture path. */
export function snapshotPrimaryWorkingTree(repoPath) {
  const primaryPath = canonicalRepo(repoPath);
  try {
    return snapshotWorkingTree(primaryPath);
  } catch {
    throw new WorktreeIsolationError('Could not snapshot primary working tree', 'E_WORKTREE_PRIMARY_SNAPSHOT');
  }
}

/**
 * Keep durable job snapshot trees reachable without exposing a general ref
 * writer. JobManager decides when a record is retained or purged; this helper
 * only owns the fixed, per-job namespace and updates it transactionally.
 */
export function pinJobTrees({ repoPath, jobId, trees } = {}) {
  const primaryPath = canonicalRepo(repoPath);
  const refs = jobTreeRefs(jobId);
  const entries = validatedJobTrees(primaryPath, trees, refs);
  runRefTransaction(
    primaryPath,
    entries.map(([name, tree]) => `update ${refs[name]} ${tree}`),
  );
  return Object.fromEntries(entries.map(([name, tree]) => [name, { tree, ref: refs[name] }]));
}

/** Remove only this job's fixed snapshot refs; no arbitrary ref is accepted. */
export function releaseJobTrees({ repoPath, jobId } = {}) {
  const primaryPath = canonicalRepo(repoPath);
  const refs = jobTreeRefs(jobId);
  runRefTransaction(
    primaryPath,
    Object.values(refs).map((ref) => `delete ${ref}`),
    { tolerateMissing: true },
  );
  return { released: Object.values(refs) };
}

function canonicalRepo(repoPath) {
  if (typeof repoPath !== 'string' || !repoPath || repoPath.includes('\0') || !isAbsolute(repoPath))
    throw new WorktreeIsolationError('repoPath must be an absolute existing path', 'E_WORKTREE_REPO');
  let topLevel;
  try {
    topLevel = run(resolve(repoPath), ['rev-parse', '--show-toplevel'], 'E_WORKTREE_REPO').trim();
  } catch {
    throw new WorktreeIsolationError('repoPath must be inside a Git working tree', 'E_WORKTREE_REPO');
  }
  try {
    return nativeRealpath(topLevel);
  } catch {
    throw new WorktreeIsolationError('Git repository path cannot be resolved', 'E_WORKTREE_REPO');
  }
}
function jobTreeRefs(jobId) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(jobId))
    throw new WorktreeIsolationError('jobId must be a safe durable identifier', 'E_WORKTREE_JOB_REF');
  return Object.freeze(
    Object.fromEntries(
      ['before', 'workerAfter', 'workspaceAfter', 'primaryAfter'].map((name) => [name, `refs/offload/jobs/${jobId}/${name}`]),
    ),
  );
}
function validatedJobTrees(repoPath, trees, refs) {
  if (!trees || typeof trees !== 'object' || Array.isArray(trees) || Object.getPrototypeOf(trees) !== Object.prototype)
    throw new WorktreeIsolationError('trees must be a plain object', 'E_WORKTREE_JOB_REF');
  const allowed = new Set(Object.keys(refs));
  if (Object.keys(trees).some((name) => !allowed.has(name)))
    throw new WorktreeIsolationError('trees contains an unsupported durable snapshot name', 'E_WORKTREE_JOB_REF');
  if (!Object.hasOwn(trees, 'before')) throw new WorktreeIsolationError('trees.before is required', 'E_WORKTREE_JOB_REF');
  const entries = [];
  for (const name of Object.keys(refs)) {
    if (!Object.hasOwn(trees, name) || trees[name] == null) continue;
    try {
      assertTree(trees[name], `trees.${name}`);
      assertTreeExists(repoPath, trees[name], 'E_WORKTREE_JOB_REF');
    } catch {
      throw new WorktreeIsolationError(`trees.${name} must name an existing Git tree`, 'E_WORKTREE_JOB_REF');
    }
    entries.push([name, trees[name]]);
  }
  return entries;
}
function runRefTransaction(
  repoPath,
  commands,
  { tolerateMissing = false, errorCode = 'E_WORKTREE_JOB_REF', errorMessage = 'Could not update durable job tree references' } = {},
) {
  const env = snapshotGitEnv();
  const hooks = process.platform === 'win32' ? 'NUL' : '/dev/null';
  // Commands contain only fixed namespace refs and validated SHA-1/SHA-256
  // object IDs. `update-ref --stdin` commits all updates as one transaction.
  const input = `start\n${commands.join('\n')}\nprepare\ncommit\n`;
  try {
    execFileSync('git', ['-C', repoPath, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooks}`, 'update-ref', '--stdin'], {
      input,
      encoding: 'utf8',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (
      tolerateMissing &&
      /cannot lock ref .*reference does not exist|unable to resolve reference/i.test(String(error?.stderr || error?.message || ''))
    ) {
      // A missing target is a normal idempotent release. Retry only deletes
      // that exist, still through one transaction.
      const existing = commands.filter((command) => {
        const ref = command.slice('delete '.length);
        try {
          run(repoPath, ['show-ref', '--verify', '--quiet', ref], 'E_WORKTREE_JOB_REF');
          return true;
        } catch {
          return false;
        }
      });
      if (existing.length) return runRefTransaction(repoPath, existing, { errorCode, errorMessage });
      return;
    }
    throw new WorktreeIsolationError(errorMessage, errorCode);
  }
}
function makePrivateRoot(tempRoot, mkdtemp) {
  if (typeof mkdtemp !== 'function') throw new WorktreeIsolationError('mkdtemp must be a server-controlled function', 'E_WORKTREE_TEMP');
  const base = canonicalTempRoot(tempRoot);
  let root;
  try {
    root = mkdtemp(join(base, 'offload-worktree-'));
  } catch {
    throw new WorktreeIsolationError('Could not allocate private worktree directory', 'E_WORKTREE_TEMP');
  }
  if (typeof root !== 'string' || !isAbsolute(root) || /[\0-\x1f\x7f]/.test(root)) {
    throw new WorktreeIsolationError('mkdtemp returned an unsafe private directory', 'E_WORKTREE_TEMP');
  }
  const supplied = resolve(root);
  // Never delete a path merely because an injected/broken allocator returned
  // it. It first has to prove it is exactly our direct, private child.
  if (!isChildOf(base, supplied) || !samePath(dirname(supplied), base) || !/^offload-worktree-[A-Za-z0-9_-]+$/.test(basename(supplied)))
    throw new WorktreeIsolationError('mkdtemp returned an unsafe private directory', 'E_WORKTREE_TEMP');
  let details;
  let canonicalRoot;
  let provedPrivate = false;
  try {
    details = lstatSync(supplied);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('not a real directory');
    if (typeof process.getuid === 'function' && details.uid !== process.getuid()) throw new Error('wrong owner');
    canonicalRoot = nativeRealpath(supplied);
    if (!samePath(canonicalRoot, supplied)) throw new Error('resolved path changed');
    provedPrivate = true;
    // mkdtemp is expected to create a private directory. Enforce that
    // invariant even when a test/server wrapper supplies the allocator.
    chmodSync(supplied, 0o700);
  } catch {
    // The proven-layout branch may only remove a current-user-owned real
    // directory; all other allocator output is left completely untouched.
    if (provedPrivate)
      try {
        rmSync(supplied, { recursive: true, force: true });
      } catch {}
    throw new WorktreeIsolationError('mkdtemp returned an unsafe private directory', 'E_WORKTREE_TEMP');
  }
  return canonicalRoot;
}
function canonicalTempRoot(tempRoot) {
  if (typeof tempRoot !== 'string' || !tempRoot || !isAbsolute(tempRoot) || /[\0-\x1f\x7f]/.test(tempRoot))
    throw new WorktreeIsolationError('tempRoot must be an absolute server-controlled directory', 'E_WORKTREE_TEMP');
  try {
    return nativeRealpath(tempRoot);
  } catch {
    throw new WorktreeIsolationError('tempRoot must be an existing server-controlled directory', 'E_WORKTREE_TEMP');
  }
}
function privateWorkspaceLocation(workspacePath, tempRoot, { requireExisting }) {
  if (typeof workspacePath !== 'string' || !workspacePath || !isAbsolute(workspacePath) || /[\0-\x1f\x7f]/.test(workspacePath))
    throw new WorktreeIsolationError('workspacePath must be an absolute private worktree path', 'E_WORKTREE_RECOVERY');
  const base = canonicalTempRoot(tempRoot);
  const supplied = resolve(workspacePath);
  let canonicalWorkspace = supplied;
  if (requireExisting) {
    try {
      canonicalWorkspace = nativeRealpath(supplied);
    } catch {
      throw new WorktreeIsolationError('workspacePath no longer exists', 'E_WORKTREE_RECOVERY');
    }
  }
  const privateRoot = dirname(canonicalWorkspace);
  if (
    !samePath(join(privateRoot, 'workspace'), canonicalWorkspace) ||
    !isChildOf(base, privateRoot) ||
    !samePath(dirname(privateRoot), base) ||
    !/^offload-worktree-[A-Za-z0-9_-]+$/.test(basename(privateRoot))
  ) {
    throw new WorktreeIsolationError('workspacePath is outside the private offload worktree layout', 'E_WORKTREE_RECOVERY');
  }
  return { workspacePath: canonicalWorkspace, privateRoot, base };
}
function assertTree(tree, name = 'baselineTree') {
  if (typeof tree !== 'string' || !TREE_ID.test(tree))
    throw new WorktreeIsolationError(`${name} must be a Git tree object id`, 'E_WORKTREE_TREE');
}
function assertTreeExists(repoPath, tree, code) {
  try {
    run(repoPath, ['cat-file', '-e', `${tree}^{tree}`], code);
  } catch {
    throw new WorktreeIsolationError('Git tree object does not exist', code);
  }
}
function treePinRef(privateRoot, name) {
  const rootName = basename(privateRoot);
  if (!/^offload-worktree-[A-Za-z0-9_-]+$/.test(rootName) || !['baseline', 'seed', 'after'].includes(name))
    throw new WorktreeIsolationError('Invalid private worktree reference', 'E_WORKTREE_PIN');
  return `refs/offload/worktrees/${rootName}/${name}`;
}
function pinTree(repoPath, ref, tree) {
  assertTree(tree, 'tree');
  try {
    run(repoPath, ['update-ref', '--create-reflog', ref, tree], 'E_WORKTREE_PIN');
  } catch (error) {
    if (error instanceof WorktreeIsolationError) throw error;
    throw new WorktreeIsolationError('Could not pin isolated worktree tree', 'E_WORKTREE_PIN');
  }
}
function pinTrees(repoPath, privateRoot, baselineTree, seedTree) {
  try {
    pinTree(repoPath, treePinRef(privateRoot, 'baseline'), baselineTree);
    pinTree(repoPath, treePinRef(privateRoot, 'seed'), seedTree);
  } catch (error) {
    // Creation is already failing for its original reason. Pin release is
    // best-effort here, unlike lifecycle cleanup where an unreleased pin must
    // remain visible and retryable to the caller.
    releaseTreePins(repoPath, privateRoot, { bestEffort: true });
    throw error;
  }
}
function assertPinnedTrees(repoPath, privateRoot, baselineTree, seedTree) {
  for (const [name, tree] of [
    ['baseline', baselineTree],
    ['seed', seedTree],
  ]) {
    let pinned;
    try {
      pinned = run(repoPath, ['rev-parse', '--verify', `${treePinRef(privateRoot, name)}^{tree}`], 'E_WORKTREE_RECOVERY').trim();
    } catch {
      throw new WorktreeIsolationError('Isolated worktree tree pin is missing', 'E_WORKTREE_RECOVERY');
    }
    if (pinned.toLowerCase() !== tree.toLowerCase())
      throw new WorktreeIsolationError('Isolated worktree tree pin does not match its persisted tree', 'E_WORKTREE_RECOVERY');
  }
}
function releaseTreePins(repoPath, privateRoot, { bestEffort = false } = {}) {
  try {
    // A release is one authority transition. Sequential deletes could remove
    // baseline then fail on seed, leaving a partial pin set that recovery
    // overlooked. This transaction removes the fixed namespace or nothing.
    runRefTransaction(
      repoPath,
      ['baseline', 'seed', 'after'].map((name) => `delete ${treePinRef(privateRoot, name)}`),
      {
        tolerateMissing: true,
        errorCode: 'E_WORKTREE_PIN',
        errorMessage: 'Could not release isolated worktree tree pins; cleanup can be retried',
      },
    );
  } catch (error) {
    if (!bestEffort) throw error;
  }
}
function hasTreePins(repoPath, privateRoot) {
  return ['baseline', 'seed', 'after'].some((name) => {
    try {
      run(repoPath, ['show-ref', '--verify', '--quiet', treePinRef(privateRoot, name)], 'E_WORKTREE_PIN');
      return true;
    } catch {
      return false;
    }
  });
}
function diffTreeFilesForPaths(repoPath, before, after, paths) {
  if (paths.length === 0) return [];
  // diffTreeFiles has no path scope because its callers normally need the
  // complete authoritative list. Use the same hardened Git helper directly,
  // with literal pathspecs sourced only from that authoritative list.
  const raw = run(
    repoPath,
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-status',
      '-z',
      before,
      after,
      '--',
      ...paths.map((path) => `:(top,literal)${safeLiteralPath(path)}`),
    ],
    'E_WORKTREE_VERIFY',
    { output: 'buffer' },
  );
  if (!Buffer.isBuffer(raw)) throw new WorktreeIsolationError('Malformed Git changed-path output', 'E_WORKTREE_VERIFY');
  const fields = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    fields.push(raw.subarray(start, index));
    start = index + 1;
  }
  if (start !== raw.length || fields.length % 2 !== 0)
    throw new WorktreeIsolationError('Malformed Git changed-path output', 'E_WORKTREE_VERIFY');
  const files = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    let status;
    let path;
    try {
      status = new TextDecoder('utf-8', { fatal: true }).decode(fields[index]);
      path = new TextDecoder('utf-8', { fatal: true }).decode(fields[index + 1]);
    } catch {
      throw new WorktreeIsolationError('Git changed-path output is not valid UTF-8', 'E_WORKTREE_VERIFY');
    }
    if (!status || !path) throw new WorktreeIsolationError('Malformed Git changed-path output', 'E_WORKTREE_VERIFY');
    files.push({ status: status[0], path });
  }
  return files;
}
function selectChangedFiles(allFiles, paths) {
  if (paths === undefined) return allFiles;
  if (!Array.isArray(paths)) throw new WorktreeIsolationError('integration paths must be an array', 'E_WORKTREE_PATH');
  const known = new Map(allFiles.map((file) => [file.path, file]));
  const selected = [];
  const seen = new Set();
  for (const path of paths) {
    try {
      safeLiteralPath(path);
    } catch {
      throw new WorktreeIsolationError('integration paths must be safe changed file paths', 'E_WORKTREE_PATH');
    }
    if (seen.has(path) || !known.has(path))
      throw new WorktreeIsolationError('integration paths must be an explicit unique subset of changed files', 'E_WORKTREE_PATH');
    seen.add(path);
    selected.push(known.get(path));
  }
  return selected;
}
function safeLiteralPath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\0') ||
    path.startsWith(':') ||
    path.startsWith('/') ||
    path.split('/').includes('..')
  )
    throw new WorktreeIsolationError('Unsafe changed path from Git', 'E_WORKTREE_VERIFY');
  // On Windows a backslash is a separator. A POSIX backslash filename cannot
  // be represented safely there, so reject rather than silently alias it.
  if (process.platform === 'win32' && path.includes('\\'))
    throw new WorktreeIsolationError('Unsafe changed path from Git', 'E_WORKTREE_VERIFY');
  return path;
}
function run(repoPath, args, code, { output = 'text', input } = {}) {
  try {
    return git(repoPath, args, {}, { output, input });
  } catch {
    throw new WorktreeIsolationError(`Git ${args[0]} failed`, code);
  }
}
function isRegisteredWorktree(primaryPath, workspacePath) {
  try {
    // Porcelain -z preserves whitespace/newlines in a worktree path and lets
    // Windows compare Git's slash/case-normalized spelling safely. A plain
    // string equality here can mistake a still-registered linked worktree
    // for an orphan and remove its private root underneath Git.
    return run(primaryPath, ['worktree', 'list', '--porcelain', '-z'], 'E_WORKTREE_RECOVERY')
      .split('\0')
      .some((field) => field.startsWith('worktree ') && samePath(field.slice('worktree '.length), workspacePath));
  } catch {
    return false;
  }
}
function commonGitDir(repoPath) {
  let common;
  try {
    common = run(repoPath, ['rev-parse', '--git-common-dir'], 'E_WORKTREE_RECOVERY').trim();
  } catch {
    throw new WorktreeIsolationError('Could not determine Git common directory', 'E_WORKTREE_RECOVERY');
  }
  try {
    return nativeRealpath(resolve(repoPath, common));
  } catch {
    throw new WorktreeIsolationError('Git common directory cannot be resolved', 'E_WORKTREE_RECOVERY');
  }
}
function isChildOf(parent, child) {
  // Canonical existing roots are preferred, but recovery also needs a safe
  // lexical answer for a missing child. Normalize the Windows slash/case
  // representation before the component-prefix check.
  const normalized = (value) => {
    const absolute = resolve(value)
      .replaceAll('\\', '/')
      .replace(/^\/\/?\?\//, '');
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const base = normalized(parent);
  const target = normalized(child);
  return target.startsWith(base.endsWith('/') ? base : `${base}/`);
}
export function sameWorktreePath(left, right, { platform = process.platform, realpath = realpathSync.native || realpathSync } = {}) {
  const canonical = (value) => {
    // Git may retain a Windows 8.3 path while Node has expanded it through
    // realpath.  Call the resolver with the supplied absolute path first:
    // resolving it before an injected/native resolver turns `/private/...`
    // into a drive-qualified path on Windows and prevents 8.3 aliases from
    // being expanded. Retain a lexical fallback for a missing recovery target.
    try {
      return realpath(value);
    } catch {
      return resolve(value);
    }
  };
  const a = canonical(left);
  const b = canonical(right);
  // Git reports forward-slash paths while Node usually returns backslashes;
  // native realpath may also add an extended-path prefix. These are all the
  // same Windows filesystem identity, not distinct cleanup targets.
  const windows = (value) =>
    value
      .replaceAll('\\', '/')
      .replace(/^\/\/?\?\//, '')
      .toLowerCase();
  return platform === 'win32' ? windows(a) === windows(b) : a === b;
}
function samePath(left, right) {
  return sameWorktreePath(left, right);
}
function privateRootIsSafe(privateRoot, base) {
  try {
    capturePrivateRoot(privateRoot, base);
    return true;
  } catch {
    return false;
  }
}
function privateRootExists(privateRoot) {
  try {
    lstatSync(privateRoot);
    return true;
  } catch {
    return false;
  }
}
function capturePrivateRoot(privateRoot, base) {
  const resolvedRoot = resolve(privateRoot);
  if (
    !base ||
    !isChildOf(base, resolvedRoot) ||
    dirname(resolvedRoot) !== base ||
    !/^offload-worktree-[A-Za-z0-9_-]+$/.test(basename(resolvedRoot))
  ) {
    throw new WorktreeIsolationError('private worktree root is outside the managed layout', 'E_WORKTREE_REMOVE');
  }
  let details;
  let canonical;
  try {
    details = lstatSync(resolvedRoot);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('not a directory');
    if (typeof process.getuid === 'function' && details.uid !== process.getuid()) throw new Error('wrong owner');
    canonical = nativeRealpath(resolvedRoot);
  } catch {
    throw new WorktreeIsolationError('private worktree root changed or is unsafe', 'E_WORKTREE_REMOVE');
  }
  if (!samePath(canonical, resolvedRoot))
    throw new WorktreeIsolationError('private worktree root changed or is unsafe', 'E_WORKTREE_REMOVE');
  return Object.freeze({ path: resolvedRoot, base, dev: details.dev, ino: details.ino, uid: details.uid, mode: details.mode & 0o777 });
}
function privateRootProofState(proof) {
  if (!proof || typeof proof !== 'object') return privateRootExists(proof?.path) ? 'changed' : 'absent';
  try {
    const current = capturePrivateRoot(proof.path, proof.base);
    return current.dev === proof.dev && current.ino === proof.ino && current.uid === proof.uid && current.mode === proof.mode
      ? 'current'
      : 'changed';
  } catch {
    return privateRootExists(proof.path) ? 'changed' : 'absent';
  }
}
function safeRemove(
  primaryPath,
  workspacePath,
  privateRoot,
  { ownPrivateRoot = false, removeOrphanRoot = false, releaseOrphanPins = false, privateBase, privateRootProof } = {},
) {
  const needsPrivateRootRemoval = () => (removed || ownPrivateRoot || removeOrphanRoot) && ownsWorkspace(privateRoot, workspacePath);
  // Do this before `git worktree remove`: a replaced private root is no
  // longer ours to recursively remove, and deleting its Git registration
  // first would make the suspicious state harder to diagnose/retry.
  const initialRootState = privateRootProofState(privateRootProof);
  if (initialRootState === 'changed' || (privateRootExists(privateRoot) && (!privateBase || !privateRootProof)))
    return { removed: false, pruned: false, retained: true, alreadyAbsent: false };
  let removed = false;
  let pruned = false;
  let registered = isRegisteredWorktree(primaryPath, workspacePath);
  const initiallyRegistered = registered;
  try {
    if (registered) {
      run(primaryPath, ['worktree', 'remove', '--force', workspacePath], 'E_WORKTREE_REMOVE');
      removed = true;
      registered = false;
    }
  } catch {
    // A linked worktree externally deleted mid-job has a stale admin entry.
    // Git offers only repository-wide prune, so invoke it only in that case.
    try {
      run(primaryPath, ['worktree', 'prune', '--expire', 'now'], 'E_WORKTREE_PRUNE');
      pruned = true;
    } catch {}
    registered = isRegisteredWorktree(primaryPath, workspacePath);
  }
  // Never remove the private directory while Git still has a live worktree
  // registration for it.  Doing so turns a recoverable removal failure into
  // a dangling worktree administration record (and can strand its files).
  if (registered) return { removed, pruned, retained: true };
  let rootRemoved = false;
  let rootRetained = false;
  try {
    const rootState = privateRootProofState(privateRootProof);
    if (rootState === 'changed') rootRetained = true;
    else if (needsPrivateRootRemoval() && rootState === 'current') {
      rmSync(privateRoot, { recursive: true, force: true });
      rootRemoved = true;
    }
  } catch {
    rootRetained = true;
  }
  if (!rootRetained && needsPrivateRootRemoval() && privateRootProofState(privateRootProof) !== 'absent') {
    try {
      lstatSync(privateRoot);
      rootRetained = true;
    } catch {}
  }
  if (rootRetained) return { removed, pruned, retained: true, alreadyAbsent: false };
  // The Git registration is gone, so no active worktree needs these roots.
  // Leaving a ref after an unsuccessful directory removal is also harmless,
  // but release it only after a managed cleanup actually removed its root.
  // A live handle has a proof for its original private root. If an external
  // actor deleted that exact root and Git pruned its stale registration, the
  // handle can safely release only its own pins even though it did not remove
  // a directory itself. A missing proof (or any replacement) never gains
  // this authority.
  const provenManagedRootAbsent = initialRootState === 'absent' && !!privateRootProof && ownsWorkspace(privateRoot, workspacePath);
  if (rootRemoved || removed || releaseOrphanPins || provenManagedRootAbsent) releaseTreePins(primaryPath, privateRoot);
  return { removed, pruned, retained: false, alreadyAbsent: !initiallyRegistered && !rootRemoved };
}
function ownsWorkspace(privateRoot, workspacePath) {
  return (
    typeof privateRoot === 'string' && typeof workspacePath === 'string' && samePath(workspacePath, join(resolve(privateRoot), 'workspace'))
  );
}
