import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  cleanupIsolatedWorktree,
  createIsolatedWorktree,
  openIsolatedWorktree,
  pinJobTrees,
  releaseJobTrees,
  snapshotPrimaryWorkingTree,
} from '../../src/worktree.mjs';
import { cleanup, git, makeRepo, write } from './helpers.mjs';

function primaryMetadata(repo) {
  return {
    index: readFileSync(join(repo, '.git', 'index')),
    head: readFileSync(join(repo, '.git', 'HEAD')),
  };
}
function assertPrimaryMetadata(repo, before) {
  assert.deepEqual(readFileSync(join(repo, '.git', 'index')), before.index, 'primary index bytes must remain exact');
  assert.deepEqual(readFileSync(join(repo, '.git', 'HEAD')), before.head, 'primary HEAD bytes must remain exact');
}
function treePinRef(workspace, name) {
  return `refs/offload/worktrees/${basename(dirname(workspace))}/${name}`;
}

test('isolated worktree is seeded from dirty and untracked baseline without touching primary metadata', () => {
  const repo = makeRepo();
  let isolated;
  try {
    write(join(repo, 'tracked.txt'), 'dirty primary\n');
    write(join(repo, 'new.txt'), 'untracked primary\n');
    const metadata = primaryMetadata(repo);
    const baseline = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    assert.equal(readFileSync(join(isolated.path, 'tracked.txt'), 'utf8'), 'dirty primary\n');
    assert.equal(readFileSync(join(isolated.path, 'new.txt'), 'utf8'), 'untracked primary\n');
    write(join(isolated.path, 'tracked.txt'), 'worker only\n');
    assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'dirty primary\n');
    assertPrimaryMetadata(repo, metadata);
  } finally {
    isolated?.cleanup();
    cleanup(repo);
  }
});

test(
  'worktree materialization neither runs repository filters nor inherits provider credentials',
  { skip: process.platform === 'win32' },
  () => {
    const repo = makeRepo();
    let isolated;
    const marker = join(repo, 'filter-ran.txt');
    const previous = process.env.OFFLOAD_PROVIDER_SECRET;
    try {
      write(join(repo, '.gitattributes'), 'payload.txt filter=offload-test\n');
      write(join(repo, 'payload.txt'), 'safe payload\n');
      git(repo, ['add', '.gitattributes', 'payload.txt']);
      git(repo, ['commit', '-m', 'add filtered payload']);
      // If read-tree/checkouts were allowed to run this command it would both
      // prove execution and expose whether an inherited provider secret was
      // available. The hardened worktree path disables all configured filters.
      git(repo, ['config', 'filter.offload-test.smudge', `sh -c 'printf %s "$OFFLOAD_PROVIDER_SECRET" > "${marker}"'`]);
      process.env.OFFLOAD_PROVIDER_SECRET = 'must-not-reach-git-child';
      const baseline = snapshotPrimaryWorkingTree(repo);
      isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
      assert.equal(readFileSync(join(isolated.path, 'payload.txt'), 'utf8'), 'safe payload\n');
      assert.equal(existsSync(marker), false);
    } finally {
      if (previous === undefined) delete process.env.OFFLOAD_PROVIDER_SECRET;
      else process.env.OFFLOAD_PROVIDER_SECRET = previous;
      isolated?.cleanup();
      cleanup(repo);
    }
  },
);

test('integration applies only worker-touched paths, preserves unrelated primary edits, and leaves index/HEAD exact', () => {
  const repo = makeRepo();
  let isolated;
  try {
    const metadata = primaryMetadata(repo);
    const baseline = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    write(join(isolated.path, 'tracked.txt'), 'worker result\n');
    write(join(isolated.path, 'worker.bin'), Buffer.from([0, 1, 2, 255, 0]));
    const after = isolated.snapshot();
    write(join(repo, 'human.txt'), 'human edit\n');
    assert.deepEqual(isolated.verifyPrimary(after).conflicts, []);
    const result = isolated.integrate(after);
    assert.equal(result.applied, true);
    assert.deepEqual(result.files.map((file) => file.path).sort(), ['tracked.txt', 'worker.bin']);
    assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'worker result\n');
    assert.equal(readFileSync(join(repo, 'human.txt'), 'utf8'), 'human edit\n');
    assert.deepEqual(readFileSync(join(repo, 'worker.bin')), Buffer.from([0, 1, 2, 255, 0]));
    assertPrimaryMetadata(repo, metadata);
  } finally {
    isolated?.cleanup();
    cleanup(repo);
  }
});

