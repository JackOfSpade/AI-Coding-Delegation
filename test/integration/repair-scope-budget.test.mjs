import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JobStore } from '../../src/store.mjs';
import { JobManager } from '../../src/job-manager.mjs';
import { gitSnapshots } from '../../src/core.mjs';
import { autoTurnCeiling, FLASH_TURN_USD_ESTIMATE } from '../../src/budget-sizing.mjs';
import { createIsolatedWorktree, openIsolatedWorktree, cleanupIsolatedWorktree } from '../../src/worktree.mjs';
import { cleanup, git, makeRepo, write } from '../unit/helpers.mjs';

const TERMINAL_WAIT_SEC = 55;
const route = (type, baseUrl, keyRef, model) => ({ type, baseUrl, keyRef, model });
const FLASH = route('openai-chat', 'https://api.deepseek.com', 'env:deepseek', 'deepseek-flash');
const TERRA = route('openai-chat', 'https://api.openai.com/v1', 'env:openai', 'gpt-6.1-terra');
const VERSION = 'run npm run plugin:version after changing plugins/offload';

const isolatedManager = async (repo, { worker, verify }) =>
  new JobManager({
    store: new JobStore({ gitDir: await mkdtemp(`${tmpdir()}/offload-jobs-`) }),
    snapshots: gitSnapshots(),
    worker,
    runner: { verify },
    config: {
      repoPath: repo,
      git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
      isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
    },
  });

test('a verifier failure only the primary can fix ends VERIFY_FAILED without an automatic repair round', async () => {
  const repo = makeRepo();
  try {
    const failingVersionCheck = async (_command, options) => {
      const url = pathToFileURL(join(options.cwd, 'test/unit/skill-sync.test.mjs')).href;
      return {
        verdict: 'FAIL',
        result: {
          code: 1,
          sandbox: 'macos',
          stdout: `✖ failing tests:\n\ntest at ${url}:28:1\n✖ versions (1ms)\n  AssertionError: ${VERSION}\n      at TestContext.<anonymous> (${url}:31:10)\n`,
        },
      };
    };
    const run = async (ownedPaths) => {
      let rounds = 0;
      const m = await isolatedManager(repo, {
        worker: {
          run: async (job) => {
            rounds += 1;
            write(join(job.workspacePath, 'src', 'worker.txt'), `round ${rounds}\n`);
            return { status: 'DONE' };
          },
        },
        verify: failingVersionCheck,
      });
      const started = await m.start({ task: 'x', ownedPaths, repoPath: repo, testCommand: 'verify', maxRepairRounds: 1 });
      const done = await m.wait(started.jobId, { timeoutSec: TERMINAL_WAIT_SEC });
      return { m, id: started.jobId, rounds, done };
    };

    const out = await run(['src/**']);
    assert.equal(out.done.status, 'VERIFY_FAILED');
    assert.equal(out.rounds, 1, 'no worker round was spent on a failure the worker cannot fix');
    const stored = await out.m.store.get(out.id);
    assert.equal(stored.rounds || 0, 0);
    assert.equal(stored.repairSkipped.reason, 'plugin-content-version');
    assert.equal(stored.repairSkipped.command, 'npm run plugin:version');
    assert.deepEqual(out.done.repairSkipped, stored.repairSkipped, 'the public result carries the machine-readable field');
    for (const detail of ['compact', 'full']) {
      const report = (await out.m.job(out.id, { detail })).report;
      assert.match(report, /automatic repair skipped: the verifier fails only on the plugin content version/);
      assert.match(report, /npm run plugin:version/);
      assert.match(report, /next: [^\n]*apply \(after your own check\)/);
      assert.doesNotMatch(report, /next: [^\n]*\brepair\b/);
    }

    // The same failure in a job that may write the manifests keeps today's repair.
    const writable = await run(['src/**', 'plugins/**']);
    assert.equal(writable.rounds, 2, 'the worker could run the command itself, so the automatic repair runs');
    assert.equal((await writable.m.store.get(writable.id)).repairSkipped, undefined);
  } finally {
    cleanup(repo);
  }
});

