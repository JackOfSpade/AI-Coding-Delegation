import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../../src/store.mjs';
import { JobManager } from '../../src/job-manager.mjs';
import { gitPatchApplier, gitSnapshots } from '../../src/core.mjs';
import { cleanupIsolatedWorktree, createIsolatedWorktree, integrateRecordedTree, openIsolatedWorktree } from '../../src/worktree.mjs';
import { cleanup, git, makeRepo, write } from '../unit/helpers.mjs';

const WAIT_SEC = 15;
const ENV_STDERR =
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'jsdom' imported from /private/var/x/workspace/scripts/tests/testHelpers.js";

/** A real isolated-worktree manager with an injected worker and verifier. */
async function harness({ worker, verify, withIntegrateRecorded = true }) {
  const repo = makeRepo();
  const gitDir = await mkdtemp(`${tmpdir()}/offload-late-`);
  const counters = { runs: 0, verifies: 0, defects: [] };
  const manager = new JobManager({
    store: new JobStore({ gitDir }),
    snapshots: gitSnapshots(),
    worker: {
      run: async (job, api) => {
        counters.runs += 1;
        counters.defects.push(api.defects);
        return worker(job, counters.runs, api);
      },
    },
    runner: {
      verify: async (...args) => {
        counters.verifies += 1;
        return verify(...args);
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
        ...(withIntegrateRecorded ? { integrateRecorded: integrateRecordedTree } : {}),
      },
    },
  });
  const settle = async (jobId) => manager.wait(jobId, { timeoutSec: WAIT_SEC, detail: 'full' });
  return { repo, manager, counters, settle };
}
const envFail = () => ({ command: 'npm test', verdict: 'FAIL', result: { code: 1, stderr: ENV_STDERR, sandbox: 'macos' } });
const pass = () => ({ command: 'npm test', verdict: 'PASS', result: { code: 0, sandbox: 'macos' } });
const codeFail = () => ({
  command: 'npm test',
  verdict: 'FAIL',
  result: { code: 1, stderr: 'AssertionError: expected 1 to equal 2', sandbox: 'macos' },
});
const writeSrc = (job, name, body = `${name}\n`) => write(join(job.workspacePath, 'src', name), body);
const startEnvJob = async (h, request = {}) => {
  const started = await h.manager.start({ task: 'env', ownedPaths: ['src/**'], repoPath: h.repo, testCommand: 'npm test', ...request });
  return { started, done: await h.settle(started.jobId) };
};

test('an environmental verifier failure is terminal, spends no repair round or budget, and keeps the diff reviewable', async () => {
  const h = await harness({
    worker: async (job) => {
      writeSrc(job, 'a.js', 'export const a = 1;\n');
      return { status: 'DONE', turns: 3, costUsd: 0.01 };
    },
    verify: envFail,
  });
  try {
    const { started, done } = await startEnvJob(h, { maxRepairRounds: 2 });
    assert.equal(done.status, 'VERIFY_ENV_FAILED');
    assert.equal(h.counters.runs, 1, 'the worker must not be run again for an environment failure');
    assert.equal(h.counters.verifies, 1, 'the verifier is never retried');
    const job = await h.manager.store.get(started.jobId);
    assert.equal(job.rounds ?? 0, 0);
    assert.equal(job.turns, 3);
    assert.equal(job.costUsd, 0.01);
    assert.equal(job.applied === true, false, 'an unverified result is never integrated automatically');
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    assert.deepEqual(done.verifyEnvironment, {
      kind: 'missing-package',
      detail: "package 'jsdom' could not be resolved",
      specifier: 'jsdom',
    });
    assert.match(await h.manager.store.readArtifact(started.jobId, 'patch.diff'), /src\/a\.js/);
    assert.match(done.report, /verifier environment: package 'jsdom' could not be resolved/);
    assert.match(done.report, /next: .*apply/);
    assert.doesNotMatch(done.report, /next: .*\brepair\b/);
    assert.equal(existsSync(job.workspacePath), false, 'the worktree is cleaned like any terminal job');
    assert.equal((await h.manager.job(started.jobId)).verifyEnvironment.kind, 'missing-package');
  } finally {
    cleanup(h.repo);
  }
});

test('an ordinary assertion failure is still a repairable VERIFY_FAILED, not an environment failure', async () => {
  let pending = true;
  const h = await harness({
    worker: async (job, run) => {
      writeSrc(job, 'a.js', `run ${run}\n`);
      return { status: 'DONE', turns: 1 };
    },
    verify: () => (pending ? ((pending = false), codeFail()) : pass()),
  });
  try {
    const { started, done } = await startEnvJob(h);
    assert.equal(done.status, 'DONE_VERIFIED');
    assert.equal(h.counters.runs, 2, 'the code failure was repaired automatically');
    assert.equal((await h.manager.store.get(started.jobId)).rounds, 1);
    assert.equal(done.verifyEnvironment, undefined);
  } finally {
    cleanup(h.repo);
  }
});

test("apply dry-run previews, apply requires the primary's own evidence, then integrates with revert support", async () => {
  const h = await harness({
    worker: async (job) => {
      writeSrc(job, 'a.js', 'export const a = 1;\n');
      return { status: 'DONE', turns: 2 };
    },
    verify: envFail,
  });
  try {
    const { started } = await startEnvJob(h);
    const id = started.jobId;
    write(join(h.repo, 'unrelated.txt'), 'primary work in progress\n');
    assert.deepEqual(await h.manager.apply(id), { dryRun: true, applied: false, files: ['src/a.js'], fromStatus: 'VERIFY_ENV_FAILED' });
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false, 'a dry run never writes');
    for (const verifiedBy of [undefined, '', 'short', 'x'.repeat(1001)])
      await assert.rejects(() => h.manager.apply(id, { apply: true, verifiedBy }), /verifiedBy must state the check you ran/);
    await assert.rejects(() => h.manager.apply(id, { apply: 'true', verifiedBy: 'ran npm test in the primary' }), /apply must be boolean/);
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    const evidence = 'npm test in primary checkout: 412 pass, 0 fail';
    const applied = await h.manager.apply(id, { apply: true, verifiedBy: evidence });
    assert.deepEqual(applied, {
      dryRun: false,
      applied: true,
      files: ['src/a.js'],
      previousStatus: 'VERIFY_ENV_FAILED',
      status: 'DONE_UNVERIFIED',
    });
    assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), 'export const a = 1;\n');
    assert.equal(await readFile(join(h.repo, 'unrelated.txt'), 'utf8'), 'primary work in progress\n');
    assert.equal(git(h.repo, ['diff', '--cached', '--name-only']), '', 'the primary index is left alone');
    const job = await h.manager.store.get(id);
    assert.equal(job.status, 'DONE_UNVERIFIED');
    assert.equal(job.applied, true);
    assert.equal(job.integrationIntent, false);
    assert.equal(job.error, undefined);
    assert.equal(job.appliedUnverified.verifiedBy, evidence);
    assert.equal(job.appliedUnverified.previousStatus, 'VERIFY_ENV_FAILED');
    const view = await h.manager.job(id);
    assert.equal(view.appliedUnverified, true);
    assert.match(
      view.report,
      /applied WITHOUT server verification \(was VERIFY_ENV_FAILED\); primary's own check: npm test in primary checkout/,
    );
    assert.match(await h.manager.store.readArtifact(id, 'report.md'), /applied WITHOUT server verification/);
    // The same safety net as automatic integration: it can be undone, and only once.
    await assert.rejects(() => h.manager.apply(id, { apply: true, verifiedBy: evidence }), /already applied/);
    assert.deepEqual(await h.manager.revert(id), { dryRun: true, applied: false });
    assert.deepEqual(await h.manager.revert(id, { apply: true }), { dryRun: false, applied: true });
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    assert.equal(await readFile(join(h.repo, 'unrelated.txt'), 'utf8'), 'primary work in progress\n');
  } finally {
    cleanup(h.repo);
  }
});

