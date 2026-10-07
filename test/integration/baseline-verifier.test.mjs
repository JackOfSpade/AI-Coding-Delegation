import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { JobStore } from '../../src/store.mjs';
import { JobManager, validateJobRequest } from '../../src/job-manager.mjs';
import { gitPatchApplier, gitSnapshots } from '../../src/core.mjs';
import { Runner } from '../../src/runner.mjs';
import { sandboxAvailable } from '../../src/sandbox.mjs';
import { createIsolatedWorktree, openIsolatedWorktree, cleanupIsolatedWorktree } from '../../src/worktree.mjs';
import { cleanup, git, makeRepo, write } from '../unit/helpers.mjs';

const TIMEOUT_SEC = 20;
const MACOS_SANDBOX_SKIP_REASON = 'requires an available macOS sandbox';
const HOMEBREW_NODE = process.platform === 'darwin' && process.execPath.startsWith('/opt/homebrew/');

/** What `node --test` prints for a run whose only failures are `names`. */
const spec = (names, exit = names.length ? 1 : 0, extra = '') => ({
  command: 'verify',
  verdict: exit === 0 ? 'PASS' : 'FAIL',
  result: {
    code: exit,
    sandbox: 'macos',
    durationMs: 7,
    stdout: `${names.map((name) => `✖ ${name} (1ms)`).join('\n')}\nℹ tests ${names.length + 3}\nℹ fail ${names.length}\n${extra}`,
    stderr: '',
  },
});
const unparseable = (exit = 1) => ({
  command: 'verify',
  verdict: exit === 0 ? 'PASS' : 'FAIL',
  result: { code: exit, sandbox: 'macos', stdout: 'boom\n', stderr: '' },
});

/**
 * A real isolated JobManager whose worker writes one owned file and whose
 * verifier is `verify(call)`, called for the result run (`call.isResult`) and
 * for the baseline run of the untouched snapshot alike.
 */
async function harness({ verify, worker, config = {}, repo = makeRepo() } = {}) {
  const gitDir = await mkdtemp(join(tmpdir(), 'offload-baseline-store-'));
  write(join(repo, 'dirty.txt'), 'dirty baseline\n');
  const calls = [];
  const workers = [];
  let workerPath;
  let creates = 0;
  const m = new JobManager({
    store: new JobStore({ gitDir }),
    snapshots: gitSnapshots(),
    worker: {
      run: async (job, api) => {
        workerPath = job.workspacePath;
        // What the store says about the baseline copy while the worker runs: a
        // finished baseline run must already have released its path.
        const stored = await m.store.get(job.id);
        workers.push({ path: workerPath, defects: api.defects, baselinePath: stored.verifyBaselineWorkspacePath });
        if (worker) return worker(job, api, workers.length);
        write(join(job.workspacePath, 'src', 'new.txt'), `worker ${workers.length}\n`);
        return { status: 'DONE' };
      },
    },
    runner: {
      verify: async (command, options) => {
        const call = {
          command,
          options,
          isResult: options.cwd === workerPath,
          existed: existsSync(options.cwd),
          dirty: existsSync(join(options.cwd, 'dirty.txt')) ? await readFile(join(options.cwd, 'dirty.txt'), 'utf8') : undefined,
          workerFile: existsSync(join(options.cwd, 'src', 'new.txt')),
        };
        calls.push(call);
        return verify(call, calls);
      },
    },
    config: {
      repoPath: repo,
      git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
      applyPatch: gitPatchApplier,
      isolation: {
        create: async (options) => {
          creates += 1;
          if (config.failCreateAfter !== undefined && creates > config.failCreateAfter) throw new Error('injected worktree failure');
          if (config.failCreateAt?.includes(creates)) throw new Error('injected worktree failure');
          return createIsolatedWorktree(options);
        },
        open: openIsolatedWorktree,
        cleanup: cleanupIsolatedWorktree,
      },
    },
  });
  return { repo, m, calls, workers, creates: () => creates, finish: () => cleanup(repo) };
}
const start = (h, extra = {}) =>
  h.m.start({
    task: 'baseline job',
    ownedPaths: ['src/**'],
    repoPath: h.repo,
    testCommand: 'verify',
    verifierMode: 'baseline-diff',
    ...extra,
  });
const worktrees = (repo) =>
  git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '));
const defectLines = (text) => text.split('\n').filter((line) => line.startsWith('- '));