test('integration preserves a non-NUL invalid UTF-8 text patch byte-for-byte', () => {
  const repo = makeRepo();
  let isolated;
  try {
    const baseline = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    const expected = Buffer.from([0x74, 0x65, 0x78, 0x74, 0x2d, 0xff, 0x0a]);
    write(join(isolated.path, 'tracked.txt'), expected);
    const after = isolated.snapshot();
    const change = isolated.changes(after);
    assert.ok(Buffer.isBuffer(change.patch));
    assert.ok(change.patch.includes(Buffer.from([0xff])));
    assert.equal(isolated.integrate(after).applied, true);
    assert.deepEqual(readFileSync(join(repo, 'tracked.txt')), expected);
  } finally {
    isolated?.cleanup();
    cleanup(repo);
  }
});

test('primary edits on an exact worker-touched path block integration', () => {
  const repo = makeRepo();
  let isolated;
  try {
    const baseline = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    write(join(isolated.path, 'tracked.txt'), 'worker result\n');
    const after = isolated.snapshot();
    write(join(repo, 'tracked.txt'), 'human result\n');
    const verification = isolated.verifyPrimary(after);
    assert.equal(verification.ok, false);
    assert.deepEqual(verification.conflicts, [{ path: 'tracked.txt', status: 'M' }]);
    assert.throws(
      () => isolated.integrate(after),
      (error) => error.code === 'E_WORKTREE_CONFLICT',
    );
    assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'human result\n');
  } finally {
    isolated?.cleanup();
    cleanup(repo);
  }
});

test('path-filtered integration applies only its explicit changed-file subset and detects only selected conflicts', () => {
  const repo = makeRepo();
  let isolated;
  let conflicting;
  try {
    write(join(repo, 'extra.txt'), 'base extra\n');
    git(repo, ['add', 'extra.txt']);
    git(repo, ['commit', '-m', 'add extra']);
    const baseline = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    write(join(isolated.path, 'tracked.txt'), 'owned result\n');
    write(join(isolated.path, 'extra.txt'), 'ephemeral result\n');
    const after = isolated.snapshot();
    // This is a concurrent change to a worker-touched file, but that file is
    // intentionally outside the owned subset being integrated.
    write(join(repo, 'extra.txt'), 'human extra\n');
    assert.equal(isolated.verifyPrimary(after, { paths: ['tracked.txt'] }).ok, true);
    const result = isolated.integrate(after, { paths: ['tracked.txt'] });
    assert.deepEqual(result.files, [{ path: 'tracked.txt', status: 'M' }]);
    assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'owned result\n');
    assert.equal(readFileSync(join(repo, 'extra.txt'), 'utf8'), 'human extra\n');
    assert.throws(
      () => isolated.integrate(after, { paths: ['extra.txt', 'extra.txt'] }),
      (error) => error.code === 'E_WORKTREE_PATH',
    );
    assert.throws(
      () => isolated.integrate(after, { paths: ['missing.txt'] }),
      (error) => error.code === 'E_WORKTREE_PATH',
    );
    assert.throws(
      () => isolated.integrate(after, { paths: [':not-a-path'] }),
      (error) => error.code === 'E_WORKTREE_PATH',
    );

    const nextBaseline = snapshotPrimaryWorkingTree(repo);
    conflicting = createIsolatedWorktree({ repoPath: repo, baselineTree: nextBaseline });
    write(join(conflicting.path, 'tracked.txt'), 'conflicting worker result\n');
    write(join(conflicting.path, 'extra.txt'), 'never integrate this\n');
    const nextAfter = conflicting.snapshot();
    write(join(repo, 'tracked.txt'), 'human tracked\n');
    assert.equal(conflicting.verifyPrimary(nextAfter, { paths: ['tracked.txt'] }).ok, false);
    assert.throws(
      () => conflicting.integrate(nextAfter, { paths: ['tracked.txt'] }),
      (error) => error.code === 'E_WORKTREE_CONFLICT',
    );
    assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'human tracked\n');
    assert.equal(readFileSync(join(repo, 'extra.txt'), 'utf8'), 'human extra\n');
  } finally {
    conflicting?.cleanup();
    isolated?.cleanup();
    cleanup(repo);
  }
});