test('apply refuses on a primary conflict, a moved HEAD, or a drifted index, and changes nothing', async () => {
  for (const scenario of ['conflict', 'head', 'index']) {
    const h = await harness({
      worker: async (job) => {
        writeSrc(job, 'a.js', 'worker\n');
        return { status: 'DONE', turns: 1 };
      },
      verify: envFail,
    });
    try {
      const { started } = await startEnvJob(h);
      const id = started.jobId;
      if (scenario === 'conflict') write(join(h.repo, 'src', 'a.js'), 'primary wrote this first\n');
      if (scenario === 'head') {
        write(join(h.repo, 'other.txt'), 'x\n');
        git(h.repo, ['add', 'other.txt']);
        git(h.repo, ['commit', '-m', 'move head']);
      }
      if (scenario === 'index') {
        write(join(h.repo, 'src', 'a.js'), 'staged\n');
        git(h.repo, ['add', 'src/a.js']);
      }
      const expected = { conflict: /changed on a job-touched path/, head: /stale.*HEAD/, index: /stale.*index/ }[scenario];
      await assert.rejects(() => h.manager.apply(id), expected, `${scenario} dry run`);
      await assert.rejects(
        () => h.manager.apply(id, { apply: true, verifiedBy: 'ran the tests myself in primary' }),
        expected,
        `${scenario} apply`,
      );
      const job = await h.manager.store.get(id);
      assert.equal(job.status, 'VERIFY_ENV_FAILED', 'a refused apply leaves the job exactly as it was');
      assert.equal(job.applied === true, false);
      assert.equal(job.integrationIntent === true, false);
      if (scenario === 'conflict') assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), 'primary wrote this first\n');
      else if (scenario === 'head') assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    } finally {
      cleanup(h.repo);
    }
  }
});

test('apply is limited to jobs the server did not integrate, and never to scope violations or report jobs', async () => {
  const verified = await harness({
    worker: async (job) => (writeSrc(job, 'ok.js'), { status: 'DONE', turns: 1 }),
    verify: pass,
  });
  const violating = await harness({
    worker: async (job) => (write(join(job.workspacePath, 'outside.txt'), 'x\n'), writeSrc(job, 'a.js'), { status: 'BUDGET', turns: 1 }),
    verify: envFail,
  });
  const empty = await harness({ worker: async () => ({ status: 'BUDGET', turns: 1 }), verify: envFail });
  const nonIsolated = await harness({
    worker: async (job) => (writeSrc(job, 'a.js'), { status: 'DONE', turns: 1 }),
    verify: envFail,
    withIntegrateRecorded: false,
  });
  try {
    const ok = await startEnvJob(verified);
    assert.equal(ok.done.status, 'DONE_VERIFIED');
    await assert.rejects(
      () => verified.manager.apply(ok.started.jobId, { apply: true, verifiedBy: 'ran the tests myself' }),
      /already applied/,
    );
    const bad = await startEnvJob(violating);
    assert.equal(bad.done.status, 'FAILED');
    await assert.rejects(() => violating.manager.apply(bad.started.jobId), /cannot be applied this way|scope or verifier-authorship/);
    const none = await startEnvJob(empty);
    assert.equal(none.done.status, 'BUDGET');
    await assert.rejects(() => empty.manager.apply(none.started.jobId), /no in-scope changes/);
    const unavailable = await startEnvJob(nonIsolated);
    await assert.rejects(() => nonIsolated.manager.apply(unavailable.started.jobId), /late integration is unavailable/);
    await assert.rejects(() => verified.manager.apply('oj-missing-job'), /not found/i);
  } finally {
    for (const h of [verified, violating, empty, nonIsolated]) cleanup(h.repo);
  }
});