test('pre-existing failures are tolerated: DONE_VERIFIED means no new failures, and the real exit status stays visible', async () => {
  const h = await harness({ verify: () => spec(['suite > old A', 'suite > old B']) });
  try {
    const started = await start(h);
    assert.equal(started.verifierMode, 'baseline-diff');
    const done = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'DONE_VERIFIED');
    const job = await h.m.store.get(started.jobId);
    assert.equal(job.verify.verdict, 'PASS');
    assert.equal(job.verify.result.code, 1, 'the verifier result is not rewritten into a green exit');
    assert.equal(job.verify.baseline.status, 'compared');
    assert.equal(job.verify.baseline.preexisting, 2);
    assert.equal(job.verify.baseline.newFailureCount, 0);
    assert.equal(job.verify.baseline.baseline.failures, 2);
    assert.equal(job.verify.baseline.result.failures, 2);
    assert.equal(job.applied, true);
    assert.equal(await readFile(join(h.repo, 'src', 'new.txt'), 'utf8'), 'worker 1\n');
    // The compact report never describes this as a plain green suite.
    assert.match(done.report, /PASS \(exit 1\) via baseline-diff: 2 pre-existing failure\(s\) tolerated, 0 new/);
    assert.match(done.report, /baseline-diff: 2 failing now vs 2 in the untouched snapshot · 0 new, 2 pre-existing, 0 fixed/);
    assert.equal(done.verifyBaseline.newFailureCount, 0);

    assert.equal(h.calls.length, 2, 'result run, then one baseline run');
    const [result, baseline] = h.calls;
    assert.equal(result.isResult, true);
    assert.equal(baseline.isResult, false);
    assert.notEqual(baseline.options.cwd, result.options.cwd);
    assert.equal(baseline.existed, true);
    assert.equal(baseline.dirty, 'dirty baseline\n', 'the snapshot includes the primary checkout dirty state');
    assert.equal(baseline.workerFile, false, "the baseline copy is untouched by the worker's edits");
    assert.equal(existsSync(baseline.options.cwd), false, 'the baseline worktree is removed afterwards');
    assert.equal(job.verifyBaselineWorkspacePath, undefined);
    assert.equal(worktrees(h.repo).length, 1, 'only the primary worktree remains registered');
  } finally {
    h.finish();
  }
});

test('a new failure queues repair that targets only it, and the baseline run is reused by the next round', async () => {
  let round = 0;
  const h = await harness({
    verify: (call) => {
      if (!call.isResult) return spec(['old A', 'old B']);
      round += 1;
      return round === 1 ? spec(['old A', 'old B', 'brand new C']) : spec(['old A', 'old B']);
    },
  });
  try {
    const started = await start(h);
    const done = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'DONE_VERIFIED');
    assert.equal(h.workers.length, 2, 'one repair round');
    const defects = h.workers[1].defects;
    assert.equal(defects.length, 1);
    assert.match(
      defects[0],
      /^Verifier failed:\n1 new test failure\(s\) compared with the untouched snapshot; 2 pre-existing failure\(s\) are expected/,
    );
    assert.deepEqual(defectLines(defects[0]), ['- brand new C'], 'neither pre-existing failure is a repair target');
    assert.deepEqual(
      h.calls.map((call) => call.isResult),
      [true, false, true],
      'result, baseline, result: the snapshot run is computed once',
    );
    const job = await h.m.store.get(started.jobId);
    assert.equal(job.verify.baseline.status, 'compared');
    assert.equal(job.verify.baseline.baseline.cached, true, 'the second comparison used the cached snapshot run');
    assert.equal(job.rounds, 1);
    assert.equal(h.workers[1].baselinePath, undefined, 'the baseline path is released as soon as its worktree is removed');
  } finally {
    h.finish();
  }
});

test('the baseline run is cached per job: two jobs on the same snapshot and testCommand each run their own', async () => {
  const h = await harness({ verify: (call) => (call.isResult ? spec(['old A', 'new B']) : spec(['old A'])) });
  try {
    const first = await start(h, { maxRepairRounds: 0 });
    assert.equal((await h.m.wait(first.jobId, { timeoutSec: TIMEOUT_SEC })).status, 'VERIFY_FAILED');
    const second = await start(h, { maxRepairRounds: 0 });
    assert.equal((await h.m.wait(second.jobId, { timeoutSec: TIMEOUT_SEC })).status, 'VERIFY_FAILED');
    const one = await h.m.store.get(first.jobId);
    const two = await h.m.store.get(second.jobId);
    assert.equal(one.before, two.before, 'neither job applied, so both began from the same snapshot');
    assert.equal(one.testCommand, two.testCommand);
    assert.deepEqual(
      h.calls.map((call) => call.isResult),
      [true, false, true, false],
      'each job ran its own baseline',
    );
    assert.equal(one.verify.baseline.baseline.cached, false);
    assert.equal(two.verify.baseline.baseline.cached, false, 'the second job never borrowed the first job baseline');
  } finally {
    h.finish();
  }
});

