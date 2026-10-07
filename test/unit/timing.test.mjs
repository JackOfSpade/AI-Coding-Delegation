import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BATCH_COMMAND_SEC,
  RoundClock,
  STALL,
  assessStall,
  formatDuration,
  mergeRound,
  sanitizeActivity,
  sanitizeTiming,
  timingTotals,
} from '../../src/timing.mjs';

const BUCKETS = ['startupMs', 'providerMs', 'toolMs', 'verifyMs', 'finalizeMs', 'otherMs'];
const sum = (record) => BUCKETS.reduce((total, key) => total + record[key], 0);

test('formatDuration is exact at every boundary and never prints a non-duration', () => {
  const table = [
    [412, '412ms'],
    [4200, '4.2s'],
    [7000, '7s'],
    [1000, '1s'],
    [9949, '9.9s'],
    [9951, '10s'],
    [42_000, '42s'],
    [59_600, '1m00s'],
    [62_000, '1m02s'],
    [252_000, '4m12s'],
    [1_906_000, '31m46s'],
    [3_720_000, '1h02m'],
    [NaN, '0s'],
    [-5, '0s'],
    [0, '0s'],
    [Infinity, '0s'],
  ];
  for (const [ms, expected] of table) assert.equal(formatDuration(ms), expected, String(ms));
});

test('RoundClock splits a scripted round into exact buckets that sum to its active time', () => {
  const clock = new RoundClock({ round: 0, reason: 'start', claimedAtMs: 0, queueMs: 2000, setupMs: 8000 });
  assert.deepEqual(clock.observe({ turn: 1, action: 'provider_request_pending' }, 3000), {
    phase: 'provider',
    prevPhase: 'startup',
    prevMs: 3000,
  });
  assert.deepEqual(clock.observe({ turn: 1, action: 'provider_usage' }, 43_000), {
    phase: 'overhead',
    prevPhase: 'provider',
    prevMs: 40_000,
  });
  const tool = clock.observe({ turn: 1, phase: 'tool', tools: ['read_file', 'run_command'], commandTimeoutSec: 120 }, 43_500);
  assert.deepEqual(tool, { phase: 'tool', prevPhase: 'overhead', prevMs: 500 });
  assert.deepEqual(clock.activity, {
    phase: 'tool',
    since: new Date(43_500).toISOString(),
    lastEventAt: new Date(43_500).toISOString(),
    turn: 1,
    tool: 'run_command',
    commandTimeoutSec: 120,
  });
  clock.observe(
    {
      turn: 1,
      actions: ['read_file', 'run_command'],
      toolTimings: [
        { name: 'read_file', ms: 200 },
        { name: 'run_command', ms: 6000 },
      ],
    },
    50_500,
  );
  clock.observe({ turn: 2, action: 'provider_request_pending' }, 50_600);
  clock.observe({ turn: 2, action: 'provider_usage' }, 60_600);
  clock.enter('verify', 60_700);
  clock.enter('finalize', 70_700);
  const record = clock.finish(75_000);
  assert.deepEqual(record, {
    round: 0,
    reason: 'start',
    queueMs: 2000,
    setupMs: 8000,
    activeMs: 75_000,
    startupMs: 3000,
    providerMs: 50_000,
    toolMs: 7000,
    verifyMs: 10_000,
    finalizeMs: 4300,
    otherMs: 700,
    providerCalls: 2,
    providerMaxMs: 40_000,
    providerMaxTurn: 1,
    toolCalls: 2,
    toolMaxMs: 6000,
    toolMaxName: 'run_command',
  });
  assert.equal(sum(record), record.activeMs);
});