test('ignored workspace output is audited and cleanup removes its Git worktree administration idempotently', () => {
  const repo = makeRepo();
  let isolated;
  try {
    write(join(repo, '.gitignore'), 'generated/\nignored.log\n');
    const baseline = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    write(join(isolated.path, 'generated', 'output.txt'), 'generated\n');
    write(join(isolated.path, 'ignored.log'), 'log\n');
    assert.deepEqual(isolated.ignoredPaths().sort(), ['generated/output.txt', 'ignored.log']);
    const workspace = isolated.path;
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).includes(`worktree ${workspace}`), true);
    const first = isolated.cleanup();
    assert.equal(first.removed, true);
    assert.equal(existsSync(workspace), false);
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).includes(`worktree ${workspace}`), false);
    assert.deepEqual(isolated.cleanup(), { removed: false, pruned: false, alreadyAbsent: true, cleaned: true });
    isolated = undefined;
  } finally {
    isolated?.cleanup();
    cleanup(repo);
  }
});

test('active worktree tree pins survive aggressive Git GC and are released with the workspace', () => {
  const repo = makeRepo();
  let isolated;
  try {
    write(join(repo, 'tracked.txt'), 'uncommitted baseline\n');
    const baseline = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    assert.equal(git(repo, ['rev-parse', '--verify', `${treePinRef(isolated.path, 'baseline')}^{tree}`]), baseline);
    assert.equal(git(repo, ['rev-parse', '--verify', `${treePinRef(isolated.path, 'seed')}^{tree}`]), baseline);
    git(repo, ['gc', '--prune=now']);
    assert.equal(git(repo, ['cat-file', '-e', `${baseline}^{tree}`]), '');
    write(join(isolated.path, 'tracked.txt'), 'worker snapshot\n');
    const after = isolated.snapshot();
    assert.equal(git(repo, ['rev-parse', '--verify', `${treePinRef(isolated.path, 'after')}^{tree}`]), after);
    const workspace = isolated.path;
    isolated.cleanup();
    isolated = undefined;
    assert.throws(() => git(repo, ['rev-parse', '--verify', `${treePinRef(workspace, 'baseline')}^{tree}`]));
    assert.throws(() => git(repo, ['rev-parse', '--verify', `${treePinRef(workspace, 'after')}^{tree}`]));
  } finally {
    isolated?.cleanup();
    cleanup(repo);
  }
});

test('a vanished proven private root releases active pins after stale registration pruning', () => {
  const repo = makeRepo();
  let isolated;
  try {
    const baseline = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    const workspace = isolated.path;
    const pin = treePinRef(workspace, 'baseline');
    rmSync(dirname(workspace), { recursive: true, force: true });
    const result = isolated.cleanup();
    assert.equal(result.cleaned, true);
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).includes(`worktree ${workspace}`), false);
    assert.throws(() => git(repo, ['rev-parse', '--verify', `${pin}^{tree}`]));
    isolated = undefined;
  } finally {
    isolated?.cleanup();
    cleanup(repo);
  }
});