test('a changed verifier time limit never reuses a baseline measured under the old one', async () => {
  let round = 0;
  const h = await harness({
    verify: (call) => {
      if (!call.isResult) return spec(['old A']);
      round += 1;
      return round === 1 ? spec(['old A', 'new B']) : spec(['old A']);
    },
    worker: async (job, api, count) => {
      if (count === 2) await h.m.store.update(job.id, { verifierTimeoutSec: 61 });
      write(join(job.workspacePath, 'src', 'new.txt'), `worker ${count}\n`);
      return { status: 'DONE' };
    },
  });
  try {
    const started = await start(h, { verifierTimeoutSec: 60 });
    const done = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'DONE_VERIFIED');
    assert.deepEqual(
      h.calls.map((call) => call.isResult),
      [true, false, true, false],
      'the second round measured the snapshot again',
    );
    assert.deepEqual(
      h.calls.map((call) => call.options.timeoutSec),
      [60, 60, 61, 61],
    );
    assert.equal((await h.m.store.get(started.jobId)).verify.baseline.baseline.cached, false);
  } finally {
    h.finish();
  }
});

test('a passing result needs no baseline run and no second worktree', async () => {
  const h = await harness({ verify: () => spec([]) });
  try {
    const started = await start(h);
    const done = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'DONE_VERIFIED');
    assert.equal(h.calls.length, 1);
    assert.equal(h.creates(), 1, "only the job's own worktree was created");
    const job = await h.m.store.get(started.jobId);
    assert.deepEqual(job.verify.baseline, { mode: 'baseline-diff', status: 'skipped', reason: 'result-passed' });
    assert.doesNotMatch(done.report, /baseline-diff/);
  } finally {
    h.finish();
  }
});

test('unparseable failing output is inconclusive: VERIFY_FAILED, no repair round, no further worker spend', async () => {
  const h = await harness({ verify: () => unparseable() });
  try {
    const started = await start(h);
    const done = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'VERIFY_FAILED');
    assert.equal(h.workers.length, 1);
    const job = await h.m.store.get(started.jobId);
    assert.equal(job.rounds, 0);
    assert.equal(job.verify.verdict, 'FAIL');
    assert.equal(job.verify.baseline.status, 'inconclusive');
    assert.equal(job.verify.baseline.reason, 'unparseable-output');
    assert.match(done.report, /baseline-diff: INCONCLUSIVE \(unparseable-output\) - treated as a failure; no repair round was spent\./);
    assert.doesNotMatch(
      done.report.split('\n').find((line) => line.startsWith('next:')),
      /repair/,
      'the report never advertises a repair the server will not start',
    );
    assert.equal(done.verifyBaseline.reason, 'unparseable-output');
  } finally {
    h.finish();
  }
});

test('a green baseline with a failing result is a regression the worker can repair, using the raw verifier output', async () => {
  let round = 0;
  const h = await harness({
    verify: (call) => {
      if (!call.isResult) return spec([], 0);
      round += 1;
      return round === 1 ? unparseable() : spec([], 0);
    },
  });
  try {
    const started = await start(h);
    const done = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'DONE_VERIFIED');
    assert.equal(h.workers.length, 2, 'a real regression is repairable');
    assert.equal(h.workers[1].defects[0], 'Verifier failed:\nboom\n', 'with no parseable names the defect is the raw output');
    assert.equal(h.calls.filter((call) => !call.isResult).length, 1);
  } finally {
    h.finish();
  }
});

test('a regression against a green baseline is recorded with its parsed names and never passes', async () => {
  const h = await harness({
    verify: (call) => (call.isResult ? spec(['now broken']) : spec([], 0)),
    worker: async () => ({ status: 'DONE' }),
  });
  try {
    const started = await start(h, { maxRepairRounds: 0 });
    const done = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'VERIFY_FAILED');
    const baseline = (await h.m.store.get(started.jobId)).verify.baseline;
    assert.equal(baseline.status, 'compared');
    assert.equal(baseline.regression, true);
    assert.deepEqual(baseline.newFailures, ['now broken']);
    assert.match(
      done.report,
      /baseline-diff: the untouched snapshot passed but the result failed \(exit 1\) · 1 failing test\(s\) parsed\n {2}\| now broken/,
    );
  } finally {
    h.finish();
  }
});