test('a resumed clock carries the earlier owner record, books the unobserved gap as other time, and is not a queue wait', () => {
  const earlier = {
    round: 0,
    reason: 'start',
    queueMs: 1000,
    setupMs: 500,
    activeMs: 30_000,
    startupMs: 2000,
    providerMs: 12_000,
    toolMs: 15_000,
    verifyMs: 0,
    finalizeMs: 0,
    otherMs: 1000,
    providerCalls: 2,
    providerMaxMs: 7000,
    providerMaxTurn: 2,
    toolCalls: 3,
    toolMaxMs: 9000,
    toolMaxName: 'run_command',
  };
  // queueMs/setupMs passed alongside a carry (a recovery claim, not a queue wait) lose to the record.
  const clock = new RoundClock({
    round: 0,
    reason: 'start',
    claimedAtMs: 2_000_000,
    queueMs: 1_900_000,
    setupMs: 77,
    carry: { record: earlier, gapMs: 1_200_000 },
  });
  clock.observe({ turn: 3, action: 'provider_request_pending' }, 2_000_100);
  clock.observe({ turn: 3, action: 'provider_usage' }, 2_005_100);
  const record = clock.finish(2_005_200);
  assert.deepEqual(record, {
    round: 0,
    reason: 'start',
    queueMs: 1000,
    setupMs: 500,
    activeMs: 30_000 + 1_200_000 + 5200,
    startupMs: 2100,
    providerMs: 17_000,
    toolMs: 15_000,
    verifyMs: 0,
    finalizeMs: 0,
    otherMs: 1_201_100,
    providerCalls: 3,
    providerMaxMs: 7000,
    providerMaxTurn: 2,
    toolCalls: 3,
    toolMaxMs: 9000,
    toolMaxName: 'run_command',
  });
  assert.equal(sum(record), record.activeMs);
  // A carry that is not a round record, or a gap that is not a duration, adds nothing.
  const junk = new RoundClock({ claimedAtMs: 0, carry: { record: { round: 'x' }, gapMs: -5 } });
  assert.equal(junk.finish(10).activeMs, 10);
  const noGap = new RoundClock({ claimedAtMs: 0, carry: { record: earlier, gapMs: Number.NaN } });
  assert.equal(noGap.finish(0).otherMs, 1000);
});

test('a batch of commands is judged against the sum of their timeouts, not the first one', () => {
  const marker = (commandTimeoutSec) => {
    const clock = new RoundClock({ claimedAtMs: 0 });
    clock.observe({ turn: 1, phase: 'tool', tools: ['run_command'], commandTimeoutSec }, 1000);
    return clock.activity.commandTimeoutSec;
  };
  assert.equal(marker(2700), 2700, 'three 900 s commands exceed the old single-command cap');
  assert.equal(marker(MAX_BATCH_COMMAND_SEC), MAX_BATCH_COMMAND_SEC);
  assert.equal(marker(MAX_BATCH_COMMAND_SEC + 1), undefined);
  // Three 60 s commands run 180 s in all: 140 s in is a warning, and only 211 s in is past the limit.
  const batch = (elapsed) => assessStall(running({ phase: 'tool', since: ago(elapsed), tool: 'run_command', commandTimeoutSec: 180 }), NOW);
  assert.equal(batch(80 * S), undefined);
  assert.equal(batch(140 * S).level, 1);
  assert.equal(batch(200 * S).level, 1, 'inside the summed limit');
  assert.equal(batch(211 * S).level, 2);
  assert.match(batch(211 * S).message, /^tool run_command running 3m31s \(command timeout 3m00s\)/);
});

test('a snapshot attributes the in-flight interval without closing it, and a failed final request still counts as provider time', () => {
  const clock = new RoundClock({ round: 1, reason: 'repair', claimedAtMs: 1000 });
  clock.observe({ turn: 3, action: 'provider_request_pending' }, 2000);
  const early = clock.snapshot(5000);
  assert.equal(early.providerMs, 3000);
  assert.equal(early.providerCalls, 0, 'a request still open is not a completed call, so it cannot skew an average');
  const later = clock.snapshot(9000);
  assert.equal(later.providerMs, 7000, 'snapshots do not mutate the clock');
  // The worker returns (or throws) while the request is open.
  clock.enter('overhead', 11_000);
  const record = clock.finish(11_500);
  assert.equal(record.providerMs, 9000);
  assert.equal(record.providerCalls, 1);
  assert.equal(record.providerMaxTurn, 3);
  assert.equal(record.reason, 'repair');
  assert.equal(record.queueMs, undefined, 'an unknown queue time is omitted, not invented');
  assert.equal(sum(record), record.activeMs);
});

test('startup time with no provider request after it is overhead, not provider startup', () => {
  const clock = new RoundClock({ claimedAtMs: 0 });
  clock.enter('verify', 4000);
  clock.enter('finalize', 6000);
  const record = clock.finish(7000);
  assert.equal(record.startupMs, 0);
  assert.equal(record.otherMs, 4000);
  assert.equal(record.verifyMs, 2000);
  assert.equal(record.finalizeMs, 1000);
  assert.equal(record.providerCalls, 0);
  assert.equal(record.activeMs, 7000);
});