test('apply serializes with a running job through the write-scope lease and is single-flight', async () => {
  const h = await harness({
    worker: async (job) => (writeSrc(job, 'a.js'), { status: 'DONE', turns: 1 }),
    verify: envFail,
  });
  try {
    const { started } = await startEnvJob(h);
    const id = started.jobId;
    const evidence = 'ran the tests myself in primary';
    const results = await Promise.allSettled([
      h.manager.apply(id, { apply: true, verifiedBy: evidence }),
      h.manager.apply(id, { apply: true, verifiedBy: evidence }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    assert.match(String(results.find((result) => result.status === 'rejected').reason.message), /busy|already applied/);
    assert.equal((await h.manager.store.get(id)).applied, true);
  } finally {
    cleanup(h.repo);
  }
});

test('continue refreshes the stored turn-budget record so the report never shows the pre-continuation cap', async () => {
  const h = await harness({
    worker: async (job, run) => {
      writeSrc(job, `f${run}.js`);
      return { status: 'BUDGET', turns: 30, costUsd: 0.01, budgetCap: 'turns' };
    },
    verify: pass,
  });
  try {
    // 720,000 bytes is 30 read pages: recommended ceil(1.25 x (6 + 4 + 30)) = 50 turns, above the explicit cap of 30.
    write(join(h.repo, 'src', 'big.js'), `${'x'.repeat(79)}\n`.repeat(9_000));
    git(h.repo, ['add', '.']);
    git(h.repo, ['commit', '-m', 'big file']);
    const started = await h.manager.start(
      {
        task: 'big',
        ownedPaths: ['src/**'],
        relevantPaths: ['src/big.js'],
        repoPath: h.repo,
        testCommand: 'npm test',
        budget: { maxTurns: 30, maxUsd: 1, timeoutMinutes: 5 },
      },
      { turnBudget: { requested: 30, configured: 80, policy: 'fixed' } },
    );
    const id = started.jobId;
    const first = await h.settle(id);
    assert.equal(first.status, 'BUDGET');
    assert.match(first.report, /turn budget: 30 \(caller; recommended \d+\) - maxTurns 30 is below the recommended/);

    await h.manager.continue(id, { extraTurns: 30 });
    const second = await h.settle(id);
    assert.equal(second.status, 'BUDGET');
    const stored = await h.manager.store.get(id);
    assert.equal(stored.budget.maxTurns, 60);
    assert.equal(stored.budgetSizing.maxTurns, 60, 'the sizing record follows the raised cap');
    assert.equal(stored.budgetSizing.turnsSource, 'raised');
    assert.deepEqual(stored.budgetSizing.warnings, [], 'the raised cap covers the recommendation');
    assert.equal(second.budgetSizing.maxTurns, 60);
    assert.match(second.report, /budget stop: TURN cap reached \(60\/60 turns/);
    assert.doesNotMatch(second.report, /turn budget:/);
    assert.doesNotMatch(second.report, /below the recommended/);
  } finally {
    cleanup(h.repo);
  }
});

test("continue keeps a BUDGET job's work and conversation, raises the cap, and ends verified and integrated", async () => {
  const h = await harness({
    worker: async (job, run) => {
      if (run === 1) {
        writeSrc(job, 'first.js', 'first\n');
        return { status: 'BUDGET', turns: 4, costUsd: 0.02, error: 'Maximum turns reached', budgetCap: 'turns' };
      }
      assert.equal(
        await readFile(join(job.workspacePath, 'src', 'first.js'), 'utf8'),
        'first\n',
        'the partial work is already in the new workspace',
      );
      writeSrc(job, 'second.js', 'second\n');
      return { status: 'DONE', turns: 3, costUsd: 0.01 };
    },
    verify: pass,
  });
  try {
    const started = await h.manager.start({
      task: 'big',
      ownedPaths: ['src/**'],
      repoPath: h.repo,
      testCommand: 'npm test',
      budget: { maxTurns: 4, maxUsd: 1, timeoutMinutes: 5 },
    });
    const id = started.jobId;
    assert.equal((await h.settle(id)).status, 'BUDGET');
    assert.equal(existsSync(join(h.repo, 'src', 'first.js')), false);
    assert.match((await h.manager.job(id)).report, /next: .*\bcontinue\b/);
    assert.deepEqual((await h.manager.store.get(id)).budgetStop, { cap: 'turns', turns: 4, maxTurns: 4, costUsd: 0.02, maxUsd: 1 });
    assert.match((await h.manager.job(id)).report, /budget stop: TURN cap reached \(4\/4 turns; \$0\.02 of \$1\.00 spent/);
    // Without an increase the cap that stopped the job is still hit: say so, spend nothing.
    await assert.rejects(() => h.manager.continue(id), /a BUDGET stop needs extraTurns and\/or extraUsd/);
    await assert.rejects(() => h.manager.continue(id, { extraUsd: 1 }), /still exhausted/);
    for (const bad of [
      { extraTurns: 0 },
      { extraTurns: 501 },
      { extraTurns: 1.5 },
      { extraUsd: 0 },
      { extraUsd: 51 },
      { extraUsd: Number.NaN },
      { note: '' },
    ])
      await assert.rejects(() => h.manager.continue(id, bad), /extraTurns|extraUsd|note/, JSON.stringify(bad));
    assert.equal(h.counters.runs, 1);
    const continued = await h.manager.continue(id, { extraTurns: 10, note: 'only the tests remain' });
    assert.equal(continued.status, 'QUEUED');
    const done = await h.settle(id);
    assert.equal(done.status, 'DONE_VERIFIED');
    const job = await h.manager.store.get(id);
    assert.equal(job.budget.maxTurns, 14);
    assert.equal(job.budget.maxUsd, 1);
    assert.equal(job.rounds, 1, "a continuation consumes one of the job's rounds");
    assert.equal(job.continuations, 1);
    assert.equal(job.error, undefined, "the BUDGET round's error does not survive onto the verified result");
    assert.equal(job.budgetStop, undefined, "the BUDGET round's stop does not survive onto the verified result");
    assert.doesNotMatch((await h.manager.job(id)).report, /budget stop:/);
    assert.doesNotMatch((await h.manager.job(id)).report, /\berror:/);
    assert.equal(job.turns, 7, 'turns stay cumulative across the whole job');
    assert.equal(job.costUsd, 0.03);
    assert.equal(h.counters.runs, 2);
    assert.match(h.counters.defects[1][0], /stopped at its turn, cost, or time cap/);
    assert.equal(h.counters.defects[1][1], "Primary's note: only the tests remain");
    assert.equal(await readFile(join(h.repo, 'src', 'first.js'), 'utf8'), 'first\n');
    assert.equal(await readFile(join(h.repo, 'src', 'second.js'), 'utf8'), 'second\n');
  } finally {
    cleanup(h.repo);
  }
});

test('continue raises the dollar cap, honors the repair-round limit, and refuses anything that is not a kept cap stop', async () => {
  const stop =
    (status, costUsd = 0.5) =>
    async (job) => (writeSrc(job, 'work.js'), { status, turns: 2, costUsd });
  // maxUsd was the binding cap.
  const money = await harness({
    worker: async (job, run) => (run === 1 ? stop('BUDGET')(job) : (writeSrc(job, 'more.js'), { status: 'DONE', turns: 1, costUsd: 0.1 })),
    verify: pass,
  });
  // A TIMEOUT needs no extra budget: the clock restarts with each round.
  const clock = await harness({
    worker: async (job, run) => (run === 1 ? stop('TIMEOUT', 0.1)(job) : { status: 'DONE', turns: 1 }),
    verify: pass,
  });
  const noRounds = await harness({ worker: stop('BUDGET'), verify: pass });
  const verifyFail = await harness({ worker: async (job) => (writeSrc(job, 'x.js'), { status: 'DONE', turns: 1 }), verify: codeFail });
  const emptyStop = await harness({ worker: async () => ({ status: 'BUDGET', turns: 1 }), verify: pass });
  try {
    const budget = { maxTurns: 50, maxUsd: 0.5, timeoutMinutes: 5 };
    const a = await money.manager.start({ task: 'money', ownedPaths: ['src/**'], repoPath: money.repo, testCommand: 'npm test', budget });
    assert.equal((await money.settle(a.jobId)).status, 'BUDGET');
    await assert.rejects(() => money.manager.continue(a.jobId, { extraTurns: 10 }), /still exhausted/);
    await money.manager.continue(a.jobId, { extraUsd: 0.25 });
    assert.equal((await money.settle(a.jobId)).status, 'DONE_VERIFIED');
    assert.equal((await money.manager.store.get(a.jobId)).budget.maxUsd, 0.75);

    const b = await clock.manager.start({ task: 'clock', ownedPaths: ['src/**'], repoPath: clock.repo, testCommand: 'npm test', budget });
    assert.equal((await clock.settle(b.jobId)).status, 'TIMEOUT');
    await clock.manager.continue(b.jobId);
    assert.equal((await clock.settle(b.jobId)).status, 'DONE_VERIFIED');
    assert.deepEqual((await clock.manager.store.get(b.jobId)).budget, budget, 'no increase requested, none applied');

    const c = await noRounds.manager.start({
      task: 'rounds',
      ownedPaths: ['src/**'],
      repoPath: noRounds.repo,
      testCommand: 'npm test',
      budget,
      maxRepairRounds: 0,
    });
    assert.equal((await noRounds.settle(c.jobId)).status, 'BUDGET');
    await assert.rejects(() => noRounds.manager.continue(c.jobId, { extraTurns: 5 }), /maximum repair rounds reached/);

    const d = await verifyFail.manager.start({
      task: 'vf',
      ownedPaths: ['src/**'],
      repoPath: verifyFail.repo,
      testCommand: 'npm test',
      maxRepairRounds: 0,
    });
    assert.equal((await verifyFail.settle(d.jobId)).status, 'VERIFY_FAILED');
    await assert.rejects(
      () => verifyFail.manager.continue(d.jobId, { extraTurns: 5 }),
      /only a job that stopped on BUDGET or TIMEOUT.*VERIFY_FAILED.*offload_repair/,
    );

    const e = await emptyStop.manager.start({
      task: 'empty',
      ownedPaths: ['src/**'],
      repoPath: emptyStop.repo,
      testCommand: 'npm test',
      budget,
    });
    assert.equal((await emptyStop.settle(e.jobId)).status, 'BUDGET');
    await assert.rejects(() => emptyStop.manager.continue(e.jobId, { extraTurns: 5 }), /no in-scope changes to continue from/);
    assert.doesNotMatch((await emptyStop.manager.job(e.jobId)).report, /next: .*\bcontinue\b/);
  } finally {
    for (const h of [money, clock, noRounds, verifyFail, emptyStop]) cleanup(h.repo);
  }
});

test('a continued job can also be applied after a second cap stop, and a repair cannot bypass the raised cap', async () => {
  const h = await harness({
    worker: async (job, run) => (writeSrc(job, `r${run}.js`), { status: 'BUDGET', turns: 4, costUsd: 0.01 }),
    verify: pass,
  });
  try {
    const started = await h.manager.start({
      task: 'again',
      ownedPaths: ['src/**'],
      repoPath: h.repo,
      testCommand: 'npm test',
      budget: { maxTurns: 4, maxUsd: 1, timeoutMinutes: 5 },
    });
    const id = started.jobId;
    assert.equal((await h.settle(id)).status, 'BUDGET');
    // repair is not a way around the cumulative cap.
    await assert.rejects(() => h.manager.repair(id, ['just keep going']), /cumulative job budget exhausted/);
    await h.manager.continue(id, { extraTurns: 4 });
    assert.equal((await h.settle(id)).status, 'BUDGET');
    assert.equal((await h.manager.store.get(id)).turns, 8);
    // Both rounds' work is in the recorded result, and the primary can take it after its own check.
    assert.deepEqual((await h.manager.apply(id)).files.sort(), ['src/r1.js', 'src/r2.js']);
    await h.manager.apply(id, { apply: true, verifiedBy: 'read the partial diff and ran tests in primary' });
    assert.equal(existsSync(join(h.repo, 'src', 'r1.js')) && existsSync(join(h.repo, 'src', 'r2.js')), true);
    await assert.rejects(() => h.manager.continue(id, { extraTurns: 1 }), /only a job that stopped on BUDGET or TIMEOUT/);
  } finally {
    cleanup(h.repo);
  }
});

test('job and wait are compact by default: include diff returns only the diff, and detail full restores the report', async () => {
  const h = await harness({
    worker: async (job) => (
      writeSrc(job, 'a.js', 'export const a = 1;\n'),
      { status: 'DONE', turns: 1, summary: 'x'.repeat(900), concerns: ['y'.repeat(900)] }
    ),
    verify: () => ({
      command: 'npm test',
      verdict: 'FAIL',
      result: { code: 1, stderr: Array.from({ length: 60 }, (_, index) => `fail line ${index}`).join('\n'), sandbox: 'macos' },
    }),
  });
  try {
    const started = await h.manager.start({
      task: 'lean',
      ownedPaths: ['src/**'],
      repoPath: h.repo,
      testCommand: 'npm test',
      maxRepairRounds: 0,
    });
    const id = started.jobId;
    const lean = await h.manager.wait(id, { timeoutSec: WAIT_SEC });
    assert.equal(lean.done, true);
    assert.equal(lean.report.split('\n').filter((line) => line.startsWith('  | ')).length, 20);
    assert.match(lean.report, /\| fail line 59/);
    assert.doesNotMatch(lean.report, /\| fail line 39\n/);
    assert.ok(lean.report.length < 1700, `${lean.report.length}`);
    const full = await h.manager.wait(id, { timeoutSec: WAIT_SEC, detail: 'full' });
    assert.equal(full.report.split('\n').filter((line) => line.startsWith('  | ')).length, 40);
    assert.ok(full.report.length > lean.report.length);

    const diff = await h.manager.job(id, { include: 'diff' });
    assert.deepEqual(Object.keys(diff).sort(), ['diff', 'jobId', 'status']);
    assert.match(diff.diff, /export const a = 1/);
    assert.deepEqual(Object.keys(await h.manager.job(id, { include: 'files' })).sort(), ['files', 'jobId', 'status']);
    assert.deepEqual(Object.keys(await h.manager.job(id, { include: 'log' })).sort(), ['jobId', 'log', 'logInfo', 'status']);
    const summary = await h.manager.job(id);
    assert.equal(summary.report, lean.report);
    assert.equal(summary.diff, undefined);
    const legacy = await h.manager.job(id, { include: 'diff', detail: 'full' });
    assert.match(legacy.diff, /export const a/);
    assert.match(legacy.report, /worker summary: x{900}/, 'detail full restores the complete report alongside the diff');
    assert.match(summary.report, /worker summary: x{300}(?!x)/);
    await assert.rejects(() => h.manager.job(id, { detail: 'verbose' }), /detail must be compact or full/);
    await assert.rejects(() => h.manager.wait(id, { detail: 'verbose' }), /detail must be compact or full/);
    await assert.rejects(() => h.manager.job(id, { include: 'nope' }), /include must be/);
  } finally {
    cleanup(h.repo);
  }
});

test('waiting on an unchanged running job returns a few-token marker instead of repeating the payload', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const h = await harness({
    worker: async (job, _run, api) => {
      await api.progress({ turn: 1, action: 'read_file src/a.js' });
      await gate;
      writeSrc(job, 'a.js');
      return { status: 'DONE', turns: 2 };
    },
    verify: pass,
  });
  try {
    const started = await h.manager.start({ task: 'poll', ownedPaths: ['src/**'], repoPath: h.repo, testCommand: 'npm test' });
    const id = started.jobId;
    let first;
    for (let attempt = 0; attempt < 100 && !first?.progress?.turns; attempt += 1) {
      first = await h.manager.wait(id, { timeoutSec: 0 });
      if (!first.progress?.turns) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(first.done, false);
    assert.equal(first.unchanged, undefined);
    assert.deepEqual(first.progress.recentActions, ['read_file src/a.js']);
    const second = await h.manager.wait(id, { timeoutSec: 0 });
    assert.deepEqual(Object.keys(second).sort(), ['done', 'jobId', 'progress', 'status', 'unchanged']);
    assert.equal(second.unchanged, true);
    assert.ok(JSON.stringify(second).length < 200);
    const repeat = await h.manager.wait(id, { timeoutSec: 0, detail: 'full' });
    assert.equal(repeat.unchanged, undefined, 'detail full always repeats');
    assert.deepEqual(repeat.progress.recentActions, ['read_file src/a.js']);
    release();
    const done = await h.settle(id);
    assert.equal(done.status, 'DONE_VERIFIED');
    // The marker memory is per running job and dropped at completion.
    assert.equal(h.manager.lastWaitSignature.has(id), false);
  } finally {
    release?.();
    cleanup(h.repo);
  }
});

test('a started job reports verifier dependency readiness before any budget is spent on a test that cannot pass', async () => {
  const cases = [
    { name: 'not a JavaScript project', setup: () => {}, expected: { verifierDeps: 'not-applicable' } },
    {
      name: 'manifest but nothing installed',
      setup: (repo) => write(join(repo, 'package.json'), '{"name":"x"}\n'),
      expected: { verifierDeps: 'missing', verifierDepsReason: 'absent' },
    },
    {
      name: 'installed',
      setup: (repo) => (
        write(join(repo, 'package.json'), '{"name":"x"}\n'),
        write(join(repo, 'node_modules', 'jsdom', 'index.js'), 'module.exports = 1;\n')
      ),
      expected: { verifierDeps: 'ok' },
    },
    {
      name: 'installed, but with nested workspace node_modules that are not mounted',
      setup: (repo) => {
        write(join(repo, 'package.json'), '{"name":"x"}\n');
        write(join(repo, 'node_modules', 'jsdom', 'index.js'), 'module.exports = 1;\n');
        write(join(repo, 'packages', 'a', 'node_modules', 'only-here', 'index.js'), 'module.exports = 2;\n');
      },
      expected: { verifierDeps: 'partial', verifierDepsReason: 'nested-node-modules', verifierDepsNested: 1 },
    },
  ];
  for (const { name, setup, expected } of cases) {
    const h = await harness({ worker: async () => ({ status: 'DONE', turns: 1 }), verify: pass });
    try {
      write(join(h.repo, '.gitignore'), 'node_modules/\n');
      git(h.repo, ['add', '.gitignore']);
      git(h.repo, ['commit', '-m', 'ignore']);
      setup(h.repo);
      const started = await h.manager.start({ task: 'deps', ownedPaths: ['src/**'], repoPath: h.repo, testCommand: 'npm test' });
      const got = Object.fromEntries(Object.entries(started).filter(([key]) => key.startsWith('verifierDeps')));
      assert.deepEqual(got, expected, name);
      assert.equal(JSON.stringify(started).includes(`${h.repo}/node_modules`), false, 'no host path in the public record');
      await h.settle(started.jobId);
    } finally {
      cleanup(h.repo);
    }
  }
});

test('a repair after an environment failure does not leave the stale classification on the new result', async () => {
  let verifies = 0;
  const h = await harness({
    worker: async (job, run) => (writeSrc(job, `r${run}.js`), { status: 'DONE', turns: 1 }),
    verify: () => ((verifies += 1), verifies === 1 ? envFail() : pass()),
  });
  try {
    const { started, done } = await startEnvJob(h);
    assert.equal(done.status, 'VERIFY_ENV_FAILED');
    await h.manager.repair(started.jobId, ['dependencies are now installed; finish']);
    const fixed = await h.settle(started.jobId);
    assert.equal(fixed.status, 'DONE_VERIFIED');
    assert.equal(fixed.verifyEnvironment, undefined);
    assert.doesNotMatch(fixed.report, /verifier environment/);
    assert.equal((await h.manager.store.get(started.jobId)).verifyEnvironment, undefined);
  } finally {
    cleanup(h.repo);
  }
});

test('a repair round that stops on a cap stays BUDGET with its work, so continue and apply remain reachable', async () => {
  let verifies = 0;
  const h = await harness({
    worker: async (job, run) => {
      writeSrc(job, `round${run}.js`);
      return run === 1 ? { status: 'DONE', turns: 2 } : run === 2 ? { status: 'BUDGET', turns: 3 } : { status: 'DONE', turns: 1 };
    },
    verify: () => ((verifies += 1), verifies === 1 ? codeFail() : pass()),
  });
  try {
    const started = await h.manager.start({
      task: 'cap in round two',
      ownedPaths: ['src/**'],
      repoPath: h.repo,
      testCommand: 'npm test',
      budget: { maxTurns: 5, maxUsd: 1, timeoutMinutes: 5 },
    });
    const id = started.jobId;
    const capped = await h.settle(id);
    assert.equal(capped.status, 'BUDGET', `${capped.status}: ${capped.error}`);
    const job = await h.manager.store.get(id);
    assert.deepEqual(job.scopeViolations, []);
    assert.deepEqual(job.verifierMutations, []);
    assert.deepEqual(job.files.map((file) => file.path).sort(), ['src/round1.js', 'src/round2.js']);
    assert.match(capped.report, /next: .*continue/);
    await h.manager.continue(id, { extraTurns: 5 });
    assert.equal((await h.settle(id)).status, 'DONE_VERIFIED');
    assert.equal(existsSync(join(h.repo, 'src', 'round3.js')), true);
  } finally {
    cleanup(h.repo);
  }
});

test('continue refuses an increase that would pass the cumulative ceiling, naming it', async () => {
  const h = await harness({ worker: async (job) => (writeSrc(job, 'a.js'), { status: 'BUDGET', turns: 600 }), verify: pass });
  try {
    const started = await h.manager.start({
      task: 'ceiling',
      ownedPaths: ['src/**'],
      repoPath: h.repo,
      testCommand: 'npm test',
      budget: { maxTurns: 600, maxUsd: 1, timeoutMinutes: 5 },
    });
    assert.equal((await h.settle(started.jobId)).status, 'BUDGET');
    await assert.rejects(
      () => h.manager.continue(started.jobId, { extraTurns: 500 }),
      /raised maxTurns 1100 exceeds the cumulative ceiling of 1000/,
    );
  } finally {
    cleanup(h.repo);
  }
});

test('a failing apply does not leak its error to callers that merely join it', async () => {
  const h = await harness({ worker: async (job) => (writeSrc(job, 'a.js'), { status: 'DONE', turns: 1 }), verify: envFail });
  try {
    const { started } = await startEnvJob(h);
    const id = started.jobId;
    write(join(h.repo, 'src', 'a.js'), 'primary got there first\n');
    const failing = h.manager.apply(id, { apply: true, verifiedBy: 'ran the tests myself in primary' });
    const joined = h.manager.wait(id, { timeoutSec: 5 });
    await assert.rejects(() => failing, /changed on a job-touched path/);
    assert.equal((await joined).status, 'VERIFY_ENV_FAILED');
  } finally {
    cleanup(h.repo);
  }
});

test('crash recovery of an interrupted apply restores the previous status when nothing landed and records provenance when it did', async () => {
  const h = await harness({ worker: async (job) => (writeSrc(job, 'a.js'), { status: 'DONE', turns: 1 }), verify: envFail });
  try {
    const { started } = await startEnvJob(h);
    const id = started.jobId;
    const job = await h.manager.store.get(id);
    // Journal an apply that never reached the primary, as a crash right after the intent would leave it.
    await h.manager.store.update(id, {
      integrationIntent: true,
      integrationPaths: ['src/a.js'],
      integrationFinalStatus: 'DONE_UNVERIFIED',
      applyPreviousStatus: 'VERIFY_ENV_FAILED',
      applyVerifiedBy: 'ran the tests',
      runnerPid: 999_999_999,
    });
    await h.manager.recover();
    const after = await h.manager.store.get(id);
    assert.equal(after.status, 'VERIFY_ENV_FAILED', 'not a generic FAILED: nothing was applied');
    assert.equal(after.applied === true, false);
    assert.equal(after.integrationIntent, false);
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    void job;
    // The same journal, but the patch did land before the crash.
    const patch = await h.manager.store.readArtifactBytes(id, 'revert.diff');
    await gitPatchApplier(h.repo, patch, { reverse: false, check: false });
    await h.manager.store.update(id, {
      integrationIntent: true,
      integrationPaths: ['src/a.js'],
      integrationFinalStatus: 'DONE_UNVERIFIED',
      applyPreviousStatus: 'VERIFY_ENV_FAILED',
      applyVerifiedBy: 'ran the tests',
      runnerPid: 999_999_999,
    });
    await h.manager.recover();
    const landed = await h.manager.store.get(id);
    assert.equal(landed.status, 'DONE_UNVERIFIED');
    assert.equal(landed.applied, true);
    assert.equal(landed.appliedUnverified.previousStatus, 'VERIFY_ENV_FAILED');
    assert.equal(landed.appliedUnverified.verifiedBy, 'ran the tests');
  } finally {
    cleanup(h.repo);
  }
});

const LOOP_ERROR = 'Loop detected: identical failing tool calls repeated 3 times';
const loopCall = {
  tool: 'edit_file',
  args: '{"path":"src/a.js"}',
  error: 'old_string was not found',
  turn: 3,
  repeats: 3,
  signature: '0123456789abcdef',
};
const loopResult = (extra = {}) => ({
  status: 'FAILED',
  failureKind: 'tool-loop',
  error: LOOP_ERROR,
  toolFailure: loopCall,
  turns: 3,
  costUsd: 0.02,
  ...extra,
});
const failedJob = (repo, extra = {}) => ({
  task: 'loop',
  ownedPaths: ['src/**'],
  repoPath: repo,
  testCommand: 'npm test',
  budget: { maxTurns: 50, maxUsd: 1, timeoutMinutes: 5 },
  ...extra,
});

test('a worker-side loop FAILED keeps its work, shows the failing call, and offload_continue resumes it with that call in the task', async () => {
  const h = await harness({
    worker: async (job, run) =>
      run === 1
        ? (writeSrc(job, 'a.js', 'first\n'), loopResult())
        : (writeSrc(job, 'b.js', 'second\n'), { status: 'DONE', turns: 2, costUsd: 0.01 }),
    verify: pass,
  });
  try {
    const started = await h.manager.start(failedJob(h.repo));
    const id = started.jobId;
    const failed = await h.settle(id);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.failureKind, 'tool-loop');
    assert.deepEqual(failed.toolFailure, loopCall);
    const lines = failed.report.split('\n');
    const at = lines.indexOf('last failing tool call: edit_file {"path":"src/a.js"} (turn 3, failed 3x) -- old_string was not found');
    assert.ok(at >= 0, failed.report);
    assert.equal(lines[at + 1], `error: ${LOOP_ERROR}`);
    assert.match(
      lines.find((line) => line.startsWith('next:')),
      /continue/,
    );
    // The loop's failing call is also in the log, in the non-progress tail and the digest.
    const log = (await h.manager.job(id, { include: 'log' })).log;
    assert.match(log, /"lastFailingCall": \{/);
    const finished = (await h.manager.store.readArtifact(id, 'events.jsonl'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'finished');
    assert.equal(finished.status, 'FAILED');
    assert.equal(finished.failureKind, 'tool-loop');
    assert.equal(finished.toolFailure.tool, 'edit_file');

    // No cap increase is needed: the worker did not run out of budget.
    const resumed = await h.manager.continue(id, { note: 'use edit_file only after re-reading' });
    assert.equal(resumed.status, 'QUEUED');
    const done = await h.settle(id);
    assert.equal(done.status, 'DONE_VERIFIED', `${done.status}: ${done.error}`);
    assert.equal(h.counters.runs, 2);
    const [task, note] = h.counters.defects[1];
    assert.ok(
      task.includes(
        'Last failing call (turn 3): edit_file {"path":"src/a.js"}; hint: old_string is not in the file; read_file it again and copy the exact current text.',
      ),
    );
    assert.ok(task.includes('Do NOT repeat that call'));
    assert.ok(!task.includes('stopped at its turn, cost, or time cap'), 'the generic cap text is replaced, not appended');
    assert.equal(note, "Primary's note: use edit_file only after re-reading");
    const job = await h.manager.store.get(id);
    assert.equal(job.rounds, 1, 'one repair round consumed');
    assert.equal(job.continuations, 1);
    assert.equal(job.turns, 5, 'cumulative');
    assert.equal(job.costUsd, 0.03);
    assert.equal(job.failureKind, undefined);
    assert.equal(job.toolFailure, undefined);
    assert.equal(job.error, undefined);
    assert.equal(job.priorLoopSignature, '0123456789abcdef');
    assert.equal(done.failureKind, undefined);
    assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), 'first\n', 'the first round work survived');
    assert.equal(await readFile(join(h.repo, 'src', 'b.js'), 'utf8'), 'second\n');
  } finally {
    cleanup(h.repo);
  }
});

test('no-finish, output-cap and finish-protocol FAILED rounds are continuable and get their own task text', async () => {
  const kinds = {
    'no-finish': ['Worker ended without mandatory finish call', /without calling the finish tool/],
    'output-cap': ['Worker exhausted output-cap recovery without an allowed tool call', /response-size cap/],
    'finish-protocol': [
      'finish must be the sole valid tool call in a turn',
      /call finish ALONE: finish must be the only tool call in its turn/,
    ],
  };
  for (const [kind, [error, text]] of Object.entries(kinds)) {
    const h = await harness({
      worker: async (job, run) =>
        run === 1 ? (writeSrc(job, 'a.js'), { status: 'FAILED', failureKind: kind, error, turns: 2 }) : { status: 'DONE', turns: 1 },
      verify: pass,
    });
    try {
      const { jobId } = await h.manager.start(failedJob(h.repo));
      const failed = await h.settle(jobId);
      assert.equal(failed.status, 'FAILED');
      assert.equal((await h.manager.store.get(jobId)).error, error);
      assert.equal(failed.toolFailure, undefined);
      assert.doesNotMatch(failed.report, /last failing tool call/);
      await h.manager.continue(jobId);
      assert.equal((await h.settle(jobId)).status, 'DONE_VERIFIED', kind);
      assert.match(h.counters.defects[1][0], text, kind);
      assert.doesNotMatch(h.counters.defects[1][0], /loop guard/, kind);
    } finally {
      cleanup(h.repo);
    }
  }
});

test('offload_continue stays refused for every FAILED cause that is not the worker looping', async () => {
  const refused =
    /only a job that stopped on BUDGET or TIMEOUT, or that FAILED in a continuable worker-side way \(tool-loop, no-finish, output-cap, finish-protocol\)/;
  const cases = [
    // The manager's own verdict outranks a label a worker attached to its result.
    [
      'provider failure with a forged kind',
      (job) => (writeSrc(job, 'a.js'), loopResult({ providerFailure: { kind: 'http', status: 400 } })),
    ],
    ['unknown kind', (job) => (writeSrc(job, 'a.js'), loopResult({ failureKind: 'tool-loop;x' }))],
    [
      'provider protocol fault',
      (job) => (
        writeSrc(job, 'a.js'),
        { status: 'FAILED', error: 'Provider tool calls exceed size limit', failureKind: 'tool-loop-or-not', turns: 1 }
      ),
    ],
    ['no kind at all', (job) => (writeSrc(job, 'a.js'), { status: 'FAILED', error: LOOP_ERROR, turns: 1 })],
    ['bad accounting', (job) => (writeSrc(job, 'a.js'), loopResult({ turns: -5 }))],
    ['invalid usage', (job) => (writeSrc(job, 'a.js'), loopResult({ usage: { inputTokens: 5 } }))],
  ];
  for (const [label, worker] of cases) {
    const h = await harness({ worker: async (job) => worker(job), verify: pass });
    try {
      const { jobId } = await h.manager.start(failedJob(h.repo));
      const failed = await h.settle(jobId);
      assert.equal(failed.status, 'FAILED', label);
      assert.equal(failed.failureKind, undefined, `${label}: the kind is not even persisted`);
      assert.doesNotMatch(failed.report, /next: .*\bcontinue\b/, label);
      await assert.rejects(() => h.manager.continue(jobId), refused, label);
      assert.equal(h.counters.runs, 1, `${label}: no second round`);
    } finally {
      cleanup(h.repo);
    }
  }
  // A cap stop with a stray loop label is still just a cap stop.
  const capped = await harness({ worker: async (job) => (writeSrc(job, 'a.js'), loopResult({ status: 'BUDGET' })), verify: pass });
  try {
    const { jobId } = await capped.manager.start(failedJob(capped.repo));
    assert.equal((await capped.settle(jobId)).status, 'BUDGET');
    const stored = await capped.manager.store.get(jobId);
    assert.equal(stored.failureKind, undefined);
    assert.equal(stored.toolFailure, undefined);
  } finally {
    cleanup(capped.repo);
  }
});

test('a loop FAILED job with out-of-scope writes, no changes, or no rounds left cannot be continued', async () => {
  const scope = await harness({
    worker: async (job) => (writeSrc(job, 'a.js'), write(join(job.workspacePath, 'other', 'x.js'), 'x\n'), loopResult()),
    verify: pass,
  });
  const empty = await harness({ worker: async () => loopResult(), verify: pass });
  const noRounds = await harness({ worker: async (job) => (writeSrc(job, 'a.js'), loopResult()), verify: pass });
  try {
    const a = await scope.manager.start(failedJob(scope.repo));
    const scoped = await scope.settle(a.jobId);
    assert.equal(scoped.status, 'FAILED');
    assert.match((await scope.manager.store.get(a.jobId)).error, /out-of-scope/, 'the violation overwrote the canonical loop text');
    assert.doesNotMatch(scoped.report, /next: .*\bcontinue\b/);
    await assert.rejects(() => scope.manager.continue(a.jobId), /only a job that stopped on BUDGET or TIMEOUT, or that FAILED/);

    const b = await empty.manager.start(failedJob(empty.repo));
    assert.equal((await empty.settle(b.jobId)).status, 'FAILED');
    await assert.rejects(() => empty.manager.continue(b.jobId), /no in-scope changes to continue from/);
    assert.doesNotMatch((await empty.manager.job(b.jobId)).report, /next: .*\bcontinue\b/);

    const c = await noRounds.manager.start(failedJob(noRounds.repo, { maxRepairRounds: 0 }));
    assert.equal((await noRounds.settle(c.jobId)).status, 'FAILED');
    await assert.rejects(() => noRounds.manager.continue(c.jobId), /maximum repair rounds reached/);
    assert.doesNotMatch((await noRounds.manager.job(c.jobId)).report, /next: .*\bcontinue\b/);
  } finally {
    for (const h of [scope, empty, noRounds]) cleanup(h.repo);
  }
});

test('the same call looping again after a continuation is not resumed a second time, but offload_repair still is', async () => {
  const h = await harness({ worker: async (job, run) => (writeSrc(job, `r${run}.js`), loopResult()), verify: pass });
  try {
    const { jobId } = await h.manager.start(failedJob(h.repo, { maxRepairRounds: 3 }));
    assert.equal((await h.settle(jobId)).status, 'FAILED');
    await h.manager.continue(jobId);
    const again = await h.settle(jobId);
    assert.equal(again.status, 'FAILED');
    assert.equal(again.failureKind, 'tool-loop');
    assert.doesNotMatch(again.report, /next: .*\bcontinue\b/, 'the report stops offering it');
    assert.match(again.report, /next: .*\brepair\b/);
    await assert.rejects(() => h.manager.continue(jobId), /looped again after an earlier round; use offload_repair/);
    assert.equal(h.counters.runs, 2);
    await h.manager.repair(jobId, ['edit src/a.js by rewriting the whole file with edit_file after re-reading it']);
    assert.equal((await h.settle(jobId)).status, 'FAILED');
    assert.equal(h.counters.runs, 3);
  } finally {
    cleanup(h.repo);
  }
});

test('a different call looping after a continuation is resumable again', async () => {
  const h = await harness({
    worker: async (job, run) => (
      writeSrc(job, `r${run}.js`),
      loopResult({ toolFailure: { ...loopCall, signature: run === 1 ? '0123456789abcdef' : 'fedcba9876543210' } })
    ),
    verify: pass,
  });
  try {
    const { jobId } = await h.manager.start(failedJob(h.repo, { maxRepairRounds: 3 }));
    await h.settle(jobId);
    await h.manager.continue(jobId);
    const second = await h.settle(jobId);
    assert.match(second.report, /next: .*\bcontinue\b/);
    await h.manager.continue(jobId);
    await h.settle(jobId);
    assert.equal(h.counters.runs, 3);
  } finally {
    cleanup(h.repo);
  }
});

test('a FAILED continuation still honors the cumulative budget and reports what it needs', async () => {
  const h = await harness({
    worker: async (job, run) =>
      run === 1 ? (writeSrc(job, 'a.js'), loopResult({ turns: 50, costUsd: 0.02 })) : { status: 'DONE', turns: 1 },
    verify: pass,
  });
  try {
    const { jobId } = await h.manager.start(failedJob(h.repo));
    const failed = await h.settle(jobId);
    assert.equal(failed.status, 'FAILED');
    assert.match(failed.report, /next: .*continue \(extraTurns\/extraUsd needed/);
    await assert.rejects(() => h.manager.continue(jobId), /still exhausted/);
    await h.manager.continue(jobId, { extraTurns: 5 });
    assert.equal((await h.settle(jobId)).status, 'DONE_VERIFIED');
  } finally {
    cleanup(h.repo);
  }
});

test('the loop failure event and the log digest carry the failing call redacted and bounded, and a failing call stops the diagnosis flag', async () => {
  const noisy = {
    ...loopCall,
    // Long enough to be clipped, short enough to be kept: the validator drops a record whose field is over 1200 characters.
    args: `{"command":"deploy API_KEY=hunter2hunter2 ${'x'.repeat(600)}"}`,
    error: `request failed TOKEN=hunter2hunter2 ${'e'.repeat(600)}`,
  };
  const h = await harness({ worker: async (job) => (writeSrc(job, 'a.js'), loopResult({ toolFailure: noisy })), verify: pass });
  try {
    const { jobId } = await h.manager.start(failedJob(h.repo));
    const failed = await h.settle(jobId);
    assert.equal(failed.status, 'FAILED');
    const finished = (await h.manager.store.readArtifact(jobId, 'events.jsonl'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .findLast((event) => event.type === 'finished');
    assert.equal(finished.toolFailure.tool, 'edit_file');
    assert.ok(finished.toolFailure.args.startsWith('{"command":"deploy API_KEY=[REDACTED] xxx'), finished.toolFailure.args);
    assert.ok(finished.toolFailure.error.startsWith('request failed TOKEN=[REDACTED] eee'), finished.toolFailure.error);
    for (const field of ['args', 'error']) assert.ok(finished.toolFailure[field].length <= 300, `${field} is bounded`);
    const { log } = await h.manager.job(jobId, { include: 'log' });
    assert.doesNotMatch(log, /hunter2hunter2/);
    const digest = JSON.parse(log.slice(log.indexOf('DIGEST ') + 7, log.indexOf('\n---\nEVENTS')));
    assert.equal(digest.needsDiagnosis, undefined);
    assert.equal(digest.lastFailingCall.args, finished.toolFailure.args);
    assert.equal(digest.lastFailingCall.error, finished.toolFailure.error);
    assert.equal(digest.failureKind, 'tool-loop');
  } finally {
    cleanup(h.repo);
  }
});

test('a report job records only the shape of a looping call and can never be continued', async () => {
  const h = await harness({
    worker: async () => loopResult({ toolFailure: { ...loopCall, args: '{"path":"/inputs/secret-body"}', error: 'EXTERNAL BODY TEXT' } }),
    verify: pass,
  });
  try {
    const { jobId } = await h.manager.start({ mode: 'report', task: 'analyze', repoPath: h.repo });
    const failed = await h.settle(jobId);
    assert.equal(failed.status, 'FAILED');
    assert.deepEqual(failed.toolFailure, { tool: 'edit_file', turn: 3, repeats: 3 });
    assert.doesNotMatch(JSON.stringify(await h.manager.store.get(jobId)), /secret-body|EXTERNAL BODY/);
    assert.doesNotMatch(failed.report, /secret-body|EXTERNAL BODY|next: .*\bcontinue\b/);
    await assert.rejects(() => h.manager.continue(jobId), /report jobs are read-only/);
  } finally {
    cleanup(h.repo);
  }
});

test('a repair that fails during setup leaves no continuable marker behind', async () => {
  const h = await harness({ worker: async (job) => (writeSrc(job, 'a.js'), loopResult()), verify: pass });
  try {
    const { jobId } = await h.manager.start(failedJob(h.repo, { maxRepairRounds: 3 }));
    assert.equal((await h.settle(jobId)).status, 'FAILED');
    const real = h.manager.config.isolation.create;
    h.manager.config.isolation.create = async () => {
      throw new Error('disk is full');
    };
    await assert.rejects(() => h.manager.continue(jobId), /disk is full/);
    h.manager.config.isolation.create = real;
    const stored = await h.manager.store.get(jobId);
    assert.equal(stored.status, 'FAILED');
    assert.match(stored.error, /repair setup failed: disk is full/);
    assert.equal(stored.failureKind, undefined);
    assert.doesNotMatch((await h.manager.job(jobId)).report, /next: .*\bcontinue\b/);
    await assert.rejects(() => h.manager.continue(jobId), /only a job that stopped on BUDGET or TIMEOUT, or that FAILED/);
  } finally {
    cleanup(h.repo);
  }
});

test('include log is bounded by tail and limit, redacts, and rejects misuse', async () => {
  const h = await harness({ worker: async (job) => (writeSrc(job, 'a.js'), loopResult()), verify: pass });
  try {
    const { jobId } = await h.manager.start(failedJob(h.repo));
    await h.settle(jobId);
    for (let index = 0; index < 120; index += 1)
      await h.manager.store.event(jobId, { type: 'progress', note: `filler ${index} hunter2-notshaped` });
    // Not token-shaped, so write-time redaction cannot have masked it: only the read-time pass can.
    assert.match(await h.manager.store.readArtifact(jobId, 'events.jsonl'), /hunter2-notshaped/);
    h.manager.store.secrets.push('hunter2-notshaped');
    const total = (await h.manager.store.readArtifact(jobId, 'events.jsonl')).split('\n').filter(Boolean).length;

    const byDefault = await h.manager.job(jobId, { include: 'log' });
    assert.ok(byDefault.log.length <= 16_000);
    assert.deepEqual(byDefault.logInfo, { lines: total, shown: 60, truncated: true, tail: 60, limit: 16_000 });
    assert.doesNotMatch(byDefault.log, /hunter2-notshaped/);
    assert.match(byDefault.log, /\[REDACTED\]/);
    assert.match(byDefault.log, /"lastFailingCall"/);

    // A secret shorter than the [REDACTED] marker grows when masked: the limit still holds.
    h.manager.store.secrets.push('hunter2');
    const grown = await h.manager.job(jobId, { include: 'log', tail: 1_000, limit: 2_000 });
    assert.ok(grown.log.length <= 2_000, `${grown.log.length}`);
    assert.doesNotMatch(grown.log, /hunter2/);

    const narrow = await h.manager.job(jobId, { include: 'log', tail: 2, limit: 2_000 });
    assert.ok(narrow.log.length <= 2_000);
    assert.equal(narrow.logInfo.tail, 2);
    assert.equal(narrow.logInfo.limit, 2_000);
    assert.equal(narrow.logInfo.truncated, true);
    assert.ok(narrow.logInfo.shown <= 2 && narrow.logInfo.lines === total);
    // detail "full" carries the report too, with the same window.
    const full = await h.manager.job(jobId, { include: 'log', detail: 'full', tail: 1, limit: 2_000 });
    assert.equal(full.logInfo.tail, 1);
    assert.match(full.report, /last failing tool call/);

    await assert.rejects(() => h.manager.job(jobId, { include: 'diff', tail: 5 }), /tail and limit apply only to include "log"/);
    await assert.rejects(() => h.manager.job(jobId, { tail: 5 }), /tail and limit apply only to include "log"/);
    await assert.rejects(() => h.manager.job(undefined, { tail: 5 }), /tail and limit require a jobId/);
    await assert.rejects(() => h.manager.job(jobId, { include: 'log', tail: -1 }), /tail must be an integer from 0 to 1000/);
    await assert.rejects(() => h.manager.job(jobId, { include: 'log', limit: 100 }), /limit must be an integer from 2000 to 60000/);
  } finally {
    cleanup(h.repo);
  }
});
