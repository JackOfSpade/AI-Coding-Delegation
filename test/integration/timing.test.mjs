import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../../src/store.mjs';
import { JobManager } from '../../src/job-manager.mjs';
import { gitPatchApplier, gitSnapshots } from '../../src/core.mjs';
import { cleanupIsolatedWorktree, createIsolatedWorktree, integrateRecordedTree, openIsolatedWorktree } from '../../src/worktree.mjs';
import { assessStall, sanitizeTiming } from '../../src/timing.mjs';
import { cleanup, git, makeRepo, write } from '../unit/helpers.mjs';

const WAIT_SEC = 15;
const pass = () => ({ command: 'npm test', verdict: 'PASS', result: { code: 0, sandbox: 'macos' } });
const codeFail = () => ({
  command: 'npm test',
  verdict: 'FAIL',
  result: { code: 1, stderr: 'AssertionError: expected 1 to equal 2', sandbox: 'macos' },
});
const writeSrc = (job, name) => write(join(job.workspacePath, 'src', name), `${name}\n`);

/**
 * A real isolated-worktree manager on a hand-driven clock. `cost.ms` is how
 * long snapshot and worktree creation "take" while it is non-zero, which is
 * how the tests give a round measurable setup time.
 */
async function harness({ worker, verify, leases, date = (t) => new Date(t) }) {
  const repo = makeRepo();
  const gitDir = await mkdtemp(`${tmpdir()}/offload-timing-`);
  const clock = { t: Date.now(), advance: (ms) => (clock.t += ms) };
  const cost = { ms: 0, cleanupMs: 0 };
  const snapshots = gitSnapshots();
  const manager = new JobManager({
    store: new JobStore({ gitDir, now: () => new Date(clock.t) }),
    now: () => date(clock.t),
    ...(leases ? { leases } : {}),
    snapshots: {
      ...snapshots,
      create: async (path) => {
        clock.advance(cost.ms);
        return snapshots.create(path);
      },
    },
    worker: { run: async (job, api) => worker(job, api, clock, manager) },
    runner: { verify: async (...args) => verify(clock, ...args) },
    config: {
      repoPath: repo,
      git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
      applyPatch: gitPatchApplier,
      isolation: {
        create: async (...args) => {
          await cost.onCreate?.();
          clock.advance(cost.ms);
          return createIsolatedWorktree(...args);
        },
        open: openIsolatedWorktree,
        cleanup: async (...args) => {
          clock.advance(cost.cleanupMs);
          return cleanupIsolatedWorktree(...args);
        },
        integrateRecorded: integrateRecordedTree,
      },
    },
  });
  const settle = (jobId, options = {}) => manager.wait(jobId, { timeoutSec: WAIT_SEC, detail: 'full', ...options });
  return { repo, gitDir, manager, clock, cost, settle };
}
const request = (h, extra = {}) => ({ task: 'time it', ownedPaths: ['src/**'], repoPath: h.repo, testCommand: 'npm test', ...extra });
const events = async (h, id) =>
  (await h.manager.store.readArtifact(id, 'events.jsonl'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test('a round is split into queue, setup, provider, tool and verifier time that adds up, and the report says so', async () => {
  const h = await harness({
    worker: async (job, api, clock) => {
      await api.progress({ turn: 1, action: 'provider_request_pending', providerFinishReason: null });
      clock.advance(40_000);
      await api.progress({ turn: 1, action: 'provider_usage' });
      await api.progress({ turn: 1, phase: 'tool', tools: ['read_file', 'run_command'], commandTimeoutSec: 120 });
      clock.advance(7000);
      await api.progress({
        turn: 1,
        actions: ['read_file', 'run_command'],
        toolTimings: [
          { name: 'read_file', ms: 200 },
          { name: 'run_command', ms: 6000 },
        ],
      });
      writeSrc(job, 'a.js');
      return { status: 'DONE', turns: 1 };
    },
    verify: (clock) => (clock.advance(5000), pass()),
  });
  try {
    // Setup is the snapshot and worktree work before the record exists.
    h.cost.ms = 3000;
    const started = await h.manager.start(request(h), { launch: false });
    h.cost.ms = 0;
    // A detached child takes a while to be spawned and claim the job.
    await h.manager.store.update(started.jobId, { handoffState: 'CHILD_ASSIGNED' });
    h.clock.advance(7000);
    await h.manager.resume(started.jobId);
    const done = await h.settle(started.jobId);
    assert.equal(done.status, 'DONE_VERIFIED');
    const stored = await h.manager.store.get(started.jobId);
    assert.deepEqual(stored.timing.rounds, [
      {
        round: 0,
        reason: 'start',
        queueMs: 7000,
        setupMs: 6000, // the snapshot and the worktree each cost 3 s
        activeMs: 52_000,
        startupMs: 0,
        providerMs: 40_000,
        toolMs: 7000,
        verifyMs: 5000,
        finalizeMs: 0,
        otherMs: 0,
        providerCalls: 1,
        providerMaxMs: 40_000,
        providerMaxTurn: 1,
        toolCalls: 2,
        toolMaxMs: 6000,
        toolMaxName: 'run_command',
      },
    ]);
    assert.equal(stored.activity, undefined, 'a finished job is not "doing" anything');
    assert.deepEqual(done.timing, sanitizeTiming(stored.timing), 'detail full returns the structured record');
    const lines = done.report.split('\n');
    assert.ok(
      lines.includes('time: 1m05s = queue 7s + setup 6s + provider 40s (1 call, max 40s) + tools 7s (max run_command 6s) + verify 5s'),
      lines.filter((line) => line.startsWith('tim')).join('\n'),
    );
    assert.ok(lines.some((line) => line.startsWith('timing round 0 (start): queue 7s · setup 6s · provider 40s')));
    // Compact output carries the one line and no structured copy.
    const compact = await h.manager.wait(started.jobId, { timeoutSec: 1 });
    assert.equal(compact.timing, undefined);
    assert.ok(compact.report.split('\n').some((line) => line.startsWith('time: 1m05s = queue 7s')));
    assert.equal(compact.report.includes('timing round'), false);
    // Every provider call's latency is on the event after it.
    const log = await events(h, started.jobId);
    const afterUsage = log.find((event) => event.type === 'progress' && event.prevPhase === 'provider');
    assert.equal(afterUsage.phase, 'overhead');
    assert.equal(afterUsage.prevMs, 40_000);
    const marker = log.find((event) => event.type === 'progress' && event.phase === 'tool');
    assert.equal(marker.prevPhase, 'overhead');
    assert.equal(marker.timing, undefined, 'the clock record is job state, not event history');
    assert.equal(marker.activity, undefined);
    const toolEnd = log.find((event) => event.type === 'progress' && event.prevPhase === 'tool');
    assert.equal(toolEnd.prevMs, 7000);
  } finally {
    cleanup(h.repo);
  }
});

test('a repair round appends its own record and leaves the earlier one untouched', async () => {
  let earlier;
  const h = await harness({
    worker: async (job, api, clock, manager) => {
      const run = (job.rounds || 0) + 1;
      if (run === 1) {
        await api.progress({ turn: 1, action: 'provider_request_pending' });
        clock.advance(20_000);
        await api.progress({ turn: 1, action: 'provider_usage' });
        return { status: 'FAILED', turns: 1, error: 'gave up' };
      }
      earlier = structuredClone((await manager.store.get(job.id)).timing.rounds[0]);
      await api.progress({ turn: 1, action: 'provider_request_pending' });
      clock.advance(11_000);
      await api.progress({ turn: 1, action: 'provider_usage' });
      writeSrc(job, 'a.js');
      return { status: 'DONE', turns: 1 };
    },
    verify: pass,
  });
  try {
    const started = await h.manager.start(request(h));
    assert.equal((await h.settle(started.jobId)).status, 'FAILED');
    const first = (await h.manager.store.get(started.jobId)).timing.rounds[0];
    assert.equal(first.providerMs, 20_000);
    // The primary thinks for a minute, then repairs; the worktree takes 2 s to recreate.
    h.clock.advance(60_000);
    h.cost.ms = 2000;
    await h.manager.repair(started.jobId, ['try again'], { launch: false });
    h.cost.ms = 0;
    await h.manager.store.update(started.jobId, { handoffState: 'CHILD_ASSIGNED' });
    h.clock.advance(9000);
    await h.manager.resume(started.jobId);
    const done = await h.settle(started.jobId);
    assert.equal(done.status, 'DONE_VERIFIED');
    const { timing } = await h.manager.store.get(started.jobId);
    assert.equal(timing.rounds.length, 2);
    assert.deepEqual(timing.rounds[0], first, 'round 0 is exactly what it was when it ended');
    assert.deepEqual(earlier, first, 'and it was already final when the repair round started');
    assert.equal(timing.rounds[1].reason, 'repair');
    assert.equal(timing.rounds[1].round, 1);
    assert.equal(timing.rounds[1].queueMs, 9000, 'measured from when the repair was queued, not from job creation');
    assert.equal(timing.rounds[1].setupMs, 2000, "worktree recreation is that round's setup");
    assert.equal(timing.rounds[1].providerMs, 11_000);
    // The minute of the primary's own thinking is reported as idle, not as the job's time.
    assert.match(done.report, /^timing idle between rounds: 1m00s /m);
    assert.match(done.report, /^timing round 1 \(repair\): queue 9s · setup 2s · provider 11s/m);
  } finally {
    cleanup(h.repo);
  }
});

test('a manual repair is judged as stalled while it recreates the workspace, and the marker clears once it is queued', async () => {
  const h = await harness({
    worker: async (job, api) => {
      await api.progress({ turn: 1, action: 'provider_request_pending' });
      return { status: 'FAILED', turns: 1, error: 'gave up' };
    },
    verify: pass,
  });
  try {
    const started = await h.manager.start(request(h));
    assert.equal((await h.settle(started.jobId)).status, 'FAILED');
    assert.equal(assessStall(await h.manager.store.get(started.jobId), h.clock.t), undefined, 'a finished round is not judged');
    let during;
    h.cost.onCreate = async () => {
      // Three minutes pass while the replacement workspace is being created.
      h.clock.advance(180_000);
      const stored = await h.manager.store.get(started.jobId);
      during = { status: stored.status, activity: stored.activity, stall: assessStall(stored, h.clock.t) };
    };
    await h.manager.repair(started.jobId, ['try again'], { launch: false });
    assert.equal(during.status, 'REPAIRING');
    assert.equal(during.activity.phase, 'setup');
    assert.equal(during.stall.kind, 'setup');
    assert.equal(during.stall.level, 1);
    assert.equal(during.stall.sinceSec, 180);
    const queued = await h.manager.store.get(started.jobId);
    assert.equal(queued.status, 'QUEUED');
    assert.equal(queued.activity, undefined, 'the setup marker does not outlive the setup');
  } finally {
    cleanup(h.repo);
  }
});

test('an automatic repair round is timed from the moment it was queued', async () => {
  let runs = 0;
  const h = await harness({
    worker: async (job, api) => {
      runs += 1;
      await api.progress({ turn: 1, action: 'provider_request_pending' });
      writeSrc(job, 'a.js');
      return { status: 'DONE', turns: 1 };
    },
    verify: () => (runs === 1 ? codeFail() : pass()),
  });
  try {
    const started = await h.manager.start(request(h));
    const done = await h.settle(started.jobId);
    assert.equal(done.status, 'DONE_VERIFIED');
    assert.equal(runs, 2);
    const stored = await h.manager.store.get(started.jobId);
    assert.deepEqual(
      stored.timing.rounds.map(({ round, reason }) => [round, reason]),
      [
        [0, 'start'],
        [1, 'repair'],
      ],
    );
    // The clock is frozen, so a round queued and claimed at the same instant waited nothing.
    assert.equal(stored.timing.rounds[1].queueMs, 0);
    assert.ok(stored.roundQueue.at, 'the queue marker names the repair round');
  } finally {
    cleanup(h.repo);
  }
});

test('a worker that dies mid-request still leaves its provider time in the record', async () => {
  const h = await harness({
    worker: async (_job, api, clock) => {
      await api.progress({ turn: 1, action: 'provider_request_pending' });
      clock.advance(20_000);
      throw new Error('socket hang up');
    },
    verify: pass,
  });
  try {
    const started = await h.manager.start(request(h));
    const done = await h.settle(started.jobId);
    assert.equal(done.status, 'FAILED');
    const [round] = (await h.manager.store.get(started.jobId)).timing.rounds;
    assert.equal(round.providerMs, 20_000);
    assert.equal(round.providerCalls, 1);
    assert.equal(round.providerMaxMs, 20_000);
    assert.equal(round.activeMs, 20_000);
    assert.match(done.report, /^time: 20s = provider 20s \(1 call, max 20s\)$/m);
  } finally {
    cleanup(h.repo);
  }
});

test('a stalled provider request is reported once per level, then collapses to unchanged, and clears when the job ends', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const h = await harness({
    worker: async (job, api) => {
      await api.progress({ turn: 1, action: 'provider_request_pending' });
      await gate;
      writeSrc(job, 'a.js');
      return { status: 'DONE', turns: 1 };
    },
    verify: pass,
  });
  try {
    const started = await h.manager.start(request(h));
    const id = started.jobId;
    const poll = (options = {}) => h.manager.wait(id, { timeoutSec: 0, ...options });
    let first;
    for (let attempt = 0; attempt < 200 && first?.progress?.phase?.kind !== 'provider'; attempt += 1) {
      first = await poll({ detail: 'full' });
      if (first.progress?.phase?.kind !== 'provider') await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(first.progress.phase.kind, 'provider');
    h.manager.lastWaitSignature.delete(id);

    h.clock.advance(10_000);
    const early = await poll();
    assert.equal(early.done, false);
    assert.equal(early.progress.stall, undefined, 'ten seconds into a request is normal');
    assert.deepEqual(early.progress.phase, { kind: 'provider', sinceSec: 10, turn: 1 });
    const quiet = await poll();
    assert.deepEqual(Object.keys(quiet).sort(), ['done', 'jobId', 'progress', 'status', 'unchanged']);
    assert.deepEqual(Object.keys(quiet.progress).sort(), ['costUsd', 'turns'], 'no stall, no stalledSec');

    h.clock.advance(100_000);
    const warned = await poll();
    assert.equal(warned.unchanged, undefined, 'a newly appearing stall is a change');
    assert.equal(warned.progress.stall.level, 1);
    assert.equal(warned.progress.stall.kind, 'provider');
    assert.equal(warned.progress.stall.sinceSec, 110);
    assert.equal(warned.progress.stall.longestProviderSec, 110);
    assert.equal(
      warned.progress.stall.message,
      'provider request in flight 1m50s of the 5m00s per-attempt limit; longest provider call this round 1m50s',
    );
    const again = await poll();
    assert.deepEqual(Object.keys(again).sort(), ['done', 'jobId', 'progress', 'status', 'unchanged']);
    assert.deepEqual(Object.keys(again.progress).sort(), ['costUsd', 'stalledSec', 'turns']);
    assert.equal(again.progress.stalledSec, 110);
    assert.equal(again.progress.stall, undefined, 'the body is not repeated');
    h.clock.advance(60_000);
    const grown = await poll();
    assert.equal(grown.unchanged, true, 'elapsed time alone is not a change');
    assert.equal(grown.progress.stalledSec, 170);

    h.clock.advance(120_000);
    const severe = await poll();
    assert.equal(severe.unchanged, undefined, 'a worse level is a change');
    assert.equal(severe.progress.stall.level, 2);
    assert.match(severe.progress.stall.message, / - consider offload_cancel \(in-scope partial work is kept\)$/);
    assert.equal((await poll()).unchanged, true);
    const full = await poll({ detail: 'full' });
    assert.equal(full.unchanged, undefined, 'detail full always repeats');
    assert.equal(full.progress.stall.level, 2);

    // offload_job shows the same advisory on the report and as a field.
    const job = await h.manager.job(id);
    assert.equal(job.stall.level, 2);
    assert.ok(job.report.split('\n').some((line) => line.startsWith('stall: provider request in flight 4m50s')));
    assert.equal((await h.manager.job(id, { include: 'files' })).stall, undefined, 'artifact responses stay lean');

    release();
    const done = await h.settle(id);
    assert.equal(done.status, 'DONE_VERIFIED');
    assert.equal(done.progress, undefined);
    assert.equal(done.stall, undefined, 'a finished job has no stall');
    assert.equal(done.report.includes('stall:'), false);
    assert.equal(h.manager.lastWaitSignature.has(id), false);
    assert.equal((await h.manager.job(id)).stall, undefined);
    const stored = await h.manager.store.get(id);
    assert.equal(stored.timing.rounds[0].providerMs, 290_000, 'the long request is accounted for once it ends');
  } finally {
    release?.();
    cleanup(h.repo);
  }
});

test('a worker that reports nothing is judged by silence, and its first event proves life', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const h = await harness({
    worker: async (job, api) => {
      await gate;
      await api.progress({ turn: 1, action: 'read_file' });
      writeSrc(job, 'a.js');
      return { status: 'DONE', turns: 1 };
    },
    verify: pass,
  });
  try {
    const started = await h.manager.start(request(h));
    const id = started.jobId;
    const poll = (options = {}) => h.manager.wait(id, { timeoutSec: 0, ...options });
    for (let attempt = 0; attempt < 200 && (await h.manager.store.get(id)).status !== 'RUNNING'; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await poll()).progress.stall, undefined);
    h.clock.advance(200_000);
    const stalled = await poll();
    assert.equal(stalled.progress.stall.kind, 'silence');
    assert.equal(stalled.progress.stall.message, 'no progress event for 3m20s');
    release();
    const done = await h.settle(id);
    assert.equal(done.status, 'DONE_VERIFIED');
  } finally {
    release?.();
    cleanup(h.repo);
  }
});