test('repeated phase events do not double count, a request that never reported usage is closed as a call, and the clock never runs backwards', () => {
  const clock = new RoundClock({ claimedAtMs: 0 });
  clock.observe({ action: 'provider_request_pending', turn: 1 }, 1000);
  assert.equal(clock.enter('provider', 2000), undefined, 'same phase is a no-op');
  // A second pending while one is open: the first attempt ended without usage.
  assert.deepEqual(clock.observe({ action: 'provider_request_pending', turn: 2 }, 5000), {
    phase: 'provider',
    prevPhase: 'provider',
    prevMs: 4000,
  });
  clock.observe({ action: 'provider_usage' }, 4000); // earlier than the phase start
  const record = clock.finish(3000);
  for (const key of BUCKETS) assert.ok(record[key] >= 0, key);
  assert.equal(record.providerCalls, 2);
  assert.equal(record.providerMaxMs, 4000);
  assert.equal(record.providerMaxTurn, 1);
  assert.equal(sum(record), record.activeMs);
});

test('observe ignores or sanitises hostile event fields instead of trusting them', () => {
  const clock = new RoundClock({ claimedAtMs: 0 });
  assert.equal(clock.observe(null, 10), undefined);
  assert.equal(clock.observe({ phase: 'verify' }, 20), undefined, 'only the tool phase marker is accepted from a worker');
  assert.equal(clock.observe({ action: 'provider_usage_repriced' }, 30), undefined);
  clock.observe({ phase: 'tool', tools: ['../x', 'a'.repeat(40), 'read_file'], commandTimeoutSec: 99_999, turn: -4 }, 40);
  assert.deepEqual(clock.activity, {
    phase: 'tool',
    since: new Date(40).toISOString(),
    lastEventAt: new Date(40).toISOString(),
    tool: 'read_file',
  });
  clock.observe(
    {
      actions: [],
      toolTimings: [
        { name: 'read_file', ms: 5 },
        { name: '\u001b]0;x', ms: 99 },
        { name: 'grep', ms: -1 },
        { name: 'glob', ms: 1.5 },
        { name: 'list_dir', ms: 9_999_999_999 },
        null,
      ],
    },
    50,
  );
  const record = clock.finish(60);
  assert.equal(record.toolCalls, 1);
  assert.equal(record.toolMaxMs, 5);
  assert.equal(record.toolMaxName, 'read_file');
});

test('sanitizeTiming returns a closed shape and never throws', () => {
  const good = { round: 0, reason: 'start', activeMs: 10, providerMs: 5, providerCalls: 2, toolMaxName: 'grep' };
  assert.deepEqual(sanitizeTiming({ v: 1, rounds: [good] }), { v: 1, rounds: [good] });
  const hostile = sanitizeTiming({
    v: 1,
    rounds: [
      { ...good, extra: 'x', providerMs: -1, toolMs: 1.5, verifyMs: NaN, finalizeMs: 604_800_001, toolMaxName: '../x', otherMs: '7' },
      { round: 1, reason: 'bogus', activeMs: 1 },
      { round: 2, reason: 'start' },
      'nope',
      null,
    ],
  });
  assert.deepEqual(hostile, { v: 1, rounds: [{ round: 0, reason: 'start', activeMs: 10, providerCalls: 2 }] });
  assert.equal(sanitizeTiming({ rounds: [{ ...good, toolMaxName: '\u001b]0;x' }] }).rounds[0].toolMaxName, undefined);
  for (const value of [
    undefined,
    null,
    'x',
    5,
    [],
    {},
    { rounds: 'x' },
    { rounds: [] },
    {
      get rounds() {
        throw new Error('boom');
      },
    },
  ])
    assert.equal(sanitizeTiming(value), undefined);
  const many = Array.from({ length: 50 }, (_, round) => ({ round, reason: 'start', activeMs: round }));
  const trimmed = sanitizeTiming({ rounds: many });
  assert.equal(trimmed.rounds.length, 8);
  assert.equal(trimmed.rounds[0].round, 42, 'the newest rounds are the ones kept');
});

test('mergeRound replaces a round by number, keeps rounds ordered, and drops an invalid record', () => {
  const a = { round: 0, reason: 'start', activeMs: 1 };
  const b = { round: 1, reason: 'repair', activeMs: 2 };
  let timing = mergeRound(undefined, a);
  timing = mergeRound(timing, b);
  timing = mergeRound(timing, { ...a, activeMs: 9 });
  assert.deepEqual(timing, { v: 1, rounds: [{ ...a, activeMs: 9 }, b] });
  assert.deepEqual(mergeRound(timing, { round: 'x' }), timing);
  assert.deepEqual(mergeRound({ rounds: 'junk' }, a), { v: 1, rounds: [a] });
});