test('a mid-release pin failure leaves every pin visible and cleanup retryable', () => {
  const repo = makeRepo();
  let isolated;
  let lock;
  try {
    const baseline = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    const after = isolated.snapshot();
    const baselinePin = treePinRef(isolated.path, 'baseline');
    const seedPin = treePinRef(isolated.path, 'seed');
    const afterPin = treePinRef(isolated.path, 'after');
    // This is deliberately the second sequential ref from the old cleanup
    // loop. A lock here used to erase baseline before reporting a retry.
    lock = join(repo, '.git', `${seedPin}.lock`);
    mkdirSync(dirname(lock), { recursive: true });
    write(lock, 'lock\n');
    assert.throws(
      () => isolated.cleanup(),
      (error) => error.code === 'E_WORKTREE_PIN',
    );
    assert.equal(git(repo, ['rev-parse', '--verify', `${baselinePin}^{tree}`]), baseline, 'a failed transaction must retain baseline');
    assert.equal(git(repo, ['rev-parse', '--verify', `${seedPin}^{tree}`]), baseline, 'a failed transaction must retain seed');
    assert.equal(git(repo, ['rev-parse', '--verify', `${afterPin}^{tree}`]), after, 'a failed transaction must retain after');
    rmSync(lock, { force: true });
    assert.equal(isolated.cleanup().cleaned, true, 'a live handle can retry exact pin release');
    for (const pin of [baselinePin, seedPin, afterPin]) assert.throws(() => git(repo, ['rev-parse', '--verify', `${pin}^{tree}`]));
    isolated = undefined;
  } finally {
    if (lock) rmSync(lock, { force: true });
    isolated?.cleanup();
    cleanup(repo);
  }
});

test('durable job tree pins survive GC, are transactional, and cannot affect another job namespace', () => {
  const repo = makeRepo();
  try {
    write(join(repo, 'tracked.txt'), 'durable before\n');
    const before = snapshotPrimaryWorkingTree(repo);
    write(join(repo, 'tracked.txt'), 'durable after\n');
    const workspaceAfter = snapshotPrimaryWorkingTree(repo);
    const first = pinJobTrees({ repoPath: repo, jobId: 'job_A-1', trees: { before, workspaceAfter } });
    pinJobTrees({ repoPath: repo, jobId: 'job_B-2', trees: { before } });
    assert.equal(git(repo, ['rev-parse', '--verify', `${first.before.ref}^{tree}`]), before);
    assert.equal(git(repo, ['rev-parse', '--verify', `${first.workspaceAfter.ref}^{tree}`]), workspaceAfter);
    git(repo, ['gc', '--prune=now']);
    assert.equal(git(repo, ['cat-file', '-e', `${workspaceAfter}^{tree}`]), '');
    assert.deepEqual(releaseJobTrees({ repoPath: repo, jobId: 'job_A-1' }).released.sort(), [
      'refs/offload/jobs/job_A-1/before',
      'refs/offload/jobs/job_A-1/primaryAfter',
      'refs/offload/jobs/job_A-1/workerAfter',
      'refs/offload/jobs/job_A-1/workspaceAfter',
    ]);
    assert.throws(() => git(repo, ['rev-parse', '--verify', `${first.before.ref}^{tree}`]));
    assert.equal(git(repo, ['rev-parse', '--verify', 'refs/offload/jobs/job_B-2/before^{tree}']), before);
    assert.throws(
      () => pinJobTrees({ repoPath: repo, jobId: '../other', trees: { before } }),
      (error) => error.code === 'E_WORKTREE_JOB_REF',
    );
    assert.throws(
      () => pinJobTrees({ repoPath: repo, jobId: 'job_C', trees: { before, arbitrary: workspaceAfter } }),
      (error) => error.code === 'E_WORKTREE_JOB_REF',
    );
    releaseJobTrees({ repoPath: repo, jobId: 'job_B-2' });
  } finally {
    cleanup(repo);
  }
});

test('a failed cleanup remains retryable and never removes a still-registered locked worktree', () => {
  const repo = makeRepo();
  let isolated;
  try {
    const baseline = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    git(repo, ['worktree', 'lock', '--reason', 'test lock', isolated.path]);
    assert.throws(
      () => isolated.cleanup(),
      (error) => error.code === 'E_WORKTREE_REMOVE',
    );
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).includes(`worktree ${isolated.path}`), true);
    // The handle was deliberately left open, so callers can clear a transient
    // external lock and retry rather than leaking a registered worktree.
    assert.equal(isolated.snapshot().length, 40);
    git(repo, ['worktree', 'unlock', isolated.path]);
    assert.deepEqual(isolated.cleanup(), { removed: true, pruned: false, alreadyAbsent: false, cleaned: true });
    isolated = undefined;
  } finally {
    isolated?.cleanup();
    cleanup(repo);
  }
});

