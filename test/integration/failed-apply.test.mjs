import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../../src/store.mjs';
import { JobManager } from '../../src/job-manager.mjs';
import { FAILURE_ERRORS } from '../../src/failure.mjs';
import { gitPatchApplier, gitSnapshots } from '../../src/core.mjs';
import { cleanupIsolatedWorktree, createIsolatedWorktree, integrateRecordedTree, openIsolatedWorktree } from '../../src/worktree.mjs';
import { cleanup, git, makeRepo, write } from '../unit/helpers.mjs';

// A write job whose worker ended FAILED after doing correct, in-scope work (the
// real-session case: finish put beside other calls twice). These drive a real
// isolated-worktree manager; only the worker and the command verifier are
// injected, so every conflict, lease, HEAD, index and recorded-tree check that
// offload_apply runs is the production one.

const WAIT_SEC = 15;
const A_BYTES = 'export const a = 1;\n';
const PROTOCOL = FAILURE_ERRORS['finish-protocol'];
const EVIDENCE = 'npm test in the primary checkout: 412 pass, 0 fail';
const failedProtocol = (extra = {}) => ({ status: 'FAILED', turns: 3, failureKind: 'finish-protocol', ...extra });
const green = () => ({ command: 'node check.js', verdict: 'PASS', result: { code: 0, stdout: 'ok\n', stderr: '', sandbox: 'macos' } });
const red = () => ({
  command: 'node check.js',
  verdict: 'FAIL',
  result: { code: 1, stdout: '', stderr: 'AssertionError: boom\n', sandbox: 'macos' },
});

async function harness({ worker, check = green, secrets, applyPatch = gitPatchApplier } = {}) {
  const repo = makeRepo();
  const gitDir = await mkdtemp(`${tmpdir()}/offload-failedapply-`);
  const counters = { runs: 0, checks: [] };
  const manager = new JobManager({
    store: new JobStore({ gitDir, ...(secrets ? { secrets } : {}) }),
    snapshots: gitSnapshots(),
    worker: {
      run: async (job, api) => {
        counters.runs += 1;
        return worker(job, counters.runs, api);
      },
    },
    runner: {
      verify: async (command, options) => {
        counters.checks.push({ command, options });
        return check(command, options);
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
      },
    },
  });
  const settle = (jobId) => manager.wait(jobId, { timeoutSec: WAIT_SEC, detail: 'full' });
  const begin = async (request = {}) => {
    const started = await manager.start({ task: 'work', ownedPaths: ['src/**'], repoPath: repo, ...request });
    return { id: started.jobId, done: await settle(started.jobId) };
  };
  return { repo, manager, store: manager.store, counters, settle, begin, snapshots: gitSnapshots() };
}
const writeSrc = (job, name, body = `${name}\n`) => write(join(job.workspacePath, 'src', name), body);
const goodWork = async (job) => (writeSrc(job, 'a.js', A_BYTES), failedProtocol());
const nextLine = (report) => report.split('\n').find((line) => line.startsWith('next: '));
const APPLY_NEXT = /apply \(after your own check\)/;

test('a FAILED job with an intact in-scope diff dry-runs, applies with the primary evidence, ends DONE_UNVERIFIED with the failure on record, and reverts', async () => {
  const h = await harness({ worker: goodWork });
  try {
    const { id, done } = await h.begin();
    assert.equal(done.status, 'FAILED');
    assert.equal(done.failureKind, 'finish-protocol');
    assert.match(nextLine(done.report), APPLY_NEXT, 'the report lists apply for an apply-eligible FAILED job');
    assert.match(nextLine(done.report), /\brepair\b/, 'repair is listed exactly as before');
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false, 'a FAILED job is never integrated automatically');
    write(join(h.repo, 'unrelated.txt'), 'primary work in progress\n');

    const failure = { kind: 'finish-protocol', reason: PROTOCOL };
    assert.deepEqual(await h.manager.apply(id), { dryRun: true, applied: false, files: ['src/a.js'], fromStatus: 'FAILED', failure });
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false, 'a dry run never writes');
    for (const verifiedBy of [undefined, '', 'short'])
      await assert.rejects(() => h.manager.apply(id, { apply: true, verifiedBy }), /verifiedBy must state the check you ran/);
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);

    const applied = await h.manager.apply(id, { apply: true, verifiedBy: EVIDENCE });
    assert.deepEqual(applied, {
      dryRun: false,
      applied: true,
      files: ['src/a.js'],
      previousStatus: 'FAILED',
      status: 'DONE_UNVERIFIED',
      failure,
    });
    assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), A_BYTES);
    assert.equal(await readFile(join(h.repo, 'unrelated.txt'), 'utf8'), 'primary work in progress\n');
    assert.equal(git(h.repo, ['diff', '--cached', '--name-only']), '', 'the primary index is left alone');

    const job = await h.store.get(id);
    assert.equal(job.status, 'DONE_UNVERIFIED');
    assert.equal(job.applied, true);
    assert.equal(job.error, undefined);
    assert.equal(job.appliedUnverified.previousStatus, 'FAILED');
    assert.equal(job.appliedUnverified.verifiedBy, EVIDENCE);
    assert.deepEqual(job.appliedUnverified.failure, failure);
    const view = await h.manager.job(id);
    assert.equal(view.appliedUnverified, true);
    assert.equal(view.failureKind, undefined, 'a DONE job no longer presents as FAILED');
    for (const report of [view.report, await h.store.readArtifact(id, 'report.md')]) {
      assert.match(
        report,
        /applied WITHOUT server verification \(was FAILED; original failure: finish-protocol: finish must be the sole valid tool call in a turn\); primary's own check: npm test in the primary checkout: 412 pass/,
      );
      assert.doesNotMatch(report, /DONE_VERIFIED/);
    }

    // The ordinary safety net: once only, no repair of an applied job, and revert restores.
    await assert.rejects(() => h.manager.apply(id, { apply: true, verifiedBy: EVIDENCE }), /already applied/);
    await assert.rejects(() => h.manager.repair(id, ['try again']), /an applied job cannot be repaired/);
    assert.deepEqual(await h.manager.revert(id), { dryRun: true, applied: false });
    assert.deepEqual(await h.manager.revert(id, { apply: true }), { dryRun: false, applied: true });
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false, 'revert removed the applied file');
    assert.equal(await readFile(join(h.repo, 'unrelated.txt'), 'utf8'), 'primary work in progress\n');
    assert.equal(git(h.repo, ['status', '--porcelain', '--', 'src']), '');
  } finally {
    cleanup(h.repo);
  }
});

