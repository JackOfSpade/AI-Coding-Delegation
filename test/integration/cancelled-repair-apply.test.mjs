import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../../src/store.mjs';
import { JobManager } from '../../src/job-manager.mjs';
import { gitPatchApplier, gitSnapshots } from '../../src/core.mjs';
import { compactReport } from '../../src/report.mjs';
import {
  cleanupIsolatedWorktree,
  createIsolatedWorktree,
  integrateRecordedTree,
  openIsolatedWorktree,
  pinJobTrees,
} from '../../src/worktree.mjs';
import { cleanup, git, makeRepo, write } from '../unit/helpers.mjs';
// A wait returns as soon as the job settles, so this bounds a hang, not the host's speed.
const WAIT_SEC = 55;
const VERIFIED_BY = 'node --test run by the primary after reading the diff';

// The real incident: the server's own verifier failed for an environmental
// reason, so it queued a repair round by itself, and the primary cancelled that
// pointless round. The reviewed round-N diff had to stay reviewable in the
// report and applicable through offload_apply. Only the worker and the command
// verifier are injected; worktrees, cancellation, capture and apply are real.

/** What `node --test` prints for an assertion failure, exit 1, in the macOS sandbox. */
const assertionFailure = () => ({
  command: 'node --test',
  verdict: 'FAIL',
  result: {
    code: 1,
    sandbox: 'macos',
    durationMs: 7,
    stdout: 'not ok 1 - adds\nAssertionError [ERR_ASSERTION]: expected 1 to equal 2\n1..1\n',
    stderr: '',
  },
});

const green = () => ({ command: 'node --test', verdict: 'PASS', result: { code: 0, sandbox: 'macos', stdout: 'ok\n', stderr: '' } });

/**
 * A real isolated JobManager whose verifier fails the first round (the server
 * then queues a repair itself). The round-0 worker adds `src/new.txt`; the
 * repair-round worker optionally edits it (`repairEdit`), then cancels the job
 * and ends, which is the incident this file exists for.
 */
async function harness({ repairEdit } = {}) {
  const repo = makeRepo();
  const gitDir = await mkdtemp(join(tmpdir(), 'offload-cancelled-repair-'));
  // The repair round starts after start() resolves, so the closure reads the
  // manager through a holder instead of a harness object that is not built yet.
  const holder = {};
  let runs = 0;
  let verifyCalls = 0;
  const manager = new JobManager({
    store: new JobStore({ gitDir }),
    snapshots: gitSnapshots(),
    worker: {
      run: async (job, api) => {
        runs += 1;
        if (runs === 1) {
          write(join(job.workspacePath, 'src', 'new.txt'), 'export const added = 2;\n');
          return { status: 'DONE' };
        }
        if (repairEdit) write(join(job.workspacePath, 'src', 'new.txt'), repairEdit);
        return cancelFromRepairRound(holder.manager, job, api);
      },
    },
    runner: {
      verify: async (command, options) => {
        verifyCalls += 1;
        return verifyCalls === 1 ? assertionFailure() : green(command, options);
      },
    },
    config: {
      repoPath: repo,
      git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
      applyPatch: gitPatchApplier,
      isolation: {
        create: createIsolatedWorktree,
        open: openIsolatedWorktree,
        cleanup: cleanupIsolatedWorktree,
        integrateRecorded: integrateRecordedTree,
        pin: pinJobTrees,
      },
    },
  });
  const started = await manager.start({ task: 'add a file', ownedPaths: ['src/**'], repoPath: repo, testCommand: 'node --test' });
  holder.manager = manager;
  return {
    repo,
    manager,
    store: manager.store,
    id: started.jobId,
    runs: () => runs,
    settle: () => manager.wait(started.jobId, { timeoutSec: WAIT_SEC, detail: 'full' }),
    finish: () => cleanup(repo),
  };
}

/** Cancel the job from inside the repair round and wait for its abort, so the round ends cancelled without touching the workspace. */
const cancelFromRepairRound = async (manager, job, api) => {
  await manager.cancel(job.id);
  for (let waited = 0; waited < 2_000 && !api.signal?.aborted; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  return {};
};

test('a job cancelled during its automatic repair keeps the round-0 verdict and its unchanged diff can still be applied', async () => {
  const h = await harness();
  try {
    const done = await h.settle();
    assert.equal(done.status, 'CANCELLED');
    assert.equal(h.runs(), 2, 'the server queued the repair round by itself and the round-1 worker ran');
    const job = await h.store.get(h.id);
    assert.equal(job.status, 'CANCELLED');
    assert.equal(job.repairBase.round, 0);
    assert.equal(job.repairBase.auto, true);
    assert.equal(job.verify, undefined, 'the repair requeue reset the live verifier state');
    const report = compactReport(job, { detail: 'compact' });
    assert.match(report, /verify \(round 0, before the automatic repair that was cancelled\): `node --test` FAIL \(exit 1\)/);
    assert.match(report, /AssertionError \[ERR_ASSERTION\]: expected 1 to equal 2/);
    assert.doesNotMatch(report, /verify: not run/);

    const dry = await h.manager.apply(h.id);
    assert.notEqual(dry.applied, true);
    assert.deepEqual(dry.cancelledDuringRepair, { round: 0 });

    const applied = await h.manager.apply(h.id, { apply: true, verifiedBy: VERIFIED_BY });
    assert.equal(applied.applied, true);
    assert.equal(existsSync(join(h.repo, 'src', 'new.txt')), true);
    assert.equal((await h.store.get(h.id)).status, 'DONE_UNVERIFIED');
  } finally {
    await h.finish();
  }
});

test('a repair round that changed the diff before the cancel is refused with the round-0 reason', async () => {
  const h = await harness({ repairEdit: 'export const added = 3;\n' });
  try {
    const done = await h.settle();
    assert.equal(done.status, 'CANCELLED');
    const job = await h.store.get(h.id);
    assert.equal(job.repairBase.round, 0);
    assert.notEqual(job.workspaceAfter, job.repairBase.workspaceAfter, 'the repair round captured a different tree');
    const report = compactReport(job, { detail: 'compact' });
    assert.match(report, /verify \(round 0, before the automatic repair that was cancelled\):/);
    assert.match(report, /apply: BLOCKED: the cancelled repair round changed the diff after round 0/);
    await assert.rejects(
      () => h.manager.apply(h.id),
      /the cancelled repair round changed the diff after round 0, so it is not the reviewed round-0 diff/,
    );
    await assert.rejects(
      () => h.manager.apply(h.id, { apply: true, verifiedBy: VERIFIED_BY }),
      /the cancelled repair round changed the diff after round 0, so it is not the reviewed round-0 diff/,
    );
    assert.equal(existsSync(join(h.repo, 'src', 'new.txt')), false);
  } finally {
    await h.finish();
  }
});
