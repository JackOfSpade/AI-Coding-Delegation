import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../../src/store.mjs';
import { JobManager } from '../../src/job-manager.mjs';
import { gitPatchApplier, gitSnapshots } from '../../src/core.mjs';
import { Runner } from '../../src/runner.mjs';
import { sandboxAvailable } from '../../src/sandbox.mjs';
import { cleanupIsolatedWorktree, createIsolatedWorktree, integrateRecordedTree, openIsolatedWorktree } from '../../src/worktree.mjs';
import { cleanup, git, makeRepo, write } from '../unit/helpers.mjs';

const WAIT_SEC = 15;
const JOB_COMMAND = 'npm test';
const CHECK = 'node check.js';
const ENV_STDERR =
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'jsdom' imported from /private/var/x/workspace/scripts/tests/testHelpers.js";
const JOB_BYTES = 'export const a = 1;\n';
const SKIP_REASON = 'requires an available macOS sandbox';

const green = (extra = {}) => ({
  command: CHECK,
  verdict: 'PASS',
  result: { code: 0, stdout: 'marker line one\nmarker line two\n', stderr: '', sandbox: 'macos', durationMs: 1500, ...extra },
});
const red = (extra = {}) => ({
  command: CHECK,
  verdict: 'FAIL',
  result: { code: 1, stdout: '', stderr: 'AssertionError: boom 42\n', sandbox: 'macos', durationMs: 800, ...extra },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

/**
 * A real isolated-worktree manager. The job's own verifier (testCommand
 * `npm test`) always reports an environment failure so the job lands in
 * VERIFY_ENV_FAILED (unless `jobVerify` says otherwise); every other command is the applyThenVerify command and goes
 * to `check`, which can look at the real primary checkout while it "runs".
 */
async function harness({
  check = () => green(),
  runner = {},
  leases,
  isolation = {},
  applyPatch = gitPatchApplier,
  denyRead,
  allowNetwork,
  jobVerify = () => ({ code: 1, stderr: ENV_STDERR, sandbox: 'macos' }),
  workerStatus,
} = {}) {
  const repo = makeRepo();
  const gitDir = await mkdtemp(`${tmpdir()}/offload-applyverify-`);
  const calls = [];
  const manager = new JobManager({
    store: new JobStore({ gitDir }),
    snapshots: gitSnapshots(),
    ...(leases ? { leases } : {}),
    worker: {
      run: async (job) => {
        write(join(job.workspacePath, 'src', 'a.js'), JOB_BYTES);
        return { status: workerStatus?.() ?? 'DONE', turns: 2 };
      },
    },
    runner: {
      ...runner,
      verify: async (command, options) => {
        if (command === JOB_COMMAND) {
          const result = jobVerify();
          return { command, verdict: result.code === 0 ? 'PASS' : 'FAIL', result };
        }
        calls.push({ command, options });
        return check(command, options, calls.length);
      },
    },
    config: {
      repoPath: repo,
      git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
      applyPatch: (...args) => applyPatch(...args),
      isolation: {
        create: createIsolatedWorktree,
        open: openIsolatedWorktree,
        cleanup: cleanupIsolatedWorktree,
        integrateRecorded: integrateRecordedTree,
        ...isolation,
      },
    },
  });
  const started = await manager.start({
    task: 'env',
    ownedPaths: ['src/**'],
    repoPath: repo,
    testCommand: JOB_COMMAND,
    ...(denyRead ? { denyRead } : {}),
    ...(allowNetwork ? { allowNetwork } : {}),
  });
  const done = await manager.wait(started.jobId, { timeoutSec: WAIT_SEC, detail: 'full' });
  assert.equal(done.status, workerStatus?.() === 'BUDGET' ? 'BUDGET' : 'VERIFY_ENV_FAILED');
  write(join(repo, 'unrelated.txt'), 'primary work in progress\n');
  return { repo, manager, calls, id: started.jobId, snapshots: gitSnapshots(), store: manager.store };
}
const run = async (testBody) => {
  const h = await harness(testBody.options);
  try {
    await testBody.run(h);
  } finally {
    cleanup(h.repo);
  }
};
const via = (command = CHECK, extra = {}) => ({ apply: true, applyThenVerify: command, ...extra });
const readReport = (h) => h.store.readArtifact(h.id, 'report.md');
const status = (h) => git(h.repo, ['status', '--porcelain']);

test('a passing applyThenVerify runs AFTER the apply, read-only, and leaves DONE_UNVERIFIED with the evidence', async () => {
  const seen = {};
  await run({
    options: {
      denyRead: ['secrets/**'],
      check: (command, options) => {
        // The command must see the applied diff, so the apply came first.
        seen.contents = readFileSync(join(options.cwd, 'src', 'a.js'), 'utf8');
        seen.options = options;
        return green();
      },
    },
    run: async (h) => {
      const result = await h.manager.apply(h.id, via());
      assert.equal(seen.contents, JOB_BYTES);
      assert.deepEqual(seen.options.writablePaths, [], 'the primary is read-only to the command');
      assert.equal(seen.options.requireSandbox, true);
      assert.equal(seen.options.timeoutMs, 300_000);
      assert.equal(seen.options.allowNetwork, false);
      assert.deepEqual(seen.options.denyRead, ['secrets/**'], "the job's own read denials follow the command into the primary");
      assert.equal(seen.options.cwd, realpathSync(h.repo), 'it runs in the primary checkout');
      assert.ok(seen.options.signal instanceof AbortSignal);
      assert.match(seen.options.gitDir, /\.git$/);
      assert.equal(result.applied, true);
      assert.equal(result.status, 'DONE_UNVERIFIED');
      assert.equal(result.previousStatus, 'VERIFY_ENV_FAILED');
      assert.equal(result.applyThenVerify.outcome, 'PASSED');
      assert.equal(result.applyThenVerify.exitCode, 0);
      assert.equal(result.applyThenVerify.outputTail, 'marker line one\nmarker line two');
      assert.equal(result.applyThenVerify.sandbox, 'required');
      assert.equal(result.applyThenVerify.ranUnder, 'macos');
      const job = await h.store.get(h.id);
      assert.equal(job.status, 'DONE_UNVERIFIED');
      assert.equal(job.applied, true);
      assert.equal(job.applyVerifyIntent, false, 'the journal is cleared');
      assert.equal(job.integrationIntent, false);
      assert.equal(job.applyVerify.phase, undefined);
      assert.equal(job.applyVerify.outcome, 'PASSED');
      assert.equal(job.appliedUnverified.verifiedBy, '');
      assert.equal(job.appliedUnverified.previousStatus, 'VERIFY_ENV_FAILED');
      assert.equal(job.appliedUnverified.applyThenVerify.outcome, 'PASSED');
      const report = await readReport(h);
      assert.match(report, /^applyThenVerify PASSED \(exit 0, 1\.5s, sandbox: macos\): `node check\.js`/m);
      assert.match(report, /not server-verified/);
      assert.match(report, /primary's own check: applyThenVerify \(below\)/);
      assert.doesNotMatch(report, /DONE_VERIFIED/);
      const view = await h.manager.job(h.id);
      assert.equal(view.applyThenVerify.outcome, 'PASSED');
      assert.equal(view.applyThenVerify.outputTail, undefined, 'the public view never carries the output');
      // The ordinary safety net still applies afterwards.
      await assert.rejects(() => h.manager.apply(h.id, via()), /already applied/);
      assert.deepEqual(await h.manager.revert(h.id), { dryRun: true, applied: false });
      assert.deepEqual(await h.manager.revert(h.id, { apply: true }), { dryRun: false, applied: true });
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    },
  });
});

test('a BUDGET write job with a focused verifier can use applyThenVerify instead of landing from primary-only evidence', async () => {
  await run({
    options: { workerStatus: () => 'BUDGET' },
    run: async (h) => {
      const before = await readReport(h);
      assert.match(before, /configured verifier: not run because the worker reached its cap before finish/);
      assert.match(before, /use applyThenVerify with the same focused check/);

      const result = await h.manager.apply(h.id, via());
      assert.equal(result.applied, true);
      assert.equal(result.previousStatus, 'BUDGET');
      assert.equal(result.status, 'DONE_UNVERIFIED');
      assert.equal(result.applyThenVerify.outcome, 'PASSED');
      assert.equal(h.calls.length, 1, 'the server ran the focused primary-check path after applying');
      assert.equal(h.calls[0].command, CHECK);
      assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), JOB_BYTES);
      const job = await h.store.get(h.id);
      assert.equal(job.appliedUnverified.previousStatus, 'BUDGET');
      assert.equal(job.appliedUnverified.applyThenVerify.outcome, 'PASSED');
      assert.equal(job.appliedUnverified.verifiedBy, '');
    },
  });
});

test('apply needs verifiedBy or applyThenVerify, and a malformed verifiedBy is refused even beside a command', async () => {
  await run({
    run: async (h) => {
      const need = /verifiedBy must state the check you ran.*or applyThenVerify must give a command/;
      for (const verifiedBy of [undefined, '', 'short', 'x'.repeat(1001)])
        await assert.rejects(() => h.manager.apply(h.id, { apply: true, verifiedBy }), need);
      for (const verifiedBy of ['short', '   ', 'x'.repeat(1001), 42])
        await assert.rejects(() => h.manager.apply(h.id, via(CHECK, { verifiedBy })), need, String(verifiedBy));
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
      assert.equal(h.calls.length, 0);
      // Both together are both recorded.
      const evidence = 'ran npm test in the primary before: 12 pass';
      const result = await h.manager.apply(h.id, via(CHECK, { verifiedBy: evidence }));
      assert.equal(result.applyThenVerify.outcome, 'PASSED');
      const job = await h.store.get(h.id);
      assert.equal(job.appliedUnverified.verifiedBy, evidence);
      assert.equal(job.appliedUnverified.applyThenVerify.outcome, 'PASSED');
      assert.match(await readReport(h), /primary's own check: ran npm test in the primary before/);
    },
  });
});

test('a failing command reverts the diff, proves the primary is restored, and keeps the job apply-eligible', async () => {
  await run({
    options: { check: () => red() },
    run: async (h) => {
      const beforeTree = await h.snapshots.create(h.repo);
      const beforeStatus = status(h);
      const result = await h.manager.apply(h.id, via());
      assert.equal(result.applied, false);
      assert.equal(result.reverted, true);
      assert.equal(result.status, 'VERIFY_ENV_FAILED', 'the prior status is untouched');
      assert.equal(result.applyThenVerify.outcome, 'FAILED');
      assert.equal(result.applyThenVerify.exitCode, 1);
      assert.equal(result.applyThenVerify.outputTail, 'AssertionError: boom 42');
      assert.equal(result.applyThenVerify.revertVerified, true);
      assert.equal(result.applyThenVerify.primaryRestoredExactly, true);
      assert.match(result.message, /applyThenVerify FAILED; the diff was REVERTED/);
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
      assert.equal(await h.snapshots.create(h.repo), beforeTree, 'the primary tree is byte-identical to before');
      assert.equal(status(h), beforeStatus);
      assert.equal(await readFile(join(h.repo, 'unrelated.txt'), 'utf8'), 'primary work in progress\n');
      const job = await h.store.get(h.id);
      assert.equal(job.status, 'VERIFY_ENV_FAILED');
      assert.equal(job.applied, false);
      assert.equal(job.revertedAt, undefined, 'an auto-revert is not a manual revert');
      assert.equal(job.applyVerifyIntent, false);
      assert.equal(job.integrationIntent, false);
      assert.equal(job.revertIntent, false);
      assert.equal(job.applyVerify.reverted, true);
      assert.equal(job.applyVerify.attempts, 1);
      const report = await readReport(h);
      assert.match(report, /applyThenVerify FAILED \(exit 1.*the diff was REVERTED/);
      assert.match(report, /^ {2}\| AssertionError: boom 42$/m);
      assert.match(report, /next: .*apply \(after your own check\)/);
      await assert.rejects(() => h.manager.revert(h.id, { apply: true }), /not applied/);
      // An auto-revert must not leave the job stuck as "already applied" or "reverted".
      const again = await h.manager.apply(h.id, { apply: true, verifiedBy: 'ran the suite by hand in the primary' });
      assert.equal(again.applied, true);
      assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), JOB_BYTES);
    },
  });
});

test('after a revert the same job applies for real once the check passes', async () => {
  let pass = false;
  await run({
    options: { check: () => (pass ? green() : red()) },
    run: async (h) => {
      assert.equal((await h.manager.apply(h.id, via())).applied, false);
      pass = true;
      const second = await h.manager.apply(h.id, via());
      assert.equal(second.applied, true);
      assert.equal(second.status, 'DONE_UNVERIFIED');
      assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), JOB_BYTES);
      const job = await h.store.get(h.id);
      assert.equal(job.applyVerify.attempts, 2);
      assert.equal(job.applied, true);
    },
  });
});

