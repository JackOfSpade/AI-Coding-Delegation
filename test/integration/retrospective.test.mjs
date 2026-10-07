import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JobManager } from '../../src/job-manager.mjs';
import { createCore } from '../../src/core.mjs';
import { createRetrospectiveLog, RETROSPECTIVE_FILE, RETROSPECTIVE_LOG_LIMITS } from '../../src/retrospective-log.mjs';
import { buildRetrospective } from '../../src/retrospective.mjs';
import { cleanup, makeRepo, tempDir } from '../unit/helpers.mjs';

const SESSION = '2026-10-06T12:00:00.000Z';
const BEFORE = '2026-10-06T09:00:00.000Z';
const AFTER = '2026-10-06T13:00:00.000Z';
const row = (id, status, extra = {}) => ({
  id,
  repoPath: '/repo',
  status,
  createdAt: AFTER,
  updatedAt: AFTER,
  rounds: 0,
  costUsd: 0.1,
  task: `task of ${id}`,
  ...extra,
});
const newestFirst = (jobs) => [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

test('the retrospective source is the session by default, the named jobs, or the newest of the store', async () => {
  const jobs = [
    row('old-done', 'DONE_VERIFIED', { createdAt: '2026-10-06T08:00:00.000Z', updatedAt: BEFORE }),
    row('old-running', 'RUNNING', { createdAt: '2026-10-06T08:30:00.000Z', updatedAt: BEFORE }),
    row('touched', 'DONE_UNVERIFIED', { createdAt: '2026-10-06T07:00:00.000Z', updatedAt: AFTER }),
    row('fresh-1', 'DONE_VERIFIED', { createdAt: '2026-10-06T12:30:00.000Z' }),
    row('fresh-2', 'FAILED', { createdAt: '2026-10-06T12:40:00.000Z' }),
  ];
  // Only the operational view is read: a rotated credential must not stop a digest, as for a report.
  const reads = [];
  const store = {
    list: async () => assert.fail('list needs the credential'),
    get: async () => assert.fail('get needs the credential'),
    listOperational: async () => (reads.push('list'), newestFirst(jobs)),
    getOperational: async (id) => (reads.push(id), jobs.find((job) => job.id === id)),
    secrets: ['store-secret'],
  };
  const manager = new JobManager({ store, config: { sessionStartedAt: SESSION }, now: () => new Date('2026-10-06T14:00:00.000Z') });
  const ids = (source) => source.jobs.map((job) => job.id);
  const session = await manager.retrospectiveSource();
  assert.deepEqual(
    ids(session),
    ['fresh-2', 'fresh-1', 'touched'],
    'created or touched this session, an untouched old job (even a running one) excluded',
  );
  assert.deepEqual([session.omitted, session.secrets, session.nowMs], [0, ['store-secret'], Date.parse('2026-10-06T14:00:00.000Z')]);
  assert.deepEqual(ids(await manager.retrospectiveSource({ ids: ['old-done', 'fresh-1'] })), ['fresh-1', 'old-done']);
  assert.deepEqual(
    ids(await manager.retrospectiveSource({ last: 2 })),
    ['fresh-2', 'fresh-1'],
    'the newest of the whole store, not the session',
  );
  const asked = await manager.retrospectiveSource({ last: 4 });
  assert.deepEqual([asked.jobs.length, asked.omitted], [4, 0], 'what last leaves out was never asked for, so it is not called omitted');
  assert.deepEqual(ids(await manager.retrospectiveSource({ limit: 1 })), ['fresh-2']);
  assert.equal((await manager.retrospectiveSource({ limit: 1 })).omitted, 2);
  // Without a session boundary (direct use) every stored job is in scope.
  const bare = new JobManager({ store, config: {} });
  assert.equal((await bare.retrospectiveSource()).jobs.length, 5);
  assert.ok(reads.includes('old-done'));
});

function coreFor({ config: extra, ...overrides } = {}) {
  return createCore({
    config: {
      maintainerRoot: '/opt/offload',
      // The developer's own installed skill copy must not decide whether a test finds a stale skill.
      skillHealth: () => ({ stale: false, state: 'current', reason: 'match', installedHash: 'sha256:x' }),
      ...extra,
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
    worker: { run: async () => ({ status: 'DONE', summary: 'ok', costUsd: 0.25 }) },
    runner: { verify: async (command) => ({ command, verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
    ...overrides,
  });
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const memoryLog = () => {
  const appended = [];
  return {
    appended,
    path: '/memory',
    append: (result) => appended.push(result),
    history: () => ({ path: '/memory', records: appended, aggregate: {} }),
  };
};
const finished = async (core, repo, task) => {
  const started = await core.start({ repoPath: repo, task, ownedPaths: ['src/**'], testCommand: 'true', profile: 'test' });
  assert.equal((await core.wait(started.jobId, { repoPath: repo, timeoutSec: 5 })).status, 'DONE_VERIFIED');
  return started.jobId;
};

test('Core builds the digest for this session, the named jobs or the newest, and records one history line per digest', async () => {
  const repo = makeRepo();
  try {
    const first = coreFor();
    const old = await finished(first, repo, 'the old task');
    await pause(25);
    const sessionStart = new Date();
    await pause(25);
    const log = memoryLog();
    const core = coreFor({ sessionStartedAt: sessionStart, config: { retrospectiveLog: log } });
    const fresh = await finished(core, repo, 'the fresh task');

    const session = await core.retrospective({ repoPath: repo });
    assert.equal(session.scope, 'session');
    assert.deepEqual(
      session.jobs.map((job) => [job.id, job.status, job.verdict, job.costUsd, job.task, job.profile]),
      [[fresh, 'DONE_VERIFIED', 'PASS', 0.25, 'the fresh task', 'test']],
    );
    assert.deepEqual([session.totals.jobs, session.totals.costUsd, session.maintainerPromptWarranted], [1, 0.25, false]);
    assert.ok(
      session.maintainerPromptSkeleton.includes('The Offload checkout to change is /opt/offload.'),
      'the configured maintainer checkout is named',
    );
    assert.equal(session.project.repo, repo.split('/').at(-1));
    assert.ok(!JSON.stringify(session).includes(repo), 'the checkout path never reaches the digest');

    const named = await core.retrospective({ repoPath: repo, jobIds: [old, fresh] });
    assert.deepEqual([named.scope, named.jobs.map((job) => job.id).sort()], ['jobs', [old, fresh].sort()]);
    const recent = await core.retrospective({ repoPath: repo, last: 1 });
    assert.deepEqual([recent.scope, recent.jobs.map((job) => job.id)], ['recent', [fresh]]);
    assert.equal(recent.totals.jobs, 1);
    assert.deepEqual([log.appended.length, log.appended.map((entry) => entry.scope)], [3, ['session', 'jobs', 'recent']]);
    await core.retrospective({ repoPath: repo, persist: false });
    assert.equal(log.appended.length, 3, 'persist:false records nothing');
    assert.equal((await core.retrospectiveHistory()).records.length, 3);

    // A failing history never costs the caller the digest.
    const broken = coreFor({
      sessionStartedAt: sessionStart,
      config: {
        retrospectiveLog: {
          append() {
            throw new Error('disk full');
          },
        },
      },
    });
    assert.equal((await broken.retrospective({ repoPath: repo })).totals.jobs, 1);

    // Nothing is read or written for a request that is malformed.
    const bad = [
      [{ jobIds: [] }, /jobIds must be 1-16 distinct job ids/],
      [{ jobIds: [fresh, fresh] }, /jobIds must be 1-16 distinct job ids/],
      [{ jobIds: Array.from({ length: 17 }, (_, index) => `oj-${index}`) }, /jobIds must be 1-16/],
      [{ jobIds: 'oj-1' }, /jobIds must be 1-16/],
      [{ jobIds: ['bad id'] }, /valid job id is required/],
      [{ jobIds: [fresh], last: 1 }, /last applies only without jobIds/],
      [{ last: 0 }, /last must be an integer from 1 to 16/],
      [{ last: 17 }, /last must be an integer from 1 to 16/],
      [{ last: 1.5 }, /last must be an integer from 1 to 16/],
      [{ jobIds: [`oj-${'0'.repeat(40)}`] }, /job not found/],
      [{ repoPath: 'relative/path' }, /repoPath/],
    ];
    for (const [options, message] of bad)
      await assert.rejects(() => core.retrospective({ repoPath: repo, ...options }), message, JSON.stringify(options).slice(0, 80));
    assert.equal(log.appended.length, 3);
  } finally {
    cleanup(repo);
  }
});

test('Core reads a job by id only inside the repository named for it', async () => {
  const a = makeRepo(),
    b = makeRepo();
  try {
    const core = coreFor({ config: { retrospectiveLog: memoryLog() } });
    const inA = await finished(core, a, 'in a');
    await finished(core, b, 'in b');
    await assert.rejects(() => core.retrospective({ repoPath: b, jobIds: [inA] }), /job not found/);
    assert.equal((await core.retrospective({ repoPath: a, jobIds: [inA] })).jobs[0].id, inA);
    // With no repository named, the loaded repositories merge, newest first.
    const savedEnv = { ...process.env };
    for (const key of ['CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'CURSOR_PROJECT_DIR']) delete process.env[key];
    let merged;
    try {
      merged = await core.retrospective({});
    } finally {
      Object.assign(process.env, savedEnv);
    }
    assert.equal(merged.totals.jobs, 2);
    assert.equal(merged.project.repo.split(', ').length, 2, 'both project names, never their paths');
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

test('with no repository bound the digest is empty and carries the health facts alone', async () => {
  const core = coreFor({ config: { retrospectiveLog: memoryLog() } });
  const savedEnv = { ...process.env };
  for (const key of ['CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'CURSOR_PROJECT_DIR']) delete process.env[key];
  let result;
  try {
    result = await core.retrospective({});
  } finally {
    Object.assign(process.env, savedEnv);
  }
  assert.deepEqual([result.totals.jobs, result.jobs, result.signals, result.maintainerPromptWarranted], [0, [], [], false]);
  assert.ok(['macos', 'policy-only'].includes(result.health.sandbox));
  assert.equal(result.health.skillStale ?? false, false);
});

const record = (n, extra = {}) =>
  buildRetrospective({
    jobs: [
      { id: `oj-${n}`, status: 'FAILED', failureKind: 'no-finish', costUsd: 0.3, turns: 3, repoPath: '/r/p', createdAt: AFTER, ...extra },
    ],
    health: {},
    nowMs: Date.parse(AFTER),
    maintainerRoot: '/opt/offload',
  });

test('the history is one bounded, private, rotating file that holds the digest and never the skeleton or the brief', () => {
  const dir = tempDir('offload-retro-');
  try {
    const log = createRetrospectiveLog({ dir });
    assert.equal(log.path, join(dir, RETROSPECTIVE_FILE));
    assert.deepEqual(log.history().records, [], 'no file yet is an empty history');
    log.append(record(1, { task: 'a private brief' }));
    log.append(record(2));
    const text = readFileSync(log.path, 'utf8');
    assert.equal(text.trim().split('\n').length, 2);
    assert.ok(!text.includes('maintainerPromptSkeleton') && !text.includes('a private brief') && !text.includes('/opt/offload'));
    assert.equal(statSync(log.path).mode & 0o777, 0o600);
    const history = log.history();
    assert.deepEqual(
      history.records.map((entry) => entry.jobs[0].id),
      ['oj-1', 'oj-2'],
    );
    assert.deepEqual(
      history.aggregate.signals.map((signal) => [signal.code, signal.retrospectives]),
      [
        ['protocol-failure-finish', 2],
        ['wasted-spend-on-failed-job', 2],
      ],
    );
    assert.deepEqual(
      log.history({ limit: 1 }).records.map((entry) => entry.jobs[0].id),
      ['oj-2'],
    );
  } finally {
    cleanup(dir);
  }
});

test('the history rotates once at its size cap, so disk use is bounded however many digests are recorded', () => {
  const dir = tempDir('offload-retro-');
  try {
    const limits = { ...RETROSPECTIVE_LOG_LIMITS, maxBytes: 6 * 1024 };
    const log = createRetrospectiveLog({ dir, limits });
    for (let n = 0; n < 60; n += 1) log.append(record(n));
    const live = statSync(log.path).size,
      rotated = statSync(`${log.path}.1`).size;
    assert.ok(live <= limits.maxBytes && rotated <= limits.maxBytes, `${live} and ${rotated} bytes`);
    assert.ok(existsSync(`${log.path}.1`));
    assert.ok(!existsSync(`${log.path}.2`), 'one generation only');
    const ids = log.history({ limit: 1000 }).records.map((entry) => Number(entry.jobs[0].id.slice(3)));
    assert.equal(ids.at(-1), 59, 'the newest is kept');
    assert.ok(ids.length < 60 && ids.length > 2, 'the oldest were dropped');
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
      'oldest first, across the rotation',
    );
  } finally {
    cleanup(dir);
  }
});

test('the history refuses a symlink, skips foreign or tampered lines, re-redacts what it reads, and is off with OFFLOAD_LOG=off', () => {
  const dir = tempDir('offload-retro-');
  try {
    const target = join(dir, 'elsewhere.txt');
    writeFileSync(target, 'untouched\n');
    const linked = createRetrospectiveLog({ dir });
    symlinkSync(target, linked.path);
    linked.append(record(1));
    assert.equal(readFileSync(target, 'utf8'), 'untouched\n', 'a symlinked history is never written through');
    assert.deepEqual(linked.history().records, [], 'nor read');
    assert.ok(lstatSync(linked.path).isSymbolicLink());

    const clean = tempDir('offload-retro-');
    try {
      const log = createRetrospectiveLog({ dir: clean });
      log.append(record(7));
      const good = JSON.parse(readFileSync(log.path, 'utf8'));
      const tampered = { ...good, reasons: ['token=hunter2hunter2 in /Users/jane.doe/work'], extra: 'dropped' };
      writeFileSync(log.path, ['not json', '{"v":9}', JSON.stringify(tampered), '[1]', ''].join('\n'));
      chmodSync(log.path, 0o600);
      const [only, ...rest] = log.history().records;
      assert.equal(rest.length, 0);
      assert.ok(!JSON.stringify(only).includes('hunter2hunter2') && !JSON.stringify(only).includes('jane.doe'));
      assert.equal(only.extra, undefined);

      const off = createRetrospectiveLog({ dir: join(clean, 'off'), env: { OFFLOAD_LOG: 'off' } });
      off.append(record(8));
      assert.equal(off.path, null);
      assert.equal(existsSync(join(clean, 'off')), false);
    } finally {
      cleanup(clean);
    }
    // A directory that cannot be created never throws into the caller.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'a file where a directory should be');
    createRetrospectiveLog({ dir: join(blocked, 'sub') }).append(record(9));
    mkdirSync(join(dir, 'ok'), { recursive: true });
  } finally {
    cleanup(dir);
  }
});