test('timingTotals sums buckets across rounds and keeps the single longest provider and tool call', () => {
  const totals = timingTotals({
    rounds: [
      {
        round: 0,
        reason: 'start',
        queueMs: 5,
        setupMs: 7,
        activeMs: 100,
        providerMs: 60,
        providerCalls: 3,
        providerMaxMs: 30,
        toolMs: 20,
        toolCalls: 2,
        toolMaxMs: 15,
        toolMaxName: 'grep',
      },
      {
        round: 1,
        reason: 'repair',
        queueMs: 1,
        activeMs: 50,
        providerMs: 40,
        providerCalls: 2,
        providerMaxMs: 25,
        toolMs: 5,
        toolCalls: 1,
        toolMaxMs: 40,
        toolMaxName: 'run_command',
      },
    ],
  });
  assert.equal(totals.rounds, 2);
  assert.equal(totals.queueMs, 6);
  assert.equal(totals.setupMs, 7);
  assert.equal(totals.activeMs, 150);
  assert.equal(totals.providerMs, 100);
  assert.equal(totals.providerCalls, 5);
  assert.equal(totals.providerMaxMs, 30);
  assert.equal(totals.toolMaxMs, 40);
  assert.equal(totals.toolMaxName, 'run_command');
  assert.equal(timingTotals('junk').rounds, 0);
});

test('sanitizeActivity keeps a closed shape and tolerates a phase it does not know', () => {
  const at = '2026-01-01T00:00:00.000Z';
  assert.deepEqual(sanitizeActivity({ phase: 'provider', since: at, lastEventAt: at, turn: 3, junk: 1 }), {
    phase: 'provider',
    since: at,
    lastEventAt: at,
    turn: 3,
  });
  assert.equal(sanitizeActivity({ phase: 'future', since: at }).phase, 'future');
  assert.equal(sanitizeActivity({ phase: 'future', since: at }).lastEventAt, at);
  for (const bad of [
    null,
    'x',
    { phase: 'Provider!', since: at },
    { phase: 'provider', since: 'never' },
    { phase: 'provider' },
    { phase: 5, since: at },
  ])
    assert.equal(sanitizeActivity(bad), undefined);
  assert.equal(sanitizeActivity({ phase: 'tool', since: at, tool: '../x' }).tool, undefined);
  assert.equal(sanitizeActivity({ phase: 'tool', since: at, commandTimeoutSec: 0 }).commandTimeoutSec, undefined);
});

// ---- assessStall -----------------------------------------------------------