test('timeout, a command that cannot start, and a policy-only run each revert and are never a pass', async () => {
  const cases = [
    [
      'TIMED_OUT',
      () => ({
        command: CHECK,
        verdict: 'FAIL',
        result: { code: null, timedOut: true, sandbox: 'macos', stdout: 'still going', stderr: '' },
      }),
    ],
    [
      'NOT_RUN',
      () => {
        throw new Error('Required macOS sandbox is unavailable for this command');
      },
    ],
    ['NOT_RUN', () => green({ sandbox: 'policy-only' })],
  ];
  for (const [outcome, check] of cases) {
    await run({
      options: { check },
      run: async (h) => {
        const result = await h.manager.apply(h.id, via());
        assert.equal(result.applied, false, outcome);
        assert.equal(result.applyThenVerify.outcome, outcome);
        assert.equal(result.applyThenVerify.reverted, true);
        assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
        const job = await h.store.get(h.id);
        assert.equal(job.applied, false);
        if (outcome === 'NOT_RUN') assert.match(job.applyVerify.error, /macOS sandbox/);
      },
    });
  }
});

test('cancelling through the request signal, offload_cancel, or shutdown stops the command and reverts the diff', async () => {
  for (const how of ['signal', 'cancel', 'shutdown']) {
    const started = deferred();
    const observed = {};
    await run({
      options: {
        check: async (command, options) => {
          started.resolve();
          await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
          observed.aborted = options.signal.aborted;
          return { command, verdict: 'FAIL', result: { code: null, cancelled: true, sandbox: 'macos', stdout: '', stderr: '' } };
        },
      },
      run: async (h) => {
        const request = new AbortController();
        const pending = h.manager.apply(h.id, via(CHECK, how === 'signal' ? { signal: request.signal } : {}));
        await started.promise;
        assert.equal(h.manager.controllers.has(h.id), true, 'the run is registered so cancel/shutdown can reach it');
        if (how === 'signal') request.abort();
        else if (how === 'cancel') await h.manager.cancel(h.id);
        else await h.manager.shutdown();
        const result = await pending;
        assert.equal(observed.aborted, true, how);
        assert.equal(result.applied, false, how);
        assert.equal(result.applyThenVerify.outcome, 'CANCELLED', how);
        assert.equal(result.applyThenVerify.reverted, true);
        assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false, `${how}: the diff is reverted`);
        assert.equal(h.manager.controllers.has(h.id), false, 'the controller is released');
        assert.equal((await h.store.get(h.id)).applyVerifyIntent, false);
      },
    });
  }
});