test('a baseline run that times out or whose worktree cannot be made is inconclusive, never a pass', async () => {
  const timedOut = await harness({
    verify: (call) =>
      call.isResult
        ? spec(['old A'])
        : { command: 'verify', verdict: 'FAIL', result: { code: null, timedOut: true, sandbox: 'macos', stdout: '✖ old A\n' } },
  });
  try {
    const started = await start(timedOut);
    const done = await timedOut.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'VERIFY_FAILED');
    assert.equal(timedOut.workers.length, 1);
    assert.equal((await timedOut.m.store.get(started.jobId)).verify.baseline.reason, 'baseline-timed-out');
    assert.match(done.report, /raise verifierTimeoutSec/);
    assert.equal(worktrees(timedOut.repo).length, 1);
  } finally {
    timedOut.finish();
  }

  const throwing = await harness({
    verify: (call) => {
      if (call.isResult) return spec(['old A']);
      throw new Error('runner exploded');
    },
  });
  try {
    const started = await start(throwing);
    const done = await throwing.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'VERIFY_FAILED');
    assert.equal(throwing.workers.length, 1);
    const job = await throwing.m.store.get(started.jobId);
    assert.equal(job.verify.baseline.reason, 'baseline-unavailable');
    assert.equal(job.verifyBaselineWorkspacePath, undefined);
    assert.equal(worktrees(throwing.repo).length, 1, 'the baseline worktree is removed even when the runner throws');
  } finally {
    throwing.finish();
  }

  const noWorktree = await harness({ verify: () => spec(['old A']), config: { failCreateAfter: 1 } });
  try {
    const started = await start(noWorktree);
    const done = await noWorktree.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'VERIFY_FAILED');
    assert.equal(noWorktree.calls.length, 1, 'no baseline run without a baseline worktree');
    assert.equal((await noWorktree.m.store.get(started.jobId)).verify.baseline.reason, 'baseline-unavailable');
  } finally {
    noWorktree.finish();
  }
});

test('a baseline run that did not finish is never cached: a later verification measures the snapshot again', async () => {
  const timeout = { command: 'verify', verdict: 'FAIL', result: { code: null, timedOut: true, sandbox: 'macos', stdout: '✖ old A\n' } };
  for (const failure of ['timeout', 'no-worktree', 'throw']) {
    let baselines = 0;
    const h = await harness({
      verify: (call) => {
        if (call.isResult) return spec(['old A']);
        baselines += 1;
        if (baselines > 1 || failure === 'no-worktree') return spec(['old A']);
        if (failure === 'throw') throw new Error('runner exploded');
        return timeout;
      },
      // Creates: 1 is the worker's worktree, 2 the first baseline copy.
      config: failure === 'no-worktree' ? { failCreateAt: [2] } : {},
    });
    try {
      const started = await start(h);
      const first = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
      assert.equal(first.status, 'VERIFY_FAILED', failure);
      assert.equal((await h.m.store.get(started.jobId)).verify.baseline.status, 'inconclusive', failure);
      const createsAfterFirst = h.creates();

      await h.m.repair(started.jobId, ['measure the snapshot again']);
      const second = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
      assert.equal(second.status, 'DONE_VERIFIED', `${failure}: ${JSON.stringify((await h.m.store.get(started.jobId)).verify?.baseline)}`);
      const job = await h.m.store.get(started.jobId);
      assert.equal(job.verify.baseline.baseline.cached, false, failure);
      assert.equal(job.verify.baseline.baseline.failures, 1, failure);
      assert.equal(h.calls.filter((call) => !call.isResult).length, failure === 'no-worktree' ? 1 : 2, failure);
      assert.ok(h.creates() > createsAfterFirst, `${failure}: the second verification created a fresh baseline worktree`);
      assert.equal(worktrees(h.repo).length, 1, failure);
    } finally {
      h.finish();
    }
  }
});

test('cancelling during the baseline run ends CANCELLED and leaves no baseline worktree', async () => {
  let enteredBaseline;
  const entered = new Promise((resolve) => {
    enteredBaseline = resolve;
  });
  const h = await harness({
    verify: async (call) => {
      if (call.isResult) return spec(['old A']);
      enteredBaseline();
      await new Promise((resolve) => call.options.signal.addEventListener('abort', resolve, { once: true }));
      return {
        command: 'verify',
        verdict: 'FAIL',
        result: { code: null, signal: 'SIGTERM', cancelled: true, sandbox: 'macos', stdout: '' },
      };
    },
  });
  try {
    const started = await start(h);
    await entered;
    assert.equal(
      (await h.m.store.get(started.jobId)).verifyBaselineWorkspacePath,
      h.calls[1].options.cwd,
      'the copy is recorded before it is used',
    );
    await h.m.cancel(started.jobId);
    const done = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'CANCELLED');
    const job = await h.m.store.get(started.jobId);
    assert.equal(job.verifyBaselineWorkspacePath, undefined);
    assert.equal(existsSync(h.calls[1].options.cwd), false);
    assert.equal(worktrees(h.repo).length, 1);
    assert.equal(existsSync(join(h.repo, 'src', 'new.txt')), false, 'a cancelled job never integrates');
    assert.equal(h.workers.length, 1);
  } finally {
    h.finish();
  }
});

