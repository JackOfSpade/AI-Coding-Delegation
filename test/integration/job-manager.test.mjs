import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { JobStore } from '../../src/store.mjs';
import { JobManager, validateJobId, validateJobRequest } from '../../src/job-manager.mjs';
import { gitPatchApplier, gitSnapshots } from '../../src/core.mjs';
import { createIsolatedWorktree, openIsolatedWorktree, cleanupIsolatedWorktree } from '../../src/worktree.mjs';
import { cleanup, git, makeRepo, write } from '../unit/helpers.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const gitId = 'a'.repeat(40),
  nextGitId = 'b'.repeat(40),
  currentGitId = 'c'.repeat(40);
test('public job IDs share the durable Git-ref component boundary', () => {
  for (const id of ['_private', '-private', '', 'x'.repeat(129)]) assert.throws(() => validateJobId(id), /valid job id/);
  assert.equal(validateJobId('safe_job-1'), 'safe_job-1');
});
test('public job results expose cleanup errors without exposing a workspace path', () => {
  const manager = new JobManager({ store: {} });
  const result = manager.public({
    id: 'cleanup-status',
    repoPath: '/repo',
    status: 'FAILED',
    workspacePath: '/private/worktree',
    workspaceCleanupError: 'stored job validation failed; manual workspace cleanup is required',
    workspaceCleanupRequired: true,
  });
  assert.equal(result.workspaceCleanupRequired, true);
  assert.match(result.workspaceCleanupError, /manual workspace cleanup/);
  assert.doesNotMatch(JSON.stringify(result), /private\/worktree/);
});
test('recovery never heals a job explicitly excluded as active', async () => {
  const job = { id: 'active-job', status: 'RUNNING', createdAt: new Date().toISOString() };
  let healed = 0;
  const m = new JobManager({
    store: {
      list: async () => [job],
      update: async () => job,
      writeArtifact: async () => {},
      healPublications: async () => {
        healed += 1;
        return job;
      },
    },
  });
  assert.equal(await m.recover({ exceptIds: [job.id] }), 0);
  assert.equal(healed, 0);
});
test('recovery converges after recording that an invalid lifecycle needs manual workspace cleanup', async () => {
  const job = {
    id: 'manual-cleanup-job',
    status: 'FAILED',
    workspacePath: '/untrusted/workspace',
    workspaceCleanupError: 'stored job validation failed; manual workspace cleanup is required',
    workspaceCleanupRequired: true,
  };
  const m = new JobManager({
    store: {
      list: async () => [job],
      update: async () => job,
      writeArtifact: async () => {},
      healPublications: async () => job,
    },
  });
  assert.equal(await m.recover(), 0);
  assert.equal(await m.recover(), 0, 'the explicit manual-cleanup decision must not be re-finalized forever');
});
test('shutdown clears and unrefs its losing lifecycle timeout', async () => {
  let scheduled,
    cleared,
    unrefed = false;
  const timer = {
    unref() {
      unrefed = true;
    },
  };
  const m = new JobManager({
    store: {},
    setTimeoutFn: (resolve, delay) => {
      scheduled = { resolve, delay };
      return timer;
    },
    clearTimeoutFn: (value) => {
      cleared = value;
    },
  });
  await m.shutdown({ timeoutMs: 123 });
  assert.equal(scheduled.delay, 123);
  assert.equal(unrefed, true);
  assert.equal(cleared, timer, 'the pending promise won, so its timeout cannot retain the process');
});
test('extra writable scope is demonstrably disjoint from owned scope', async () => {
  const request = { task: 'x', ownedPaths: ['src/**'], extraWritable: ['cache/**'] };
  assert.doesNotThrow(() => validateJobRequest(request));
  for (const extraWritable of [['src/**'], ['src/tmp/**'], ['**']]) {
    assert.throws(() => validateJobRequest({ ...request, extraWritable }), /duplicate or overlap/);
  }
  // validatePersisted reuses the same request projection, so a modified
  // durable record cannot convert an ephemeral path into owned output.
  const m = await manager({ run: async () => ({ status: 'DONE' }) });
  const started = await m.start({ ...request, repoPath: process.cwd() }, { launch: false });
  await m.store.update(started.jobId, { extraWritable: ['src/tmp/**'] });
  const modified = await m.store.get(started.jobId);
  assert.throws(() => m.validatePersisted(modified), /duplicate or overlap/);
});
async function manager(worker, command = 'ok') {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-jobs-`);
  return new JobManager({
    store: new JobStore({ gitDir }),
    worker,
    runner: {
      verify: async (testCommand) => ({
        command: testCommand,
        verdict: command === 'ok' ? 'PASS' : 'FAIL',
        result: { code: command === 'ok' ? 0 : 1, sandbox: 'macos' },
      }),
    },
    snapshots: { create: async () => gitId, diff: async () => 'patch' },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
}
test('direct Git patch application accepts only byte buffers', () => {
  assert.throws(() => gitPatchApplier(process.cwd(), 'diff --git a/a b/a\n', { reverse: false, check: true }), /patch must be a Buffer/);
});
test('async start and server verification produce a durable final report', async () => {
  const m = await manager({
    run: async (_job, api) => {
      await api.progress({ turn: 1 });
      return { summary: 'done', turns: 1 };
    },
  });
  const job = await m.start({ task: 'do it', ownedPaths: ['src/**'], repoPath: process.cwd(), testCommand: 'test' });
  assert.equal(job.status, 'QUEUED');
  const done = await m.wait(job.jobId, { timeoutSec: 1 });
  assert.equal(done.status, 'DONE_VERIFIED');
  assert.match(done.report, /verify: `test` PASS/);
  assert.match(await m.store.readArtifact(job.jobId, 'patch.diff'), /patch/);
});
test('isolated lifecycle keeps primary unchanged until verified integration and supports safe revert', async () => {
  const repo = makeRepo(),
    gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-manager-`);
  let workerPath, verifierPath;
  try {
    write(join(repo, 'dirty.txt'), 'dirty baseline\n');
    const m = new JobManager({
      store: new JobStore({ gitDir }),
      snapshots: gitSnapshots(),
      worker: {
        run: async (job) => {
          workerPath = job.workspacePath;
          write(join(job.workspacePath, 'src', 'owned.txt'), 'worker\n');
          return { status: 'DONE' };
        },
      },
      runner: {
        verify: async (_command, options) => {
          verifierPath = options.cwd;
          return { command: 'verify', verdict: 'PASS', result: { code: 0, sandbox: 'macos' } };
        },
      },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        applyPatch: gitPatchApplier,
        isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
      },
    });
    const started = await m.start({ task: 'isolated apply', ownedPaths: ['src/**'], repoPath: repo, testCommand: 'verify' });
    assert.equal(existsSync(join(repo, 'src', 'owned.txt')), false, 'worker must not mutate primary');
    const done = await m.wait(started.jobId, { timeoutSec: 2 });
    assert.equal(done.status, 'DONE_VERIFIED');
    const job = await m.store.get(started.jobId);
    assert.notEqual(workerPath, repo);
    assert.equal(verifierPath, workerPath);
    assert.equal(job.applied, true);
    assert.equal(existsSync(job.workspacePath), false);
    assert.equal(await readFile(join(repo, 'src', 'owned.txt'), 'utf8'), 'worker\n');
    assert.equal(await readFile(join(repo, 'dirty.txt'), 'utf8'), 'dirty baseline\n');
    const revertPatch = await m.store.readArtifact(started.jobId, 'revert.diff');
    assert.match(revertPatch, /owned\.txt/);
    assert.deepEqual(await m.revert(started.jobId), { dryRun: true, applied: false });
    assert.deepEqual(await m.revert(started.jobId, { apply: true }), { dryRun: false, applied: true });
    assert.equal(existsSync(join(repo, 'src', 'owned.txt')), false);
  } finally {
    cleanup(repo);
  }
});
test('isolated JobManager apply and revert preserve non-NUL invalid UTF-8 patch bytes', async () => {
  const repo = makeRepo(),
    gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-raw-bytes-`);
  const expected = Buffer.from([0x77, 0x6f, 0x72, 0x6b, 0x65, 0x72, 0x2d, 0xff, 0x0a]);
  try {
    const m = new JobManager({
      store: new JobStore({ gitDir }),
      snapshots: gitSnapshots(),
      worker: {
        run: async (job) => {
          write(join(job.workspacePath, 'tracked.txt'), expected);
          return { status: 'DONE' };
        },
      },
      runner: { verify: async () => ({ verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        applyPatch: gitPatchApplier,
        isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
      },
    });
    const started = await m.start({ task: 'preserve bytes', ownedPaths: ['tracked.txt'], repoPath: repo, testCommand: 'verify' });
    assert.equal((await m.wait(started.jobId, { timeoutSec: 2 })).status, 'DONE_VERIFIED');
    assert.deepEqual(await readFile(join(repo, 'tracked.txt')), expected);
    const rawRevert = await m.store.readArtifactBytes(started.jobId, 'revert.diff');
    assert.ok(rawRevert.includes(Buffer.from([0xff])));
    const displayed = await m.job(started.jobId, { include: 'diff' });
    assert.match(displayed.diff, /^\[Lossy display: exact patch bytes are retained for apply\/revert\.\]\n/);
    assert.deepEqual(await m.revert(started.jobId, { apply: true }), { dryRun: false, applied: true });
    assert.deepEqual(await readFile(join(repo, 'tracked.txt')), Buffer.from('base\n'));
  } finally {
    cleanup(repo);
  }
});
test('isolated ephemeral output is discarded while an outside-scope write blocks all primary integration', async () => {
  const make = async (worker) => {
    const repo = makeRepo(),
      gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-scope-`);
    const m = new JobManager({
      store: new JobStore({ gitDir }),
      snapshots: gitSnapshots(),
      worker,
      runner: { verify: async () => ({ verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
      },
    });
    return { repo, m };
  };
  let pair = await make({
    run: async (job) => {
      write(join(job.workspacePath, 'src', 'ok.txt'), 'ok\n');
      write(join(job.workspacePath, 'cache', 'build.log'), 'cache\n');
      return { status: 'DONE' };
    },
  });
  try {
    const started = await pair.m.start({
      task: 'ephemeral',
      ownedPaths: ['src/**'],
      extraWritable: ['cache/**'],
      repoPath: pair.repo,
      testCommand: 'verify',
    });
    assert.equal((await pair.m.wait(started.jobId, { timeoutSec: 2 })).status, 'DONE_VERIFIED');
    assert.equal(existsSync(join(pair.repo, 'src', 'ok.txt')), true);
    assert.equal(existsSync(join(pair.repo, 'cache', 'build.log')), false);
    const job = await pair.m.store.get(started.jobId);
    assert.deepEqual(job.discardedEphemeralOutputs, ['cache/build.log']);
    assert.deepEqual(job.revertFiles, ['src/ok.txt']);
  } finally {
    cleanup(pair.repo);
  }
  pair = await make({
    run: async (job) => {
      write(join(job.workspacePath, 'src', 'ok.txt'), 'ok\n');
      write(join(job.workspacePath, 'rogue.txt'), 'bad\n');
      return { status: 'DONE' };
    },
  });
  try {
    const started = await pair.m.start({ task: 'violation', ownedPaths: ['src/**'], repoPath: pair.repo, testCommand: 'verify' });
    assert.equal((await pair.m.wait(started.jobId, { timeoutSec: 2 })).status, 'FAILED');
    assert.equal(existsSync(join(pair.repo, 'src', 'ok.txt')), false);
    assert.match(await pair.m.store.readArtifact(started.jobId, 'patch.diff'), /rogue\.txt/);
  } finally {
    cleanup(pair.repo);
  }
});
test('manual isolated repair reseeds accumulated workspace changes from the original baseline', async () => {
  const repo = makeRepo(),
    gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-repair-`);
  let runs = 0,
    pass = false;
  try {
    const m = new JobManager({
      store: new JobStore({ gitDir }),
      snapshots: gitSnapshots(),
      worker: {
        run: async (job) => {
          runs += 1;
          write(join(job.workspacePath, 'src', runs === 1 ? 'first.txt' : 'second.txt'), `${runs}\n`);
          return { status: runs === 1 ? 'FAILED' : 'DONE' };
        },
      },
      runner: { verify: async () => ({ verdict: pass ? 'PASS' : 'FAIL', result: { code: pass ? 0 : 1, sandbox: 'macos' } }) },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
      },
    });
    const started = await m.start({
      task: 'repair seed',
      ownedPaths: ['src/**'],
      repoPath: repo,
      testCommand: 'verify',
      maxRepairRounds: 1,
    });
    assert.equal((await m.wait(started.jobId, { timeoutSec: 2 })).status, 'FAILED');
    const failed = await m.store.get(started.jobId);
    assert.equal(existsSync(failed.workspacePath), false);
    assert.ok(failed.workspaceAfter);
    pass = true;
    await m.repair(started.jobId, ['finish accumulated work']);
    assert.equal((await m.wait(started.jobId, { timeoutSec: 2 })).status, 'DONE_VERIFIED');
    assert.equal(await readFile(join(repo, 'src', 'first.txt'), 'utf8'), '1\n');
    assert.equal(await readFile(join(repo, 'src', 'second.txt'), 'utf8'), '2\n');
  } finally {
    cleanup(repo);
  }
});
test('an index-only primary edit on an owned path blocks isolated integration', async () => {
  const repo = makeRepo(),
    gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-index-race-`);
  try {
    const m = new JobManager({
      store: new JobStore({ gitDir }),
      snapshots: gitSnapshots(),
      worker: {
        run: async (job) => {
          write(join(job.workspacePath, 'src', 'same.txt'), 'worker\n');
          write(join(repo, 'src', 'same.txt'), 'human staged\n');
          git(repo, ['add', 'src/same.txt']);
          return { status: 'DONE' };
        },
      },
      runner: { verify: async () => ({ verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
      },
    });
    const started = await m.start({ task: 'index race', ownedPaths: ['src/**'], repoPath: repo, testCommand: 'verify' });
    assert.equal((await m.wait(started.jobId, { timeoutSec: 2 })).status, 'FAILED');
    assert.equal(await readFile(join(repo, 'src', 'same.txt'), 'utf8'), 'human staged\n');
    assert.equal((await m.store.get(started.jobId)).integrationConflict, true);
  } finally {
    cleanup(repo);
  }
});
test('a verifier cannot silently author owned output after the worker completes', async () => {
  const repo = makeRepo(),
    gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-verifier-mutation-`);
  try {
    const m = new JobManager({
      store: new JobStore({ gitDir }),
      snapshots: gitSnapshots(),
      worker: {
        run: async (job) => {
          write(join(job.workspacePath, 'src', 'worker.txt'), 'worker\n');
          return { status: 'DONE' };
        },
      },
      runner: {
        verify: async (_command, options) => {
          write(join(options.cwd, 'src', 'verifier.txt'), 'test changed source\n');
          return { verdict: 'PASS', result: { code: 0, sandbox: 'macos' } };
        },
      },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
      },
    });
    const started = await m.start({ task: 'do not trust verifier writes', ownedPaths: ['src/**'], repoPath: repo, testCommand: 'verify' });
    assert.equal((await m.wait(started.jobId, { timeoutSec: 2 })).status, 'FAILED');
    const job = await m.store.get(started.jobId);
    assert.deepEqual(job.verifierMutations, ['src/verifier.txt']);
    assert.ok(job.scopeViolations.includes('src/verifier.txt'));
    assert.equal(existsSync(join(repo, 'src', 'worker.txt')), false);
    assert.equal(existsSync(join(repo, 'src', 'verifier.txt')), false);
  } finally {
    cleanup(repo);
  }
});
test('a failing verifier cannot seed its owned mutation into automatic or manual repair', async () => {
  const repo = makeRepo(),
    gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-failing-verifier-mutation-`);
  let runs = 0;
  try {
    const m = new JobManager({
      store: new JobStore({ gitDir }),
      snapshots: gitSnapshots(),
      worker: {
        run: async (job) => {
          runs += 1;
          write(join(job.workspacePath, 'src', 'worker.txt'), 'worker\n');
          return { status: 'DONE' };
        },
      },
      runner: {
        verify: async (_command, options) => {
          write(join(options.cwd, 'src', 'verifier.txt'), 'failed test changed source\n');
          return { verdict: 'FAIL', result: { code: 1, sandbox: 'macos' } };
        },
      },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
      },
    });
    const started = await m.start({
      task: 'failed verifier must not write',
      ownedPaths: ['src/**'],
      repoPath: repo,
      testCommand: 'verify',
      maxRepairRounds: 1,
    });
    assert.equal((await m.wait(started.jobId, { timeoutSec: 2 })).status, 'FAILED');
    assert.equal(runs, 1, 'verification mutation must suppress automatic repair');
    const failed = await m.store.get(started.jobId);
    assert.deepEqual(failed.verifierMutations, ['src/verifier.txt']);
    await assert.rejects(() => m.repair(started.jobId, ['retry']), /scope or verifier-authorship/);
  } finally {
    cleanup(repo);
  }
});
test('isolated revert rejects selected-path index drift even when worktree bytes are unchanged', async () => {
  const repo = makeRepo(),
    gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-revert-index-`);
  try {
    const m = new JobManager({
      store: new JobStore({ gitDir }),
      snapshots: gitSnapshots(),
      worker: {
        run: async (job) => {
          write(join(job.workspacePath, 'src', 'owned.txt'), 'worker\n');
          return { status: 'DONE' };
        },
      },
      runner: { verify: async () => ({ verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        applyPatch: gitPatchApplier,
        isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
      },
    });
    const started = await m.start({ task: 'index-aware revert', ownedPaths: ['src/**'], repoPath: repo, testCommand: 'verify' });
    assert.equal((await m.wait(started.jobId, { timeoutSec: 2 })).status, 'DONE_VERIFIED');
    // The primary worktree still has exactly the worker bytes, but its index
    // now has a new selected-path entry that git apply would leave behind.
    git(repo, ['add', 'src/owned.txt']);
    await assert.rejects(() => m.revert(started.jobId, { apply: true }), /primary index changed/);
    assert.equal(await readFile(join(repo, 'src', 'owned.txt'), 'utf8'), 'worker\n');
  } finally {
    cleanup(repo);
  }
});
test('crash recovery reconciles a post-apply integration intent truthfully', async () => {
  const repo = makeRepo(),
    gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-integration-journal-`);
  let workspace;
  try {
    const store = new JobStore({ gitDir });
    const m = new JobManager({
      store,
      snapshots: gitSnapshots(),
      worker: { run: async () => ({ status: 'DONE' }) },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
      },
    });
    const started = await m.start({ task: 'crash after apply', ownedPaths: ['src/**'], repoPath: repo }, { launch: false });
    const queued = await store.get(started.jobId);
    workspace = openIsolatedWorktree({
      repoPath: repo,
      workspacePath: queued.workspacePath,
      baselineTree: queued.before,
      seedTree: queued.workspaceSeed,
    });
    write(join(workspace.path, 'src', 'crash.txt'), 'applied before crash\n');
    const workspaceAfter = workspace.snapshot();
    await store.update(started.jobId, {
      status: 'FINALIZING',
      finalStatus: 'DONE_VERIFIED',
      workerAfter: workspaceAfter,
      workspaceAfter,
      after: workspaceAfter,
      revertFiles: ['src/crash.txt'],
      integrationIntent: true,
      integrationPaths: ['src/crash.txt'],
      integrationFinalStatus: 'DONE_VERIFIED',
      runnerPid: 99999999,
      runnerHeartbeatAt: new Date(0).toISOString(),
    });
    workspace.integrate(workspaceAfter, { paths: ['src/crash.txt'] });
    await m.recover();
    const settled = await store.get(started.jobId);
    assert.equal(settled.status, 'DONE_VERIFIED');
    assert.equal(settled.applied, true);
    assert.equal(settled.integrationOutcome, 'applied');
    assert.equal(settled.integrationIntent, false);
    assert.equal(await readFile(join(repo, 'src', 'crash.txt'), 'utf8'), 'applied before crash\n');
    workspace = undefined;
  } finally {
    workspace?.cleanup();
    cleanup(repo);
  }
});
test('recovery publishes a proven applied integration after a pre-publication crash', async () => {
  const repo = makeRepo(),
    gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-publication-crash-`);
  let workspace;
  try {
    const store = new JobStore({ gitDir });
    const m = new JobManager({
      store,
      snapshots: gitSnapshots(),
      worker: { run: async () => ({ status: 'DONE' }) },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
      },
    });
    const started = await m.start({ task: 'crash before publication', ownedPaths: ['src/**'], repoPath: repo }, { launch: false });
    const queued = await store.get(started.jobId);
    workspace = openIsolatedWorktree({
      repoPath: repo,
      workspacePath: queued.workspacePath,
      baselineTree: queued.before,
      seedTree: queued.workspaceSeed,
    });
    write(join(workspace.path, 'src', 'published.txt'), 'already applied\n');
    const workspaceAfter = workspace.snapshot();
    workspace.integrate(workspaceAfter, { paths: ['src/published.txt'] });
    const primaryAfter = await gitSnapshots().create(repo);
    await store.update(started.jobId, {
      status: 'FINALIZING',
      finalStatus: 'DONE_VERIFIED',
      workerAfter: workspaceAfter,
      workspaceAfter,
      after: primaryAfter,
      primaryAfter,
      revertFiles: ['src/published.txt'],
      applied: true,
      integrationOutcome: 'applied',
      runnerPid: 99999999,
      runnerHeartbeatAt: new Date(0).toISOString(),
    });
    await m.recover();
    const settled = await store.get(started.jobId);
    assert.equal(settled.status, 'DONE_VERIFIED');
    assert.equal(settled.applied, true);
    assert.equal(await readFile(join(repo, 'src', 'published.txt'), 'utf8'), 'already applied\n');
    workspace = undefined;
  } finally {
    workspace?.cleanup();
    cleanup(repo);
  }
});
test('terminal revert journals are reconciled after a post-apply persistence failure', async () => {
  const repo = makeRepo(),
    gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-revert-journal-`);
  try {
    const store = new JobStore({ gitDir });
    const m = new JobManager({
      store,
      snapshots: gitSnapshots(),
      worker: {
        run: async (job) => {
          write(join(job.workspacePath, 'src', 'revert.txt'), 'worker\n');
          return { status: 'DONE' };
        },
      },
      runner: { verify: async () => ({ verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        applyPatch: gitPatchApplier,
        isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
      },
    });
    const started = await m.start({ task: 'revert journal', ownedPaths: ['src/**'], repoPath: repo, testCommand: 'verify' });
    assert.equal((await m.wait(started.jobId, { timeoutSec: 2 })).status, 'DONE_VERIFIED');
    const originalUpdate = store.update.bind(store);
    store.update = async (id, changes) => {
      if (changes?.revertOutcome) throw new Error('simulated post-reverse persistence failure');
      return originalUpdate(id, changes);
    };
    await assert.rejects(() => m.revert(started.jobId, { apply: true }), /simulated post-reverse/);
    assert.equal(existsSync(join(repo, 'src', 'revert.txt')), false, 'reverse patch already changed primary');
    assert.equal((await store.get(started.jobId)).revertIntent, true);
    store.update = originalUpdate;
    await store.update(started.jobId, { runnerPid: 99999999, runnerHeartbeatAt: new Date(0).toISOString() });
    await m.recover();
    const settled = await store.get(started.jobId);
    assert.ok(settled.revertedAt);
    assert.equal(settled.revertIntent, false);
    assert.equal(settled.revertOutcome, 'reverted');
  } finally {
    cleanup(repo);
  }
});
test('recovery applies the normal ignored-output audit and retries transient terminal cleanup', async () => {
  const make = async ({ ignored, extraWritable = [] }) => {
    const repo = makeRepo(),
      gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-recovery-audit-`);
    write(join(repo, '.gitignore'), `${ignored}\n`);
    let cleanupCalls = 0;
    const m = new JobManager({
      store: new JobStore({ gitDir }),
      snapshots: gitSnapshots(),
      worker: { run: async () => ({ status: 'DONE' }) },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        isolation: {
          create: createIsolatedWorktree,
          open: openIsolatedWorktree,
          cleanup: (args) => {
            cleanupCalls += 1;
            return cleanupCalls === 1 ? { removed: false } : cleanupIsolatedWorktree(args);
          },
        },
      },
    });
    const started = await m.start({ task: 'recovery audit', ownedPaths: ['src/**'], extraWritable, repoPath: repo }, { launch: false });
    const job = await m.store.get(started.jobId);
    const workspace = openIsolatedWorktree({
      repoPath: repo,
      workspacePath: job.workspacePath,
      baselineTree: job.before,
      seedTree: job.workspaceSeed,
    });
    write(join(workspace.path, ignored), 'ignored\n');
    await m.store.update(started.jobId, { status: 'RUNNING', runnerPid: 99999999, runnerHeartbeatAt: new Date(0).toISOString() });
    return { repo, m, workspace, id: started.jobId, cleanupCalls: () => cleanupCalls };
  };
  const rogue = await make({ ignored: 'rogue.log' });
  try {
    await rogue.m.recover();
    const job = await rogue.m.store.get(rogue.id);
    assert.ok(job.scopeViolations.includes('rogue.log'));
    assert.ok(job.workspaceCleanupError, 'first explicit removed:false result must be persisted as retryable');
    await rogue.m.recover();
    const retried = await rogue.m.store.get(rogue.id);
    assert.ok(retried.workspaceCleanedAt);
    assert.equal(retried.workspaceCleanupError, undefined);
    assert.ok(rogue.cleanupCalls() >= 2);
    rogue.workspace = undefined;
  } finally {
    rogue.workspace?.cleanup();
    cleanup(rogue.repo);
  }
  const ephemeral = await make({ ignored: 'cache/build.log', extraWritable: ['cache/**'] });
  try {
    await ephemeral.m.recover();
    const job = await ephemeral.m.store.get(ephemeral.id);
    assert.deepEqual(job.scopeViolations, []);
    assert.deepEqual(job.discardedEphemeralOutputs, ['cache/build.log']);
    ephemeral.workspace = undefined;
  } finally {
    ephemeral.workspace?.cleanup();
    cleanup(ephemeral.repo);
  }
});
test('manual repair clears an old cleanup marker so a replacement workspace is recoverable', async () => {
  const repo = makeRepo(),
    gitDir = await mkdtemp(`${tmpdir()}/offload-isolated-repair-cleanup-marker-`);
  let released = [];
  try {
    const m = new JobManager({
      store: new JobStore({ gitDir }),
      snapshots: gitSnapshots(),
      worker: {
        run: async (job) => {
          write(join(job.workspacePath, 'src', 'partial.txt'), 'partial\n');
          return { status: 'FAILED' };
        },
      },
      leases: {
        release: async (_id, owner) => {
          released.push(owner?.ownerNonce);
          return true;
        },
      },
      config: {
        repoPath: repo,
        git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
        isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
      },
    });
    const started = await m.start({ task: 'repair cleanup marker', ownedPaths: ['src/**'], repoPath: repo });
    assert.equal((await m.wait(started.jobId, { timeoutSec: 2 })).status, 'FAILED');
    const failed = await m.store.get(started.jobId);
    assert.ok(failed.workspaceCleanedAt);
    await m.repair(started.jobId, ['continue'], { launch: false });
    const replacement = await m.store.get(started.jobId);
    assert.equal(replacement.workspaceCleanedAt, undefined);
    assert.equal(replacement.workspaceCleanupError, undefined);
    const replacementPath = replacement.workspacePath;
    released = [];
    // Simulate a crash after a terminal state was published for the new
    // workspace. Recovery must not mistake the prior workspace's marker for
    // a successful cleanup of this one.
    await m.store.update(started.jobId, { status: 'FAILED', runnerPid: 99999999, runnerHeartbeatAt: new Date(0).toISOString() });
    await m.recover();
    assert.equal(existsSync(replacementPath), false);
    assert.ok((await m.store.get(started.jobId)).workspaceCleanedAt);
    assert.ok(released.includes(replacement.leaseOwnerNonce));
  } finally {
    cleanup(repo);
  }
});
test('only one concurrent manual repair may reserve and clean a terminal workspace', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-concurrent-repair-reservation-`);
  const store = new JobStore({ gitDir });
  const job = await store.create({
    repoPath: process.cwd(),
    task: 'concurrent repair reservation',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: gitId,
    before: gitId,
    workspacePath: '/private/tmp/offload-concurrent-repair-reservation/old/workspace',
    workspaceBaseline: gitId,
    workspaceSeed: gitId,
    workspaceAfter: nextGitId,
    primaryIndexBefore: gitId,
    status: 'FAILED',
    leaseOwnerNonce: 'old-owner',
  });
  let releaseReservations;
  const reservations = new Promise((resolve) => {
    releaseReservations = resolve;
  });
  let entered = 0;
  let bothEntered;
  const both = new Promise((resolve) => {
    bothEntered = resolve;
  });
  const updateOperationalIf = store.updateOperationalIf.bind(store);
  store.updateOperationalIf = async (id, expected, changes) => {
    if (expected.status === 'FAILED' && changes.status === 'REPAIRING') {
      entered += 1;
      if (entered === 2) bothEntered();
      await reservations;
    }
    return updateOperationalIf(id, expected, changes);
  };
  let cleanups = 0,
    workspaces = 0;
  const makeManager = () => {
    const m = new JobManager({
      store,
      leases: { acquire: async () => {}, release: async () => true },
      config: {
        repoPath: process.cwd(),
        git: { branch: async () => 'main', head: async () => gitId },
        isolation: {
          create: async () => ({
            path: `/private/tmp/offload-concurrent-repair-reservation/${++workspaces}/workspace`,
            cleanup: async () => {},
          }),
          open: async () => {},
        },
      },
    });
    m.cleanupWorkspace = async () => {
      cleanups += 1;
      return true;
    };
    return m;
  };
  const first = makeManager();
  const second = makeManager();
  const repairing = [first.repair(job.id, ['first'], { launch: false }), second.repair(job.id, ['second'], { launch: false })];
  await both;
  releaseReservations();
  const results = await Promise.allSettled(repairing);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(cleanups, 1, 'the losing repair must fail before rereading and cleaning the winner workspace');
  const queued = await store.get(job.id);
  assert.equal(queued.status, 'QUEUED');
  assert.equal(queued.handoffState, 'PARENT_QUEUED');
  assert.equal(workspaces, 1);
});
test('default job identifiers carry at least 96 random bits', async () => {
  const store = new JobStore({ gitDir: await mkdtemp(`${tmpdir()}/offload-id-`) });
  const job = await store.create({ task: 'id', ownedPaths: ['src/**'] });
  assert.match(job.id, /^oj-\d{8}-[a-f0-9]{32}$/);
  assert.throws(() => store.path('x'.repeat(129)), /invalid job id/);
});
test('cancel preserves a terminal job and validation rejects unsafe scope', async () => {
  const m = await manager({
    run: async (_job, { signal }) => {
      while (!signal.aborted) await pause(5);
      return {};
    },
  });
  await assert.rejects(() => m.start({ task: 'x', ownedPaths: ['../outside'] }), /ownedPaths/);
  const job = await m.start({ task: 'x', ownedPaths: ['**'], repoPath: process.cwd() });
  await m.cancel(job.jobId);
  assert.equal((await m.store.get(job.jobId)).status, 'CANCELLED');
});
test('start rejects path aliases and non-boolean capability flags before creating a job', async () => {
  const m = await manager({ run: async () => ({ status: 'DONE' }) });
  for (const ownedPaths of [['.'], ['./src/**'], ['src/./a.mjs'], ['src//a.mjs'], ['src/**', 'src/**']]) {
    await assert.rejects(() => m.start({ task: 'x', ownedPaths, repoPath: process.cwd() }), /ownedPaths/);
  }
  await assert.rejects(() => m.start({ task: 'x', ownedPaths: ['src/**'], allowNetwork: 'true', repoPath: process.cwd() }), /allowNetwork/);
  await assert.rejects(() => m.start({ task: 'x', ownedPaths: ['src/**'], denyRead: ['../secret'], repoPath: process.cwd() }), /denyRead/);
  await assert.rejects(
    () => m.start({ task: 'x', ownedPaths: ['src/**'], extraWritable: ['src/**'], repoPath: process.cwd() }),
    /extraWritable.*duplicate/,
  );
  assert.equal((await m.store.list()).length, 0, 'invalid scopes must not create a failed job artifact');
  const profile = { type: 'openai-chat', baseUrl: 'https://provider.example.test/v1', keyRef: 'env:OFFLOAD_TEST_KEY', model: 'test-model' };
  await assert.rejects(
    () =>
      m.start({
        task: 'x',
        ownedPaths: ['src/**'],
        executionProfile: { ...profile, baseUrl: 'https://provider.example.test/\nsmuggled' },
        repoPath: process.cwd(),
      }),
    /executionProfile/,
  );
  await assert.rejects(
    () =>
      m.start({
        task: 'x',
        ownedPaths: ['src/**'],
        executionProfile: { ...profile, baseUrl: `https://provider.example.test/${'x'.repeat(2048)}` },
        repoPath: process.cwd(),
      }),
    /executionProfile/,
  );
  await assert.rejects(
    () =>
      m.start({
        task: 'x',
        ownedPaths: ['src/**'],
        executionProfile: { ...profile, pricingFile: 'relative-pricing.json' },
        repoPath: process.cwd(),
      }),
    /executionProfile/,
  );
  await assert.rejects(() => m.start({ task: 'x', ownedPaths: ['src/**'], budget: { maxUSd: 1 }, repoPath: process.cwd() }), /budget/);
  for (const budget of [{ maxUsd: null }, { maxTurns: null }, { timeoutMinutes: null }])
    await assert.rejects(() => m.start({ task: 'x', ownedPaths: ['src/**'], budget, repoPath: process.cwd() }), /budget/);
});
test('persisted jobs cannot redirect repositories, Git revisions, or write scope', async () => {
  const m = await manager({ run: async () => ({ status: 'DONE' }) });
  const redirected = await m.start({ task: 'x', ownedPaths: ['src/**'], repoPath: process.cwd() }, { launch: false });
  await m.store.update(redirected.jobId, { repoPath: '/private/tmp/other-repository' });
  await assert.rejects(() => m.resume(redirected.jobId), /repository/);

  const hostileRevision = await m.start({ task: 'x', ownedPaths: ['src/**'], repoPath: process.cwd() }, { launch: false });
  await m.store.update(hostileRevision.jobId, { before: '--config=core.hooksPath=/tmp/hostile' });
  await assert.rejects(() => m.resume(hostileRevision.jobId), /Git metadata/);

  const gitDir = await mkdtemp(`${tmpdir()}/offload-write-scope-`);
  const acquired = [];
  const scoped = new JobManager({
    store: new JobStore({ gitDir }),
    worker: { run: async () => ({ status: 'DONE' }) },
    snapshots: { create: async () => gitId, diff: async () => '' },
    leases: { acquire: async (_id, paths) => acquired.push(paths), release: async () => {} },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  const job = await scoped.start({ task: 'x', ownedPaths: ['src/**'], repoPath: process.cwd() }, { launch: false });
  await scoped.store.update(job.jobId, { writePaths: ['**'], handoffState: 'CHILD_ASSIGNED' });
  await scoped.resume(job.jobId);
  assert.deepEqual(acquired.at(-1), ['src/**']);
  await scoped.wait(job.jobId, { timeoutSec: 1 });
});
test('policy-only verifier failures never trigger or permit repair', async () => {
  let policyRuns = 0;
  const policyOnly = await manager(
    {
      run: async () => {
        policyRuns += 1;
        return { status: 'DONE' };
      },
    },
    'fail',
  );
  policyOnly.runner.verify = async () => ({ command: 'fail', verdict: 'FAIL', result: { code: 1, sandbox: 'policy-only' } });
  const failed = await policyOnly.start({
    task: 'x',
    ownedPaths: ['src/**'],
    repoPath: process.cwd(),
    testCommand: 'fail',
    sandboxMode: 'policy-only',
    maxRepairRounds: 1,
  });
  assert.equal((await policyOnly.wait(failed.jobId, { timeoutSec: 1 })).status, 'VERIFY_FAILED');
  assert.equal(policyRuns, 1, 'a policy-only verifier must not schedule automatic repair');
  await assert.rejects(() => policyOnly.repair(failed.jobId, ['retry']), /policy-only.*fresh start/);

  const unverified = await manager({ run: async () => ({ status: 'DONE' }) });
  const noVerifier = await unverified.start({ task: 'x', ownedPaths: ['src/**'], repoPath: process.cwd(), sandboxMode: 'policy-only' });
  assert.equal((await unverified.wait(noVerifier.jobId, { timeoutSec: 1 })).status, 'DONE_UNVERIFIED');
  await unverified.repair(noVerifier.jobId, ['caller-authorized'], { launch: false });
});
test('verifier repair trusts only the actual macOS result, never start-time sandbox metadata', async () => {
  let runs = 0;
  const m = await manager(
    {
      run: async () => {
        runs += 1;
        return { status: 'DONE' };
      },
    },
    'fail',
  );
  // A stale/misleading start-time claim must not make this policy-only result
  // eligible for automatic or manual repair.
  m.runner.verify = async () => ({ command: 'fail', verdict: 'FAIL', result: { code: 1, sandbox: 'policy-only' } });
  const started = await m.start({
    task: 'strict verifier result',
    ownedPaths: ['src/**'],
    repoPath: process.cwd(),
    testCommand: 'fail',
    sandboxMode: 'macos',
    maxRepairRounds: 1,
    unsafePolicyOnlyVerifier: true,
  });
  assert.equal((await m.wait(started.jobId, { timeoutSec: 1 })).status, 'VERIFY_FAILED');
  assert.equal(runs, 1);
  await assert.rejects(() => m.repair(started.jobId, ['retry']), /policy-only or unknown verifier result/);
});
test('sealed lifecycle updates preserve transcript integrity across automatic repair', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-sealed-repair-`);
  let runs = 0;
  const store = new JobStore({ gitDir }).configureIntegrity({ requiredFor: () => true, keyForId: () => 'sealed-credential' });
  const m = new JobManager({
    store,
    worker: {
      run: async (_job, api) => {
        runs += 1;
        await api.appendMessage({ role: 'user', content: `round ${runs}` });
        return { status: 'DONE' };
      },
    },
    runner: { verify: async () => ({ command: 'fail', verdict: 'FAIL', result: { code: 1, sandbox: 'macos' } }) },
    snapshots: { create: async () => gitId, diff: async () => '' },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  const started = await m.start({
    task: 'repair',
    ownedPaths: ['src/**'],
    repoPath: process.cwd(),
    testCommand: 'fail',
    maxRepairRounds: 1,
    sandboxMode: 'macos',
    executionProfile: { type: 'openai-chat', baseUrl: 'https://provider.example.test/v1', keyRef: 'env:GOOD', model: 'model' },
  });
  assert.equal((await m.wait(started.jobId, { timeoutSec: 2 })).status, 'VERIFY_FAILED');
  assert.equal(runs, 2);
  assert.equal((await store.readMessages(started.jobId)).length, 2);
  assert.equal(store.verifyJob(await store.get(started.jobId)), true);
});
test('automatic repair clears its per-round scheduling marker through the final allowed round', async () => {
  let runs = 0;
  const m = await manager({ run: async () => ({ status: 'DONE', summary: `attempt ${++runs}` }) }, 'fail');
  m.runner.verify = async () => ({ command: 'fail', verdict: 'FAIL', result: { code: 1, sandbox: 'macos' } });
  const started = await m.start({
    task: 'retry until capped',
    ownedPaths: ['src/**'],
    repoPath: process.cwd(),
    testCommand: 'fail',
    maxRepairRounds: 2,
    sandboxMode: 'macos',
  });
  const done = await m.wait(started.jobId, { timeoutSec: 2 });
  assert.equal(done.status, 'VERIFY_FAILED');
  assert.equal(runs, 3, 'the initial attempt plus every permitted automatic repair must finish');
  assert.equal(m.running.has(started.jobId), false, 'a capped repair lifecycle must not leave a worker task running');
});
test('non-owner cancellation of a queued lifecycle only records its durable marker', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-cancel-`);
  let released;
  const leases = {
    acquire: async () => {},
    release: async (_id, owner) => {
      released = owner.ownerNonce;
    },
    list: async () => [],
  };
  const m = new JobManager({
    store: new JobStore({ gitDir }),
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: { verify: async () => ({ verdict: 'PASS', result: { code: 0 } }) },
    snapshots: { create: async () => gitId, diff: async () => '' },
    leases,
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  const started = await m.start({ task: 'queued', ownedPaths: ['src/**'], repoPath: process.cwd() }, { launch: false });
  await m.cancel(started.jobId);
  assert.equal((await m.store.get(started.jobId)).status, 'QUEUED');
  assert.equal(await m.store.cancelRequested(started.jobId), true);
  assert.equal(released, undefined, 'a process without the worker controller must not release or clean a possible detached owner');
});
test('detached finalization requires an affirmative exact-lease release before cleanup', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-detached-release-`);
  const m = new JobManager({
    store: new JobStore({ gitDir }),
    worker: { run: async () => ({ status: 'DONE' }) },
    snapshots: { create: async () => gitId, diff: async () => '' },
    leases: { acquire: async () => {}, list: async () => [], release: async () => false },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  const started = await m.start({ task: 'detached release', ownedPaths: ['src/**'], repoPath: process.cwd() }, { launch: false });
  const initial = await m.store.get(started.jobId);
  await m.store.update(started.jobId, { handoffState: 'PARENT_QUEUED' });
  let cleanups = 0;
  m.cleanupWorkspace = async () => {
    cleanups += 1;
    return true;
  };
  await assert.rejects(
    () =>
      m.finishDetachedTerminal(started.jobId, {
        ownerNonce: 'transferred-owner',
        expectedOwnerNonce: initial.leaseOwnerNonce,
        status: 'CANCELLED',
      }),
    /release was not confirmed/,
  );
  assert.equal((await m.store.get(started.jobId)).status, 'FINALIZING');
  assert.equal(cleanups, 0);
});
test('wait does not publish terminal verification before slow snapshot finalization', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-finalizing-`);
  let snapshots = 0;
  const m = new JobManager({
    store: new JobStore({ gitDir }),
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: { verify: async () => ({ command: 'ok', verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
    snapshots: {
      create: async () => {
        snapshots += 1;
        if (snapshots > 1) await pause(120);
        return snapshots === 1 ? gitId : nextGitId;
      },
      diff: async () => '',
    },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  const started = await m.start({ task: 'slow finish', ownedPaths: ['src/**'], repoPath: process.cwd(), testCommand: 'ok' });
  const early = await m.wait(started.jobId, { timeoutSec: 0.02 });
  assert.equal(early.done, false);
  assert.ok(['WORKER_DONE', 'FINALIZING'].includes(early.status));
  assert.equal((await m.wait(started.jobId, { timeoutSec: 1 })).status, 'DONE_VERIFIED');
});
test('terminal status and wait stay behind an in-flight owned cleanup attempt', async () => {
  const m = await manager({ run: async () => ({ status: 'FAILED' }) });
  let enterCleanup;
  let releaseCleanup;
  const cleanupEntered = new Promise((resolve) => {
    enterCleanup = resolve;
  });
  const cleanupGate = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const cleanupWorkspace = m.cleanupWorkspace.bind(m);
  m.cleanupWorkspace = async (id) => {
    enterCleanup();
    await cleanupGate;
    return cleanupWorkspace(id);
  };
  const started = await m.start({ task: 'deferred cleanup', ownedPaths: ['src/**'], repoPath: process.cwd() });
  await cleanupEntered;
  assert.equal((await m.store.get(started.jobId)).status, 'FINALIZING');
  let waitSettled = false;
  const waiting = m.wait(started.jobId, { timeoutSec: 1 }).then((result) => {
    waitSettled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(waitSettled, false, 'wait must not expose a terminal status before cleanup resolves');
  releaseCleanup();
  assert.equal((await waiting).status, 'FAILED');
});
test('shutdown cancellation suppresses an automatic repair queued at the scheduling boundary', async () => {
  let runs = 0;
  const m = await manager({ run: async () => ({ status: 'DONE', summary: `run ${++runs}` }) }, 'fail');
  m.runner.verify = async () => ({ command: 'fail', verdict: 'FAIL', result: { code: 1, sandbox: 'macos' } });
  const update = m.store.update.bind(m.store);
  let enterSchedule;
  let releaseSchedule;
  const scheduleEntered = new Promise((resolve) => {
    enterSchedule = resolve;
  });
  const scheduleGate = new Promise((resolve) => {
    releaseSchedule = resolve;
  });
  m.store.update = async (id, changes) => {
    if (changes.autoRepairScheduled === true) {
      enterSchedule();
      await scheduleGate;
    }
    return update(id, changes);
  };
  const started = await m.start({
    task: 'shutdown auto repair handoff',
    ownedPaths: ['src/**'],
    repoPath: process.cwd(),
    testCommand: 'fail',
    maxRepairRounds: 1,
    sandboxMode: 'macos',
  });
  await scheduleEntered;
  const stopping = m.shutdown();
  releaseSchedule();
  await stopping;
  assert.equal((await m.wait(started.jobId, { timeoutSec: 1 })).status, 'CANCELLED');
  assert.equal(runs, 1, 'shutdown must not install a replacement lifecycle after the old task was snapshotted');
  assert.equal(m.running.has(started.jobId), false);
});
test('shutdown retains worker ownership through blocked terminal report publication', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-shutdown-publication-`);
  const store = new JobStore({ gitDir });
  const writeArtifact = store.writeArtifact.bind(store);
  let releaseReport,
    reportWritten = false;
  const reportEntered = new Promise((resolve) => {
    store.writeArtifact = async (id, name, content) => {
      if (name === 'report.md') {
        reportWritten = true;
        resolve();
        await new Promise((release) => {
          releaseReport = release;
        });
      }
      return writeArtifact(id, name, content);
    };
  });
  const m = new JobManager({
    store,
    worker: { run: async () => ({ status: 'DONE' }) },
    snapshots: { create: async () => gitId, diff: async () => '' },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  const started = await m.start({ task: 'publish', ownedPaths: ['src/**'], repoPath: process.cwd() });
  await reportEntered;
  let shutdownSettled = false;
  const shutdown = m.shutdown({ timeoutMs: 1_000 }).then(() => {
    shutdownSettled = true;
  });
  await pause(20);
  assert.equal(reportWritten, true);
  assert.equal(shutdownSettled, false, 'shutdown must await its own final publication task');
  assert.equal(m.running.has(started.jobId), true);
  releaseReport();
  await shutdown;
  assert.equal(m.running.has(started.jobId), false);
});
test('manager enforces cumulative worker budgets and honors cancellation during finalization', async () => {
  let verified = false;
  const overBudget = await manager({ run: async () => ({ status: 'DONE', turns: 2, costUsd: 2, usage: {} }) });
  overBudget.runner.verify = async () => {
    verified = true;
    return { verdict: 'PASS', result: { code: 0 } };
  };
  const started = await overBudget.start({
    task: 'cap',
    ownedPaths: ['src/**'],
    repoPath: process.cwd(),
    testCommand: 'test',
    budget: { maxTurns: 1, maxUsd: 1 },
  });
  assert.equal((await overBudget.wait(started.jobId, { timeoutSec: 1 })).status, 'BUDGET');
  assert.equal(verified, false);

  let creates = 0,
    releaseFinalSnapshot;
  const snapshotEntered = new Promise((resolve) => {
    releaseFinalSnapshot = resolve;
  });
  const store = new JobStore({ gitDir: await mkdtemp(`${tmpdir()}/offload-final-cancel-`) });
  const m = new JobManager({
    store,
    worker: { run: async () => ({ status: 'DONE' }) },
    snapshots: {
      create: async () => {
        creates++;
        if (creates === 2) await snapshotEntered;
        return gitId;
      },
      diff: async () => '',
    },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  const cancelling = await m.start({ task: 'cancel finalizing', ownedPaths: ['src/**'], repoPath: process.cwd() });
  while (creates < 2) await pause(2);
  await store.requestCancel(cancelling.jobId);
  releaseFinalSnapshot();
  assert.equal((await m.wait(cancelling.jobId, { timeoutSec: 1 })).status, 'CANCELLED');
});
test('revert permits unrelated changes but rejects a change to an owned patch path', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-revert-scope-`);
  let changed = [{ path: 'other.txt', status: 'M' }];
  let applied = 0;
  const applyOptions = [];
  const store = new JobStore({ gitDir });
  const job = await store.create({
    repoPath: process.cwd(),
    task: 'revert',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: gitId,
    status: 'DONE_VERIFIED',
    applied: true,
    after: nextGitId,
    revertFiles: ['src/a.mjs'],
  });
  await store.writeArtifact(job.id, 'patch.diff', 'review patch');
  await store.writeArtifact(job.id, 'revert.diff', 'patch');
  const m = new JobManager({
    store,
    snapshots: { create: async () => currentGitId, files: async () => changed },
    config: {
      repoPath: process.cwd(),
      applyPatch: (_repoPath, _patch, options) => {
        applied += 1;
        applyOptions.push(options);
        return { dryRun: options.check, applied: !options.check };
      },
    },
  });
  // MCP supplies an object containing apply:undefined when the optional tool
  // argument is absent.  JavaScript's parameter default therefore remains a
  // real, conservative dry run rather than an invalid explicit value.
  assert.deepEqual(await m.revert(job.id, { apply: undefined }), { dryRun: true, applied: false });
  assert.deepEqual(await m.revert(job.id, { apply: true }), { dryRun: false, applied: true });
  assert.deepEqual(applyOptions, [
    { reverse: true, check: true },
    { reverse: true, check: false },
  ]);
  await assert.rejects(() => m.revert(job.id, { apply: 'false' }), /apply must be boolean/);
  await assert.rejects(() => m.revert(job.id, { apply: 1 }), /apply must be boolean/);
  assert.equal(applied, 2, 'truthy non-booleans must not reach an applying patch adapter');
  changed = [{ path: 'src/a.mjs', status: 'M' }];
  await assert.rejects(() => m.revert(job.id), /job-owned file/);
});
test('recovery finalizes partial artifacts and releases the dead worker lease before visibility', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-recover-final-`);
  let released = false;
  const store = new JobStore({ gitDir });
  const job = await store.create({
    repoPath: process.cwd(),
    task: 'recover',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: gitId,
    before: gitId,
    status: 'RUNNING',
    runnerPid: 999999999,
    runnerHeartbeatAt: new Date(0).toISOString(),
    leaseOwnerNonce: 'recovery-owner-nonce',
  });
  const m = new JobManager({
    store,
    snapshots: {
      create: async () => nextGitId,
      diff: async () => 'diff --git a/src/a.mjs b/src/a.mjs\n',
      files: async () => [{ path: 'src/a.mjs', status: 'M' }],
    },
    leases: {
      release: async (_id, { ownerNonce }) => {
        released = ownerNonce === 'recovery-owner-nonce';
        return released;
      },
    },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  assert.equal(await m.recover(), 1);
  const done = await store.get(job.id);
  assert.equal(done.status, 'FAILED');
  assert.equal(released, true);
  assert.match(await store.readArtifact(job.id, 'patch.diff'), /src\/a/);
  assert.match(await store.readArtifact(job.id, 'report.md'), /server restarted/);
});
test('recovery cannot overwrite a child handoff or clean after a stale release loses ownership', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-recovery-handoff-race-`);
  const store = new JobStore({ gitDir });
  const job = await store.create({
    repoPath: process.cwd(),
    task: 'recover handoff race',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: gitId,
    before: gitId,
    status: 'RUNNING',
    handoffState: 'PARENT_QUEUED',
    runnerPid: 999999999,
    runnerHeartbeatAt: new Date(0).toISOString(),
    leaseOwnerNonce: 'parent-owner',
  });
  let cleanups = 0;
  const m = new JobManager({
    store,
    snapshots: { create: async () => nextGitId, diff: async () => '' },
    leases: {
      // Deterministically model a child transfer which wins after recovery's
      // stale-heartbeat decision and FINALIZING CAS, but before old-nonce
      // release. Recovery must preserve the child's durable tuple and leave
      // its workspace alone.
      release: async (id, { ownerNonce }) => {
        assert.equal(ownerNonce, 'parent-owner');
        await store.update(id, {
          status: 'QUEUED',
          handoffState: 'CHILD_ASSIGNED',
          leaseOwnerNonce: 'child-owner',
          runnerPid: process.pid,
          runnerHeartbeatAt: new Date().toISOString(),
        });
        throw new Error('lease ownership changed');
      },
      list: async () => [{ jobId: job.id, ownerNonce: 'child-owner' }],
    },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  m.cleanupWorkspace = async () => {
    cleanups += 1;
    return true;
  };
  assert.equal(await m.recover(), 0);
  const child = await store.get(job.id);
  assert.equal(child.status, 'QUEUED');
  assert.equal(child.handoffState, 'CHILD_ASSIGNED');
  assert.equal(child.leaseOwnerNonce, 'child-owner');
  assert.equal(cleanups, 0);
});
test('a delayed detached resume cannot resurrect a lifecycle recovery already finalized', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-resume-recovery-claim-`);
  const store = new JobStore({ gitDir });
  const job = await store.create({
    repoPath: process.cwd(),
    task: 'resume claim race',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: gitId,
    before: gitId,
    status: 'QUEUED',
    handoffState: 'CHILD_ASSIGNED',
    runnerPid: process.pid,
    runnerHeartbeatAt: new Date(0).toISOString(),
    leaseOwnerNonce: 'child-owner',
  });
  const event = store.event.bind(store);
  let releaseClaim;
  const workerClaimed = new Promise((resolve) => {
    releaseClaim = resolve;
  });
  let claimEntered;
  const enteredClaim = new Promise((resolve) => {
    claimEntered = resolve;
  });
  store.event = async (id, entry) => {
    if (entry?.type === 'worker-claimed') {
      claimEntered();
      await workerClaimed;
    }
    return event(id, entry);
  };
  let runs = 0;
  const leases = { transfer: async () => {}, release: async () => true };
  const config = { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } };
  const child = new JobManager({ store, leases, worker: { run: async () => ({ runs: ++runs, status: 'DONE' }) }, config });
  const resuming = child.resume(job.id);
  await enteredClaim;
  await store.update(job.id, { status: 'FINALIZING', finalStatus: 'FAILED', error: 'recovery won ownership' });
  await store.update(job.id, { status: 'FAILED' });
  assert.equal((await store.get(job.id)).status, 'FAILED');
  releaseClaim();
  const resumed = await resuming;
  const launch = child.running.get(job.id);
  if (launch) await launch;
  assert.equal(resumed.status, 'FAILED');
  assert.equal((await store.get(job.id)).status, 'FAILED');
  assert.equal(runs, 0, 'a lost launch claim must not reach the worker');
  assert.equal(child.running.has(job.id), false);
  assert.equal(child.controllers.has(job.id), false);
});
test('recovery leaves a stale-heartbeat live detached child alone and the child resumes normally', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-resume-live-child-`);
  const store = new JobStore({ gitDir });
  const job = await store.create({
    repoPath: process.cwd(),
    task: 'live detached child',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: gitId,
    before: gitId,
    status: 'QUEUED',
    handoffState: 'CHILD_ASSIGNED',
    runnerPid: process.pid,
    runnerHeartbeatAt: new Date(0).toISOString(),
    leaseOwnerNonce: 'live-child-owner',
  });
  const event = store.event.bind(store);
  let releaseClaim;
  const workerClaimed = new Promise((resolve) => {
    releaseClaim = resolve;
  });
  let claimEntered;
  const enteredClaim = new Promise((resolve) => {
    claimEntered = resolve;
  });
  store.event = async (id, entry) => {
    if (entry?.type === 'worker-claimed') {
      claimEntered();
      await workerClaimed;
    }
    return event(id, entry);
  };
  let runs = 0,
    cleanups = 0;
  const config = { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } };
  const leases = { transfer: async () => {}, release: async () => true };
  const child = new JobManager({
    store,
    leases,
    worker: { run: async () => ({ status: 'FAILED', error: `run ${++runs}` }) },
    config,
  });
  child.cleanupWorkspace = async () => {
    cleanups += 1;
    return true;
  };
  const resuming = child.resume(job.id);
  await enteredClaim;
  const recovery = new JobManager({ store, leases, config });
  recovery.cleanupWorkspace = async () => {
    cleanups += 1;
    return true;
  };
  assert.equal(await recovery.recover(), 0, 'a live PID remains authoritative despite its old heartbeat');
  assert.equal(cleanups, 0);
  releaseClaim();
  await resuming;
  const result = await child.wait(job.id, { timeoutSec: 2 });
  assert.equal(result.status, 'FAILED');
  assert.equal(runs, 1);
});
test('recovery does not clean a terminal record while a different lease owner remains live', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-recovery-terminal-owner-`);
  const store = new JobStore({ gitDir });
  const job = await store.create({
    repoPath: process.cwd(),
    task: 'terminal ownership race',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: gitId,
    before: gitId,
    status: 'FAILED',
    handoffState: 'CHILD_ASSIGNED',
    runnerPid: process.pid,
    runnerHeartbeatAt: new Date().toISOString(),
    leaseOwnerNonce: 'stale-owner',
  });
  let cleanups = 0;
  const m = new JobManager({
    store,
    leases: {
      release: async (_id, { ownerNonce }) => {
        assert.equal(ownerNonce, 'stale-owner');
        throw new Error('lease ownership changed');
      },
      list: async () => [{ jobId: job.id, ownerNonce: 'live-child-owner' }],
    },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  m.cleanupWorkspace = async () => {
    cleanups += 1;
    return true;
  };
  assert.equal(await m.recover(), 0);
  assert.equal((await store.get(job.id)).status, 'FAILED');
  assert.equal(cleanups, 0);
});
test('terminal cleanup retries under a live server only after proving its lease is absent', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-recovery-live-terminal-cleanup-`);
  const store = new JobStore({ gitDir });
  const job = await store.create({
    repoPath: process.cwd(),
    task: 'live terminal cleanup',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: gitId,
    before: gitId,
    workspacePath: '/private/tmp/offload-recovery-live-terminal-cleanup/workspace',
    workspaceBaseline: gitId,
    workspaceSeed: gitId,
    primaryIndexBefore: gitId,
    status: 'FAILED',
    finalStatus: 'REPAIR_QUEUED',
    runnerPid: process.pid,
    runnerHeartbeatAt: new Date(0).toISOString(),
    leaseOwnerNonce: 'former-owner',
  });
  let hasLease = true,
    releases = 0,
    cleanups = 0;
  const m = new JobManager({
    store,
    leases: {
      release: async () => {
        releases += 1;
        throw new Error('live owners must not be released by recovery');
      },
      list: async () => (hasLease ? [{ jobId: job.id, ownerNonce: 'former-owner' }] : []),
    },
    config: {
      repoPath: process.cwd(),
      git: { branch: async () => 'main', head: async () => gitId },
      isolation: { create: async () => {}, open: async () => {} },
    },
  });
  m.cleanupWorkspace = async () => {
    cleanups += 1;
    return true;
  };
  assert.equal(await m.recover(), 0);
  assert.equal(cleanups, 0);
  hasLease = false;
  assert.equal(await m.recover(), 1);
  assert.equal(cleanups, 1);
  assert.equal(releases, 0, 'live terminal retry uses only its no-lease proof');
  assert.equal((await store.get(job.id)).finalStatus, 'FAILED', 'a stale nonterminal finalStatus cannot strand the cleanup reservation');
});
test('terminal recovery reservation cannot clean a manual repair workspace published at its CAS boundary', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-terminal-recovery-repair-race-`);
  const store = new JobStore({ gitDir });
  const job = await store.create({
    repoPath: process.cwd(),
    task: 'terminal recovery repair race',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: gitId,
    before: gitId,
    workspacePath: '/private/tmp/offload-terminal-recovery-repair-race/old/workspace',
    workspaceBaseline: gitId,
    workspaceSeed: gitId,
    workspaceAfter: nextGitId,
    primaryIndexBefore: gitId,
    status: 'FAILED',
    runnerPid: process.pid,
    runnerHeartbeatAt: new Date(0).toISOString(),
    leaseOwnerNonce: 'former-owner',
  });
  let created = 0,
    recoveryCleanups = 0,
    repairCleanups = 0;
  const config = {
    repoPath: process.cwd(),
    git: { branch: async () => 'main', head: async () => gitId },
    isolation: {
      create: async () => ({ path: `/private/tmp/offload-terminal-recovery-repair-race/${++created}/workspace`, cleanup: async () => {} }),
      open: async () => {},
    },
  };
  const leases = { acquire: async () => {}, release: async () => true, list: async () => [] };
  const repair = new JobManager({ store, leases, config });
  repair.cleanupWorkspace = async () => {
    repairCleanups += 1;
    return true;
  };
  const recovery = new JobManager({ store, leases, config });
  recovery.cleanupWorkspace = async () => {
    recoveryCleanups += 1;
    return true;
  };
  const updateOperationalIf = store.updateOperationalIf.bind(store);
  let injected = false;
  store.updateOperationalIf = async (id, expected, changes) => {
    if (!injected && changes.status === 'FINALIZING') {
      injected = true;
      await repair.repair(id, ['continue'], { launch: false });
    }
    return updateOperationalIf(id, expected, changes);
  };
  assert.equal(await recovery.recover(), 0);
  const queued = await store.get(job.id);
  assert.equal(queued.status, 'QUEUED');
  assert.equal(queued.handoffState, 'PARENT_QUEUED');
  assert.equal(repairCleanups, 1);
  assert.equal(recoveryCleanups, 0, 'the failed terminal reservation must not clean the repair replacement');
  assert.equal(created, 1);
});
test('revert-journal recovery also leaves a newly assigned child workspace untouched', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-recovery-revert-owner-`);
  const store = new JobStore({ gitDir });
  const job = await store.create({
    repoPath: process.cwd(),
    task: 'revert ownership race',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: gitId,
    before: gitId,
    workspacePath: '/private/tmp/offload-recovery-revert-owner/workspace',
    workspaceBaseline: gitId,
    workspaceSeed: gitId,
    primaryIndexBefore: gitId,
    workspaceAfter: nextGitId,
    status: 'FAILED',
    handoffState: 'PARENT_QUEUED',
    runnerPid: 999999999,
    runnerHeartbeatAt: new Date(0).toISOString(),
    leaseOwnerNonce: 'parent-owner',
    revertIntent: true,
    revertPaths: ['src/a.mjs'],
    revertExpectedTree: nextGitId,
  });
  let cleanups = 0;
  const m = new JobManager({
    store,
    leases: {
      release: async (id) => {
        await store.update(id, {
          status: 'QUEUED',
          handoffState: 'CHILD_ASSIGNED',
          leaseOwnerNonce: 'child-owner',
          runnerPid: process.pid,
          runnerHeartbeatAt: new Date().toISOString(),
        });
        throw new Error('lease ownership changed');
      },
      list: async () => [{ jobId: job.id, ownerNonce: 'child-owner' }],
    },
    config: {
      repoPath: process.cwd(),
      git: { branch: async () => 'main', head: async () => gitId },
      isolation: { create: async () => {}, open: async () => {} },
    },
  });
  m.cleanupWorkspace = async () => {
    cleanups += 1;
    return true;
  };
  assert.equal(await m.recover(), 0);
  const child = await store.get(job.id);
  assert.equal(child.status, 'QUEUED');
  assert.equal(child.handoffState, 'CHILD_ASSIGNED');
  assert.equal(cleanups, 0);
});
test('revert-journal recovery reserves the terminal record before cleanup so repair cannot replace its workspace', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-recovery-revert-repair-race-`);
  const store = new JobStore({ gitDir });
  const job = await store.create({
    repoPath: process.cwd(),
    task: 'revert cleanup reservation',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: gitId,
    before: gitId,
    workspacePath: '/private/tmp/offload-recovery-revert-repair-race/old/workspace',
    workspaceBaseline: gitId,
    workspaceSeed: gitId,
    primaryIndexBefore: gitId,
    workspaceAfter: nextGitId,
    status: 'FAILED',
    handoffState: 'PARENT_QUEUED',
    runnerPid: 999999999,
    runnerHeartbeatAt: new Date(0).toISOString(),
    leaseOwnerNonce: 'dead-owner',
    revertIntent: true,
    revertPaths: ['src/a.mjs'],
    revertExpectedTree: nextGitId,
  });
  let recoveryCleanups = 0,
    repairCleanups = 0;
  const config = {
    repoPath: process.cwd(),
    git: { branch: async () => 'main', head: async () => gitId },
    isolation: {
      create: async () => ({ path: '/private/tmp/offload-recovery-revert-repair-race/replacement/workspace', cleanup: async () => {} }),
      open: async () => {},
    },
  };
  const leases = { acquire: async () => {}, release: async () => true, list: async () => [] };
  const repair = new JobManager({ store, leases, config });
  repair.cleanupWorkspace = async () => {
    repairCleanups += 1;
    return true;
  };
  const recovery = new JobManager({ store, leases, config });
  recovery.cleanupWorkspace = async () => {
    // This is after recovery's exact lease release, immediately before its
    // destructive cleanup. A pre-reservation implementation let repair win
    // here and then cleaned repair's replacement workspace.
    await assert.rejects(() => repair.repair(job.id, ['continue'], { launch: false }), /job is still running/);
    recoveryCleanups += 1;
    return true;
  };
  assert.equal(await recovery.recover(), 1);
  const settled = await store.get(job.id);
  assert.equal(settled.status, 'FAILED');
  assert.equal(settled.revertIntent, false);
  assert.equal(recoveryCleanups, 1);
  assert.equal(repairCleanups, 0, 'repair must not clean or replace while recovery owns the terminal reservation');
});
test('recovery uses injected time and authoritative snapshot file names', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-recover-clock-`);
  const now = new Date(1_000);
  const store = new JobStore({ gitDir, now: () => now });
  const job = await store.create({
    repoPath: process.cwd(),
    task: 'recover',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: gitId,
    before: gitId,
    status: 'RUNNING',
    runnerPid: process.pid,
    runnerHeartbeatAt: now.toISOString(),
  });
  const m = new JobManager({
    store,
    now: () => now,
    snapshots: {
      create: async () => nextGitId,
      diff: async () => 'diff --git a/quoted b/incorrect\n',
      files: async () => [{ path: 'src/odd\nname.mjs', status: 'A' }],
    },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  assert.equal(await m.recover(), 0, 'a live current heartbeat must not be measured against wall-clock time');
  now.setTime(200_000);
  assert.equal(await m.recover(), 0, 'a suspended live PID must not be recovered solely because its heartbeat is old');
  await store.update(job.id, { runnerPid: 99999999 });
  assert.equal(await m.recover(), 1);
  const recovered = await store.get(job.id);
  assert.deepEqual(recovered.allFiles, [{ path: 'src/odd\nname.mjs', status: 'A' }]);
  assert.deepEqual(recovered.revertFiles, []);
});
test('scope attribution retains owned changes and exempts a live disjoint lease', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-scope-`);
  const patch =
    'diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\ndiff --git a/test/b.mjs b/test/b.mjs\n--- a/test/b.mjs\n+++ b/test/b.mjs\ndiff --git a/rogue.mjs b/rogue.mjs\n--- a/rogue.mjs\n+++ b/rogue.mjs\n';
  const m = new JobManager({
    store: new JobStore({ gitDir }),
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: { verify: async () => ({ command: 'true', verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
    snapshots: { create: async () => gitId, diff: async () => patch },
    leases: { acquire: async () => {}, release: async () => {}, list: async () => [{ jobId: 'other', ownedPaths: ['test/**'] }] },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  const started = await m.start({ task: 'x', ownedPaths: ['src/**'], repoPath: process.cwd(), testCommand: 'true' });
  await m.wait(started.jobId, { timeoutSec: 1 });
  const job = await m.store.get(started.jobId);
  assert.deepEqual(
    job.files.map((x) => x.path),
    ['src/a.mjs'],
  );
  assert.deepEqual(job.scopeViolations, ['rogue.mjs']);
});
test('review diffs retain outside-scope changes while revert artifacts never do', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-revert-artifact-`);
  const review =
    'diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\ndiff --git a/rogue.mjs b/rogue.mjs\n--- a/rogue.mjs\n+++ b/rogue.mjs\n';
  const owned = 'diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\n';
  let applied = 0;
  const m = new JobManager({
    store: new JobStore({ gitDir }),
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: { verify: async () => ({ command: 'true', verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
    snapshots: {
      create: async () => gitId,
      files: async () => [
        { path: 'src/a.mjs', status: 'M' },
        { path: 'rogue.mjs', status: 'M' },
      ],
      diff: async (_repo, _before, _after, options) => (options ? owned : review),
    },
    leases: { acquire: async () => {}, release: async () => {}, list: async () => [] },
    config: {
      repoPath: process.cwd(),
      git: { branch: async () => 'main', head: async () => gitId },
      applyPatch: async () => {
        applied += 1;
      },
    },
  });
  const started = await m.start({ task: 'scope split', ownedPaths: ['src/**'], repoPath: process.cwd(), testCommand: 'true' });
  assert.equal((await m.wait(started.jobId, { timeoutSec: 1 })).status, 'FAILED');
  const job = await m.store.get(started.jobId);
  assert.deepEqual(job.revertFiles, ['src/a.mjs']);
  assert.match(await m.store.readArtifact(started.jobId, 'patch.diff'), /rogue\.mjs/);
  assert.doesNotMatch(await m.store.readArtifact(started.jobId, 'revert.diff'), /rogue\.mjs/);
  await assert.rejects(() => m.revert(started.jobId), /scope violations/);
  await assert.rejects(() => m.revert(started.jobId, { apply: true }), /scope violations/);
  assert.equal(applied, 0);
});
test('scope attribution retains a disjoint peer that was queued first but began during this job', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-scope-queued-peer-`);
  let finish;
  const workerDone = new Promise((resolve) => {
    finish = resolve;
  });
  const store = new JobStore({ gitDir });
  const peer = await store.create({
    repoPath: process.cwd(),
    task: 'peer',
    ownedPaths: ['test/**'],
    branch: 'main',
    head: gitId,
    status: 'DONE_VERIFIED',
  });
  await pause(2);
  const patch =
    'diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\ndiff --git a/test/b.mjs b/test/b.mjs\n--- a/test/b.mjs\n+++ b/test/b.mjs\n';
  const m = new JobManager({
    store,
    worker: {
      run: async () => {
        await workerDone;
        return { status: 'DONE' };
      },
    },
    runner: { verify: async () => ({ command: 'true', verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
    snapshots: { create: async () => gitId, diff: async () => patch },
    leases: { acquire: async () => {}, release: async () => {}, list: async () => [] },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  const started = await m.start({ task: 'main', ownedPaths: ['src/**'], repoPath: process.cwd(), testCommand: 'true' });
  await pause(2);
  await store.update(peer.id, { startedAt: new Date().toISOString() });
  finish();
  assert.equal((await m.wait(started.jobId, { timeoutSec: 1 })).status, 'DONE_VERIFIED');
  const job = await store.get(started.jobId);
  assert.deepEqual(
    job.files.map((file) => file.path),
    ['src/a.mjs'],
  );
  assert.deepEqual(job.scopeViolations, []);
  assert.deepEqual(job.revertFiles, ['src/a.mjs']);
});
test('scope attribution retains a peer live at the baseline snapshot that releases before a later scan', async () => {
  const gitDir = await mkdtemp(`${tmpdir()}/offload-scope-live-peer-`);
  let finish,
    peerLive = true;
  const workerDone = new Promise((resolve) => {
    finish = resolve;
  });
  const store = new JobStore({ gitDir });
  const peer = await store.create({
    repoPath: process.cwd(),
    task: 'peer',
    ownedPaths: ['test/**'],
    branch: 'main',
    head: gitId,
    status: 'DONE_VERIFIED',
  });
  await store.update(peer.id, { startedAt: new Date(Date.now() - 1_000).toISOString() });
  const patch =
    'diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\ndiff --git a/test/b.mjs b/test/b.mjs\n--- a/test/b.mjs\n+++ b/test/b.mjs\n';
  const m = new JobManager({
    store,
    worker: {
      run: async () => {
        await workerDone;
        return { status: 'DONE' };
      },
    },
    runner: { verify: async () => ({ command: 'true', verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
    snapshots: {
      create: async () => {
        peerLive = false;
        return gitId;
      },
      diff: async () => patch,
    },
    leases: {
      acquire: async () => {},
      release: async () => {},
      list: async () => (peerLive ? [{ jobId: peer.id, ownedPaths: ['test/**'] }] : []),
    },
    config: { repoPath: process.cwd(), git: { branch: async () => 'main', head: async () => gitId } },
  });
  const started = await m.start({ task: 'main', ownedPaths: ['src/**'], repoPath: process.cwd(), testCommand: 'true' });
  finish();
  assert.equal((await m.wait(started.jobId, { timeoutSec: 1 })).status, 'DONE_VERIFIED');
  const job = await store.get(started.jobId);
  assert.deepEqual(job.concurrentScopes, ['test/**']);
  assert.deepEqual(job.scopeViolations, []);
  assert.deepEqual(job.revertFiles, ['src/a.mjs']);
});