test('a request aborted before the apply starts changes nothing, and one aborted right after the apply reverts without running the command', async () => {
  await run({
    run: async (h) => {
      const request = new AbortController();
      request.abort();
      await assert.rejects(() => h.manager.apply(h.id, via(CHECK, { signal: request.signal })), /cancelled/);
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
      assert.equal(h.calls.length, 0);
      const job = await h.store.get(h.id);
      assert.equal(job.applyVerifyIntent, false, 'the journal is undone');
      assert.equal(job.integrationIntent, false);
      assert.equal(job.status, 'VERIFY_ENV_FAILED');
    },
  });
  const request = new AbortController();
  await run({
    options: {
      isolation: {
        integrateRecorded: (target) => {
          const result = integrateRecordedTree(target);
          if (!target.dryRun) request.abort();
          return result;
        },
      },
    },
    run: async (h) => {
      const result = await h.manager.apply(h.id, via(CHECK, { signal: request.signal }));
      assert.equal(h.calls.length, 0, 'the command is never started once the request is cancelled');
      assert.equal(result.applied, false);
      assert.equal(result.applyThenVerify.outcome, 'CANCELLED');
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    },
  });
});

test('the UNSANDBOXED label follows what ran, not the consent that allowed it', async () => {
  // Consent was given but the host sandboxed the command anyway.
  await run({
    run: async (h) => {
      const result = await h.manager.apply(h.id, via(CHECK, { unsafePolicyOnlyVerifier: true }));
      assert.equal(result.applyThenVerify.sandbox, 'policy-only-authorized');
      assert.equal(result.applyThenVerify.ranUnder, 'macos');
      const report = await readReport(h);
      assert.match(report, /sandbox: macos/);
      assert.match(report, /ran sandboxed/);
      assert.doesNotMatch(report, /UNSANDBOXED/);
    },
  });
});

test('the command never gets network access, whatever the job was granted', async () => {
  await run({
    options: { allowNetwork: true },
    run: async (h) => {
      assert.equal((await h.store.get(h.id)).allowNetwork, true, 'the job itself has network');
      await h.manager.apply(h.id, via());
      assert.equal(h.calls[0].options.allowNetwork, false);
    },
  });
});

test('another process cancelling a running applyThenVerify stops the command and reverts, and leaves no marker behind', async () => {
  const started = deferred();
  await run({
    options: {
      check: async (command, options) => {
        started.resolve();
        // A cancel that never arrives must fail the test, not hang it.
        const timer = setTimeout(() => options.signal.dispatchEvent(new Event('timeout')), 3000);
        const cancelled = await new Promise((resolve) => {
          options.signal.addEventListener('abort', () => resolve(true), { once: true });
          options.signal.addEventListener('timeout', () => resolve(false), { once: true });
        });
        clearTimeout(timer);
        return cancelled
          ? { command, verdict: 'FAIL', result: { code: null, cancelled: true, sandbox: 'macos', stdout: '', stderr: '' } }
          : green();
      },
    },
    run: async (h) => {
      // A control-plane process: same store, no controller for this run.
      const other = new JobManager({ store: h.store, snapshots: gitSnapshots() });
      const pending = h.manager.apply(h.id, via());
      await started.promise;
      assert.equal(other.controllers.has(h.id), false);
      await other.cancel(h.id);
      const result = await pending;
      assert.equal(result.applyThenVerify.outcome, 'CANCELLED');
      assert.equal(result.applyThenVerify.reverted, true);
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false, 'the diff is reverted');
      assert.equal(await h.store.cancelRequested(h.id), false, 'the marker was consumed');
      // Apply-eligible again: a stale marker would refuse this.
      assert.equal((await h.manager.apply(h.id, via())).applyThenVerify.outcome, 'PASSED');
    },
  });
});