test('crash recovery removes an orphaned baseline worktree and refuses a forged path', async () => {
  const h = await harness({ verify: () => spec([]) });
  const forged = await mkdtemp(join(tmpdir(), 'offload-forged-baseline-'));
  try {
    write(join(forged, 'precious.txt'), 'keep\n');
    const started = await start(h);
    assert.equal((await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC })).status, 'DONE_VERIFIED');
    const job = await h.m.store.get(started.jobId);
    const orphan = createIsolatedWorktree({ repoPath: h.repo, baselineTree: job.before });
    assert.equal(worktrees(h.repo).length, 2);
    await h.m.store.update(started.jobId, { verifyBaselineWorkspacePath: orphan.path });
    assert.equal(await h.m.cleanupWorkspace(started.jobId), true);
    assert.equal(existsSync(orphan.path), false, 'the orphan copy is removed');
    assert.equal(worktrees(h.repo).length, 1);
    assert.equal((await h.m.store.get(started.jobId)).verifyBaselineWorkspacePath, undefined);

    await h.m.store.update(started.jobId, { verifyBaselineWorkspacePath: forged });
    assert.equal(await h.m.cleanupWorkspace(started.jobId), false, 'a path outside the server-created layout is rejected');
    assert.equal(await readFile(join(forged, 'precious.txt'), 'utf8'), 'keep\n');
    const after = await h.m.store.get(started.jobId);
    assert.equal(after.verifyBaselineWorkspacePath, forged, 'the field stays so the failure is visible and retryable');
    assert.match(after.workspaceCleanupError, /could not be completed/);
  } finally {
    cleanup(forged);
    h.finish();
  }
});

test('verifier options: the baseline mode defaults to a 300 s limit per run, runs share one sandbox shape, and the standard mode is unchanged', async () => {
  const withMode = async (extra) => {
    const h = await harness({ verify: (call) => (call.isResult ? spec(['old A', 'new B']) : spec(['old A'])) });
    try {
      const started = await start(h, { maxRepairRounds: 0, denyRead: ['secret/**'], extraWritable: ['cache/**'], ...extra });
      await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
      return h.calls;
    } finally {
      h.finish();
    }
  };
  const shape = (call) => ({
    denyRead: call.options.denyRead,
    writable: call.options.writablePaths.map((path) => relative(call.options.cwd, path)),
    readable: call.options.readablePaths.length,
    requireSandbox: call.options.requireSandbox,
    allowNetwork: call.options.allowNetwork,
  });
  const defaults = await withMode({});
  assert.equal(defaults.length, 2);
  assert.deepEqual(
    defaults.map((call) => call.options.timeoutSec),
    [300, 300],
  );
  assert.deepEqual(shape(defaults[0]), shape(defaults[1]));
  assert.deepEqual(shape(defaults[0]).writable, ['src/**', 'cache/**']);
  assert.equal(defaults[0].options.requireSandbox, true);
  assert.deepEqual(shape(defaults[0]).denyRead, ['secret/**']);
  assert.equal(typeof defaults[0].options.onOutput, 'function');
  assert.equal(typeof defaults[1].options.onOutput, 'function');

  const explicit = await withMode({ verifierTimeoutSec: 120 });
  assert.deepEqual(
    explicit.map((call) => call.options.timeoutSec),
    [120, 120],
  );

  const standard = await withMode({ verifierMode: undefined });
  assert.equal(standard.length, 1, 'the standard verifier never runs a baseline');
  assert.equal(Object.hasOwn(standard[0].options, 'timeoutSec'), false, 'the standard verifier keeps the runner default');
  assert.equal(Object.hasOwn(standard[0].options, 'onOutput'), false);
  assert.equal(Object.hasOwn(standard[0].options, 'outputCap'), false);
  const standardTimeout = await withMode({ verifierMode: 'standard', verifierTimeoutSec: 45 });
  assert.equal(standardTimeout[0].options.timeoutSec, 45);
  assert.equal(Object.hasOwn(standardTimeout[0].options, 'onOutput'), false);
});

