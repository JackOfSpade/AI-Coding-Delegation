import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  cleanupIsolatedWorktree,
  createIsolatedWorktree,
  integrateRecordedTree,
  isolatedDependencyReadPaths,
  verifierDependencyStatus,
  openIsolatedWorktree,
  pinJobTrees,
  releaseJobTrees,
  sameWorktreePath,
  snapshotPrimaryWorkingTree,
  workingTreeStatus,
} from '../../src/worktree.mjs';
import { runCommand, sandboxAvailable } from '../../src/sandbox.mjs';
import { cleanup, git, makeRepo, tempDir, write } from './helpers.mjs';

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
function registeredWorktree(repo, workspace) {
  return git(repo, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .some((field) => field.startsWith('worktree ') && sameWorktreePath(field.slice('worktree '.length), workspace));
}

test('worktree path equality resolves Windows short-name aliases before case folding', () => {
  const realpath = (value) => value.replace('/private/tmp/OFFLOA~1/workspace', '/private/tmp/offload-worktree-abcdef/workspace');
  assert.equal(
    sameWorktreePath('/private/tmp/OFFLOA~1/workspace', '/private/tmp/offload-worktree-abcdef/workspace', {
      platform: 'win32',
      realpath,
    }),
    true,
  );
  assert.equal(
    sameWorktreePath('/private/tmp/OFFLOA~1/workspace', '/private/tmp/offload-worktree-other/workspace', { platform: 'win32', realpath }),
    false,
  );
});

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
    assert.equal(registeredWorktree(repo, workspace), true);
    const first = isolated.cleanup();
    assert.equal(first.removed, true);
    assert.equal(existsSync(workspace), false);
    assert.equal(registeredWorktree(repo, workspace), false);
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
    assert.equal(registeredWorktree(repo, isolated.path), true);
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
    assert.equal(registeredWorktree(repo, isolated.path), true);
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
    assert.equal(registeredWorktree(repo, workspace), false);
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

// Dependencies live in a gitignored node_modules that a Git worktree never
// contains. The server links the primary's directory beside (not inside) the
// worktree so Node's upward resolution finds it.
function repoWithDependency() {
  const repo = makeRepo();
  write(join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, ['add', '.gitignore']);
  git(repo, ['commit', '-m', 'ignore deps']);
  write(join(repo, 'node_modules', 'dep-pkg', 'package.json'), '{"name":"dep-pkg","version":"1.0.0","main":"index.js"}\n');
  write(join(repo, 'node_modules', 'dep-pkg', 'index.js'), 'module.exports = "from-primary-deps";\n');
  return repo;
}

test('a private worktree resolves the primary node_modules through a link beside it, invisible to Git and scope checks', () => {
  const repo = repoWithDependency();
  let isolated;
  try {
    const baseline = snapshotPrimaryWorkingTree(repo);
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: baseline });
    assert.equal(isolated.dependencies.nodeModules, 'linked');
    const link = join(dirname(isolated.path), 'node_modules');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(realpathSync(link), realpathSync(join(repo, 'node_modules')));
    assert.equal(existsSync(join(isolated.path, 'node_modules')), false, 'the workspace itself stays free of dependencies');
    assert.deepEqual(isolatedDependencyReadPaths(isolated.path, repo), [realpathSync(join(repo, 'node_modules'))]);
    // Neither the snapshot, the changed-file list, nor ignored-output accounting sees the link.
    assert.deepEqual(isolated.changes(isolated.snapshot()).files, []);
    assert.deepEqual(isolated.ignoredPaths(), []);
    // Reopening a persisted worktree reports the same state.
    assert.equal(
      openIsolatedWorktree({ repoPath: repo, workspacePath: isolated.path, baselineTree: baseline }).dependencies.nodeModules,
      'linked',
    );
  } finally {
    isolated?.cleanup();
    cleanup(repo);
  }
});

test('cleanup removes the dependency link without touching the primary node_modules', () => {
  const repo = repoWithDependency();
  try {
    const isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: snapshotPrimaryWorkingTree(repo) });
    const privateRoot = dirname(isolated.path);
    isolated.cleanup();
    assert.equal(existsSync(privateRoot), false);
    assert.equal(readFileSync(join(repo, 'node_modules', 'dep-pkg', 'index.js'), 'utf8'), 'module.exports = "from-primary-deps";\n');
  } finally {
    cleanup(repo);
  }
});