test('a policy-only host refuses applyThenVerify before anything is applied unless the caller consents', async () => {
  const probes = [
    { sandboxAvailable: () => false },
    { sandboxStatus: () => ({ available: false, reason: 'sandbox-apply-not-permitted' }), sandboxAvailable: () => true },
  ];
  for (const runner of probes) {
    await run({
      options: { runner },
      run: async (h) => {
        const refusal =
          /applyThenVerify requires a macOS sandbox and this host is policy-only.*pass verifiedBy instead.*unsafePolicyOnlyVerifier/;
        await assert.rejects(() => h.manager.apply(h.id, via()), refusal);
        await assert.rejects(
          () => h.manager.apply(h.id, { apply: false, applyThenVerify: CHECK }),
          refusal,
          'a dry run is preflighted too',
        );
        assert.equal(h.calls.length, 0);
        assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
        assert.equal((await h.store.get(h.id)).applyVerifyIntent, undefined);
      },
    });
  }
  await run({
    options: {
      runner: { sandboxAvailable: () => false },
      check: () => green({ sandbox: 'policy-only' }),
    },
    run: async (h) => {
      const dry = await h.manager.apply(h.id, { apply: false, applyThenVerify: CHECK, unsafePolicyOnlyVerifier: true });
      assert.equal(dry.applyThenVerify.sandbox, 'policy-only-authorized');
      const result = await h.manager.apply(h.id, via(CHECK, { unsafePolicyOnlyVerifier: true }));
      assert.equal(h.calls[0].options.requireSandbox, false);
      assert.equal(result.applyThenVerify.outcome, 'PASSED');
      assert.equal(result.applyThenVerify.sandbox, 'policy-only-authorized');
      assert.match(await readReport(h), /UNSANDBOXED \(policy-only authorized by the caller\)/);
    },
  });
});

test('applyThenVerify options are validated before anything runs, and the dependent ones need a command', async () => {
  await run({
    run: async (h) => {
      for (const value of [4, 901, 1.5, '30'])
        await assert.rejects(
          () => h.manager.apply(h.id, via(CHECK, { applyThenVerifyTimeoutSec: value })),
          /applyThenVerifyTimeoutSec must be an integer from 5 to 900/,
        );
      await assert.rejects(() => h.manager.apply(h.id, via(' ')), /applyThenVerify must be a non-empty string/);
      await assert.rejects(
        () => h.manager.apply(h.id, via(CHECK, { unsafePolicyOnlyVerifier: 'yes' })),
        /unsafePolicyOnlyVerifier must be boolean/,
      );
      await assert.rejects(
        () => h.manager.apply(h.id, { apply: true, verifiedBy: 'ran the tests by hand', unsafePolicyOnlyVerifier: true }),
        /require applyThenVerify/,
      );
      await assert.rejects(
        () => h.manager.apply(h.id, { apply: true, verifiedBy: 'ran the tests by hand', applyThenVerifyTimeoutSec: 30 }),
        /require applyThenVerify/,
      );
      assert.equal(h.calls.length, 0);
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
      await h.manager.apply(h.id, via(CHECK, { applyThenVerifyTimeoutSec: 30 }));
      assert.equal(h.calls[0].options.timeoutMs, 30_000);
    },
  });
});

test('a dry run with applyThenVerify previews the plan and writes, runs and leases nothing', async () => {
  const events = [];
  await run({
    options: {
      leases: {
        acquire: async () => void events.push('acquire'),
        release: async () => void events.push('release'),
      },
    },
    run: async (h) => {
      events.length = 0;
      const plain = await h.manager.apply(h.id);
      assert.deepEqual(
        plain,
        { dryRun: true, applied: false, files: ['src/a.js'], fromStatus: 'VERIFY_ENV_FAILED' },
        'no plan: byte-identical output',
      );
      const dry = await h.manager.apply(h.id, { apply: false, applyThenVerify: ` ${CHECK} ` });
      assert.deepEqual(dry, {
        dryRun: true,
        applied: false,
        files: ['src/a.js'],
        fromStatus: 'VERIFY_ENV_FAILED',
        applyThenVerify: { command: CHECK, timeoutSec: 300, sandbox: 'required' },
      });
      assert.equal(h.calls.length, 0);
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
      assert.deepEqual(events, []);
      assert.equal((await h.store.get(h.id)).applyVerifyIntent, undefined);
    },
  });
});

test('the write lease is held from before the apply until after the revert, and a second apply waits its turn', async () => {
  const events = [];
  const blocked = deferred();
  const started = deferred();
  await run({
    options: {
      leases: {
        acquire: async () => void events.push('acquire'),
        release: async () => void events.push('release'),
      },
      applyPatch: async (repo, patch, options) => {
        if (options.reverse && !options.check) events.push('revert');
        return gitPatchApplier(repo, patch, options);
      },
      check: async () => {
        events.push('verify');
        started.resolve();
        await blocked.promise;
        return red();
      },
    },
    run: async (h) => {
      events.length = 0;
      const first = h.manager.apply(h.id, via());
      await started.promise;
      assert.deepEqual(events, ['acquire', 'verify'], 'held while the command runs');
      // A second apply joins the owner and re-evaluates afterwards; it never overlaps the first.
      const second = h.manager.apply(h.id, via());
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(h.calls.length, 1, 'the second command has not started while the first holds the job');
      blocked.resolve();
      assert.equal((await first).applied, false);
      assert.deepEqual(events.slice(0, 4), ['acquire', 'verify', 'revert', 'release'], 'released only after the revert');
      assert.equal((await second).applied, false);
      assert.deepEqual(events.slice(4), ['acquire', 'verify', 'revert', 'release']);
      assert.equal(h.calls.length, 2);
    },
  });
});

test('edits to a job-owned path while the command runs are never overwritten by the revert', async () => {
  for (const [name, exit] of [
    ['failing', red],
    ['passing', green],
  ]) {
    await run({
      options: {
        check: (command, options) => {
          write(join(options.cwd, 'src', 'a.js'), 'a human edited this while the check ran\n');
          return exit();
        },
      },
      run: async (h) => {
        await assert.rejects(
          () => h.manager.apply(h.id, via()),
          (error) => {
            assert.match(error.message, /automatic revert did NOT complete/, name);
            assert.match(error.message, /STILL APPLIED/);
            assert.match(error.message, /no automatic revert was attempted/);
            if (name === 'passing') assert.match(error.message, /command passed but is not trusted/);
            return true;
          },
        );
        assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), 'a human edited this while the check ran\n', 'the edit survives');
        const job = await h.store.get(h.id);
        assert.equal(job.applied, true);
        assert.equal(job.status, 'DONE_UNVERIFIED');
        assert.equal(job.applyVerifyIntent, false);
        assert.equal(job.revertIntent === true, false);
        assert.equal(job.applyVerify.outcome, 'PRIMARY_CHANGED');
        assert.equal(job.applyVerify.commandOutcome, name === 'passing' ? 'PASSED' : 'FAILED');
        assert.deepEqual(job.applyVerify.changed, ['src/a.js']);
        assert.equal(job.applyVerify.reverted, false);
        const report = await readReport(h);
        assert.match(report, /AUTO-REVERT DID NOT COMPLETE/);
        assert.match(report, /next: .*revert/);
        assert.equal((await h.manager.job(h.id)).applyThenVerify.outcome, 'PRIMARY_CHANGED');
      },
    });
  }
});