test('an environment failure introduced with the new failures wins, but the same noise in the snapshot is not blamed', async () => {
  const eperm = "Error: EPERM: operation not permitted, mkdtemp '/tmp/zzz-XXXXXX'";
  // New environment failure: the snapshot has no such line.
  const fresh = await harness({
    verify: (call) => (call.isResult ? spec(['old A', 'new B'], 1, `${eperm}\n`) : spec(['old A'])),
  });
  try {
    const started = await start(fresh);
    const done = await fresh.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'VERIFY_ENV_FAILED');
    assert.equal(fresh.workers.length, 1, 'no repair round for an environment failure');
    assert.equal(done.verifyEnvironment.kind, 'temp-dir-denied');
    assert.match(done.report, /Hard-coded \/tmp is not writable in the verifier/);
  } finally {
    fresh.finish();
  }

  // The same environment line already appears in the untouched snapshot's run:
  // it did not cause the new failure, so the worker may still repair it.
  let round = 0;
  const preexisting = await harness({
    verify: (call) => {
      if (!call.isResult) return spec(['old A'], 1, `${eperm}\n`);
      round += 1;
      return round === 1 ? spec(['old A', 'new B'], 1, `${eperm}\n`) : spec(['old A'], 1, `${eperm}\n`);
    },
  });
  try {
    const started = await start(preexisting);
    const done = await preexisting.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'DONE_VERIFIED');
    assert.equal(preexisting.workers.length, 2);
    assert.deepEqual(defectLines(preexisting.workers[1].defects[0]), ['- new B']);
  } finally {
    preexisting.finish();
  }
});

test('a run that stopped early is inconclusive: identical transcripts never become DONE_VERIFIED', async () => {
  // Real pytest -x output: the run stops at the first (pre-existing) failure and never reaches the worker's new test.
  const pytestX = (command, stdout) => ({
    command,
    verdict: 'FAIL',
    result: { code: 1, sandbox: 'macos', durationMs: 5, stdout, stderr: '' },
  });
  const stopped = [
    '=========================== short test summary info ============================',
    'FAILED test_a.py::test_old_fail - assert False',
    '!!!!!!!!!!!!!!!!!!!!!!!!!! stopping after 1 failures !!!!!!!!!!!!!!!!!!!!!!!!!!!',
    '1 failed in 0.01s',
    '',
  ].join('\n');
  const cases = [
    ['pytest -x', 'verify', () => pytestX('verify', stopped)],
    // go prints nothing about -failfast: the command flag is what marks the run.
    ['go -failfast', 'go test -failfast ./...', () => spec(['TestOld'])],
  ];
  for (const [name, testCommand, output] of cases) {
    const h = await harness({ verify: () => output() });
    try {
      const started = await start(h, { testCommand });
      const done = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
      assert.equal(done.status, 'VERIFY_FAILED', name);
      assert.equal(h.workers.length, 1, `${name}: no repair round`);
      const job = await h.m.store.get(started.jobId);
      assert.equal(job.verify.baseline.status, 'inconclusive', name);
      assert.equal(job.verify.baseline.reason, 'stopped-early', name);
      assert.match(done.report, /baseline-diff: INCONCLUSIVE \(stopped-early\)/, name);
      assert.match(done.report, /--no-fail-fast/, name);
    } finally {
      h.finish();
    }
  }
  // A snapshot run that stopped early lists only the failures it reached, so the result's extra name is not
  // proven new: no repair round is spent on it.
  const partial = await harness({ verify: (call) => (call.isResult ? spec(['old A', 'new B']) : spec(['old A'])) });
  try {
    const started = await start(partial, { testCommand: 'go test -failfast ./...' });
    const done = await partial.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'VERIFY_FAILED');
    assert.equal(partial.workers.length, 1);
    assert.equal((await partial.m.store.get(started.jobId)).verify.baseline.reason, 'stopped-early');
  } finally {
    partial.finish();
  }
  // The same two runs without a stop marker or flag still compare and pass.
  const clean = await harness({ verify: () => spec(['TestOld']) });
  try {
    const started = await start(clean, { testCommand: 'go test ./...' });
    assert.equal((await clean.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC })).status, 'DONE_VERIFIED');
  } finally {
    clean.finish();
  }
});

test('a baseline that cannot be compared keeps the shared environment failure instead of blaming the worker', async () => {
  const missing = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zz-missing' imported from /x/a.js\n";
  const out = () => ({ command: 'verify', verdict: 'FAIL', result: { code: 1, sandbox: 'macos', stdout: '', stderr: missing } });
  const h = await harness({ verify: () => out() });
  try {
    const started = await start(h);
    const done = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    const job = await h.m.store.get(started.jobId);
    assert.equal(job.verify.baseline.status, 'inconclusive', 'neither run printed a recognised failure list');
    assert.equal(done.status, 'VERIFY_ENV_FAILED');
    assert.equal(done.verifyEnvironment.kind, 'missing-package');
    assert.equal(h.workers.length, 1);
  } finally {
    h.finish();
  }
});