test('no dependency link is made for an absent, symlinked, or tracked node_modules', () => {
  for (const [setup, expected] of [
    [() => {}, 'absent'],
    [
      (repo, outside) => {
        write(join(outside, 'secret.txt'), 'host file\n');
        symlinkSync(outside, join(repo, 'node_modules'), 'dir');
      },
      'not-a-directory',
    ],
    [
      (repo) => {
        write(join(repo, 'node_modules', 'tracked', 'index.js'), 'x\n');
        git(repo, ['add', '-f', 'node_modules']);
        git(repo, ['commit', '-m', 'track deps']);
      },
      'tracked',
    ],
  ]) {
    const repo = makeRepo();
    const outside = tempDir('offload-outside-');
    let isolated;
    try {
      setup(repo, outside);
      isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: snapshotPrimaryWorkingTree(repo) });
      assert.equal(isolated.dependencies.nodeModules, expected);
      assert.equal(
        existsSync(join(dirname(isolated.path), 'node_modules')) &&
          lstatSync(join(dirname(isolated.path), 'node_modules')).isSymbolicLink(),
        false,
      );
      assert.deepEqual(isolatedDependencyReadPaths(isolated.path, repo), []);
    } finally {
      isolated?.cleanup();
      cleanup(repo);
      cleanup(outside);
    }
  }
});

test('a retargeted or replaced dependency link grants no read path', () => {
  const repo = repoWithDependency();
  const outside = tempDir('offload-outside-');
  let isolated;
  try {
    isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: snapshotPrimaryWorkingTree(repo) });
    const link = join(dirname(isolated.path), 'node_modules');
    assert.equal(isolatedDependencyReadPaths(isolated.path, repo).length, 1);
    rmSync(link);
    symlinkSync(outside, link, 'dir');
    assert.equal(readlinkSync(link), outside);
    assert.deepEqual(isolatedDependencyReadPaths(isolated.path, repo), [], 'a link to anything but the primary node_modules is ignored');
    rmSync(link);
    assert.deepEqual(isolatedDependencyReadPaths(isolated.path, repo), []);
    assert.deepEqual(isolatedDependencyReadPaths(isolated.path, join(outside, 'not-a-repo')), []);
    assert.deepEqual(isolatedDependencyReadPaths('relative/workspace', repo), []);
  } finally {
    isolated?.cleanup();
    cleanup(repo);
    cleanup(outside);
  }
});

test(
  'a sandboxed command in the worktree imports a primary dependency, read-only, and cannot reach other host files',
  { skip: process.platform !== 'darwin' || !sandboxAvailable() },
  async () => {
    const repo = repoWithDependency();
    const outside = tempDir('offload-outside-');
    let isolated;
    try {
      write(join(outside, 'host.txt'), 'host secret\n');
      for (const secret of ['.npmrc', '.env', 'k.pem', '.cache/c.txt', 'nested/.ssh/id_rsa'])
        write(join(repo, 'node_modules', 'dep-pkg', secret), 'TOKEN=abc\n');
      write(join(repo, 'node_modules', 'dep-pkg', 'lib', 'credentials', 'index.js'), 'module.exports = "credentials-module";\n');
      write(join(repo, 'probe.cjs'), 'process.stdout.write(require("dep-pkg"));\n');
      git(repo, ['add', 'probe.cjs']);
      git(repo, ['commit', '-m', 'probe']);
      isolated = createIsolatedWorktree({ repoPath: repo, baselineTree: snapshotPrimaryWorkingTree(repo) });
      const readablePaths = [dirname(isolated.path), ...isolatedDependencyReadPaths(isolated.path, repo)];
      const options = {
        cwd: isolated.path,
        gitDir: join(repo, '.git', 'worktrees', basename(git(isolated.path, ['rev-parse', '--git-dir']))),
        readablePaths,
        requireSandbox: true,
        timeoutSec: 30,
      };
      const imported = await runCommand(`${process.execPath} probe.cjs`, options);
      assert.equal(imported.sandbox, 'macos');
      assert.equal(imported.code, 0, imported.stderr);
      assert.equal(imported.stdout, 'from-primary-deps');
      const writeAttempt = await runCommand(
        `${process.execPath} -e "require('fs').writeFileSync(require.resolve('dep-pkg'), 'tampered')"`,
        options,
      );
      assert.notEqual(writeAttempt.code, 0, 'dependencies are read-only');
      assert.equal(readFileSync(join(repo, 'node_modules', 'dep-pkg', 'index.js'), 'utf8'), 'module.exports = "from-primary-deps";\n');
      const hostRead = await runCommand(`cat ${JSON.stringify(join(outside, 'host.txt'))}`, options);
      assert.notEqual(hostRead.code, 0, 'the extra read root is only the dependency directory');
      for (const secret of ['.npmrc', '.env', 'k.pem', '.cache/c.txt', 'nested/.ssh/id_rsa']) {
        const read = await runCommand(`cat ../node_modules/dep-pkg/${secret}`, options);
        assert.notEqual(read.code, 0, `credential-shaped dependency file ${secret} must stay unreadable`);
        assert.doesNotMatch(read.stdout, /TOKEN=abc/);
      }
      const credentialsModule = await runCommand(`${process.execPath} -p "require('dep-pkg/lib/credentials')"`, options);
      assert.equal(credentialsModule.code, 0, credentialsModule.stderr);
      assert.equal(credentialsModule.stdout.trim(), 'credentials-module', 'a credentials directory of module code remains importable');
      // Without the grant the very same import fails: this is the bug being fixed.
      const withoutGrant = await runCommand(`${process.execPath} probe.cjs`, { ...options, readablePaths: [dirname(isolated.path)] });
      assert.notEqual(withoutGrant.code, 0);
    } finally {
      isolated?.cleanup();
      cleanup(repo);
      cleanup(outside);
    }
  },
);