test('edits to unrelated files while the command runs are tolerated, reported, and left alone', async () => {
  await run({
    options: {
      check: (command, options) => {
        write(join(options.cwd, 'unrelated.txt'), 'edited during the check\n');
        return red();
      },
    },
    run: async (h) => {
      const result = await h.manager.apply(h.id, via());
      assert.equal(result.applied, false);
      assert.equal(result.applyThenVerify.reverted, true);
      assert.deepEqual(result.applyThenVerify.primaryChangedDuringVerify, ['unrelated.txt']);
      assert.equal(result.applyThenVerify.primaryRestoredExactly, false);
      assert.equal(await readFile(join(h.repo, 'unrelated.txt'), 'utf8'), 'edited during the check\n');
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
      assert.match(result.message, /other primary files changed during verification and were left alone/);
    },
  });
});

test('a branch or HEAD move while the command runs is a loud PRIMARY_CHANGED, not a revert', async () => {
  await run({
    options: {
      check: (command, options) => {
        git(options.cwd, ['add', '-A']);
        git(options.cwd, ['commit', '-m', 'committed during the check']);
        return green();
      },
    },
    run: async (h) => {
      await assert.rejects(() => h.manager.apply(h.id, via()), /automatic revert did NOT complete.*branch, HEAD, or the index/s);
      const job = await h.store.get(h.id);
      assert.equal(job.applyVerify.outcome, 'PRIMARY_CHANGED');
      assert.equal(job.applied, true);
      assert.equal(job.applyVerifyIntent, false);
    },
  });
});

test('a revert that fails is thrown loudly and leaves a durable STILL APPLIED record, and a manual revert still works', async () => {
  let breakRevert = true;
  await run({
    options: {
      check: () => red(),
      applyPatch: async (repo, patch, options) => {
        if (breakRevert && options.reverse && !options.check) throw new Error('disk on fire');
        return gitPatchApplier(repo, patch, options);
      },
    },
    run: async (h) => {
      await assert.rejects(
        () => h.manager.apply(h.id, via()),
        (error) => {
          assert.match(error.message, /applyThenVerify FAILED and the automatic revert did NOT complete \(disk on fire\)/);
          assert.match(error.message, /STILL APPLIED to the primary checkout/);
          assert.match(error.message, /AssertionError: boom 42/, 'the failing output reaches the caller');
          return true;
        },
      );
      assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), JOB_BYTES);
      const job = await h.store.get(h.id);
      assert.equal(job.applied, true);
      assert.equal(job.status, 'DONE_UNVERIFIED');
      assert.equal(job.applyVerifyIntent, false, 'no stale in-flight marker');
      assert.equal(job.revertIntent, false);
      assert.equal(job.applyVerify.outcome, 'FAILED');
      assert.equal(job.applyVerify.reverted, false);
      assert.match(job.applyVerify.autoRevertError, /disk on fire/);
      assert.match(job.error, /automatic revert did NOT complete/);
      assert.match(await readReport(h), /VERIFICATION DID NOT PASS and the AUTO-REVERT DID NOT COMPLETE \(disk on fire\)/);
      breakRevert = false;
      assert.deepEqual(await h.manager.revert(h.id, { apply: true }), { dryRun: false, applied: true });
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    },
  });
});

test('a revert that lands and then throws is proven from the tree and reported as a clean revert', async () => {
  await run({
    options: {
      check: () => red(),
      applyPatch: async (repo, patch, options) => {
        const result = await gitPatchApplier(repo, patch, options);
        if (options.reverse && !options.check) throw new Error('record write failed after the patch landed');
        return result;
      },
    },
    run: async (h) => {
      const result = await h.manager.apply(h.id, via());
      assert.equal(result.applied, false);
      assert.equal(result.applyThenVerify.reverted, true);
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
      assert.equal((await h.store.get(h.id)).applied, false);
    },
  });
});

test('the stored output tail is bounded, cleaned and redacted everywhere it can be read', async () => {
  const big = [
    'FIRST-LINE-SENTINEL',
    ...Array.from({ length: 300 }, (_, i) => `noise ${i} ${'n'.repeat(60)}`),
    '\u001b[31mred ansi\u001b[0m',
    'API_KEY=sk-live-abc123',
    'LAST-LINE-SENTINEL',
  ].join('\n');
  await run({
    options: { check: () => red({ stdout: big, stderr: '' }) },
    run: async (h) => {
      const result = await h.manager.apply(h.id, via());
      const job = await h.store.get(h.id);
      for (const tail of [result.applyThenVerify.outputTail, job.applyVerify.outputTail]) {
        assert.ok(tail.length <= 8000);
        assert.ok(tail.split('\n').length <= 40);
        assert.ok(tail.includes('LAST-LINE-SENTINEL'));
        assert.ok(!tail.includes('FIRST-LINE-SENTINEL'));
        assert.ok(!tail.includes('sk-live-abc123'));
        assert.ok(!tail.includes('\u001b'));
        assert.ok(tail.includes('API_KEY=[REDACTED]'));
      }
      assert.ok(!(await readReport(h)).includes('sk-live-abc123'));
      assert.ok(JSON.stringify(job).length < 100_000, 'the record stays far below the store limit');
    },
  });
});

test('the returned, stored and reported output tail are one redaction, including bare token shapes', async () => {
  const bare = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
  const ghp = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  await run({
    options: { check: () => red({ stdout: `leaked ${bare}\nalso ${ghp}`, stderr: '' }) },
    run: async (h) => {
      const failed = await h.manager.apply(h.id, via());
      const stored = (await h.store.get(h.id)).applyVerify.outputTail;
      assert.ok(!stored.includes(bare), 'the stored copy is redacted');
      assert.equal(failed.applyThenVerify.outputTail, stored, 'the returned copy is the stored copy');
      assert.ok(!failed.applyThenVerify.outputTail.includes(bare));
      assert.ok(!JSON.stringify(failed).includes(bare));
    },
  });
  await run({
    options: { check: () => green({ stdout: `ok ${bare}`, stderr: '' }) },
    run: async (h) => {
      const passed = await h.manager.apply(h.id, via());
      assert.equal(passed.applyThenVerify.outputTail, 'ok [REDACTED]');
      assert.equal((await h.store.get(h.id)).applyVerify.outputTail, 'ok [REDACTED]');
    },
  });
  await run({
    options: {
      check: () => red({ stdout: `leaked ${bare}`, stderr: '' }),
      applyPatch: async (repo, patch, options) => {
        if (options.reverse && !options.check) throw new Error('disk on fire');
        return gitPatchApplier(repo, patch, options);
      },
    },
    run: async (h) => {
      await assert.rejects(
        () => h.manager.apply(h.id, via()),
        (error) => {
          assert.match(error.message, /Output tail:\nleaked \[REDACTED\]/);
          assert.ok(!error.message.includes(bare), 'the thrown tail is redacted too');
          return true;
        },
      );
    },
  });
});

