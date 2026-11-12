import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../../src/store.mjs';
import { JobManager } from '../../src/job-manager.mjs';
import { gitSnapshots, noEditSteerNotice, withAutoExtension } from '../../src/core.mjs';
import { noEditSteerTurn } from '../../src/budget-sizing.mjs';
import { createIsolatedWorktree, openIsolatedWorktree, cleanupIsolatedWorktree } from '../../src/worktree.mjs';
import { cleanup, git, makeRepo, write } from '../unit/helpers.mjs';

const TERMINAL_WAIT_SEC = 55;
const route = (type, baseUrl, keyRef, model) => ({ type, baseUrl, keyRef, model });
const FLASH = route('openai-chat', 'https://api.deepseek.com', 'env:deepseek', 'deepseek-flash');
const TERRA = route('openai-chat', 'https://api.openai.com/v1', 'env:openai', 'gpt-6.1-terra');

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

// The "no edits yet" steer: a write round on the DeepSeek Flash route that has
// changed nothing in scope when it reaches max(20, 40% of its cap) is told once
// to stop reading and make its first edit. The worker's progress callback is the
// real withAutoExtension wrapper, so both the manager's return value and the
// notice that reaches the worker's context are exercised end to end.
const noEditJob = async ({ profile = FLASH, budget = {}, changes = false, configured = 80, mode = 'write' } = {}) => {
  const repo = makeRepo();
  const events = [];
  const notices = [];
  let extensions = 0;
  const m = await isolatedManager(repo, {
    worker: {
      run: async (job, api) => {
        if (changes) write(join(job.workspacePath, 'src', 'worker.txt'), 'edit\n');
        const cap = job.budget.maxTurns;
        const steerTurn = noEditSteerTurn(cap);
        const context = { add: (message) => notices.push(message), flush: async () => {} };
        const progress = withAutoExtension(api.progress, () => ({ extendTurns: () => (extensions += 1) }), context, false);
        await progress({ action: 'provider_usage', turn: 1, costUsd: 0.01 });
        events.push(await progress({ action: 'provider_request_pending', turn: steerTurn - 1 }));
        events.push(await progress({ action: 'provider_request_pending', turn: steerTurn }));
        // A later event in the same round must neither steer again nor re-check scope.
        events.push(await progress({ action: 'provider_request_pending', turn: steerTurn + 2 }));
        return mode === 'report'
          ? { status: 'DONE', report: 'analysis complete', concerns: [], testsRun: [] }
          : { status: 'DONE', summary: 'read only', turns: 1, costUsd: 0.01 };
      },
    },
    verify: async (command) => ({ command, verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }),
  });
  const started = await m.start(
    {
      task: 'x',
      ...(mode === 'report' ? { mode: 'report' } : { ownedPaths: ['src/**'], testCommand: 'verify' }),
      executionProfile: profile,
      repoPath: repo,
      budget: { maxTurns: 80, maxUsd: 3, timeoutMinutes: 30, ...budget },
    },
    mode === 'write' ? { turnBudget: { configured, policy: 'auto' } } : {},
  );
  const done = await m.wait(started.jobId, { timeoutSec: TERMINAL_WAIT_SEC });
  const stored = await m.store.get(started.jobId);
  return { m, repo, id: started.jobId, done, events, notices, extensions, cap: stored.budget.maxTurns, stored };
};

test('a Flash write round with no in-scope edits is steered once at 40% of its cap and the notice reaches the worker', async () => {
  const run = await noEditJob();
  try {
    const steerTurn = noEditSteerTurn(run.cap);
    assert.equal(steerTurn, Math.max(20, Math.ceil(0.4 * run.cap)));
    assert.deepEqual(run.events, [undefined, { steer: 'no-edits', turnsUsed: steerTurn, maxTurns: run.cap }, undefined]);
    assert.deepEqual(run.stored.budgetSizing.noEditSteer, { atTurn: steerTurn, maxTurns: run.cap }, 'the steer is durable');
    assert.deepEqual(run.done.budgetSizing.noEditSteer, { atTurn: steerTurn, maxTurns: run.cap }, 'public view');
    assert.deepEqual(run.notices, [{ role: 'user', content: noEditSteerNotice(steerTurn, run.cap) }], 'exactly one notice');
    assert.equal(run.extensions, 0, 'no auto-extension without in-scope changes');
    assert.equal(run.stored.budget.maxTurns, run.cap);
    assert.equal(run.done.status, 'DONE_VERIFIED', 'the configured verifier passes the empty diff');
  } finally {
    cleanup(run.repo);
  }
});

test('no no-edit steer when the round has an in-scope edit, on a non-Flash route, or for a report job', async () => {
  const cases = [
    ['an in-scope edit', { changes: true }],
    ['a non-Flash route', { profile: TERRA }],
    ['a report job', { mode: 'report', budget: { maxTurns: 60 } }],
  ];
  for (const [label, options] of cases) {
    const run = await noEditJob(options);
    try {
      assert.deepEqual(run.events, [undefined, undefined, undefined], label);
      assert.equal(run.stored.budgetSizing?.noEditSteer, undefined, label);
      assert.deepEqual(run.notices, [], label);
    } finally {
      cleanup(run.repo);
    }
  }
});