test('cleanup retains a private-root replacement instead of recursively removing it', () => {
  const repo = makeRepo();
  let isolated;
  let originalRoot;
  let replacementRoot;
  try {
    const baseline = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    originalRoot = dirname(isolated.path);
    replacementRoot = `${originalRoot}-saved`;
    renameSync(originalRoot, replacementRoot);
    mkdirSync(originalRoot, { mode: 0o700 });
    write(join(originalRoot, 'must-not-delete.txt'), 'replacement\n');
    assert.throws(
      () => isolated.cleanup(),
      (error) => error.code === 'E_WORKTREE_REMOVE',
    );
    assert.equal(existsSync(join(originalRoot, 'must-not-delete.txt')), true);
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).includes(`worktree ${isolated.path}`), true);
    rmSync(originalRoot, { recursive: true, force: true });
    renameSync(replacementRoot, originalRoot);
    assert.equal(isolated.cleanup().removed, true);
    isolated = undefined;
  } finally {
    isolated?.cleanup();
    if (replacementRoot && existsSync(replacementRoot) && !existsSync(originalRoot)) renameSync(replacementRoot, originalRoot);
    cleanup(repo);
  }
});

test('worktree creation rejects non-tree baselines before creating a workspace', () => {
  const repo = makeRepo();
  try {
    assert.throws(
      () => createIsolatedWorktree({ repoPath: repo, baselineTree: '--bad' }),
      (error) => error.code === 'E_WORKTREE_TREE',
    );
    assert.throws(
      () => createIsolatedWorktree({ repoPath: repo, baselineTree: '0'.repeat(40) }),
      (error) => error.code === 'E_WORKTREE_BASELINE',
    );
    const baseline = snapshotPrimaryWorkingTree(repo);
    assert.throws(
      () => createIsolatedWorktree({ repoPath: repo, baselineTree: baseline, seedTree: '--bad' }),
      (error) => error.code === 'E_WORKTREE_TREE',
    );
    assert.throws(
      () => createIsolatedWorktree({ repoPath: repo, baselineTree: baseline, seedTree: '0'.repeat(40) }),
      (error) => error.code === 'E_WORKTREE_SEED',
    );
  } finally {
    cleanup(repo);
  }
});

test('a distinct seed tree populates the workspace while comparisons and integration retain the original baseline', () => {
  const repo = makeRepo();
  let isolated;
  let reopened;
  try {
    write(join(repo, 'tracked.txt'), 'original baseline\n');
    const baseline = snapshotPrimaryWorkingTree(repo);
    write(join(repo, 'tracked.txt'), 'manual repair seed\n');
    const seed = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline, seedTree: seed });
    assert.equal(isolated.seedTree, seed);
    assert.equal(readFileSync(join(isolated.path, 'tracked.txt'), 'utf8'), 'manual repair seed\n');
    write(join(isolated.path, 'tracked.txt'), 'final accumulated result\n');
    reopened = openIsolatedWorktree({ repoPath: repo, workspacePath: isolated.path, baselineTree: baseline, seedTree: seed });
    assert.equal(reopened.seedTree, seed);
    const after = reopened.snapshot();
    const change = reopened.changes(after);
    assert.deepEqual(change.files, [{ path: 'tracked.txt', status: 'M' }]);
    assert.ok(Buffer.isBuffer(change.patch));
    assert.match(change.patch.toString('utf8'), /-original baseline/);
    assert.match(change.patch.toString('utf8'), /\+final accumulated result/);
    // The primary still has the repair seed, which differs from the original
    // baseline. This confirms conflict checks did not switch to seedTree.
    assert.equal(reopened.verifyPrimary(after).ok, false);
    write(join(repo, 'tracked.txt'), 'original baseline\n');
    assert.equal(reopened.verifyPrimary(after).ok, true);
    assert.equal(reopened.integrate(after).applied, true);
    assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'final accumulated result\n');
  } finally {
    reopened?.cleanup();
    isolated?.cleanup();
    cleanup(repo);
  }
});