test('verifierDependencyStatus tells a primary, before it spends budget, whether a verifier can resolve dependencies', () => {
  const repo = makeRepo();
  try {
    // Not a JavaScript project: nothing to resolve.
    assert.deepEqual(verifierDependencyStatus(repo), { verifierDeps: 'not-applicable' });
    // A manifest without installed dependencies cannot pass a test that imports one.
    write(join(repo, 'package.json'), '{"name":"x"}\n');
    write(join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'manifest']);
    assert.deepEqual(verifierDependencyStatus(repo), { verifierDeps: 'missing', reason: 'absent' });
    // Installed: linkable.
    write(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    assert.deepEqual(verifierDependencyStatus(repo), { verifierDeps: 'ok' });
    // Nested node_modules (workspace sub-packages) are NOT mounted: say so rather than claim ok.
    write(join(repo, 'packages', 'a', 'node_modules', 'only-here', 'index.js'), 'module.exports = 2;\n');
    write(join(repo, 'packages', 'b', 'node_modules', 'other', 'index.js'), 'module.exports = 3;\n');
    const partial = verifierDependencyStatus(repo);
    assert.equal(partial.verifierDeps, 'partial');
    assert.equal(partial.reason, 'nested-node-modules');
    assert.deepEqual(partial.nested.sort(), ['packages/a/node_modules', 'packages/b/node_modules']);
    assert.equal(partial.nestedCount, 2);
    // Never an arbitrary host path: a symlinked node_modules is refused, not followed.
    rmSync(join(repo, 'packages'), { recursive: true });
    const elsewhere = tempDir('offload-deps-target-');
    try {
      rmSync(join(repo, 'node_modules'), { recursive: true });
      symlinkSync(elsewhere, join(repo, 'node_modules'));
      assert.deepEqual(verifierDependencyStatus(repo), { verifierDeps: 'missing', reason: 'not-a-directory' });
    } finally {
      cleanup(elsewhere);
    }
    assert.deepEqual(verifierDependencyStatus('/definitely/not/a/repo'), { verifierDeps: 'missing', reason: 'unresolvable' });
    assert.deepEqual(verifierDependencyStatus('relative'), { verifierDeps: 'missing', reason: 'unresolvable' });
  } finally {
    cleanup(repo);
  }
});

test('tracked dependencies are already in the worktree and count as resolvable', () => {
  const repo = makeRepo();
  try {
    write(join(repo, 'package.json'), '{"name":"x"}\n');
    write(join(repo, 'node_modules', 'vendored', 'index.js'), 'module.exports = 1;\n');
    git(repo, ['add', '-f', '.']);
    git(repo, ['commit', '-m', 'vendored']);
    assert.deepEqual(verifierDependencyStatus(repo), { verifierDeps: 'ok' });
  } finally {
    cleanup(repo);
  }
});

