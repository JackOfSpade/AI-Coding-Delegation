import test from 'node:test';
import assert from 'node:assert/strict';
import { JobManager } from '../../src/job-manager.mjs';
import { createCore } from '../../src/core.mjs';
import { cleanup, makeRepo, write } from '../unit/helpers.mjs';
import { join } from 'node:path';

const SESSION = '2026-10-06T12:00:00.000Z';
const BEFORE = '2026-10-06T09:00:00.000Z';
const AFTER = '2026-10-06T13:00:00.000Z';
// Newest first, the way the store lists them.
const row = (id, status, { createdAt, updatedAt = createdAt, costUsd, rounds = 1 }) => ({
  id,
  repoPath: '/repo',
  status,
  createdAt,
  updatedAt,
  rounds,
  ...(costUsd === undefined ? {} : { costUsd }),
});
const newestFirst = (jobs) => [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
function manager(jobs, { config = { sessionStartedAt: SESSION }, report } = {}) {
  const store = {
    list: async () => newestFirst(jobs),
    listOperational: async () => newestFirst(jobs),
    get: async (id) => jobs.find((job) => job.id === id),
  };
  return new JobManager({ store, config, ...(report ? { report } : {}) });
}
const ids = (result) => result.jobs.map((job) => job.jobId).sort();

const fixture = () => [
  row('old-done', 'DONE_VERIFIED', { createdAt: '2026-10-06T08:00:00.000Z', costUsd: 0.1 }),
  row('old-active', 'RUNNING', { createdAt: '2026-10-06T08:30:00.000Z', updatedAt: BEFORE, costUsd: 0.05 }),
  row('session-done', 'DONE_VERIFIED', { createdAt: '2026-10-06T12:30:00.000Z', costUsd: 0.2 }),
  row('touched', 'DONE_UNVERIFIED', { createdAt: '2026-10-06T07:00:00.000Z', updatedAt: AFTER, costUsd: 0.4, rounds: 2 }),
];

test('the no-argument list holds active jobs and jobs touched this session, and counts the rest', async () => {
  const result = await manager(fixture()).job();
  assert.deepEqual(ids(result), ['old-active', 'session-done', 'touched']);
  assert.equal(result.listing.scope, 'session');
  assert.equal(result.listing.sessionStartedAt, SESSION);
  assert.equal(result.listing.shown, 3);
  assert.equal(result.listing.omitted, 1);
  assert.equal(result.listing.omittedByScope, 1);
  assert.equal(result.listing.omittedByLimit, 0);
  assert.equal(typeof result.listing.hint, 'string');
  assert.match(result.listing.hint, /all:true/);
  // The hint names counts and parameters, never a job id.
  assert.doesNotMatch(result.listing.hint, /old-done/);
  assert.deepEqual(result.health, { sandbox: 'unknown' });
});

test('all:true lists every stored job and drops the hint', async () => {
  const result = await manager(fixture()).job(undefined, { all: true });
  assert.deepEqual(ids(result), ['old-active', 'old-done', 'session-done', 'touched']);
  assert.equal(result.listing.scope, 'all');
  assert.equal('sessionStartedAt' in result.listing, false);
  assert.equal(result.listing.omitted, 0);
  assert.equal('hint' in result.listing, false);
});

test('without a session boundary the list is the legacy complete list', async () => {
  const result = await manager(fixture(), { config: {} }).job();
  assert.equal(result.listing.scope, 'all');
  assert.equal(result.jobs.length, 4);
  assert.equal(result.listing.omitted, 0);
  // An unparsable boundary is the same as none: nothing is hidden by a bad value.
  assert.equal((await manager(fixture(), { config: { sessionStartedAt: 'not a date' } }).job()).jobs.length, 4);
});

test('maxJobs never cuts an active job and counts what it cut', async () => {
  const jobs = [
    row('active-1', 'RUNNING', { createdAt: '2026-10-06T12:01:00.000Z' }),
    row('active-2', 'QUEUED', { createdAt: '2026-10-06T12:02:00.000Z' }),
    row('done-1', 'DONE_VERIFIED', { createdAt: '2026-10-06T12:03:00.000Z' }),
    row('done-2', 'DONE_VERIFIED', { createdAt: '2026-10-06T12:04:00.000Z' }),
    row('done-3', 'DONE_VERIFIED', { createdAt: '2026-10-06T12:05:00.000Z' }),
  ];
  const tight = await manager(jobs).job(undefined, { maxJobs: 1 });
  assert.deepEqual(ids(tight), ['active-1', 'active-2']);
  assert.equal(tight.listing.omittedByLimit, 3);
  assert.equal(tight.listing.omittedByScope, 0);
  assert.equal(tight.listing.omitted, 3);
  assert.match(tight.listing.hint, /maxJobs/);
  // Total spend still covers the hidden jobs; only the rows are cut.
  const quiet = jobs.filter((job) => job.status === 'DONE_VERIFIED');
  const two = await manager(quiet).job(undefined, { maxJobs: 2 });
  assert.deepEqual(
    two.jobs.map((job) => job.jobId),
    ['done-3', 'done-2'],
    'the newest two, newest first',
  );
  assert.equal(two.listing.omittedByLimit, 1);
});

test('rows and listing carry exact cumulative costs and never a NaN', async () => {
  const jobs = [
    row('a', 'DONE_VERIFIED', { createdAt: '2026-10-06T12:01:00.000Z', costUsd: 0.1, rounds: 3 }),
    row('b', 'DONE_VERIFIED', { createdAt: '2026-10-06T12:02:00.000Z', costUsd: 0.2 }),
    row('c', 'DONE_VERIFIED', { createdAt: '2026-10-06T12:03:00.000Z', costUsd: 0.05 }),
    row('x', 'FAILED', { createdAt: '2026-10-06T12:04:00.000Z', costUsd: 'x' }),
    row('n', 'FAILED', { createdAt: '2026-10-06T12:05:00.000Z', costUsd: Number.NaN }),
    row('neg', 'FAILED', { createdAt: '2026-10-06T12:06:00.000Z', costUsd: -1 }),
    row('old', 'DONE_VERIFIED', { createdAt: BEFORE, costUsd: 1.5 }),
  ];
  const result = await manager(jobs).job();
  assert.equal(result.listing.totalCostUsd, 0.35, 'rounded, not 0.35000000000000003');
  assert.equal(result.listing.storeCostUsd, 1.85);
  assert.equal(result.listing.costUnknownJobs, 3);
  const byId = Object.fromEntries(result.jobs.map((job) => [job.jobId, job]));
  assert.equal(byId.a.costUsd, 0.1);
  assert.equal(byId.a.rounds, 3, 'cumulative across rounds, counted once');
  assert.equal(byId.x.costUsd, null);
  assert.equal(byId.n.costUsd, null);
  assert.equal(byId.neg.costUsd, null);
  assert.equal(byId.a.createdAt, '2026-10-06T12:01:00.000Z');
  assert.equal('costUnknownJobs' in (await manager(fixture()).job()).listing, false);
});

test('totalCostUsd and costUnknownJobs cover the rows returned, not jobs cut by maxJobs or scope', async () => {
  const jobs = [
    row('a', 'DONE_VERIFIED', { createdAt: '2026-10-06T12:01:00.000Z', costUsd: 1 }),
    row('b', 'DONE_VERIFIED', { createdAt: '2026-10-06T12:02:00.000Z', costUsd: 2 }),
    row('c', 'DONE_VERIFIED', { createdAt: '2026-10-06T12:03:00.000Z', costUsd: 4 }),
    row('u', 'DONE_VERIFIED', { createdAt: '2026-10-06T12:00:00.000Z' }),
    row('old', 'DONE_VERIFIED', { createdAt: BEFORE, costUsd: 8 }),
  ];
  const { jobs: rows, listing } = await manager(jobs).job(undefined, { maxJobs: 1 });
  assert.deepEqual(
    rows.map((job) => job.jobId),
    ['c'],
  );
  assert.equal(listing.omittedByLimit, 3);
  assert.equal(listing.totalCostUsd, 4, 'the sum of the shown rows, not of the 7 in scope');
  assert.equal(listing.storeCostUsd, 15);
  assert.equal('costUnknownJobs' in listing, false, 'the unknown-cost job is not shown');
  const wide = (await manager(jobs).job(undefined, { maxJobs: 10 })).listing;
  assert.equal(wide.totalCostUsd, 7);
  assert.equal(wide.costUnknownJobs, 1);
});

test('an active job with no recorded cost has spent nothing so far, not an unknown cost', async () => {
  const jobs = [
    row('queued', 'QUEUED', { createdAt: '2026-10-06T12:01:00.000Z', rounds: 0 }),
    row('running', 'RUNNING', { createdAt: '2026-10-06T12:02:00.000Z', costUsd: 0.25 }),
    row('badrun', 'RUNNING', { createdAt: '2026-10-06T12:03:00.000Z', costUsd: 'x' }),
    row('never-priced', 'FAILED', { createdAt: '2026-10-06T12:04:00.000Z' }),
  ];
  const { jobs: rows, listing } = await manager(jobs).job();
  const byId = Object.fromEntries(rows.map((job) => [job.jobId, job]));
  assert.equal(byId.queued.costUsd, 0);
  assert.equal(byId.running.costUsd, 0.25);
  assert.equal(byId.badrun.costUsd, null, 'a malformed value is still unknown');
  assert.equal(byId['never-priced'].costUsd, null, 'a finished job that never recorded a cost is unknown');
  assert.equal(listing.totalCostUsd, 0.25);
  assert.equal(listing.costUnknownJobs, 2);
  const calls = [];
  await manager(jobs, { report: (job, options) => (calls.push(options), 'report') }).job('running');
  assert.deepEqual(calls.at(-1).spend, { jobs: 4, costUsd: 0.25, unknown: 2 });
});

test('a first-round running job lists with zero cost through Core', async () => {
  const repo = makeRepo();
  try {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const core = coreFor({ worker: { run: async () => (await gate, { status: 'DONE', summary: 'ok', costUsd: 0.25 }) } });
    const started = await core.start({ repoPath: repo, task: 't', ownedPaths: ['src/**'], testCommand: 'true' });
    const live = await core.job(undefined, { repoPath: repo });
    assert.equal(live.jobs[0].costUsd, 0);
    assert.equal('costUnknownJobs' in live.listing, false);
    release();
    await core.wait(started.jobId, { repoPath: repo, timeoutSec: 5 });
    assert.equal((await core.job(undefined, { repoPath: repo })).jobs[0].costUsd, 0.25);
  } finally {
    cleanup(repo);
  }
});

test('a legacy row without updatedAt falls back to createdAt for the session boundary', async () => {
  const legacy = (id, createdAt) => ({ id, repoPath: '/repo', status: 'DONE_VERIFIED', createdAt, rounds: 1, costUsd: 0.1 });
  const result = await manager([legacy('legacy-new', AFTER), legacy('legacy-old', BEFORE)]).job();
  assert.deepEqual(ids(result), ['legacy-new']);
  assert.equal(result.listing.omittedByScope, 1);
});

test('spend counts every job touched this session in full, and says so', async () => {
  const jobs = [
    // Created before the session, touched (applied) during it: all $5 counts.
    row('carried', 'DONE_VERIFIED', { createdAt: BEFORE, updatedAt: AFTER, costUsd: 5 }),
    row('fresh', 'DONE_VERIFIED', { createdAt: AFTER, costUsd: 0.01 }),
    row('untouched', 'DONE_VERIFIED', { createdAt: BEFORE, costUsd: 100 }),
  ];
  const calls = [];
  await manager(jobs, { report: (job, options) => (calls.push(options), 'report') }).job('fresh');
  assert.deepEqual(calls.at(-1).spend, { jobs: 2, costUsd: 5.01, unknown: 0 });
});

test('list parameters are validated and refused alongside a jobId', async () => {
  const m = manager(fixture());
  await assert.rejects(() => m.job(undefined, { all: 'yes' }), /all must be a boolean/);
  for (const maxJobs of [0, 101, 1.5, '5', null, Number.NaN])
    await assert.rejects(() => m.job(undefined, { maxJobs }), /maxJobs must be an integer from 1 to 100/, String(maxJobs));
  await assert.rejects(() => m.job('old-done', { all: true }), /apply only to the job list/);
  await assert.rejects(() => m.job('old-done', { maxJobs: 5 }), /apply only to the job list/);
  // A valid explicit false is accepted and means the session scope.
  assert.equal((await m.job(undefined, { all: false })).listing.scope, 'session');
});

test('interactive compact reports carry session spend; durable and full reports do not', async () => {
  const jobs = fixture();
  const calls = [];
  const m = manager(jobs, {
    report: (job, options) => {
      calls.push({ id: job.id, options });
      return 'report';
    },
  });
  const terminal = jobs.find((job) => job.id === 'session-done');
  // session-done, touched and old-active are in the session (old-active only if touched, which it is not).
  const expected = { jobs: 2, costUsd: 0.6, unknown: 0 };
  await m.job('session-done');
  assert.deepEqual(calls.at(-1).options.spend, expected);
  await m.wait('session-done', { timeoutSec: 0 });
  assert.deepEqual(calls.at(-1).options.spend, expected);
  await m.job('session-done', { detail: 'full' });
  assert.equal(calls.at(-1).options.spend, undefined);
  await m.wait('session-done', { timeoutSec: 0, detail: 'full' });
  assert.equal(calls.at(-1).options.spend, undefined);
  assert.equal(terminal.status, 'DONE_VERIFIED');
  // The unknown-cost count is reported, not silently summed as zero.
  jobs.push(row('unpriced', 'FAILED', { createdAt: '2026-10-06T12:40:00.000Z' }));
  await m.job('session-done');
  assert.deepEqual(calls.at(-1).options.spend, { jobs: 3, costUsd: 0.6, unknown: 1 });
});

test('a failing spend scan never fails the report', async () => {
  const jobs = fixture();
  const calls = [];
  const store = {
    list: async () => {
      throw new Error('store unavailable');
    },
    listOperational: async () => {
      throw new Error('store unavailable');
    },
    get: async (id) => jobs.find((job) => job.id === id),
  };
  const m = new JobManager({
    store,
    config: { sessionStartedAt: SESSION },
    report: (job, options) => {
      calls.push(options);
      return 'report';
    },
  });
  assert.equal((await m.job('session-done')).report, 'report');
  assert.equal(calls.at(-1).spend, undefined);
  // No session boundary: no spend at all.
  const none = manager(jobs, { config: {}, report: (job, options) => (calls.push(options), 'report') });
  await none.job('session-done');
  assert.equal(calls.at(-1).spend, undefined);
});

test('spend is scanned from the operational view so a rotated credential cannot break a report', async () => {
  const jobs = fixture();
  let authenticated = 0;
  const calls = [];
  const store = {
    list: async () => {
      authenticated += 1;
      throw new Error('credential rotated');
    },
    listOperational: async () => newestFirst(jobs),
    get: async (id) => jobs.find((job) => job.id === id),
  };
  const m = new JobManager({ store, config: { sessionStartedAt: SESSION }, report: (job, options) => (calls.push(options), 'report') });
  await m.job('session-done');
  assert.deepEqual(calls.at(-1).spend, { jobs: 2, costUsd: 0.6, unknown: 0 });
  assert.equal(authenticated, 0);
});

function coreFor({ config: extraConfig, ...overrides } = {}) {
  return createCore({
    config: {
      ...extraConfig,
      loaded: {
        disabled: false,
        repoConfig: {},
        config: {
          default: 'test',
          profiles: { test: { provider: 'test', model: 'test-model' } },
          providers: { test: { type: 'openai-chat', keyRef: 'env:IGNORED', baseUrl: 'https://example.test' } },
          limits: { maxTurns: 2, timeoutMinutes: 1, maxUsd: 1 },
        },
      },
    },
    worker: { run: async () => ({ status: 'DONE', summary: 'ok' }) },
    runner: { verify: async (command) => ({ command, verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
    ...overrides,
  });
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Core scopes the no-argument list to its session, and all:true reaches older jobs', async () => {
  const repo = makeRepo();
  try {
    const first = coreFor();
    const old = await first.start({ repoPath: repo, task: 'old', ownedPaths: ['src/**'], testCommand: 'true' });
    assert.equal((await first.wait(old.jobId, { repoPath: repo, timeoutSec: 5 })).status, 'DONE_VERIFIED');
    await pause(25);
    const sessionStart = new Date();
    await pause(25);
    const second = coreFor({ sessionStartedAt: sessionStart });
    const fresh = await second.start({ repoPath: repo, task: 'fresh', ownedPaths: ['src/**'], testCommand: 'true' });
    assert.equal((await second.wait(fresh.jobId, { repoPath: repo, timeoutSec: 5 })).status, 'DONE_VERIFIED');

    const scoped = await second.job(undefined, { repoPath: repo });
    assert.deepEqual(
      scoped.jobs.map((job) => job.jobId),
      [fresh.jobId],
    );
    assert.equal(scoped.listing.scope, 'session');
    assert.equal(scoped.listing.sessionStartedAt, sessionStart.toISOString());
    assert.equal(scoped.listing.omitted, 1);
    assert.equal(scoped.listing.omittedByScope, 1);

    const everything = await second.job(undefined, { repoPath: repo, all: true });
    assert.deepEqual(everything.jobs.map((job) => job.jobId).sort(), [old.jobId, fresh.jobId].sort());
    assert.equal(everything.listing.omitted, 0);

    // An old job stays readable by id, and reading it does not make it "touched".
    const before = await second.job(old.jobId, { repoPath: repo });
    assert.equal(before.status, 'DONE_VERIFIED');
    const stillScoped = await second.job(undefined, { repoPath: repo });
    assert.deepEqual(
      stillScoped.jobs.map((job) => job.jobId),
      [fresh.jobId],
      'reading and recovering a terminal job must not bump its updatedAt',
    );
    await assert.rejects(() => second.job(old.jobId, { repoPath: repo, all: true }), /apply only to the job list/);
    await assert.rejects(() => second.job(undefined, { repoPath: repo, maxJobs: 0 }), /maxJobs must be an integer/);
  } finally {
    cleanup(repo);
  }
});

test('a caller config cannot override the server session boundary', async () => {
  const repo = makeRepo();
  try {
    const sessionStart = new Date();
    const core = coreFor({ sessionStartedAt: sessionStart, config: { sessionStartedAt: '2000-01-01T00:00:00Z' } });
    const listing = (await core.job(undefined, { repoPath: repo })).listing;
    assert.equal(listing.sessionStartedAt, sessionStart.toISOString());
    // The bound manager received the server boundary too, not the config's.
    const seen = await core.start({ repoPath: repo, task: 't', ownedPaths: ['src/**'], testCommand: 'true' });
    assert.equal((await core.wait(seen.jobId, { repoPath: repo, timeoutSec: 5 })).status, 'DONE_VERIFIED');
    assert.equal((await core.job(undefined, { repoPath: repo })).listing.sessionStartedAt, sessionStart.toISOString());
  } finally {
    cleanup(repo);
  }
});

test('Core refuses a malformed session boundary', () => {
  assert.throws(() => coreFor({ sessionStartedAt: 'yesterday-ish' }), /sessionStartedAt must be an ISO timestamp/);
  assert.doesNotThrow(() => coreFor({ sessionStartedAt: new Date() }));
  assert.doesNotThrow(() => coreFor({ sessionStartedAt: '2026-01-01T00:00:00Z' }));
  // Coercible-but-meaningless values would become the epoch and match every job.
  for (const bad of [null, 0, false, true, '', 1767225600000, {}, []]) {
    assert.throws(() => coreFor({ sessionStartedAt: bad }), /sessionStartedAt must be an ISO timestamp/, JSON.stringify(bad));
  }
});

test('health reports the working tree of the bound repository', async () => {
  const repo = makeRepo();
  try {
    const core = coreFor();
    const clean = await core.job(undefined, { repoPath: repo });
    assert.deepEqual(clean.health.workingTree, {
      clean: true,
      changed: 0,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicted: 0,
      sample: [],
    });
    write(join(repo, '.env'), 'TOKEN=abc\n');
    write(join(repo, 'notes.txt'), 'x\n');
    write(join(repo, 'tracked.txt'), 'changed\n');
    const dirty = (await core.job(undefined, { repoPath: repo })).health.workingTree;
    assert.deepEqual(dirty, {
      clean: false,
      changed: 3,
      staged: 0,
      modified: 1,
      untracked: 2,
      conflicted: 0,
      sample: [' M tracked.txt', '?? notes.txt'],
    });
  } finally {
    cleanup(repo);
  }
});

test('with no repository bound there is no working tree and the listing is empty', async () => {
  const result = await coreFor().job();
  assert.deepEqual(result.jobs, []);
  assert.equal(result.health.workingTree, undefined);
  assert.equal(result.listing.scope, 'session');
  for (const key of ['shown', 'omitted', 'omittedByScope', 'omittedByLimit', 'totalCostUsd', 'storeCostUsd'])
    assert.equal(result.listing[key], 0, key);
  const everything = await coreFor().job(undefined, { all: true });
  assert.equal(everything.listing.scope, 'all');
  await assert.rejects(() => coreFor().job(undefined, { all: 'no' }), /all must be a boolean/);
  await assert.rejects(() => coreFor().job(undefined, { maxJobs: 101 }), /maxJobs must be an integer from 1 to 100/);
});

test('with several repositories loaded the unbound list merges them newest first with summed counts', async () => {
  const a = makeRepo(),
    b = makeRepo();
  try {
    const core = coreFor();
    const first = await core.start({ repoPath: a, task: 'first', ownedPaths: ['src/**'], testCommand: 'true' });
    await pause(15);
    const second = await core.start({ repoPath: b, task: 'second', ownedPaths: ['lib/**'], testCommand: 'true' });
    await core.wait(first.jobId, { repoPath: a, timeoutSec: 5 });
    await core.wait(second.jobId, { repoPath: b, timeoutSec: 5 });
    // An unbound call after both repositories are loaded: no cwd hint reaches it.
    const savedEnv = { ...process.env };
    for (const key of ['CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'CURSOR_PROJECT_DIR']) delete process.env[key];
    let result;
    try {
      result = await core.job();
    } finally {
      Object.assign(process.env, savedEnv);
    }
    assert.equal(result.health.repositories.length, 2);
    assert.deepEqual(
      result.jobs.map((job) => job.jobId),
      [second.jobId, first.jobId],
    );
    assert.equal(result.listing.shown, 2);
    assert.equal(result.listing.omitted, 0);
    assert.equal(result.health.workingTree, undefined);
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

test('the unbound multi-repository list applies maxJobs once to the merged rows and keeps active jobs', async () => {
  const a = makeRepo(),
    b = makeRepo();
  try {
    const core = coreFor();
    const ids = [];
    for (const [repo, owned] of [
      [a, 'src/**'],
      [a, 'src/**'],
      [b, 'lib/**'],
      [b, 'lib/**'],
    ]) {
      const started = await core.start({ repoPath: repo, task: 't', ownedPaths: [owned], testCommand: 'true' });
      assert.equal((await core.wait(started.jobId, { repoPath: repo, timeoutSec: 5 })).status, 'DONE_VERIFIED');
      ids.push(started.jobId);
      await pause(15);
    }
    const savedEnv = { ...process.env };
    for (const key of ['CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'CURSOR_PROJECT_DIR']) delete process.env[key];
    let capped, wide;
    try {
      capped = await core.job(undefined, { maxJobs: 1 });
      wide = await core.job(undefined, { maxJobs: 3 });
    } finally {
      Object.assign(process.env, savedEnv);
    }
    assert.deepEqual(
      capped.jobs.map((job) => job.jobId),
      [ids[3]],
      'one row in total, the newest across both repositories',
    );
    assert.equal(capped.listing.shown, 1);
    assert.equal(capped.listing.omittedByLimit, 3);
    assert.equal(capped.listing.omitted, 3);
    assert.match(capped.listing.hint, /maxJobs/);
    assert.deepEqual(
      wide.jobs.map((job) => job.jobId),
      [ids[3], ids[2], ids[1]],
    );
    assert.equal(wide.listing.omittedByLimit, 1);
    assert.equal(wide.listing.shown, 3);
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

// A list row says what the job was for and how long it took, without carrying the brief.
test('rows carry a redacted one-line task, the latest round clock and a running duration', async () => {
  const at = (time) => `2026-10-06T${time}.000Z`;
  const detail = (id, status, extra) => ({ ...row(id, status, { createdAt: at('12:01:00'), costUsd: 0.5 }), ...extra });
  const jobs = [
    detail('done', 'DONE_VERIFIED', { task: 'Add retries\nto the fetcher', startedAt: at('12:02:00'), finishedAt: at('12:07:30') }),
    detail('running', 'RUNNING', { task: 'Port the parser', startedAt: at('12:30:00') }),
    detail('queued', 'QUEUED', { task: 'Not claimed yet', startedAt: at('12:02:00') }),
    detail('requeued', 'REPAIR_QUEUED', { task: 'Second round pending', startedAt: at('12:03:00') }),
    detail('cancelled-early', 'CANCELLED', { task: 'Never claimed', finishedAt: at('12:05:00') }),
    detail('no-task', 'DONE_UNVERIFIED', { task: '   ', startedAt: at('12:02:00'), finishedAt: at('12:03:00') }),
  ];
  const now = () => new Date(at('12:30:42'));
  const store = { list: async () => newestFirst(jobs), listOperational: async () => newestFirst(jobs), get: async () => undefined };
  const { jobs: rows } = await new JobManager({ store, config: { sessionStartedAt: SESSION }, now }).job();
  const byId = Object.fromEntries(rows.map((job) => [job.jobId, job]));
  assert.equal(byId.done.task, 'Add retries to the fetcher', 'a single line');
  assert.deepEqual(
    [byId.done.startedAt, byId.done.finishedAt, byId.done.durationSec, 'running' in byId.done],
    [at('12:02:00'), at('12:07:30'), 330, false],
    'a terminal job: finished minus started, not flagged running',
  );
  assert.deepEqual(
    [byId.running.startedAt, 'finishedAt' in byId.running, byId.running.durationSec, byId.running.running],
    [at('12:30:00'), false, 42, true],
    'an active job: elapsed so far, flagged running, and no finishedAt',
  );
  for (const id of ['queued', 'requeued']) {
    assert.deepEqual(
      ['startedAt', 'finishedAt', 'durationSec', 'running'].filter((key) => key in byId[id]),
      [],
      `${id} has not been claimed this round, so it shows no stale clock`,
    );
    assert.equal(typeof byId[id].task, 'string');
  }
  assert.deepEqual(
    ['startedAt', 'durationSec'].filter((key) => key in byId['cancelled-early']),
    [],
    'a job that never started has no duration',
  );
  assert.equal(byId['cancelled-early'].finishedAt, at('12:05:00'));
  assert.equal('task' in byId['no-task'], false, 'a blank brief is no summary');
  assert.equal(byId['no-task'].durationSec, 60);
  assert.equal(byId.done.costUsd, 0.5, 'the cumulative cost stays on the row');
});

test('a row task is clipped, and credentials, home paths and literal secrets never reach it', async () => {
  const secret = 'literal-store-secret-4711';
  const poisoned = [
    'Rotate the credentials in /Users/jane.doe/work/app/.env then',
    'API_KEY=hunter2hunter2 and Authorization: Bearer abcdef0123456789abcdef',
    'plus sk-live0123456789abcdef and the store value',
    secret,
    'and a long tail '.repeat(40),
  ].join('\n');
  const jobs = [{ ...row('poisoned', 'FAILED', { createdAt: '2026-10-06T12:01:00.000Z', costUsd: 0.2 }), task: poisoned }];
  const store = { list: async () => jobs, listOperational: async () => jobs, get: async () => jobs[0], secrets: [secret] };
  const [{ task }] = (await new JobManager({ store, config: { sessionStartedAt: SESSION } }).job()).jobs;
  assert.ok(task.length <= 100, `${task.length} characters`);
  assert.ok(task.endsWith('…'), 'clipped, and said so');
  assert.doesNotMatch(task, /\n/);
  assert.match(task, /^Rotate the credentials in ~\/work\/app\/\.env then API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(task, /jane\.doe|hunter2|abcdef0123456789|sk-live|literal-store-secret/);
  // The same inputs through a long brief that places the secret across the cut: redaction runs before the clip.
  const edge = 'x'.repeat(80) + ' API_KEY=hunter2hunter2hunter2 trailing';
  const row2 = { ...jobs[0], id: 'edge', task: edge };
  const only = { list: async () => [row2], listOperational: async () => [row2], get: async () => row2 };
  const [{ task: edgeTask }] = (await new JobManager({ store: only, config: { sessionStartedAt: SESSION } }).job()).jobs;
  assert.doesNotMatch(edgeTask, /hunter2|API_KEY=h/);
});

test('an unknown cost is null on the row, never zero, beside the new detail fields', async () => {
  const unpriced = { ...row('unpriced', 'FAILED', { createdAt: '2026-10-06T12:01:00.000Z' }), task: 't', startedAt: SESSION };
  const store = { list: async () => [unpriced], listOperational: async () => [unpriced], get: async () => unpriced };
  const { jobs, listing } = await new JobManager({ store, config: { sessionStartedAt: SESSION } }).job();
  assert.equal(jobs[0].costUsd, null);
  assert.equal(listing.costUnknownJobs, 1);
  assert.equal(listing.totalCostUsd, 0, 'the total counts known costs only and the unknown ones are counted beside it');
});