const NOW = Date.parse('2026-01-01T01:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const S = 1000;
const MIN = 60_000;
/** A running job whose round has 5 completed provider calls averaging 20 s. */
const running = (activity, extra = {}) => ({
  status: 'RUNNING',
  rounds: 0,
  turns: 5,
  startedAt: ago(10 * MIN),
  timing: {
    v: 1,
    rounds: [
      { round: 0, reason: 'start', activeMs: 225_000, providerMs: 100_000, providerCalls: 5, providerMaxMs: 30_000, startupMs: 1000 },
    ],
  },
  activity: activity && { lastEventAt: activity.since, ...activity },
  ...extra,
});

test('a provider request is judged against the per-attempt timeout and the average call', () => {
  const job = (elapsed, extra) => running({ phase: 'provider', since: ago(elapsed) }, extra);
  assert.equal(assessStall(job(40 * S), NOW), undefined);
  const warn = assessStall(job(100 * S), NOW);
  assert.deepEqual(warn, {
    level: 1,
    kind: 'provider',
    sinceSec: 100,
    thresholdSec: 60,
    message:
      'provider request in flight 1m40s of the 5m00s per-attempt limit; longest provider call this round 1m40s (avg 20s over 5 completed)',
    providerCalls: 5,
    avgProviderSec: 20,
    longestProviderSec: 100,
  });
  const severe = assessStall(job(280 * S), NOW);
  assert.equal(severe.level, 2);
  assert.equal(severe.thresholdSec, 270);
  assert.match(severe.message, / - consider offload_cancel \(in-scope partial work is kept\)$/);
  // The stored maximum wins while it is the longer one.
  const slowHistory = running(
    { phase: 'provider', since: ago(160 * S) },
    {
      timing: { v: 1, rounds: [{ round: 0, reason: 'start', activeMs: 1, providerMs: 400_000, providerCalls: 4, providerMaxMs: 290_000 }] },
    },
  );
  const slow = assessStall(slowHistory, NOW);
  assert.equal(slow.longestProviderSec, 290);
  assert.equal(slow.level, 1);
  assert.equal(slow.thresholdSec, 150, 'a slow history raises the warning to three times its average, capped at half the attempt limit');
  assert.equal(assessStall(running({ phase: 'provider', since: ago(120 * S) }, { timing: slowHistory.timing }), NOW), undefined);
  assert.equal(assessStall(running({ phase: 'provider', since: ago(151 * S) }, { timing: slowHistory.timing }), NOW).level, 1);
});

test('thresholds scale with the configured attempt timeout', () => {
  // Five calls averaging 100 s make the warning three times that, capped at half the attempt limit.
  const history = {
    timing: { v: 1, rounds: [{ round: 0, reason: 'start', activeMs: 1, providerMs: 500_000, providerCalls: 5, providerMaxMs: 150_000 }] },
  };
  const at = (attemptTimeoutMs, elapsed, extra = {}) =>
    assessStall(running({ phase: 'provider', since: ago(elapsed) }, { executionProfile: { attemptTimeoutMs }, ...extra }), NOW);
  assert.equal(at(30_000, 14 * S), undefined);
  assert.equal(at(30_000, 16 * S).level, 1, 'half of a 30 s limit');
  assert.equal(at(30_000, 28 * S).level, 2, '90% of a 30 s limit');
  assert.match(at(30_000, 28 * S).message, /of the 30s per-attempt limit/);
  assert.equal(at(300_000, 149 * S, history), undefined);
  assert.equal(at(300_000, 151 * S, history).thresholdSec, 150, 'half of the default five minutes');
  assert.equal(at(600_000, 299 * S, history), undefined, 'the same wait is normal under a 10 minute limit');
  assert.equal(at(600_000, 301 * S, history).thresholdSec, 300);
  assert.equal(at(600_000, 301 * S, history).level, 1);
});

test('a command is judged against its own timeout and other tools against fixed limits', () => {
  const command = (elapsed, commandTimeoutSec) =>
    assessStall(running({ phase: 'tool', since: ago(elapsed), tool: 'run_command', commandTimeoutSec }), NOW);
  assert.equal(command(200 * S, 600), undefined);
  assert.deepEqual(command(310 * S, 600), {
    level: 1,
    kind: 'tool',
    sinceSec: 310,
    thresholdSec: 300,
    message: 'tool run_command running 5m10s (command timeout 10m00s)',
    tool: 'run_command',
  });
  assert.equal(command(631 * S, 600).level, 2, 'past the command timeout itself');
  assert.equal(command(600 * S, 600).level, 1, 'inside its own timeout it is only a warning');
  assert.equal(command(59 * S, undefined), undefined, 'the default command timeout is a minute');
  assert.equal(command(61 * S, undefined).level, 1);
  const read = (elapsed) => assessStall(running({ phase: 'tool', since: ago(elapsed), tool: 'read_file' }), NOW);
  assert.equal(read(29 * S), undefined);
  assert.equal(read(31 * S).message, 'tool read_file running 31s');
  assert.equal(read(121 * S).level, 2);
});

test('queue, overhead, verify and finalize have their own limits', () => {
  const phase = (name, elapsed, extra = {}) => assessStall(running({ phase: name, since: ago(elapsed) }, extra), NOW);
  assert.equal(phase('overhead', 59 * S), undefined);
  assert.equal(phase('overhead', 61 * S).kind, 'overhead');
  assert.equal(phase('overhead', 181 * S).level, 2);
  assert.equal(phase('verify', 149 * S, { status: 'WORKER_DONE' }), undefined);
  assert.equal(phase('verify', 151 * S, { status: 'WORKER_DONE' }).kind, 'verify');
  assert.equal(phase('verify', 301 * S, { status: 'WORKER_DONE' }).level, 2);
  // Two baseline-diff runs of up to 300 s each are not a stall at 6 minutes.
  const baseline = { status: 'WORKER_DONE', verifierMode: 'baseline-diff' };
  assert.equal(phase('verify', 359 * S, baseline), undefined);
  assert.equal(phase('verify', 361 * S, baseline).level, 1);
  assert.equal(phase('verify', 700 * S, baseline).level, 1);
  assert.equal(phase('verify', 721 * S, baseline).level, 2);
  assert.equal(
    phase('verify', 300 * S, { status: 'WORKER_DONE', verifierTimeoutSec: 1000 }),
    undefined,
    'a long verifier limit is respected',
  );
  assert.equal(phase('finalize', 119 * S, { status: 'FINALIZING' }), undefined);
  assert.equal(phase('finalize', 121 * S, { status: 'FINALIZING' }).kind, 'finalize');
  assert.equal(phase('finalize', 299 * S, { status: 'FINALIZING' }).level, 1, 'severe starts at five minutes, not before');
  assert.equal(phase('finalize', 301 * S, { status: 'FINALIZING' }).level, 2);
  // Recreating the workspace for a repair or continue: the job is REPAIRING with no loop running yet.
  const setup = (elapsed) => phase('setup', elapsed, { status: 'REPAIRING', rounds: 1 });
  assert.equal(setup(119 * S), undefined);
  assert.deepEqual(setup(121 * S), {
    level: 1,
    kind: 'setup',
    sinceSec: 121,
    thresholdSec: 120,
    message: 'recreating the isolated workspace for the next round for 2m01s',
  });
  assert.equal(setup(299 * S).level, 1);
  assert.equal(setup(301 * S).level, 2);
  // It is judged by its own limit, never as silence or against the previous round's wall clock.
  assert.equal(
    phase('setup', 100 * S, {
      status: 'REPAIRING',
      rounds: 1,
      startedAt: ago(40 * MIN),
      budget: { maxTurns: 40, timeoutMinutes: 30 },
      activity: { phase: 'setup', since: ago(100 * S), lastEventAt: ago(100 * S) },
    }),
    undefined,
  );
  const queued = (elapsed, extra = {}) =>
    assessStall({ status: 'QUEUED', rounds: 0, createdAt: ago(elapsed), roundQueue: { at: ago(elapsed), setupMs: 0 }, ...extra }, NOW);
  assert.equal(queued(29 * S), undefined);
  assert.deepEqual(queued(31 * S), {
    level: 1,
    kind: 'queue',
    sinceSec: 31,
    thresholdSec: 30,
    message: 'queued 31s without a worker claiming the round',
  });
  assert.equal(queued(119 * S).level, 1, 'severe starts at two minutes, not before');
  assert.equal(queued(121 * S).level, 2);
  // A repair round is measured from when it was queued, not from the job's creation.
  assert.equal(queued(10 * S, { createdAt: ago(3 * 60 * MIN), rounds: 1 }), undefined);
  assert.equal(
    assessStall(
      { status: 'REPAIR_QUEUED', rounds: 0, createdAt: ago(900 * MIN), roundQueue: { at: ago(900 * MIN) }, finishedAt: ago(5 * S) },
      NOW,
    ),
    undefined,
    'REPAIR_QUEUED ages from the round that just finished',
  );
});

test('the wall-clock allowance warns at 80% and 95% of the round and names the turn', () => {
  const budget = { maxTurns: 40, timeoutMinutes: 30 };
  const at = (elapsedMin, activity = { phase: 'tool', since: ago(2 * S), tool: 'read_file' }) =>
    assessStall(running(activity, { startedAt: ago(elapsedMin * MIN), budget, turns: 39 }), NOW);
  assert.equal(at(23), undefined);
  assert.deepEqual(at(25.2), {
    level: 1,
    kind: 'wall',
    sinceSec: 1512,
    thresholdSec: 1440,
    message: 'round has used 25m12s of its 30m00s wall-clock allowance (turn 39 of 40)',
    providerCalls: 5,
    avgProviderSec: 20,
    longestProviderSec: 30,
  });
  assert.equal(at(28.6).level, 2);
  assert.equal(at(28.6).thresholdSec, 1710);
  // The verifier is outside the loop's deadline, so it never trips the wall check.
  assert.equal(at(29, { phase: 'verify', since: ago(10 * S) }), undefined);
});

test('a steady round that is a quarter of the way through its allowance is not warned about', () => {
  // 15 turns of 28 s provider + 2 s tool is 30 s per turn; 65 of 80 turns remain, which at that pace would
  // not fit in the allowance. The turn cap is only a ceiling, so that projection must not become a warning.
  const steady = (elapsedMin) =>
    assessStall(
      running(
        { phase: 'tool', since: ago(2 * S), tool: 'read_file' },
        {
          startedAt: ago(elapsedMin * MIN),
          turns: 15,
          budget: { maxTurns: 80, timeoutMinutes: 30 },
          timing: {
            v: 1,
            rounds: [
              {
                round: 0,
                reason: 'start',
                activeMs: 450_000,
                providerMs: 420_000,
                toolMs: 30_000,
                providerCalls: 15,
                providerMaxMs: 40_000,
              },
            ],
          },
        },
      ),
      NOW,
    );
  assert.equal(steady(7.55), undefined);
  assert.equal(steady(20), undefined, 'still inside the allowance, so still healthy');
  assert.equal(steady(24.1).kind, 'wall', 'only the share of the allowance already used warns');
});

test('silence fires for a phase with no limit of its own, from the last event, not the phase start', () => {
  const quiet = (phase, since, lastEventAt) => assessStall(running({ phase, since: ago(since), lastEventAt: ago(lastEventAt) }), NOW);
  assert.equal(quiet('startup', 170 * S, 170 * S), undefined);
  const warn = quiet('startup', 190 * S, 190 * S);
  assert.deepEqual(
    { kind: warn.kind, level: warn.level, message: warn.message },
    { kind: 'silence', level: 1, message: 'no progress event for 3m10s' },
  );
  assert.equal(quiet('startup', 400 * S, 359 * S).level, 1, 'severe is 1.2x the attempt timeout (360 s), not 1.0x');
  assert.equal(quiet('startup', 400 * S, 361 * S).level, 2);
  assert.equal(quiet('startup', 900 * S, 5 * S), undefined, 'a recent event means the round is alive');
  assert.equal(quiet('future', 200 * S, 200 * S).kind, 'silence', 'an unrecognised phase still ages');
  assert.equal(quiet('provider', 100 * S, 100 * S).kind, 'provider', 'a known phase is judged by its own rule, not silence');
});

test('the worst level wins and a tie keeps the phase check first', () => {
  const job = running(
    { phase: 'tool', since: ago(40 * S), tool: 'read_file' },
    { startedAt: ago(29 * MIN), budget: { maxTurns: 40, timeoutMinutes: 30 } },
  );
  const found = assessStall(job, NOW);
  assert.equal(found.level, 2);
  assert.equal(found.kind, 'wall', 'the severe wall warning outranks a mild tool warning');
  const tie = assessStall({ ...job, startedAt: ago(25 * MIN) }, NOW);
  assert.equal(tie.level, 1);
  assert.equal(tie.kind, 'tool', 'equal levels keep the phase check ahead of the wall check');
});

test('assessStall is undefined for a finished job and never throws on junk', () => {
  for (const status of ['DONE_VERIFIED', 'FAILED', 'BUDGET', 'CANCELLED', 'TIMEOUT', 'VERIFY_FAILED'])
    assert.equal(assessStall(running({ phase: 'provider', since: ago(900 * S) }, { status }), NOW), undefined, status);
  for (const junk of [
    undefined,
    null,
    'x',
    7,
    [],
    {},
    { status: 'RUNNING' },
    { status: 'RUNNING', activity: 'x', timing: 5, budget: 'x', executionProfile: 3 },
  ])
    assert.doesNotThrow(() => assessStall(junk, NOW));
  assert.equal(assessStall({ status: 'RUNNING', activity: { phase: 'provider', since: ago(900 * S) } }, NaN), undefined);
  assert.equal(
    assessStall({ status: 'RUNNING', activity: { phase: 'provider', since: ago(900 * S) } }, NOW).kind,
    'provider',
    'no timing or budget needed',
  );
});

test('a stall message carries only numbers and closed names, whatever the stored record says', () => {
  const found = assessStall(
    running({ phase: 'tool', since: ago(200 * S), tool: 'run_command\u001b]0;pwn\u0007', commandTimeoutSec: 60 }),
    NOW,
  );
  assert.ok(found, 'a malformed tool name degrades to a generic tool warning');
  assert.doesNotMatch(found.message, /[\u0000-\u001f]|pwn/);
  assert.equal(STALL.providerSevereShare, 0.9, 'the thresholds are a frozen, documented table');
  assert.throws(() => {
    'use strict';
    STALL.providerSevereShare = 1;
  });
});