test('a stored job without timing fields (a record from before this feature) still waits, reports and finishes', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const h = await harness({
    worker: async (job) => {
      await gate;
      writeSrc(job, 'a.js');
      return { status: 'DONE', turns: 1 };
    },
    verify: pass,
  });
  try {
    const started = await h.manager.start(request(h));
    const id = started.jobId;
    await h.manager.store.update(id, { timing: undefined, activity: undefined, roundQueue: undefined });
    h.clock.advance(1_000_000);
    const poll = await h.manager.wait(id, { timeoutSec: 0 });
    assert.equal(poll.done, false);
    assert.equal(poll.progress.phase, undefined);
    release();
    const done = await h.settle(id);
    assert.equal(done.status, 'DONE_VERIFIED');
  } finally {
    release?.();
    cleanup(h.repo);
  }
});

test('finalization time stays out of the provider bucket when a worker dies mid-request', async () => {
  const h = await harness({
    worker: async (_job, api, clock) => {
      await api.progress({ turn: 1, action: 'provider_request_pending' });
      clock.advance(20_000);
      // Closing the workspace takes ten seconds: that is finalization, not the provider's time.
      h.cost.cleanupMs = 10_000;
      throw new Error('socket hang up');
    },
    verify: pass,
  });
  try {
    const started = await h.manager.start(request(h));
    const done = await h.settle(started.jobId);
    assert.equal(done.status, 'FAILED');
    const [round] = (await h.manager.store.get(started.jobId)).timing.rounds;
    assert.equal(round.providerMs, 20_000);
    assert.equal(round.providerCalls, 1);
    assert.equal(round.finalizeMs, 10_000);
    assert.equal(round.activeMs, 30_000);
  } finally {
    cleanup(h.repo);
  }
});