test('a primary that acts on an applyThenVerify outcome supersedes it: no stale "reverted" or "STILL APPLIED" claim remains', async () => {
  // Reverted by the command's failure, then applied by hand with its own evidence.
  await run({
    options: { check: () => red() },
    run: async (h) => {
      const failed = await h.manager.apply(h.id, via());
      assert.equal(failed.reverted, true);
      assert.match((await h.manager.job(h.id)).report, /applyThenVerify FAILED .*the diff was REVERTED/);
      const evidence = 'ran npm test by hand in the primary: ok';
      const applied = await h.manager.apply(h.id, { apply: true, verifiedBy: evidence });
      assert.equal(applied.applied, true);
      const job = await h.store.get(h.id);
      assert.equal(job.applyVerify, undefined, 'the reverted outcome is retired by the apply');
      const view = await h.manager.job(h.id);
      assert.equal(view.applyThenVerify, undefined);
      assert.match(view.report, new RegExp(`primary's own check: ${evidence}`));
      assert.doesNotMatch(view.report, /applyThenVerify [A-Z]/, 'no outcome line');
      assert.doesNotMatch(await readReport(h), /applyThenVerify [A-Z]/);
    },
  });
  // A failed automatic revert, then the manual revert the error asked for.
  let breakRevert = true;
  await run({
    options: {
      check: () => red(),
      applyPatch: async (repo, patch, options) => {
        if (breakRevert && options.reverse && !options.check) throw new Error('disk on fire');
        return gitPatchApplier(repo, patch, options);
      },
    },
    run: async (h) => {
      await assert.rejects(() => h.manager.apply(h.id, via()), /STILL APPLIED/);
      assert.match((await h.manager.job(h.id)).report, /STILL APPLIED/);
      breakRevert = false;
      assert.deepEqual(await h.manager.revert(h.id, { apply: true }), { dryRun: false, applied: true });
      const job = await h.store.get(h.id);
      assert.ok(job.revertedAt);
      assert.equal(job.applyVerify, undefined);
      assert.equal(job.error, undefined, 'the STILL APPLIED error is retired by the revert');
      assert.equal(job.appliedUnverified.applyThenVerify, undefined, 'and so is the pointer to the record');
      const view = await h.manager.job(h.id);
      assert.equal(view.applyThenVerify, undefined);
      assert.doesNotMatch(view.report, /STILL APPLIED|AUTO-REVERT DID NOT COMPLETE|applyThenVerify [A-Z]|applyThenVerify \(below\)/);
      assert.match(view.report, /applied patch reverted/);
    },
  });
  // A revert of a job that never had an applyThenVerify touches nothing extra.
  await run({
    run: async (h) => {
      await h.manager.apply(h.id, { apply: true, verifiedBy: 'ran npm test by hand in the primary: ok' });
      await h.manager.revert(h.id, { apply: true });
      const job = await h.store.get(h.id);
      assert.equal(job.applyVerify, undefined);
      assert.equal(job.appliedUnverified.verifiedBy, 'ran npm test by hand in the primary: ok');
    },
  });
});

test('a repair or continue after an automatic revert retires the applyThenVerify record', async () => {
  for (const next of ['repair', 'continue']) {
    let jobPasses = false;
    await run({
      options: {
        check: () => red(),
        // A continuation resumes a capped round; a repair follows a verifier failure.
        workerStatus: () => (next === 'continue' && !jobPasses ? 'BUDGET' : 'DONE'),
        jobVerify: () =>
          jobPasses ? { code: 0, stdout: 'ok', stderr: '', sandbox: 'macos' } : { code: 1, stderr: ENV_STDERR, sandbox: 'macos' },
      },
      run: async (h) => {
        const failed = await h.manager.apply(h.id, via());
        assert.equal(failed.reverted, true);
        assert.equal((await h.store.get(h.id)).applyVerify.outcome, 'FAILED');
        // The new round's own verifier passes: the diff is integrated, not reverted.
        jobPasses = true;
        if (next === 'repair') await h.manager.repair(h.id, ['fix the environment-sensitive check']);
        else await h.manager.continue(h.id, { extraTurns: 10 });
        const done = await h.manager.wait(h.id, { timeoutSec: WAIT_SEC, detail: 'full' });
        assert.equal(done.status, 'DONE_VERIFIED', next);
        const job = await h.store.get(h.id);
        assert.equal(job.applied, true);
        assert.equal(job.applyVerify, undefined, `${next}: the stale outcome is gone`);
        assert.equal(done.applyThenVerify, undefined);
        const view = await h.manager.job(h.id);
        assert.equal(view.applyThenVerify, undefined);
        assert.doesNotMatch(view.report, /applyThenVerify [A-Z]|offload_apply again/, next);
        assert.doesNotMatch(await readReport(h), /applyThenVerify [A-Z]|offload_apply again/, next);
      },
    });
  }
});

test('an unexpected failure right after the apply is settled from the live tree, not left as a live run', async () => {
  await run({
    run: async (h) => {
      const original = h.store.event.bind(h.store);
      let armed = true;
      h.store.event = async (id, event) => {
        if (armed && event.type === 'apply-verify-started') throw new Error('disk full (injected)');
        return original(id, event);
      };
      await assert.rejects(
        () => h.manager.apply(h.id, via()),
        (error) => {
          assert.match(error.message, /applyThenVerify stopped unexpectedly \(disk full \(injected\)\)/);
          assert.match(error.message, /STILL BE APPLIED to the primary checkout/);
          assert.match(error.message, /offload_revert/);
          return true;
        },
      );
      armed = false;
      assert.equal(h.calls.length, 0, 'the command never ran');
      assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), JOB_BYTES);
      const job = await h.store.get(h.id);
      assert.equal(job.applyVerifyIntent, false, 'no journal claims a live run');
      assert.equal(job.integrationIntent, false);
      assert.equal(job.applied, true);
      assert.equal(job.status, 'DONE_UNVERIFIED');
      assert.equal(job.applyVerify.outcome, 'INTERRUPTED');
      assert.equal(job.applyVerify.reverted, false);
      assert.match(job.applyVerify.autoRevertError, /disk full/);
      assert.match((await h.manager.job(h.id)).report, /applyThenVerify INTERRUPTED.*STILL APPLIED/);
      // Not stuck: the primary can revert by hand right away, no restart needed.
      assert.deepEqual(await h.manager.revert(h.id, { apply: true }), { dryRun: false, applied: true });
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    },
  });
});