test('mixed environment noise classifies the same in both runs whatever order it prints', async () => {
  const other = "Error: EPERM: operation not permitted, open '/opt/homebrew/etc/openssl@3/openssl.cnf'";
  const temp = "Error: EPERM: operation not permitted, mkdtemp '/tmp/zzz-XXXXXX'";
  let round = 0;
  const h = await harness({
    verify: (call) => {
      if (!call.isResult) return spec(['old A'], 1, `${temp}\n${other}\n`);
      round += 1;
      // The result prints the unrelated denial first; the snapshot printed the temp one first.
      return round === 1 ? spec(['old A', 'new B'], 1, `${other}\n${temp}\n`) : spec(['old A'], 1, `${temp}\n${other}\n`);
    },
  });
  try {
    const started = await start(h);
    const done = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'DONE_VERIFIED', 'the shared noise is not blamed, so the worker repairs the new failure');
    assert.deepEqual(defectLines(h.workers[1].defects[0]), ['- new B']);
  } finally {
    h.finish();
  }
});

test('a job cancelled just before the baseline run never creates a baseline worktree', async () => {
  let id;
  const h = await harness({
    verify: async (call) => {
      assert.equal(call.isResult, true, 'the baseline run must not start');
      // The result run finishes normally, then the job is cancelled before its baseline run begins.
      await h.m.cancel(id);
      return spec(['old A']);
    },
  });
  try {
    const started = await start(h);
    id = started.jobId;
    const done = await h.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'CANCELLED');
    assert.equal(h.creates(), 1, 'only the worker workspace was created');
    assert.equal(h.calls.length, 1);
    assert.equal(worktrees(h.repo).length, 1);
  } finally {
    h.finish();
  }
});

test('baseline-diff validation, public echo and durable round trip', async () => {
  const base = { task: 'x', ownedPaths: ['src/**'], testCommand: 'true' };
  assert.doesNotThrow(() => validateJobRequest({ ...base, verifierMode: 'baseline-diff', verifierTimeoutSec: 5 }));
  assert.doesNotThrow(() => validateJobRequest({ ...base, verifierMode: 'standard', verifierTimeoutSec: 1800 }));
  assert.throws(
    () => validateJobRequest({ ...base, verifierMode: 'Baseline-Diff' }),
    /^Error: verifierMode must be standard or baseline-diff$/,
  );
  for (const verifierTimeoutSec of [4, 1801, 5.5, '9', Number.POSITIVE_INFINITY])
    assert.throws(
      () => validateJobRequest({ ...base, verifierTimeoutSec }),
      /^Error: verifierTimeoutSec must be an integer from 5 to 1800$/,
    );
  assert.throws(
    () => validateJobRequest({ ...base, verifierMode: 'baseline-diff', unsafePolicyOnlyVerifier: true }),
    /baseline-diff verification requires the macOS sandbox and cannot use unsafePolicyOnlyVerifier/,
  );
  assert.throws(
    () => validateJobRequest({ task: 'r', mode: 'report', verifierMode: 'baseline-diff' }),
    /report jobs do not use verifier sandbox options/,
  );
  assert.throws(
    () => validateJobRequest({ task: 'r', mode: 'report', verifierTimeoutSec: 60 }),
    /report jobs do not use verifier sandbox options/,
  );

  // A manager with no isolated worktrees cannot run a baseline.
  const repo = makeRepo();
  const plain = new JobManager({
    store: new JobStore({ gitDir: await mkdtemp(join(tmpdir(), 'offload-baseline-plain-')) }),
    snapshots: gitSnapshots(),
    worker: { run: async () => ({ status: 'DONE' }) },
    config: { repoPath: repo, git: { branch: async () => 'main', head: async () => 'a'.repeat(40) } },
  });
  try {
    await assert.rejects(
      () => plain.start({ ...base, repoPath: repo, verifierMode: 'baseline-diff' }),
      /baseline-diff verification requires an isolated private worktree/,
    );
    await assert.rejects(
      () => plain.start({ task: 'x', ownedPaths: ['src/**'], repoPath: repo, verifierMode: 'baseline-diff' }),
      /baseline-diff verification requires a testCommand/,
    );
    assert.equal(
      plain.public({ id: 'j', repoPath: repo, status: 'DONE_VERIFIED', verifierMode: 'baseline-diff' }).verifierMode,
      'baseline-diff',
    );
    assert.equal(Object.hasOwn(plain.public({ id: 'j', repoPath: repo, status: 'DONE_VERIFIED' }), 'verifierMode'), false);
    const hostile = plain.public({
      id: 'j',
      repoPath: repo,
      status: 'VERIFY_FAILED',
      verify: {
        baseline: {
          mode: 'baseline-diff',
          status: 'compared',
          newFailureCount: 3,
          newFailures: ['evil\n\u001b[31mred', ...Array.from({ length: 80 }, (_, index) => `n${index}`)],
          preexisting: -4,
          secret: 'leak',
          reason: 'Not Valid!',
        },
      },
    });
    assert.equal(hostile.verifyBaseline.newFailures.length, 50);
    assert.equal(hostile.verifyBaseline.newFailures[0], 'evil red');
    assert.equal(hostile.verifyBaseline.preexisting, 0);
    assert.equal(Object.hasOwn(hostile.verifyBaseline, 'secret'), false);
    assert.equal(Object.hasOwn(hostile.verifyBaseline, 'reason'), false);
    assert.equal(
      plain.public({ id: 'j', repoPath: repo, status: 'X', verify: { baseline: { mode: 'other', status: 'compared' } } }).verifyBaseline,
      undefined,
    );
  } finally {
    cleanup(repo);
  }
});