test('every FAILED cause qualifies when the diff is intact, and the dry run names the kind and the reason', async () => {
  const cases = [
    ['tool-loop', { failureKind: 'tool-loop' }, FAILURE_ERRORS['tool-loop']],
    ['no-finish', { failureKind: 'no-finish' }, FAILURE_ERRORS['no-finish']],
    ['output-cap', { failureKind: 'output-cap' }, FAILURE_ERRORS['output-cap']],
    ['finish-protocol', { failureKind: 'finish-protocol' }, PROTOCOL],
    [
      'a provider protocol fault',
      { failureKind: undefined, error: 'Provider tool calls exceed size limit' },
      'Provider tool calls exceed size limit',
    ],
    [
      'a provider HTTP failure',
      { failureKind: undefined, providerFailure: { kind: 'http', status: 503, attempts: 2 } },
      'Provider request failed (HTTP 503)',
    ],
  ];
  for (const [label, extra, reason] of cases) {
    const h = await harness({ worker: async (job) => (writeSrc(job, 'a.js', A_BYTES), failedProtocol(extra)) });
    try {
      const { id, done } = await h.begin();
      assert.equal(done.status, 'FAILED', label);
      assert.match(nextLine(done.report), APPLY_NEXT, label);
      const dry = await h.manager.apply(id);
      assert.deepEqual(dry.files, ['src/a.js'], label);
      assert.equal(dry.failure.reason, reason, label);
      assert.equal(dry.failure.kind, extra.failureKind, label);
      const applied = await h.manager.apply(id, { apply: true, verifiedBy: EVIDENCE });
      assert.equal(applied.status, 'DONE_UNVERIFIED', label);
      assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), A_BYTES, label);
    } finally {
      cleanup(h.repo);
    }
  }
});

test('a FAILED job with an empty diff is refused, and the report does not offer apply', async () => {
  const h = await harness({ worker: async () => failedProtocol() });
  try {
    const { id, done } = await h.begin();
    assert.equal(done.status, 'FAILED');
    assert.doesNotMatch(nextLine(done.report), /apply/);
    for (const options of [{}, { apply: true, verifiedBy: EVIDENCE }])
      await assert.rejects(
        () => h.manager.apply(id, options),
        /a FAILED job cannot be applied this way: it has no in-scope changes to apply \(its retained diff is empty\)/,
      );
    assert.equal((await h.store.get(id)).status, 'FAILED');
  } finally {
    cleanup(h.repo);
  }
});

test('a FAILED job that wrote outside its scope is never applied, even for the in-scope part', async () => {
  const h = await harness({
    worker: async (job) => (writeSrc(job, 'a.js', A_BYTES), write(join(job.workspacePath, 'outside.txt'), 'x\n'), failedProtocol()),
  });
  try {
    const { id, done } = await h.begin();
    assert.equal(done.status, 'FAILED');
    assert.match(done.report, /scope: VIOLATIONS: outside\.txt/);
    assert.doesNotMatch(nextLine(done.report), /apply/);
    for (const options of [{}, { apply: true, verifiedBy: EVIDENCE }])
      await assert.rejects(
        () => h.manager.apply(id, options),
        /a FAILED job cannot be applied this way: it has scope or verifier-authorship violations \(outside\.txt\).*start a fresh job/,
      );
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    assert.equal(existsSync(join(h.repo, 'outside.txt')), false);
  } finally {
    cleanup(h.repo);
  }
});