test('a long command with many redactable assignments still reverts: the journaled command is bounded', async () => {
  const command = 'KEY=x '.repeat(1365).trim();
  assert.ok(command.length > 8000 && command.length <= 8192);
  let seen;
  await run({
    options: {
      check: (ran) => {
        seen = ran;
        return red();
      },
    },
    run: async (h) => {
      const result = await h.manager.apply(h.id, via(command));
      assert.equal(seen, command, 'the run uses the caller text, not the journaled display form');
      assert.equal(result.applied, false);
      assert.equal(result.reverted, true);
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
      const job = await h.store.get(h.id);
      assert.equal(job.applyVerifyIntent, false);
      assert.ok(job.applyVerify.command.length <= 1500, `stored command is ${job.applyVerify.command.length} characters`);
      assert.ok(job.applyVerify.command.includes('KEY=[REDACTED]'));
      assert.ok(!job.applyVerify.command.includes('KEY=x'), 'the journaled command is redacted');
    },
  });
});

test('while a command runs the job reports progress, refuses a concurrent revert, and wait() stays bounded', async () => {
  const blocked = deferred();
  const started = deferred();
  await run({
    options: {
      check: async () => {
        started.resolve();
        await blocked.promise;
        return green();
      },
    },
    run: async (h) => {
      const pending = h.manager.apply(h.id, via());
      await started.promise;
      await assert.rejects(() => h.manager.revert(h.id, { apply: true }), /applyThenVerify run is in progress/);
      await assert.rejects(() => h.manager.revert(h.id), /applyThenVerify run is in progress/);
      const waited = await h.manager.wait(h.id, { timeoutSec: 0 });
      assert.equal(waited.done, false, 'a held terminal status is progress, not completion');
      assert.equal(waited.progress.applyThenVerify.phase, 'verifying');
      assert.equal(waited.applyThenVerify.command, CHECK);
      const again = await h.manager.wait(h.id, { timeoutSec: 0 });
      assert.equal(again.unchanged, true, 'an unchanged poll is collapsed');
      const view = await h.manager.job(h.id);
      assert.match(view.report, /applyThenVerify RUNNING \(verifying\)/);
      assert.doesNotMatch(view.report, /next: .*revert/);
      assert.equal(view.applyThenVerify.phase, 'verifying', 'offload_job carries the phase at the top level');
      assert.equal('progress' in view, false, 'only offload_wait has a progress object');
      assert.doesNotMatch(view.report, /Review the diff, then use offload_apply/, 'the advice the running command is already acting on');
      blocked.resolve();
      assert.equal((await pending).applyThenVerify.outcome, 'PASSED');
      const finished = await h.manager.wait(h.id, { timeoutSec: 1 });
      assert.equal(finished.done, true);
    },
  });
});

/** A journal as a process that died at `phase` would leave it, with the diff `landed` in the primary or not. */
async function crashed(h, { phase, landed, extra = {} }) {
  if (landed) {
    const patch = await h.store.readArtifactBytes(h.id, 'revert.diff');
    await gitPatchApplier(h.repo, patch, { reverse: false, check: false });
  }
  await h.store.update(h.id, {
    applyVerifyIntent: true,
    applyVerify: {
      phase,
      command: CHECK,
      timeoutSec: 300,
      sandbox: 'required',
      startedAt: '2026-10-06T10:00:00.000Z',
      previousStatus: 'VERIFY_ENV_FAILED',
      attempts: 1,
    },
    applyPreviousStatus: 'VERIFY_ENV_FAILED',
    applyVerifiedBy: '',
    runnerPid: 999_999_999,
    ...extra,
  });
}
const applyIntegrationJournal = { integrationIntent: true, integrationPaths: ['src/a.js'], integrationFinalStatus: 'DONE_UNVERIFIED' };

test('crash recovery settles an interrupted applyThenVerify from the live tree and never claims a pass', async () => {
  const cases = [
    { name: 'applying, patch landed', phase: 'applying', landed: true, extra: applyIntegrationJournal, applied: true },
    { name: 'applying, nothing landed', phase: 'applying', landed: false, extra: applyIntegrationJournal, applied: false },
    { name: 'verifying, patch landed', phase: 'verifying', landed: true, applied: true },
    { name: 'verifying, primary already restored', phase: 'verifying', landed: false, applied: false },
    {
      name: 'reverting, reverse not applied',
      phase: 'reverting',
      landed: true,
      extra: { revertIntent: true, revertPaths: ['src/a.js'] },
      applied: true,
    },
    {
      name: 'reverting, reverse landed',
      phase: 'reverting',
      landed: false,
      extra: { revertIntent: true, revertPaths: ['src/a.js'] },
      applied: false,
    },
  ];
  for (const scenario of cases) {
    await run({
      run: async (h) => {
        await crashed(h, scenario);
        assert.equal(await h.manager.recover(), 1, scenario.name);
        const job = await h.store.get(h.id);
        assert.equal(job.applyVerifyIntent, false, scenario.name);
        assert.equal(job.integrationIntent === true, false);
        assert.equal(job.revertIntent === true, false);
        assert.equal(job.applyVerify.outcome, 'INTERRUPTED', scenario.name);
        assert.equal(job.applyVerify.phase, undefined);
        assert.equal(existsSync(join(h.repo, 'src', 'a.js')), scenario.applied, scenario.name);
        if (scenario.applied) {
          assert.equal(job.status, 'DONE_UNVERIFIED');
          assert.equal(job.applied, true);
          assert.equal(job.applyVerify.reverted, false);
          assert.equal(job.appliedUnverified.previousStatus, 'VERIFY_ENV_FAILED');
          assert.equal(job.appliedUnverified.verifiedBy, '');
          assert.equal(job.appliedUnverified.applyThenVerify.outcome, 'INTERRUPTED');
          assert.match(await readReport(h), /applyThenVerify INTERRUPTED.*STILL APPLIED/);
        } else {
          assert.equal(job.status, 'VERIFY_ENV_FAILED', scenario.name);
          assert.equal(job.applied, false);
          assert.equal(job.applyVerify.reverted, true);
          assert.equal(job.appliedUnverified, undefined);
          assert.match(await readReport(h), /applyThenVerify INTERRUPTED.*the diff was restored/);
          // And it is apply-eligible again.
          assert.equal((await h.manager.apply(h.id, via())).applied, true);
        }
      },
    });
  }
});