test('a cancel during a command batch books the batch as tool time and the cleanup as finalization', async () => {
  const h = await harness({
    worker: async (_job, api) => {
      await api.progress({ turn: 1, phase: 'tool', tools: ['run_command'], commandTimeoutSec: 60 });
      await new Promise((resolve) => api.signal.addEventListener('abort', resolve, { once: true }));
      h.cost.cleanupMs = 10_000;
      throw new Error('aborted');
    },
    verify: pass,
  });
  try {
    const started = await h.manager.start(request(h));
    const id = started.jobId;
    for (let attempt = 0; attempt < 200 && (await h.manager.store.get(id)).activity?.phase !== 'tool'; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await h.manager.store.get(id)).activity.phase, 'tool');
    h.clock.advance(30_000);
    await h.manager.cancel(id);
    const done = await h.settle(id);
    assert.equal(done.status, 'CANCELLED');
    const [round] = (await h.manager.store.get(id)).timing.rounds;
    assert.equal(round.toolMs, 30_000);
    assert.equal(round.toolCalls, 1, 'the open batch counts as one call');
    assert.equal(round.finalizeMs, 10_000);
    assert.equal(round.activeMs, 40_000);
  } finally {
    cleanup(h.repo);
  }
});

test('a clock that reads fractional milliseconds still yields a whole-millisecond record', async () => {
  // A Date whose numeric value is fractional and different on every read, as an injected clock could produce.
  let reads = 0;
  class FractionalDate extends Date {
    valueOf() {
      reads += 1;
      return super.valueOf() + (reads % 7) / 10;
    }
  }
  const h = await harness({
    date: (t) => new FractionalDate(t),
    worker: async (job, api, clock) => {
      await api.progress({ turn: 1, action: 'provider_request_pending' });
      clock.advance(4000);
      await api.progress({ turn: 1, action: 'provider_usage' });
      writeSrc(job, 'a.js');
      return { status: 'DONE', turns: 1 };
    },
    verify: (clock) => (clock.advance(1000), pass()),
  });
  try {
    const started = await h.manager.start(request(h));
    const done = await h.settle(started.jobId);
    assert.equal(done.status, 'DONE_VERIFIED');
    const [round] = (await h.manager.store.get(started.jobId)).timing.rounds;
    assert.equal(round.providerMs, 4000, 'a fractional reading must not make the whole breakdown unreadable');
    assert.equal(round.verifyMs, 1000);
    assert.equal(round.activeMs, 5000);
    assert.equal(round.queueMs, 0, 'a fractional queue figure would be dropped as not a duration');
    assert.ok(reads > 4, 'the injected clock was the one in use');
  } finally {
    cleanup(h.repo);
  }
});