test('a FAILED apply refuses on a primary conflict, a moved HEAD, or a drifted index, and changes nothing', async () => {
  for (const scenario of ['conflict', 'head', 'index']) {
    const h = await harness({ worker: goodWork });
    try {
      const { id } = await h.begin();
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
      await assert.rejects(() => h.manager.apply(id, { apply: true, verifiedBy: EVIDENCE }), expected, `${scenario} apply`);
      const job = await h.store.get(id);
      assert.equal(job.status, 'FAILED', 'a refused apply leaves the job exactly as it was');
      assert.equal(job.error, PROTOCOL);
      assert.equal(job.applied === true, false);
      assert.equal(job.integrationIntent === true, false);
      if (scenario === 'conflict') assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), 'primary wrote this first\n');
      if (scenario === 'head') assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    } finally {
      cleanup(h.repo);
    }
  }
});

test('apply serializes through the write-scope lease and is single-flight for a FAILED job', async () => {
  const h = await harness({ worker: goodWork });
  try {
    const { id } = await h.begin();
    const results = await Promise.allSettled([
      h.manager.apply(id, { apply: true, verifiedBy: EVIDENCE }),
      h.manager.apply(id, { apply: true, verifiedBy: EVIDENCE }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    assert.match(String(results.find((result) => result.status === 'rejected').reason.message), /busy|already applied/);
    assert.equal((await h.store.get(id)).applied, true);
  } finally {
    cleanup(h.repo);
  }
});

test('a FAILED job with an unresolved or untrustworthy record is refused with the exact reason, and the report stops offering apply', async () => {
  const h = await harness({ worker: goodWork });
  try {
    const { id, done } = await h.begin();
    assert.match(nextLine(done.report), APPLY_NEXT);
    const cases = [
      [
        'manual cleanup is required',
        { workspaceCleanupRequired: true },
        { workspaceCleanupRequired: undefined },
        /isolated workspace still needs cleanup/,
      ],
      [
        'a cleanup error is recorded',
        { workspaceCleanupError: 'rm failed' },
        { workspaceCleanupError: undefined },
        /isolated workspace still needs cleanup/,
      ],
      ['it lost its lease', { error: 'lease lost: heartbeat stopped' }, { error: PROTOCOL }, /lost its write lease while running/],
      [
        'its diff held a configured secret',
        { error: 'refusing to persist patch containing configured secret' },
        { error: PROTOCOL },
        /contained a configured secret and was not retained/,
      ],
      [
        'it was integrated and reverted',
        { revertedAt: '2026-10-01T00:00:00.000Z' },
        { revertedAt: undefined },
        /integrated and then reverted/,
      ],
      ['its retained diff is from an earlier round', { rounds: 1 }, { rounds: 0 }, /not from its final round \(round 1\)/],
      [
        'an integration outcome is uncertain',
        { integrationUncertain: true },
        { integrationUncertain: false },
        /unresolved primary mutation outcome/,
      ],
    ];
    for (const [label, bad, good, expected] of cases) {
      await h.store.update(id, bad);
      await assert.rejects(() => h.manager.apply(id), expected, `${label}: dry run`);
      await assert.rejects(() => h.manager.apply(id, { apply: true, verifiedBy: EVIDENCE }), expected, `${label}: apply`);
      assert.doesNotMatch(nextLine((await h.manager.job(id)).report), /apply/, `${label}: report`);
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false, `${label}: nothing was applied`);
      await h.store.update(id, good);
    }
    // Restoring the records restores eligibility: each refusal above was caused by exactly its own field.
    assert.deepEqual((await h.manager.apply(id)).files, ['src/a.js']);
    assert.match(nextLine((await h.manager.job(id)).report), APPLY_NEXT);
  } finally {
    cleanup(h.repo);
  }
});

test('a FAILED job whose retained diff does not match its recorded snapshots is refused before anything is applied', async () => {
  const h = await harness({ worker: goodWork });
  try {
    const { id } = await h.begin();
    const original = await h.store.readArtifactBytes(id, 'revert.diff');
    assert.ok(original.length > 0);
    const job = await h.store.get(id);
    const unverifiable = /this FAILED job's retained diff cannot be verified against its recorded snapshots \((.*)\); nothing was applied/;
    const cases = [
      [
        'a different stored diff',
        () => h.store.writeArtifact(id, 'revert.diff', 'diff --git a/src/a.js b/src/a.js\n'),
        /differs from the recorded snapshots/,
      ],
      ['an empty stored diff', () => h.store.writeArtifact(id, 'revert.diff', ''), /revert\.diff is empty/],
      [
        'a result snapshot that is not the one the diff came from',
        () => h.store.update(id, { workspaceAfter: job.before }),
        /differs from the recorded snapshots/,
      ],
      [
        'a result snapshot that does not exist',
        () => h.store.update(id, { workspaceAfter: 'b'.repeat(40) }),
        /a recorded snapshot is missing/,
      ],
    ];
    for (const [label, tamper, why] of cases) {
      await tamper();
      for (const options of [{}, { apply: true, verifiedBy: EVIDENCE }])
        await assert.rejects(
          () => h.manager.apply(id, options),
          (error) => unverifiable.test(error.message) && why.test(error.message),
          label,
        );
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false, `${label}: nothing was applied`);
      assert.equal((await h.store.get(id)).integrationIntent === true, false, label);
      await h.store.writeArtifact(id, 'revert.diff', original);
      await h.store.update(id, { workspaceAfter: job.workspaceAfter });
    }
    const applied = await h.manager.apply(id, { apply: true, verifiedBy: EVIDENCE });
    assert.equal(applied.applied, true, 'with the record restored the same job applies');
  } finally {
    cleanup(h.repo);
  }
});

test('a FAILED round after a continuation applies that round, and a patch holding a configured secret is never retained or applied', async () => {
  const secret = 'sk-test-0123456789-not-a-real-credential';
  const h = await harness({
    secrets: [secret],
    worker: async (job, run) => {
      if (run === 1) return (writeSrc(job, 'a.js', 'first\n'), failedProtocol());
      if (run === 2) return (writeSrc(job, 'b.js', 'second\n'), failedProtocol({ failureKind: 'no-finish' }));
      return (writeSrc(job, 'c.js', `const key = '${secret}';\n`), failedProtocol({ failureKind: 'no-finish' }));
    },
  });
  try {
    const { id } = await h.begin({ maxRepairRounds: 3 });
    await h.manager.continue(id, { note: 'carry on' });
    const second = await h.settle(id);
    assert.equal(second.status, 'FAILED');
    const stored = await h.store.get(id);
    assert.equal(stored.rounds, 1);
    assert.equal(stored.patchRound, 1, 'the capture is stamped with the round that made it');
    const dry = await h.manager.apply(id);
    assert.deepEqual(dry.files, ['src/a.js', 'src/b.js'], 'the final round retained the work of both rounds');
    assert.equal(dry.failure.kind, 'no-finish');

    // A third round whose own diff cannot be retained leaves round two's capture behind: it must not pass for round three's.
    await h.manager.continue(id, { note: 'once more' });
    const third = await h.settle(id);
    assert.equal(third.status, 'FAILED');
    assert.match((await h.store.get(id)).error, /patch containing configured secret/);
    assert.doesNotMatch(nextLine(third.report), /apply/);
    await assert.rejects(() => h.manager.apply(id), /a FAILED job cannot be applied this way: its diff contained a configured secret/);
    assert.equal(existsSync(join(h.repo, 'src', 'c.js')), false);
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
  } finally {
    cleanup(h.repo);
  }
});

test('applyThenVerify on a FAILED job reverts a failing check, keeps the job FAILED and apply-eligible, then keeps the diff on a passing one', async () => {
  let pass = false;
  const h = await harness({ worker: goodWork, check: () => (pass ? green() : red()) });
  try {
    const { id } = await h.begin();
    write(join(h.repo, 'unrelated.txt'), 'primary work in progress\n');
    const before = await h.snapshots.create(h.repo);
    const failed = await h.manager.apply(id, { apply: true, applyThenVerify: 'node check.js' });
    assert.equal(failed.applied, false);
    assert.equal(failed.reverted, true);
    assert.equal(failed.status, 'FAILED', 'the job is exactly what it was');
    assert.equal(failed.applyThenVerify.outcome, 'FAILED');
    assert.equal(failed.applyThenVerify.outputTail, 'AssertionError: boom');
    assert.equal(h.counters.checks.length, 1);
    assert.equal(await h.snapshots.create(h.repo), before, 'the primary is byte-identical to before');
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);

    const job = await h.store.get(id);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.error, PROTOCOL, 'the original failure is still the job error');
    assert.equal(job.applied, false);
    assert.equal(job.applyVerify.reverted, true);
    const report = await h.store.readArtifact(id, 'report.md');
    assert.match(report, /^error: finish must be the sole valid tool call in a turn$/m);
    assert.match(report, /applyThenVerify FAILED \(exit 1.*the diff was REVERTED/);
    assert.match(nextLine(report), APPLY_NEXT, 'still apply-eligible');

    pass = true;
    const passed = await h.manager.apply(id, { apply: true, applyThenVerify: 'node check.js' });
    assert.equal(passed.applied, true);
    assert.equal(passed.previousStatus, 'FAILED');
    assert.equal(passed.status, 'DONE_UNVERIFIED');
    assert.deepEqual(passed.failure, { kind: 'finish-protocol', reason: PROTOCOL });
    assert.equal(passed.applyThenVerify.outcome, 'PASSED');
    assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), A_BYTES);
    const applied = await h.store.get(id);
    assert.equal(applied.appliedUnverified.previousStatus, 'FAILED');
    assert.equal(applied.appliedUnverified.applyThenVerify.outcome, 'PASSED');
    assert.equal(applied.appliedUnverified.failure.kind, 'finish-protocol');
    const finalReport = await h.store.readArtifact(id, 'report.md');
    assert.match(finalReport, /applied WITHOUT server verification \(was FAILED; original failure: finish-protocol: finish must be/);
    assert.match(finalReport, /primary's own check: applyThenVerify \(below\)/);
    assert.match(finalReport, /^applyThenVerify PASSED \(exit 0.*`node check\.js`/m);
    assert.deepEqual(await h.manager.revert(id, { apply: true }), { dryRun: false, applied: true });
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    assert.equal(await readFile(join(h.repo, 'unrelated.txt'), 'utf8'), 'primary work in progress\n');
  } finally {
    cleanup(h.repo);
  }
});

test('a CANCELLED job is never applied, and the refusal says which statuses are eligible', async () => {
  const h = await harness({ worker: async (job) => (writeSrc(job, 'a.js', A_BYTES), { status: 'CANCELLED', turns: 1 }) });
  try {
    const { id, done } = await h.begin();
    assert.equal(done.status, 'CANCELLED');
    assert.doesNotMatch(nextLine(done.report), /apply/);
    await assert.rejects(
      () => h.manager.apply(id),
      /a CANCELLED job cannot be applied this way; eligible: VERIFY_ENV_FAILED, VERIFY_FAILED, BUDGET, TIMEOUT, or FAILED with an intact in-scope diff.*stopped on purpose/,
    );
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
  } finally {
    cleanup(h.repo);
  }
});

test('a job recovered after a server restart keeps its in-scope diff, and that FAILED record can be applied', async () => {
  const h = await harness({ worker: async () => ({ status: 'DONE' }) });
  let workspace;
  try {
    const started = await h.manager.start({ task: 'crash mid-run', ownedPaths: ['src/**'], repoPath: h.repo }, { launch: false });
    const queued = await h.store.get(started.jobId);
    workspace = openIsolatedWorktree({
      repoPath: h.repo,
      workspacePath: queued.workspacePath,
      baselineTree: queued.before,
      seedTree: queued.workspaceSeed,
    });
    write(join(workspace.path, 'src', 'a.js'), A_BYTES);
    await h.store.update(started.jobId, {
      status: 'RUNNING',
      handoffState: 'RUNNING',
      runnerPid: 99999999,
      runnerHeartbeatAt: new Date(0).toISOString(),
    });
    assert.equal(await h.manager.recover(), 1);
    const job = await h.store.get(started.jobId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.error, 'server restarted');
    assert.equal(job.patchRound, 0, 'the recovery capture is stamped like a live one');
    assert.match(nextLine((await h.manager.job(started.jobId)).report), APPLY_NEXT);
    assert.deepEqual(await h.manager.apply(started.jobId), {
      dryRun: true,
      applied: false,
      files: ['src/a.js'],
      fromStatus: 'FAILED',
      failure: { reason: 'server restarted' },
    });
    const applied = await h.manager.apply(started.jobId, { apply: true, verifiedBy: EVIDENCE });
    assert.equal(applied.status, 'DONE_UNVERIFIED');
    assert.equal(await readFile(join(h.repo, 'src', 'a.js'), 'utf8'), A_BYTES);
    assert.match(
      await h.store.readArtifact(started.jobId, 'report.md'),
      /applied WITHOUT server verification \(was FAILED; original failure: server restarted\)/,
    );
    workspace = undefined;
  } finally {
    workspace?.cleanup();
    cleanup(h.repo);
  }
});

test('crash recovery of an interrupted applyThenVerify on a FAILED job settles from the live tree and keeps the original failure', async () => {
  for (const landed of [true, false]) {
    const h = await harness({ worker: goodWork });
    try {
      const { id } = await h.begin();
      if (landed) await gitPatchApplier(h.repo, await h.store.readArtifactBytes(id, 'revert.diff'), { reverse: false, check: false });
      await h.store.update(id, {
        applyVerifyIntent: true,
        applyVerify: {
          phase: 'verifying',
          command: 'node check.js',
          timeoutSec: 300,
          sandbox: 'required',
          startedAt: '2026-10-06T10:00:00.000Z',
          previousStatus: 'FAILED',
          attempts: 1,
        },
        applyPreviousStatus: 'FAILED',
        applyVerifiedBy: '',
        runnerPid: 999_999_999,
      });
      assert.equal(await h.manager.recover(), 1, `landed=${landed}`);
      const job = await h.store.get(id);
      assert.equal(job.applyVerifyIntent, false);
      assert.equal(job.applyVerify.outcome, 'INTERRUPTED', 'recovery never claims a pass');
      const report = await h.store.readArtifact(id, 'report.md');
      if (landed) {
        assert.equal(job.status, 'DONE_UNVERIFIED');
        assert.equal(job.applied, true);
        assert.equal(job.appliedUnverified.previousStatus, 'FAILED');
        assert.deepEqual(job.appliedUnverified.failure, { kind: 'finish-protocol', reason: PROTOCOL });
        assert.match(report, /applied WITHOUT server verification \(was FAILED; original failure: finish-protocol: finish must be/);
        assert.deepEqual(await h.manager.revert(id, { apply: true }), { dryRun: false, applied: true });
      } else {
        assert.equal(job.status, 'FAILED', 'nothing landed: the job is exactly what it was');
        assert.equal(job.applied === true, false);
        assert.equal(job.error, PROTOCOL);
        assert.match(nextLine(report), APPLY_NEXT, 'still apply-eligible');
      }
      assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
    } finally {
      cleanup(h.repo);
    }
  }
});

test('a FAILED job whose automatic revert fails keeps the STILL APPLIED record and its original failure, and a manual revert works', async () => {
  let breakRevert = true;
  const h = await harness({
    worker: goodWork,
    check: red,
    applyPatch: async (repo, patch, options) => {
      if (breakRevert && options.reverse && !options.check) throw new Error('disk on fire');
      return gitPatchApplier(repo, patch, options);
    },
  });
  try {
    const { id } = await h.begin();
    await assert.rejects(
      () => h.manager.apply(id, { apply: true, applyThenVerify: 'node check.js' }),
      /applyThenVerify FAILED and the automatic revert did NOT complete \(disk on fire\).*STILL APPLIED/s,
    );
    const job = await h.store.get(id);
    assert.equal(job.status, 'DONE_UNVERIFIED');
    assert.equal(job.applied, true);
    assert.equal(job.appliedUnverified.previousStatus, 'FAILED');
    assert.deepEqual(
      job.appliedUnverified.failure,
      { kind: 'finish-protocol', reason: PROTOCOL },
      'the original failure survives the overwritten error',
    );
    assert.match(
      await h.store.readArtifact(id, 'report.md'),
      /applied WITHOUT server verification \(was FAILED; original failure: finish-protocol: finish must be/,
    );
    breakRevert = false;
    assert.deepEqual(await h.manager.revert(id, { apply: true }), { dryRun: false, applied: true });
    assert.equal(existsSync(join(h.repo, 'src', 'a.js')), false);
  } finally {
    cleanup(h.repo);
  }
});

test('provider failure verifies an audited retained diff before reporting without integrating or repairing', async () => {
  for (const pass of [false, true]) {
    const h = await harness({
      worker: async (job) => {
        writeSrc(job, 'a.js', A_BYTES);
        return { status: 'FAILED', turns: 22, costUsd: 2.58, providerFailure: { kind: 'http', status: 503, attempts: 1 } };
      },
      check: (command, options) => {
        assert.notEqual(options.cwd, h.repo);
        return {
          command,
          verdict: pass ? 'PASS' : 'FAIL',
          result: {
            code: pass ? 0 : 1,
            sandbox: 'macos',
            stdout: pass ? '15/15 PASS' : '14/15 PASS',
            stderr: pass ? '' : 'AssertionError src/a.js: wrong constant',
          },
        };
      },
    });
    try {
      const { id, done } = await h.begin({ testCommand: 'node check.js', budget: { maxUsd: 3 } });
      assert.equal(done.status, 'FAILED');
      assert.equal(h.counters.checks.length, 1);
      assert.equal(h.counters.runs, 1);
      assert.match(done.report, pass ? /verify:.*PASS/ : /verify:.*FAIL/);
      if (!pass) {
        assert.match(done.report, /14\/15 PASS/);
        assert.match(done.report, /wrong constant/);
      }
      assert.match(done.report, /\$0\.420000 remaining against maxUsd \$3\.000000/);
      assert.equal(existsSync(join(h.repo, 'src/a.js')), false);
      assert.equal((await h.manager.apply(id)).dryRun, true);
    } finally {
      cleanup(h.repo);
    }
  }
});

test('provider failure never runs a verifier on empty or out-of-scope output', async () => {
  for (const outside of [false, true]) {
    const h = await harness({
      worker: async (job) => {
        if (outside) write(join(job.workspacePath, 'outside.js'), 'bad\n');
        return { status: 'FAILED', providerFailure: { kind: 'transport', attempts: 1 } };
      },
    });
    try {
      const { done } = await h.begin({ testCommand: 'node check.js' });
      assert.equal(done.status, 'FAILED');
      assert.equal(h.counters.checks.length, 0);
    } finally {
      cleanup(h.repo);
    }
  }
});

test('provider diagnostic verifier mutations are rejected and never integrated', async () => {
  const h = await harness({
    worker: async (job) => {
      writeSrc(job, 'a.js', A_BYTES);
      return { status: 'FAILED', providerFailure: { kind: 'transport', attempts: 1 } };
    },
    check: (command, options) => {
      write(join(options.cwd, 'src/a.js'), 'verifier authored\n');
      return green();
    },
  });
  try {
    const { id } = await h.begin({ testCommand: 'node check.js' });
    const job = await h.store.get(id);
    assert.deepEqual(job.verifierMutations, ['src/a.js']);
    await assert.rejects(() => h.manager.apply(id), /scope|authorship/);
  } finally {
    cleanup(h.repo);
  }
});

test('named assertion repair gets an explicit fixed allowance after a reverted apply check even with spent caps', async () => {
  const h = await harness({ worker: goodWork, check: red });
  try {
    const { id } = await h.begin({ budget: { maxUsd: 3, maxTurns: 3 } });
    await h.manager.apply(id, { apply: true, applyThenVerify: 'node check.js' });
    await h.store.update(id, { costUsd: 3 });
    const before = await h.manager.job(id);
    assert.match(before.report, /assertionPaths.*\$0\.50 fixed allowance/);
    await assert.rejects(() => h.manager.repair(id, ['wrong expected constant']), /budget exhausted/);
    for (const paths of [['outside.js'], ['src/**'], [], ['src/a.js', 'src/a.js']])
      await assert.rejects(() => h.manager.repair(id, ['wrong constant'], { assertionPaths: paths, launch: false }), /assertionPaths/);
    await h.manager.repair(id, ['src/a.js: expected constant should be 42'], { assertionPaths: ['src/a.js'], launch: false });
    const queued = await h.store.get(id);
    assert.equal(queued.budget.maxUsd, 3.5);
    assert.equal(queued.budget.maxTurns, 9);
    assert.equal(queued.rounds, 1);
    assert.match(queued.pendingDefects.join('\n'), /expected constant should be 42/);
    assert.deepEqual(queued.assertionRepair.paths, ['src/a.js']);
    assert.equal(queued.applyVerify, undefined);
    await h.manager.cancel(id);
  } finally {
    cleanup(h.repo);
  }
});

test('fixed assertion pass enforces file and USD boundaries on the worker', async () => {
  for (const violation of ['scope', 'usd', 'none']) {
    const h = await harness({
      check: red,
      worker: async (job, round) => {
        writeSrc(job, 'a.js', A_BYTES);
        if (round === 1) return failedProtocol({ costUsd: 3 });
        assert.deepEqual(job.ownedPaths, ['src/a.js']);
        assert.deepEqual(job.extraWritable, []);
        if (violation === 'scope') writeSrc(job, 'b.js', 'unauthorized\n');
        return { status: 'DONE', turns: 1, costUsd: violation === 'usd' ? 0.51 : 0.1 };
      },
    });
    try {
      const { id } = await h.begin({ budget: { maxUsd: 3 } });
      await h.manager.apply(id, { apply: true, applyThenVerify: 'node check.js' });
      await h.manager.repair(id, ['src/a.js: fix expected value'], { assertionPaths: ['src/a.js'] });
      const done = await h.settle(id);
      assert.equal(done.status, violation === 'scope' ? 'FAILED' : violation === 'usd' ? 'BUDGET' : 'DONE_UNVERIFIED');
      if (violation === 'scope') assert.deepEqual((await h.store.get(id)).scopeViolations, ['src/b.js']);
      assert.equal(h.counters.runs, 2);
      await assert.rejects(
        () => h.manager.repair(id, ['again'], { assertionPaths: ['src/a.js'] }),
        /allowance.*used|applied job|failed.*reverted|scope or verifier/,
      );
    } finally {
      cleanup(h.repo);
    }
  }
});

test('finish-protocol and no-finish stops verify retained in-scope work before reporting and preserve continuation/apply', async () => {
  for (const kind of ['finish-protocol', 'no-finish']) {
    for (const pass of [false, true]) {
      const h = await harness({
        worker: async (job, run, { appendMessages }) => {
          const input = JSON.stringify({ path: 'src/a.js', content: 'return { token: match[1], rest };' });
          await appendMessages([
            {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: input } }],
              anthropic_content: [
                {
                  type: 'thinking',
                  thinking: 'host.career.<kind>.<entity>.<n>',
                  signature: 'AbCdEf+/skabcdefghijklmnop+/keyabcdefghijklmnop/AbCdEf==',
                },
                { type: 'tool_use', id: 'write', name: 'write_file', input },
              ],
            },
            { role: 'tool', tool_call_id: 'write', content: 'WROTE: src/a.js' },
          ]);
          writeSrc(job, 'a.js', A_BYTES);
          return failedProtocol({ failureKind: kind });
        },
        check: pass ? green : red,
      });
      try {
        const { id, done } = await h.begin({ testCommand: 'node check.js' });
        assert.equal(done.status, 'FAILED');
        assert.equal(done.failureKind, kind);
        assert.equal(h.counters.checks.length, 1);
        assert.equal(h.counters.runs, 1, 'diagnostic verification cannot launch automatic repair');
        assert.equal((await h.store.get(id)).transcriptReplayable, true);
        assert.match(done.report, pass ? /verify:.*PASS/ : /verify:.*FAIL/);
        assert.equal(existsSync(join(h.repo, 'src/a.js')), false);
        assert.equal((await h.manager.apply(id)).dryRun, true);
        await h.manager.continue(id, { launch: false });
        assert.equal((await h.store.get(id)).status, 'QUEUED');
        await h.manager.cancel(id);
      } finally {
        cleanup(h.repo);
      }
    }
  }
});