test('a persisted isolated worktree can be reopened and integrated through a fresh handle', () => {
  const repo = makeRepo();
  let created;
  let reopened;
  try {
    const baseline = snapshotPrimaryWorkingTree(repo);
    created = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    write(join(created.path, 'tracked.txt'), 'reopened worker result\n');
    const after = created.snapshot();
    reopened = openIsolatedWorktree({ repoPath: repo, workspacePath: created.path, baselineTree: baseline, seedTree: baseline });
    assert.equal(reopened.path, created.path);
    assert.deepEqual(reopened.changes(after).files, [{ path: 'tracked.txt', status: 'M' }]);
    write(join(repo, 'human.txt'), 'unrelated human edit\n');
    assert.equal(reopened.integrate(after).applied, true);
    assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'reopened worker result\n');
    assert.equal(readFileSync(join(repo, 'human.txt'), 'utf8'), 'unrelated human edit\n');
  } finally {
    reopened?.cleanup();
    created?.cleanup();
    cleanup(repo);
  }
});

test('reopen rejects outside and unregistered paths, while recovery cleanup is path-safe and idempotent', () => {
  const repo = makeRepo();
  let isolated;
  let unregistered;
  try {
    const baseline = snapshotPrimaryWorkingTree(repo);
    assert.throws(
      () => openIsolatedWorktree({ repoPath: repo, workspacePath: repo, baselineTree: baseline }),
      (error) => error.code === 'E_WORKTREE_RECOVERY',
    );
    unregistered = mkdtempSync(join(tmpdir(), 'offload-worktree-unregistered-'));
    mkdirSync(join(unregistered, 'workspace'));
    assert.throws(
      () => openIsolatedWorktree({ repoPath: repo, workspacePath: join(unregistered, 'workspace'), baselineTree: baseline }),
      (error) => error.code === 'E_WORKTREE_RECOVERY',
    );
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    const workspace = isolated.path;
    assert.deepEqual(cleanupIsolatedWorktree({ repoPath: repo, workspacePath: workspace }), {
      removed: true,
      pruned: false,
      alreadyAbsent: false,
      cleaned: true,
    });
    assert.equal(existsSync(workspace), false);
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).includes(`worktree ${workspace}`), false);
    assert.deepEqual(cleanupIsolatedWorktree({ repoPath: repo, workspacePath: workspace }), {
      removed: false,
      pruned: false,
      alreadyAbsent: true,
      cleaned: true,
    });
    isolated = undefined;
  } finally {
    isolated?.cleanup();
    if (unregistered) rmSync(unregistered, { recursive: true, force: true });
    cleanup(repo);
  }
});

test('allocator and recovery cleanup never follow arbitrary paths, but remove a safe orphan root after Git prune', () => {
  const repo = makeRepo();
  let isolated;
  let target;
  try {
    const baseline = snapshotPrimaryWorkingTree(repo);
    target = mkdtempSync(join(tmpdir(), 'offload-unrelated-target-'));
    write(join(target, 'keep.txt'), 'must survive\n');
    assert.throws(
      () => createIsolatedWorktree({ repoPath: repo, baselineTree: baseline, mkdtemp: () => target }),
      (error) => error.code === 'E_WORKTREE_TEMP',
    );
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'must survive\n');

    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    const workspace = isolated.path;
    const privateRoot = dirname(workspace);
    rmSync(workspace, { recursive: true, force: true });
    git(repo, ['worktree', 'prune', '--expire', 'now']);
    assert.deepEqual(cleanupIsolatedWorktree({ repoPath: repo, workspacePath: workspace }), {
      removed: false,
      pruned: false,
      alreadyAbsent: false,
      cleaned: true,
    });
    assert.equal(existsSync(privateRoot), false);
    assert.throws(() => git(repo, ['rev-parse', '--verify', `${treePinRef(workspace, 'baseline')}^{tree}`]));
    isolated = undefined;
  } finally {
    isolated?.cleanup();
    if (target) rmSync(target, { recursive: true, force: true });
    cleanup(repo);
  }
});