test('recovery leaves a live owner alone, and an unrecovered dead journal blocks apply and revert with a clear instruction', async () => {
  await run({
    run: async (h) => {
      // A genuinely foreign live process: this process's own pid with no run
      // registered is an orphan, not a live owner (see the next test).
      await crashed(h, { phase: 'verifying', landed: true, extra: { runnerPid: process.ppid } });
      assert.equal(await h.manager.recover(), 0);
      assert.equal((await h.store.get(h.id)).applyVerifyIntent, true, 'a live owner keeps its journal');
      assert.equal((await h.store.get(h.id)).status, 'VERIFY_ENV_FAILED');
      await assert.rejects(() => h.manager.apply(h.id, via()), /already in progress/);
    },
  });
  await run({
    run: async (h) => {
      await crashed(h, { phase: 'verifying', landed: true });
      await assert.rejects(() => h.manager.apply(h.id, via()), /interrupted applyThenVerify run has not been recovered/);
      await assert.rejects(() => h.manager.revert(h.id, { apply: true }), /interrupted applyThenVerify run has not been recovered/);
      assert.equal(await h.manager.recover(), 1);
      assert.deepEqual(await h.manager.revert(h.id, { apply: true }), { dryRun: false, applied: true });
    },
  });
});

test('a journal this process owns with no run registered is an orphan: settled from the live tree, not a live run forever', async () => {
  // The store fails after the command starts, so the run's own settlement
  // cannot be recorded and the journal is left behind with this very pid.
  const orphan = async (h) => {
    const original = h.store.event.bind(h.store);
    const update = h.store.update.bind(h.store);
    let failing = false;
    h.store.event = async (id, event) => {
      const written = await original(id, event);
      if (event.type === 'apply-verify-started') failing = true;
      return written;
    };
    h.store.update = async (...args) => {
      if (failing) throw new Error('EIO simulated');
      return update(...args);
    };
    await assert.rejects(() => h.manager.apply(h.id, via()), /applyThenVerify stopped unexpectedly \(EIO simulated\)/);
    failing = false;
    const stuck = await h.store.get(h.id);
    assert.equal(stuck.applyVerifyIntent, true, 'the journal was left behind');
    assert.equal(stuck.runnerPid, process.pid);
    assert.equal(h.manager.controllers.has(h.id), false);
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), true, 'the diff is in the primary');
  };
  for (const how of ['wait', 'revert', 'apply', 'recover']) {
    await run({
      run: async (h) => {
        await orphan(h);
        if (how === 'wait') {
          const waited = await h.manager.wait(h.id, { timeoutSec: 0 });
          assert.equal(waited.done, true, 'no live run to wait for');
          assert.equal(waited.status, 'DONE_UNVERIFIED');
        } else if (how === 'revert') {
          assert.deepEqual(await h.manager.revert(h.id, { apply: true }), { dryRun: false, applied: true });
          assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
        } else if (how === 'apply') {
          await assert.rejects(() => h.manager.apply(h.id, via()), /already applied/);
        } else assert.equal(await h.manager.recover(), 1);
        const job = await h.store.get(h.id);
        assert.equal(job.applyVerifyIntent, false, how);
        // A manual revert supersedes the record; the others leave it.
        if (how !== 'revert') assert.equal(job.applyVerify.outcome, 'INTERRUPTED', how);
      },
    });
  }
});

test('a corrupt applyThenVerify journal fails validation instead of being trusted', async () => {
  await run({
    run: async (h) => {
      for (const applyVerify of [
        { phase: 'bogus', command: CHECK, timeoutSec: 300 },
        { phase: 'verifying', command: 42, timeoutSec: 300 },
        { phase: 'verifying', command: CHECK, timeoutSec: 'soon' },
        'nope',
      ]) {
        await h.store.update(h.id, { applyVerifyIntent: true, applyVerify });
        await assert.rejects(
          async () => h.manager.validatePersisted(await h.store.get(h.id)),
          /invalid applyThenVerify journal/,
          JSON.stringify(applyVerify),
        );
      }
    },
  });
});

test(
  'real sandbox: the command sees the applied diff, cannot write the primary, and can use its temp dir',
  { skip: !sandboxAvailable() && SKIP_REASON },
  async () => {
    const real = new Runner({ defaults: { sandbox: true } });
    const repo = makeRepo();
    const gitDir = await mkdtemp(`${tmpdir()}/offload-applyverify-real-`);
    const manager = new JobManager({
      store: new JobStore({ gitDir }),
      snapshots: gitSnapshots(),
      worker: {
        run: async (job) => {
          write(join(job.workspacePath, 'src', 'a.js'), 'export const marker = "applied-marker";\n');
          return { status: 'DONE', turns: 1 };
        },
      },
      runner: {
        sandboxStatus: (...args) => real.sandboxStatus(...args),
        verify: async (command, options) =>
          command === JOB_COMMAND
            ? { command, verdict: 'FAIL', result: { code: 1, stderr: ENV_STDERR, sandbox: 'macos' } }
            : real.verify(command, options),
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
        },
      },
    });
    try {
      const started = await manager.start({ task: 'env', ownedPaths: ['src/**'], repoPath: repo, testCommand: JOB_COMMAND });
      await manager.wait(started.jobId, { timeoutSec: WAIT_SEC });
      const id = started.jobId;
      // A write into the primary hits the read-only sandbox, so the check fails and the diff is reverted.
      const denied = await manager.apply(id, { apply: true, applyThenVerify: "echo x > src/zz.txt && echo 'wrote it'" });
      assert.equal(denied.applied, false);
      assert.equal(denied.applyThenVerify.outcome, 'FAILED');
      assert.equal(denied.applyThenVerify.ranUnder, 'macos');
      assert.equal(existsSync(join(repo, 'src', 'zz.txt')), false, 'the primary checkout is read-only to the command');
      assert.equal(existsSync(join(repo, 'src', 'a.js')), false, 'and the diff was reverted');
      // grep only succeeds if the diff was applied BEFORE the command ran; mktemp proves the per-run temp dir works.
      const passed = await manager.apply(id, {
        apply: true,
        applyThenVerify: `grep -q applied-marker src/a.js && d=$(mktemp -d) && test -d "$d" && echo "temp ok"`,
      });
      assert.equal(passed.applied, true, JSON.stringify(passed.applyThenVerify));
      assert.equal(passed.applyThenVerify.outcome, 'PASSED');
      assert.equal(passed.applyThenVerify.outputTail, 'temp ok');
      assert.equal((await manager.store.get(id)).status, 'DONE_UNVERIFIED');
      assert.equal(await readFile(join(repo, 'src', 'a.js'), 'utf8'), 'export const marker = "applied-marker";\n');
    } finally {
      cleanup(repo);
      cleanup(gitDir);
    }
  },
);