test('redacted replay state cannot strand completed work: retained diff verification decides status without provider replay', async () => {
  for (const kind of ['finish-protocol', 'no-finish', 'transcript-corruption']) {
    for (const pass of [false, true]) {
      const h = await harness({
        worker: async (job) => {
          writeSrc(job, 'a.js', A_BYTES);
          await h.store.update(job.id, { transcriptReplayable: false });
          return kind === 'transcript-corruption'
            ? { status: 'FAILED', error: 'corrupt transcript: invalid interior JSON' }
            : failedProtocol({ failureKind: kind });
        },
        check: pass ? green : red,
      });
      try {
        const { id, done } = await h.begin({ testCommand: 'node check.js' });
        assert.equal(done.status, pass ? 'DONE_VERIFIED' : 'VERIFY_FAILED');
        assert.equal(h.counters.checks.length, 1);
        assert.equal(h.counters.runs, 1, 'redacted reasoning never authorizes a repair request');
        assert.match(done.report, /worker stop: verification attempted on retained diff after transcript redaction/);
        assert.match(done.report, pass ? /verify:.*PASS/ : /verify:.*FAIL/);
        assert.equal((await h.store.get(id)).error, undefined);
        assert.equal(existsSync(join(h.repo, 'src/a.js')), pass);
        if (pass) assert.equal(await readFile(join(h.repo, 'src/a.js'), 'utf8'), A_BYTES);
        else assert.equal((await h.manager.apply(id)).dryRun, true);
      } finally {
        cleanup(h.repo);
      }
    }
  }
});