test('a skill-text-only verifier failure ends VERIFY_FAILED without a repair round and names both skill files', async () => {
  const repo = makeRepo();
  try {
    let rounds = 0;
    const m = await isolatedManager(repo, {
      worker: {
        run: async (job) => {
          rounds += 1;
          write(join(job.workspacePath, 'src', 'worker.txt'), `round ${rounds}\n`);
          return { status: 'DONE' };
        },
      },
      verify: async (_command, options) => {
        const url = pathToFileURL(join(options.cwd, 'test/integration/mcp.test.mjs')).href;
        return {
          verdict: 'FAIL',
          result: {
            code: 1,
            sandbox: 'macos',
            stdout: `✖ failing tests:\n\ntest at ${url}:1578:1\n✖ the skill names exactly the capabilities (33.7ms)\n  AssertionError [ERR_ASSERTION]: the skill never mentions capability loopbackPreflightBlocking\n      at TestContext.<anonymous> (${url}:1610:12)\n\nℹ fail 1\n`,
          },
        };
      },
    });
    const started = await m.start({
      task: 'x',
      ownedPaths: ['src/**', 'test/integration/mcp.test.mjs'],
      repoPath: repo,
      testCommand: 'verify',
      maxRepairRounds: 1,
    });
    const done = await m.wait(started.jobId, { timeoutSec: TERMINAL_WAIT_SEC });
    assert.equal(done.status, 'VERIFY_FAILED');
    assert.equal(rounds, 1, 'no repair round');
    const stored = await m.store.get(started.jobId);
    assert.equal(stored.repairSkipped.reason, 'skill-text');
    assert.deepEqual(stored.repairSkipped.missing, ['loopbackPreflightBlocking']);
    for (const detail of ['compact', 'full']) {
      const report = (await m.job(started.jobId, { detail })).report;
      assert.match(report, /automatic repair skipped: the verifier fails only on skill-text checks \(loopbackPreflightBlocking\)/);
      assert.match(report, /plugins\/offload\/skills\/offload_economy\/SKILL\.md and plugins\/offload\/skills\/offload_premium\/SKILL\.md/);
    }
  } finally {
    cleanup(repo);
  }
});

const flashJob = async ({ profile = FLASH, budget = {}, policy = 'auto', changes = true, cost = 0.07, result } = {}) => {
  const repo = makeRepo();
  const events = [];
  const verifies = [];
  let rounds = 0;
  const m = await isolatedManager(repo, {
    worker: {
      run: async (job, api) => {
        rounds += 1;
        if (changes) write(join(job.workspacePath, 'src', 'worker.txt'), 'edit\n');
        const cap = job.budget.maxTurns;
        await api.progress({ action: 'provider_usage', turn: 1, costUsd: cost });
        events.push(await api.progress({ action: 'provider_request_pending', turn: cap - 1 }));
        events.push(await api.progress({ action: 'provider_request_pending', turn: cap }));
        return result ? result(cap, events) : { status: 'DONE', summary: 'ok', turns: cap, costUsd: cost };
      },
    },
    verify: async (command) => {
      verifies.push(command);
      return { command, verdict: 'PASS', result: { code: 0, sandbox: 'macos' } };
    },
  });
  const started = await m.start(
    {
      task: 'x',
      ownedPaths: ['src/**'],
      executionProfile: profile,
      repoPath: repo,
      testCommand: 'verify',
      budget: { maxTurns: 80, maxUsd: 3, timeoutMinutes: 30, ...budget },
    },
    { turnBudget: { configured: 80, policy, requested: policy === 'fixed' ? (budget.maxTurns ?? 80) : undefined } },
  );
  const startCap = (await m.store.get(started.jobId)).budget.maxTurns;
  const done = await m.wait(started.jobId, { timeoutSec: TERMINAL_WAIT_SEC });
  return { m, repo, id: started.jobId, done, events, verifies, startCap, rounds, stored: await m.store.get(started.jobId) };
};

test('an automatically sized Flash cap gets one bounded extension when most of maxUsd is unspent and the round has in-scope edits', async () => {
  const run = await flashJob();
  try {
    const cap = run.startCap;
    const ceiling = autoTurnCeiling({ maxUsd: 3, turnUsdEstimate: FLASH_TURN_USD_ESTIMATE });
    const extra = Math.min(Math.floor(cap / 2), Math.floor((3 - 0.07) / FLASH_TURN_USD_ESTIMATE), ceiling - cap);
    assert.ok(extra >= 1);
    assert.deepEqual(run.events, [{ extraTurns: extra, wrapUp: true }, undefined], 'granted once, at the turn before the cap');
    assert.equal(run.stored.budget.maxTurns, cap + extra, 'the raised cap is durable');
    assert.equal(run.stored.budget.maxUsd, 3, 'maxUsd is never raised');
    const ext = run.stored.budgetSizing.autoExtended;
    assert.deepEqual([ext.extraTurns, ext.fromMaxTurns, ext.toMaxTurns, ext.maxUsd], [extra, cap, cap + extra, 3]);
    assert.match(run.stored.budgetSizing.warnings.join(' '), /auto-extended once/);
    assert.equal(run.done.budgetSizing.autoExtended.extraTurns, extra, 'public view');
    assert.equal(run.done.status, 'DONE_VERIFIED');
    const report = (await run.m.job(run.id, { detail: 'compact' })).report;
    assert.match(report, new RegExp(`turn cap auto-extended: \\+${extra} turns \\(${cap} -> ${cap + extra}\\)`));
  } finally {
    cleanup(run.repo);
  }
});