test(
  'end to end with the real sandboxed runner: node:test output flows through the streaming parser',
  {
    skip: !HOMEBREW_NODE ? 'requires a Homebrew Node on macOS' : !sandboxAvailable() && MACOS_SANDBOX_SKIP_REASON,
  },
  async () => {
    const run = async ({ added, expectStatus, expectNew }) => {
      const repo = makeRepo();
      write(join(repo, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      write(
        join(repo, 'test', 'old.test.mjs'),
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('always failing', () => assert.equal(1, 2));\n",
      );
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'old failing test']);
      const gitDir = await mkdtemp(join(tmpdir(), 'offload-baseline-e2e-'));
      const m = new JobManager({
        store: new JobStore({ gitDir }),
        snapshots: gitSnapshots(),
        worker: {
          run: async (job) => {
            write(join(job.workspacePath, 'test', 'new.test.mjs'), added);
            return { status: 'DONE' };
          },
        },
        runner: new Runner({ defaults: { sandbox: true } }),
        config: {
          repoPath: repo,
          git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
          applyPatch: gitPatchApplier,
          isolation: { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree },
        },
      });
      try {
        const started = await m.start({
          task: 'add a test',
          ownedPaths: ['test/new.test.mjs'],
          repoPath: repo,
          testCommand: 'node --test test/old.test.mjs test/new.test.mjs',
          verifierMode: 'baseline-diff',
          maxRepairRounds: 0,
        });
        const done = await m.wait(started.jobId, { timeoutSec: 50 });
        const job = await m.store.get(started.jobId);
        assert.equal(done.status, expectStatus, JSON.stringify(job.verify?.baseline));
        assert.equal(job.verify.result.sandbox, 'macos');
        assert.equal(job.verify.baseline.status, 'compared');
        assert.equal(job.verify.baseline.preexisting, 1);
        assert.equal(job.verify.baseline.baseline.failures, 1);
        assert.deepEqual(job.verify.baseline.newFailures, expectNew);
        assert.equal(job.verify.baseline.format, 'node-spec');
        assert.equal(job.verifyBaselineWorkspacePath, undefined);
        assert.equal(worktrees(repo).length, 1);
      } finally {
        cleanup(repo);
      }
    };
    await run({
      added: "import test from 'node:test';\ntest('fresh passing', () => {});\n",
      expectStatus: 'DONE_VERIFIED',
      expectNew: [],
    });
    await run({
      added: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fresh failing', () => assert.equal(1, 2));\n",
      expectStatus: 'VERIFY_FAILED',
      expectNew: ['fresh failing'],
    });
  },
);

test('a timed-out or unsandboxed result run skips the baseline and keeps the standard outcome', async () => {
  let round = 0;
  const timedOut = await harness({
    verify: () => {
      round += 1;
      return round === 1
        ? { command: 'verify', verdict: 'FAIL', result: { code: null, timedOut: true, sandbox: 'macos', stdout: '✖ partial\n' } }
        : spec([]);
    },
  });
  try {
    const started = await start(timedOut);
    const done = await timedOut.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'DONE_VERIFIED', 'a result timeout keeps the ordinary repair path');
    assert.equal(timedOut.calls.filter((call) => !call.isResult).length, 0, 'a timeout proves nothing, so no baseline is run');
    assert.equal(timedOut.workers.length, 2);
    assert.equal(timedOut.workers[1].defects[0].startsWith('Verifier failed:\n'), true);
  } finally {
    timedOut.finish();
  }

  const unsandboxed = await harness({
    verify: () => ({ command: 'verify', verdict: 'FAIL', result: { code: 1, sandbox: 'policy-only', stdout: '✖ x\nℹ fail 1\n' } }),
  });
  try {
    const started = await start(unsandboxed);
    const done = await unsandboxed.m.wait(started.jobId, { timeoutSec: TIMEOUT_SEC });
    assert.equal(done.status, 'VERIFY_FAILED');
    assert.equal(unsandboxed.calls.length, 1);
    assert.equal((await unsandboxed.m.store.get(started.jobId)).verify.baseline.reason, 'sandbox-unavailable');
    assert.match(done.report, /baseline-diff: skipped \(the verifier did not run under the macOS sandbox\)/);
  } finally {
    unsandboxed.finish();
  }
});