test('a valid finish with redacted replay state verifies once and cannot queue automatic repair', async () => {
  const h = await harness({
    worker: async (job) => {
      writeSrc(job, 'a.js', A_BYTES);
      await h.store.update(job.id, { transcriptReplayable: false });
      return { status: 'DONE', finish: { summary: 'done' } };
    },
    check: red,
  });
  try {
    const { done } = await h.begin({ testCommand: 'node check.js' });
    assert.equal(done.status, 'VERIFY_FAILED');
    assert.equal(h.counters.checks.length, 1);
    assert.equal(h.counters.runs, 1);
  } finally {
    cleanup(h.repo);
  }
});

test('finish failure verification skips empty, out-of-scope, cancelled and invalid-accounting work', async () => {
  for (const variant of ['empty', 'outside', 'cancelled', 'accounting']) {
    const h = await harness({
      worker: async (job) => {
        await h.store.update(job.id, { transcriptReplayable: false });
        if (variant !== 'empty') writeSrc(job, 'a.js', A_BYTES);
        if (variant === 'outside') write(join(job.workspacePath, 'outside.js'), 'outside\n');
        return failedProtocol({
          ...(variant === 'cancelled' ? { status: 'CANCELLED' } : {}),
          ...(variant === 'accounting' ? { costUsd: -1 } : {}),
        });
      },
    });
    try {
      const { done } = await h.begin({ testCommand: 'node check.js' });
      assert.equal(done.status, variant === 'cancelled' ? 'CANCELLED' : 'FAILED');
      assert.equal(h.counters.checks.length, 0);
      assert.equal(existsSync(join(h.repo, 'src/a.js')), false);
    } finally {
      cleanup(h.repo);
    }
  }
});