test('integrateRecordedTree applies a recorded result to the primary with the in-job conflict checks', () => {
  const repo = makeRepo();
  try {
    write(join(repo, 'src', 'a.txt'), 'one\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'src']);
    const baselineTree = snapshotPrimaryWorkingTree(repo);
    const isolated = createIsolatedWorktree({ repoPath: repo, baselineTree });
    let afterTree;
    try {
      write(join(isolated.path, 'src', 'a.txt'), 'two\n');
      write(join(isolated.path, 'src', 'new.txt'), 'new\n');
      write(join(isolated.path, 'elsewhere.txt'), 'outside the selected paths\n');
      afterTree = isolated.snapshot();
    } finally {
      isolated.cleanup();
    }
    const paths = ['src/a.txt', 'src/new.txt'];
    // The worktree is gone; the recorded trees are still addressable.
    const dry = integrateRecordedTree({ repoPath: repo, baselineTree, afterTree, paths, dryRun: true });
    assert.deepEqual({ applied: dry.applied, dryRun: dry.dryRun }, { applied: false, dryRun: true });
    assert.deepEqual(dry.files.map((file) => file.path).sort(), paths);
    assert.equal(readFileSync(join(repo, 'src', 'a.txt'), 'utf8'), 'one\n', 'a dry run changes nothing');
    assert.equal(existsSync(join(repo, 'src', 'new.txt')), false);
    // Unrelated primary edits do not conflict; an edit to a touched path does.
    write(join(repo, 'unrelated.txt'), 'mine\n');
    write(join(repo, 'src', 'a.txt'), 'primary edit\n');
    assert.throws(
      () => integrateRecordedTree({ repoPath: repo, baselineTree, afterTree, paths }),
      (error) => error.code === 'E_WORKTREE_CONFLICT',
    );
    assert.throws(
      () => integrateRecordedTree({ repoPath: repo, baselineTree, afterTree, paths, dryRun: true }),
      (error) => error.code === 'E_WORKTREE_CONFLICT',
    );
    assert.equal(readFileSync(join(repo, 'src', 'a.txt'), 'utf8'), 'primary edit\n');
    assert.equal(existsSync(join(repo, 'src', 'new.txt')), false);
    write(join(repo, 'src', 'a.txt'), 'one\n');
    const applied = integrateRecordedTree({ repoPath: repo, baselineTree, afterTree, paths });
    assert.equal(applied.applied, true);
    assert.equal(readFileSync(join(repo, 'src', 'a.txt'), 'utf8'), 'two\n');
    assert.equal(readFileSync(join(repo, 'src', 'new.txt'), 'utf8'), 'new\n');
    assert.equal(existsSync(join(repo, 'elsewhere.txt')), false, 'only the selected paths may land');
    assert.equal(readFileSync(join(repo, 'unrelated.txt'), 'utf8'), 'mine\n');
    assert.equal(git(repo, ['diff', '--cached', '--name-only']), '', 'the primary index is never touched');
  } finally {
    cleanup(repo);
  }
});

test('integrateRecordedTree refuses malformed input before touching the primary', () => {
  const repo = makeRepo();
  try {
    const tree = snapshotPrimaryWorkingTree(repo);
    for (const input of [
      { repoPath: repo, baselineTree: tree, afterTree: tree },
      { repoPath: repo, baselineTree: tree, afterTree: tree, paths: [] },
      { repoPath: repo, baselineTree: 'nope', afterTree: tree, paths: ['a'] },
      { repoPath: repo, baselineTree: tree, afterTree: 'nope', paths: ['a'] },
      { repoPath: repo, baselineTree: tree, afterTree: 'f'.repeat(40), paths: ['a'] },
      { repoPath: 'relative', baselineTree: tree, afterTree: tree, paths: ['a'] },
      { repoPath: tmpdir(), baselineTree: tree, afterTree: tree, paths: ['a'] },
    ])
      assert.throws(() => integrateRecordedTree(input), /E_WORKTREE|must be|required|Git/);
  } finally {
    cleanup(repo);
  }
});

test('workingTreeStatus reports a clean checkout with exact zero counts', () => {
  const repo = makeRepo();
  try {
    assert.deepEqual(workingTreeStatus(repo), { clean: true, changed: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0, sample: [] });
  } finally {
    cleanup(repo);
  }
});

test('workingTreeStatus counts staged, modified, untracked, renamed and deleted entries once each and ignores gitignored files', () => {
  const repo = makeRepo();
  try {
    for (const name of ['b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']) write(join(repo, name), `${name}\n`);
    write(join(repo, '.gitignore'), 'ignored.log\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'more files']);
    write(join(repo, 'tracked.txt'), 'unstaged edit\n'); // modified, unstaged
    write(join(repo, 'b.txt'), 'staged edit\n');
    git(repo, ['add', 'b.txt']); // staged
    git(repo, ['rm', '--cached', 'c.txt']); // staged deletion; the file stays as untracked
    git(repo, ['mv', 'd.txt', 'd-renamed.txt']); // one rename entry, not two
    rmSync(join(repo, 'e.txt')); // unstaged deletion
    write(join(repo, 'new.txt'), 'new\n'); // untracked
    write(join(repo, 'newdir', 'one.txt'), '1\n'); // a wholly untracked directory is one entry
    write(join(repo, 'newdir', 'two.txt'), '2\n');
    write(join(repo, 'newdir', 'three.txt'), '3\n');
    write(join(repo, 'ignored.log'), 'ignored\n');
    const status = workingTreeStatus(repo);
    // tracked.txt M, b.txt staged, c.txt (staged D + untracked) = 2 entries, d rename, e deleted, new.txt, newdir/
    assert.equal(status.clean, false);
    assert.equal(status.changed, 8);
    assert.equal(status.staged, 3, 'b.txt, the c.txt deletion and the rename');
    assert.equal(status.modified, 2, 'tracked.txt and the deleted e.txt');
    assert.equal(status.untracked, 3, 'c.txt (left in place), new.txt and newdir/ as one entry');
    assert.equal(status.conflicted, 0);
    assert.equal(
      status.sample.some((line) => line.includes('ignored.log')),
      false,
    );
    // The first five entries in git's order (tracked, then untracked); the rename shows once, by its new path.
    assert.deepEqual(status.sample, ['M  b.txt', 'D  c.txt', 'R  d-renamed.txt', ' D e.txt', ' M tracked.txt']);
  } finally {
    cleanup(repo);
  }
});

test('workingTreeStatus counts a merge conflict', { skip: process.platform === 'win32' }, () => {
  const repo = makeRepo();
  try {
    const base = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    git(repo, ['checkout', '-b', 'side']);
    write(join(repo, 'tracked.txt'), 'side\n');
    git(repo, ['commit', '-am', 'side']);
    git(repo, ['checkout', base]);
    write(join(repo, 'tracked.txt'), 'main\n');
    git(repo, ['commit', '-am', 'main']);
    assert.throws(() => git(repo, ['merge', 'side']));
    const status = workingTreeStatus(repo);
    assert.equal(status.clean, false);
    assert.equal(status.conflicted, 1);
    assert.equal(status.changed, 1);
    // An unmerged path is conflicted only, not also staged or modified.
    assert.equal(status.staged, 0);
    assert.equal(status.modified, 0);
    assert.equal(status.untracked, 0);
    assert.deepEqual(status.sample, ['UU tracked.txt']);
  } finally {
    cleanup(repo);
  }
});

test('workingTreeStatus counts secret-shaped files but never names them, and samples at most five paths', () => {
  const repo = makeRepo();
  try {
    write(join(repo, '.env'), 'TOKEN=abc\n');
    write(join(repo, 'server.pem'), 'pem\n');
    for (let i = 0; i < 8; i += 1) write(join(repo, `file-${i}.txt`), `${i}\n`);
    const status = workingTreeStatus(repo);
    assert.equal(status.untracked, 10, 'secret-shaped files are counted');
    assert.equal(status.changed, 10);
    assert.equal(status.sample.length, 5);
    assert.ok(
      status.sample.every((line) => /^\?\? file-\d\.txt$/.test(line)),
      JSON.stringify(status.sample),
    );
    const lonely = workingTreeStatus(
      (() => {
        for (let i = 0; i < 8; i += 1) rmSync(join(repo, `file-${i}.txt`));
        return repo;
      })(),
    );
    assert.equal(lonely.changed, 2);
    assert.deepEqual(lonely.sample, [], 'only secret-shaped names remain, so nothing may be named');
  } finally {
    cleanup(repo);
  }
});

test('workingTreeStatus keeps unicode and spaced names whole and strips control characters', { skip: process.platform === 'win32' }, () => {
  const repo = makeRepo();
  try {
    write(join(repo, 'dir with space', 'caf\u00e9 \u2713.txt'), 'x\n');
    write(join(repo, 'new\nline.txt'), 'x\n');
    const status = workingTreeStatus(repo);
    assert.equal(status.changed, 2, 'a newline in a name must not split one entry into two');
    assert.ok(status.sample.includes('?? dir with space/'), JSON.stringify(status.sample));
    // The newline name cannot be echoed (it is unnormalizable), so only the counts show it.
    assert.equal(status.sample.length, 1);
    assert.equal(
      status.sample.some((line) => /[\x00-\x1f]/.test(line)),
      false,
    );
  } finally {
    cleanup(repo);
  }
});

test('workingTreeStatus degrades to a reason instead of throwing', () => {
  const dir = tempDir('offload-notrepo-');
  try {
    assert.deepEqual(workingTreeStatus(dir), { clean: null, reason: 'unresolvable' });
    assert.deepEqual(workingTreeStatus('relative/path'), { clean: null, reason: 'unresolvable' });
    assert.deepEqual(workingTreeStatus(undefined), { clean: null, reason: 'unresolvable' });
    const repo = makeRepo();
    try {
      const calls = [];
      const failing = (file, args, options) => {
        calls.push({ args, options });
        throw Object.assign(new Error('boom'), { status: 128 });
      };
      assert.deepEqual(workingTreeStatus(repo, { execFile: failing }), { clean: null, reason: 'git-status-failed' });
      assert.ok(calls.length > 0);
    } finally {
      cleanup(repo);
    }
  } finally {
    cleanup(dir);
  }
});

test('workingTreeStatus bounds the git call and passes --no-optional-locks', () => {
  const repo = makeRepo();
  try {
    const calls = [];
    const status = workingTreeStatus(repo, {
      execFile: (file, args, options) => {
        calls.push({ file, args, options });
        // The filter lookup answers "no filters" (exit 1); the status call answers clean.
        if (args[0] === 'config') throw Object.assign(new Error('none'), { status: 1 });
        return Buffer.alloc(0);
      },
    });
    assert.equal(status.clean, true);
    const statusCall = calls.find((call) => call.args.includes('status'));
    assert.ok(statusCall, 'git status must be called');
    assert.ok(statusCall.args.includes('--no-optional-locks'));
    assert.ok(statusCall.args.includes('--porcelain=v1') && statusCall.args.includes('-z'));
    assert.ok(statusCall.options.timeout <= 5000, `status timeout ${statusCall.options.timeout}`);
    assert.ok(statusCall.options.maxBuffer <= 4 * 1024 * 1024);
  } finally {
    cleanup(repo);
  }
});

test('workingTreeStatus is read-only: a stat-dirty index is not refreshed', () => {
  const repo = makeRepo();
  try {
    // Same content, new mtime: a plain `git status` would rewrite .git/index.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(repo, 'tracked.txt'), later, later);
    const index = join(repo, '.git', 'index');
    const before = { bytes: readFileSync(index), mtimeMs: statSync(index).mtimeMs };
    assert.equal(workingTreeStatus(repo).clean, true);
    assert.deepEqual(readFileSync(index), before.bytes);
    assert.equal(statSync(index).mtimeMs, before.mtimeMs);
  } finally {
    cleanup(repo);
  }
});

test('workingTreeStatus never runs a configured clean filter', { skip: process.platform === 'win32' }, () => {
  const repo = makeRepo();
  const marker = join(repo, '..', `${basename(repo)}-filter-ran`);
  try {
    write(join(repo, '.gitattributes'), 'tracked.txt filter=probe\n');
    git(repo, ['add', '.gitattributes']);
    git(repo, ['commit', '-m', 'attrs']);
    git(repo, ['config', 'filter.probe.clean', `sh -c 'cat; touch "${marker}"'`]);
    // A stat-dirty file makes git run the clean filter to compare contents.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(repo, 'tracked.txt'), later, later);
    assert.equal(workingTreeStatus(repo).clean, true);
    assert.equal(existsSync(marker), false, 'the clean filter must not run');
  } finally {
    rmSync(marker, { force: true });
    cleanup(repo);
  }
});