test('a round recovered from a dead owner keeps what the owner recorded and is not reported as queue time', async () => {
  const leases = { acquire: async () => {}, release: async () => true, heartbeat: async () => {} };
  const h = await harness({
    leases,
    worker: async (_job, api, clock) => {
      await api.progress({ turn: 3, action: 'provider_request_pending' });
      clock.advance(5000);
      await api.progress({ turn: 3, action: 'provider_usage' });
      return { status: 'DONE', summary: 'finished after restart' };
    },
    verify: pass,
  });
  try {
    const started = await h.manager.start(request(h), { launch: false });
    const id = started.jobId;
    const since = new Date(h.clock.t).toISOString();
    // What the dead owner had recorded when it last changed phase: 12 s of provider, 18 s of tools.
    await h.manager.store.update(id, {
      status: 'RUNNING',
      handoffState: 'RUNNING',
      runnerPid: 999999999,
      runnerHeartbeatAt: new Date(0).toISOString(),
      leaseOwnerNonce: 'dead-owner',
      budgetFinishRecovery: 'queued',
      startedAt: since,
      activity: { phase: 'tool', since, lastEventAt: since, tool: 'run_command', commandTimeoutSec: 60 },
      timing: {
        v: 1,
        rounds: [
          {
            round: 0,
            reason: 'start',
            queueMs: 1000,
            setupMs: 500,
            activeMs: 30_000,
            startupMs: 0,
            providerMs: 12_000,
            toolMs: 18_000,
            verifyMs: 0,
            finalizeMs: 0,
            otherMs: 0,
            providerCalls: 2,
            providerMaxMs: 7000,
            providerMaxTurn: 2,
            toolCalls: 3,
            toolMaxMs: 9000,
            toolMaxName: 'run_command',
          },
        ],
      },
    });
    h.clock.advance(20 * 60_000);
    assert.equal(await h.manager.recover(), 1);
    const done = await h.settle(id);
    assert.equal(done.status, 'DONE_VERIFIED');
    const [round] = (await h.manager.store.get(id)).timing.rounds;
    assert.equal(round.queueMs, 1000, 'the earlier owner queue figure stands; recovery is not a queue wait');
    assert.equal(round.setupMs, 500);
    assert.equal(round.providerMs, 17_000, 'the 12 s the dead owner recorded plus the 5 s of the relaunched worker');
    assert.equal(round.providerCalls, 3);
    assert.equal(round.providerMaxMs, 7000);
    assert.equal(round.toolMs, 18_000);
    assert.equal(round.toolCalls, 3);
    assert.equal(round.otherMs, 20 * 60_000, 'the time nobody observed is other time');
    assert.equal(round.activeMs, 20 * 60_000 + 35_000);
    assert.equal(done.report.includes('queue 20m'), false);
    assert.match(done.report, /^time: 20m37s = provider 17s \(3 calls, max 7s\) \+ tools 18s \(max run_command 9s\) \+ other 20m02s$/m);
  } finally {
    cleanup(h.repo);
  }
});