test('retained-diff recovery rejects verifier-authored changes even after a passing check', async () => {
  const h = await harness({
    worker: async (job) => {
      writeSrc(job, 'a.js', A_BYTES);
      await h.store.update(job.id, { transcriptReplayable: false });
      return failedProtocol();
    },
    check: (command, options) => (write(join(options.cwd, 'src/a.js'), 'verifier authored\n'), green()),
  });
  try {
    const { id, done } = await h.begin({ testCommand: 'node check.js' });
    assert.equal(done.status, 'FAILED');
    assert.deepEqual((await h.store.get(id)).verifierMutations, ['src/a.js']);
    assert.equal(existsSync(join(h.repo, 'src/a.js')), false);
    await assert.rejects(() => h.manager.apply(id), /scope|authorship/);
  } finally {
    cleanup(h.repo);
  }
});

test('a retained-diff verifier exception reports VERIFY_FAILED with an UNVERIFIED check and keeps the diff reviewable', async () => {
  const h = await harness({
    worker: async (job) => {
      writeSrc(job, 'a.js', A_BYTES);
      await h.store.update(job.id, { transcriptReplayable: false });
      return failedProtocol();
    },
    check: () => {
      throw new Error('runner unavailable');
    },
  });
  try {
    const { id, done } = await h.begin({ testCommand: 'node check.js' });
    assert.equal(done.status, 'VERIFY_FAILED');
    assert.match(done.report, /verify:.*UNVERIFIED/);
    assert.match(done.report, /Verifier could not run: runner unavailable/);
    assert.equal(h.counters.runs, 1);
    assert.equal(existsSync(join(h.repo, 'src/a.js')), false);
    assert.equal((await h.manager.apply(id)).dryRun, true);
  } finally {
    cleanup(h.repo);
  }
});