test('no extension on a non-Flash route, a caller-fixed cap, a mostly spent budget, or a round without in-scope edits', async () => {
  const cases = [
    ['a non-Flash route', { profile: TERRA }],
    ['a caller-fixed maxTurns', { policy: 'fixed', budget: { maxTurns: 60 } }],
    ['at least half of maxUsd spent', { cost: 1.5 }],
    ['no in-scope changes', { changes: false }],
  ];
  for (const [label, options] of cases) {
    const run = await flashJob(options);
    try {
      assert.deepEqual(run.events, [undefined, undefined], `${label}: ${JSON.stringify(run.stored.budgetSizing)}`);
      assert.equal(run.stored.budget.maxTurns, run.startCap, label);
      assert.equal(run.stored.budgetSizing?.autoExtended, undefined, label);
    } finally {
      cleanup(run.repo);
    }
  }
});

test('a BUDGET stop runs the configured verifier on the retained in-scope diff and stays BUDGET', async () => {
  const stop = (cap) => ({ status: 'BUDGET', turns: cap, costUsd: 0.07, budgetCap: 'turns', error: 'Maximum turns reached' });
  // Extension granted, then exhausted: the stop is on the raised cap.
  const exhausted = await flashJob({ result: (cap) => stop(cap + Math.floor(cap / 2)) });
  try {
    assert.equal(exhausted.done.status, 'BUDGET');
    assert.equal(exhausted.verifies.length, 1, 'the verifier ran on the retained diff');
    assert.equal(exhausted.stored.verify.verdict, 'PASS');
    assert.equal(exhausted.stored.rounds || 0, 0);
    assert.equal(existsSync(join(exhausted.repo, 'src', 'worker.txt')), false, 'a BUDGET job is never integrated automatically');
    const report = (await exhausted.m.job(exhausted.id, { detail: 'compact' })).report;
    assert.match(report, /^JOB \S+\s+BUDGET/m);
    assert.match(report, /verify: `verify` PASS \(exit 0\)/);
    assert.match(report, /retained diff: configured verifier PASSED \(exit 0\) on the diff the worker left at its budget cap/);
    assert.match(report, /next: [^\n]*offload_apply with applyThenVerify \(recommended after diff review\)/);
    assert.doesNotMatch(report, /configured verifier: not run/);
  } finally {
    cleanup(exhausted.repo);
  }

  // Conditions for the extension do not hold: the verifier still runs on a BUDGET stop.
  const plain = await flashJob({ profile: TERRA, result: (cap) => stop(cap) });
  try {
    assert.equal(plain.done.status, 'BUDGET');
    assert.equal(plain.verifies.length, 1);
    assert.equal(plain.stored.verify.verdict, 'PASS');
  } finally {
    cleanup(plain.repo);
  }

  // Without in-scope changes there is nothing to verify.
  const empty = await flashJob({ profile: TERRA, changes: false, result: (cap) => stop(cap) });
  try {
    assert.equal(empty.done.status, 'BUDGET');
    assert.equal(empty.verifies.length, 0);
    assert.equal(empty.stored.verify, undefined);
  } finally {
    cleanup(empty.repo);
  }
});

test('a failing verifier on a BUDGET stop is reported on the verify line without ending the job or queuing a repair', async () => {
  const repo = makeRepo();
  try {
    let rounds = 0;
    const m = await isolatedManager(repo, {
      worker: {
        run: async (job) => {
          rounds += 1;
          write(join(job.workspacePath, 'src', 'worker.txt'), 'edit\n');
          return { status: 'BUDGET', turns: 5, costUsd: 0.01, budgetCap: 'turns', error: 'Maximum turns reached' };
        },
      },
      verify: async (command) => ({ command, verdict: 'FAIL', result: { code: 1, sandbox: 'macos', stdout: 'not ok 1 - thing' } }),
    });
    const started = await m.start({
      task: 'x',
      ownedPaths: ['src/**'],
      repoPath: repo,
      testCommand: 'verify',
      maxRepairRounds: 2,
      budget: { maxTurns: 5, maxUsd: 3, timeoutMinutes: 30 },
    });
    const done = await m.wait(started.jobId, { timeoutSec: TERMINAL_WAIT_SEC });
    assert.equal(done.status, 'BUDGET');
    assert.equal(rounds, 1, 'a cap stop is never auto-repaired');
    const report = (await m.job(started.jobId, { detail: 'full' })).report;
    assert.match(report, /verify: `verify` FAIL \(exit 1\)/);
    assert.doesNotMatch(report, /retained diff: configured verifier PASSED/);
    assert.doesNotMatch(report, /automatic repair/);
    assert.match(report, /next: [^\n]*continue/);
  } finally {
    cleanup(repo);
  }
});
