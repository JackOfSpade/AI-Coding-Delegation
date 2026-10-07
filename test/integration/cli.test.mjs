import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { parseArgs, runCli, spawnDetachedWorker } from '../../src/cli.mjs';
function sink() {
  let text = '';
  return {
    stream: new Writable({
      write(c, _, cb) {
        text += c;
        cb();
      },
    }),
    get: () => text,
  };
}
test('CLI validates and forwards start arguments', async () => {
  const out = sink(),
    err = sink();
  let input;
  const status = await runCli(['start', '--task', 'x', '--ownedPaths', '["src/**"]'], {
    core: { start: async (v) => (input = v), job: async () => ({}) },
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(status, 0);
  assert.deepEqual(input.ownedPaths, ['src/**']);
  assert.match(out.get(), /"task": "x"/);
  assert.equal(
    await runCli(['start', '--task', 'x'], {
      core: {
        start: async () => {
          throw new Error('bad');
        },
      },
      stdout: out.stream,
      stderr: err.stream,
    }),
    2,
  );
});
test('CLI accepts explicit report mode without owned paths and rejects report inputs on write jobs', async () => {
  const out = sink(),
    err = sink();
  let input;
  const status = await runCli(['start', '--mode', 'report', '--task', 'analyze', '--inputFiles', '["/tmp/result.json"]'], {
    core: { start: async (value) => (input = value), job: async () => ({}) },
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(status, 0);
  assert.equal(input.mode, 'report');
  assert.equal(input.ownedPaths, undefined);
  assert.deepEqual(input.inputFiles, ['/tmp/result.json']);
  assert.equal(
    await runCli(['start', '--task', 'write', '--ownedPaths', '["src/**"]', '--inputFiles', '["/tmp/result.json"]'], {
      core: {},
      stdout: out.stream,
      stderr: err.stream,
    }),
    2,
  );
  assert.match(err.get(), /inputFiles/);
});
test('CLI rejects report text that repeats a raw external input reference before invoking Core', async () => {
  const out = sink(),
    err = sink();
  let started = false;
  const sensitiveInput = '/tmp/customer-秘密-export.json';
  const status = await runCli(
    ['start', '--mode', 'report', '--task', `review ${sensitiveInput}`, '--inputFiles', JSON.stringify([sensitiveInput])],
    {
      core: {
        start: async () => {
          started = true;
        },
      },
      stdout: out.stream,
      stderr: err.stream,
    },
  );
  assert.equal(status, 2);
  assert.equal(started, false);
  assert.match(err.get(), /use input ordinals or generic private paths/);
});
test('CLI parses budget and bare booleans', async () => {
  const out = sink(),
    err = sink();
  let seen;
  await runCli(
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--maxUsd', '1.5', '--maxTurns', '3', '--timeoutMinutes', '2', '--allowNetwork'],
    { core: { start: async (value) => (seen = value) }, stdout: out.stream, stderr: err.stream },
  );
  assert.deepEqual(seen.budget, { maxUsd: 1.5, maxTurns: 3, timeoutMinutes: 2 });
  assert.equal(seen.allowNetwork, true);
});
test('CLI exposes explicit policy-only verifier consent with its canonical flag', async () => {
  const out = sink(),
    err = sink();
  let seen;
  const status = await runCli(
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--testCommand', 'npm test', '--unsafe-policy-only-verifier'],
    { core: { start: async (value) => (seen = value) }, stdout: out.stream, stderr: err.stream },
  );
  assert.equal(status, 0);
  assert.equal(seen.unsafePolicyOnlyVerifier, true);
});
test('CLI preserves equals signs in inline values and supports -- end of options', () => {
  assert.deepEqual(parseArgs(['start', '--task=a=b=c', '--', '--task-like', 'text']), {
    command: 'start',
    positionals: ['--task-like', 'text'],
    flags: { task: 'a=b=c' },
  });
});
test('CLI bare booleans never consume following positional input', () => {
  assert.deepEqual(parseArgs(['start', '--foreground', 'task']), { command: 'start', positionals: ['task'], flags: { foreground: true } });
  assert.deepEqual(parseArgs(['revert', '--apply', 'job']), { command: 'revert', positionals: ['job'], flags: { apply: true } });
});
test('CLI rejects unknown, duplicate, and incompatible options before calling any command family', async () => {
  const cases = [
    [['mcp', '--misspelled']],
    [['doctor', '--maxUSD', '1']],
    [['worker', 'job', 'extra']],
    [['start', '--task', 'x', '--testComand', 'npm test']],
    [['wait', 'job', '--timeoutSecs', '1']],
    [['job', 'one', 'two']],
    [['repair', 'job', '--defect', '[]']],
    [['revert', 'job', '--aply']],
    [['cancel', 'job', '--repo']],
  ];
  for (const [argv] of cases) {
    const out = sink(),
      err = sink();
    const code = await runCli(argv, { core: {}, stdout: out.stream, stderr: err.stream });
    assert.equal(code, 2, argv.join(' '));
    assert.equal(out.get(), '');
    assert.match(err.get(), /unknown option|does not accept|requires exactly|at most/);
  }
  const out = sink(),
    err = sink();
  const duplicate = await runCli(['start', '--task', 'first', '--task', 'second'], { core: {}, stdout: out.stream, stderr: err.stream });
  assert.equal(duplicate, 2);
  assert.match(err.get(), /duplicate option --task/);
});
test('CLI preserves positional start task text but rejects an ambiguous mix with --task', async () => {
  const out = sink(),
    err = sink();
  let input;
  const code = await runCli(['start', '--ownedPaths', '["src/**"]', '--', '--task-like', 'text'], {
    core: { start: async (value) => (input = value) },
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(code, 0);
  assert.equal(input.task, '--task-like text');
  const ambiguous = await runCli(['start', '--task', 'flag task', 'positional task'], {
    core: {},
    stdout: sink().stream,
    stderr: err.stream,
  });
  assert.equal(ambiguous, 2);
  assert.match(err.get(), /either --task or positional/);
});
test('CLI validates boolean/value syntax and coupled safety options before any core call', async () => {
  const invalid = [
    ['revert', 'job', '--apply', 'typo'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--allowNetwork', 'typo'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--maxUsd'],
    ['wait', 'job', '--timeoutSec', 'NaN'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--maxTurns', '1.5'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--maxRepairRounds', 'NaN'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--maxUsd', '-1'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--maxUsd', '10000.01'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--maxTurns', '0'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--maxTurns', '1001'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--timeoutMinutes', '0'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--timeoutMinutes', '1441'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--maxRepairRounds', '-1'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--maxRepairRounds', '5'],
    ['doctor', '--maxUsd', '0.01'],
    ['doctor', '--live', '--maxUsd', '0'],
    ['doctor', '--live', '--maxUsd', '0.021'],
    ['doctor', '--live', '--hook'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--budget', '{}', '--maxUsd', '1'],
    ['job', '--include', 'diff'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--maxUsd', '0x10'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--maxUsd', ' 1'],
    ['revert', '--apply', 'false'],
  ];
  for (const argv of invalid) {
    const out = sink(),
      err = sink();
    let calls = 0;
    const core = new Proxy(
      {},
      {
        get() {
          calls++;
          throw new Error('core must not be called');
        },
      },
    );
    const code = await runCli(argv, { core, stdout: out.stream, stderr: err.stream });
    assert.equal(code, 2, argv.join(' '));
    assert.equal(calls, 0);
    assert.equal(out.get(), '');
    assert.match(err.get(), /option|requires|cannot be combined|accepts either/);
  }
  assert.deepEqual(parseArgs(['revert', 'job', '--apply=false']).flags, { apply: 'false' });
  assert.deepEqual(parseArgs(['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--allowNetwork=true']).flags.allowNetwork, 'true');
});
test('CLI rejects decodable invalid requests before constructing Core', async () => {
  const invalid = [
    ['start', '--ownedPaths', '["src/**"]'],
    ['start', '--task', 'x', '--ownedPaths', 'not-json'],
    ['start', '--task', 'x', '--ownedPaths', '[]'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--budget', '{"maxUSd":1}'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--extraWritable', '["src/**"]'],
    ['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--repoPath', 'relative-repo'],
    ['repair', 'not/a-job', '--defects', '["fix"]'],
    ['repair', 'job', '--defects', '[]'],
    ['worker', 'job'],
    ['job', 'job', '--include', 'everything'],
    ['wait', 'not/a-job'],
    ['job', '--repoPath', ''],
    ['wait', 'a'.repeat(129)],
    ['doctor', '--live'],
    ['mcp', '--__proto__'],
  ];
  for (const argv of invalid) {
    const out = sink(),
      err = sink();
    let constructions = 0;
    const code = await runCli(argv, {
      createCore: () => {
        constructions += 1;
        throw new Error('must not construct Core');
      },
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.equal(code, 2, argv.join(' '));
    assert.equal(constructions, 0, argv.join(' '));
    assert.equal(out.get(), '');
    assert.match(err.get(), /offload:/);
  }
});
test('CLI accepts exact start and live-doctor numeric boundaries', async () => {
  const out = sink(),
    err = sink();
  let start;
  const code = await runCli(
    [
      'start',
      '--task',
      'x',
      '--ownedPaths',
      '["src/**"]',
      '--maxUsd',
      '0',
      '--maxTurns',
      '1000',
      '--timeoutMinutes',
      '1440',
      '--maxRepairRounds',
      '4',
    ],
    { core: { start: async (value) => (start = value) }, stdout: out.stream, stderr: err.stream },
  );
  assert.equal(code, 0);
  assert.deepEqual(start.budget, { maxUsd: 0, maxTurns: 1000, timeoutMinutes: 1440 });
  assert.equal(start.maxRepairRounds, 4);
  const low = sink(),
    high = sink(),
    seen = [];
  for (const amount of ['0.000001', '0.02']) {
    const result = await runCli(['doctor', '--live', '--maxUsd', amount], {
      core: {},
      doctorLive: async (value) => {
        seen.push(value);
        return { live: true };
      },
      stdout: low.stream,
      stderr: high.stream,
    });
    assert.equal(result, 0);
  }
  assert.deepEqual(
    seen.map((value) => value.maxUsd),
    [0.000001, 0.02],
  );
  assert.equal(high.get(), '');
});
test('detached worker receives only a job locator while retaining trusted provider environment', async () => {
  let call;
  const child = { pid: 4321, unref() {} };
  await spawnDetachedWorker({
    jobId: 'oj-safe',
    repoPath: '/repo',
    env: { HOME: '/home/test', PATH: '/bin', DEEPSEEK_API_KEY: 'secret', OTHER_TOKEN: 'also-secret' },
    spawnProcess: (...args) => ((call = args), child),
  });
  assert.equal(call[1][1], 'worker');
  assert.equal(call[1][2], 'oj-safe');
  assert.equal(call[1].includes('secret'), false);
  assert.equal(call[2].env.DEEPSEEK_API_KEY, 'secret');
  assert.equal(call[2].env.OTHER_TOKEN, 'also-secret');
});
test('detached worker waits for a valid spawn lifecycle before unrefing', async () => {
  const failing = new EventEmitter();
  failing.pid = undefined;
  failing.unref = () => {
    throw new Error('must not unref a failed spawn');
  };
  const pending = spawnDetachedWorker({ jobId: 'oj-safe', repoPath: '/repo', spawnProcess: () => failing });
  queueMicrotask(() => failing.emit('error', new Error('spawn denied')));
  await assert.rejects(pending, /spawn denied/);

  const ready = new EventEmitter();
  ready.pid = 9876;
  let unrefs = 0;
  ready.unref = () => {
    unrefs++;
  };
  const launched = spawnDetachedWorker({ jobId: 'oj-safe', repoPath: '/repo', spawnProcess: () => ready });
  assert.equal(unrefs, 0);
  queueMicrotask(() => ready.emit('spawn'));
  assert.equal((await launched).pid, 9876);
  assert.equal(unrefs, 1);
});
test('CLI reports Core construction failures safely', async () => {
  const out = sink(),
    err = sink();
  const status = await runCli(['doctor'], {
    createCore: () => {
      throw new Error('API_KEY=not-for-output');
    },
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(status, 2);
  assert.equal(out.get(), '');
  assert.doesNotMatch(err.get(), /not-for-output/);
});
test('CLI errors remove terminal controls and credential-shaped text', async () => {
  const out = sink(),
    err = sink();
  const status = await runCli(['start', '--task', 'x', '--ownedPaths', '["src/**"]'], {
    core: {
      start: async () => {
        throw new Error('\u001b]8;;https://bad\u0007Bearer abc-secret\r\nnope');
      },
    },
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(status, 2);
  assert.doesNotMatch(err.get(), /abc-secret|\u001b|\r|\nnope/);
  assert.match(err.get(), /Bearer \[REDACTED\]/);
});
test('ordinary doctor shuts down only the core it created', async () => {
  const out = sink(),
    err = sink();
  let shutdowns = 0;
  const status = await runCli(['doctor'], {
    createCore: () => ({
      job: async () => ({ health: {} }),
      shutdown: async ({ timeoutMs }) => {
        shutdowns++;
        assert.equal(timeoutMs, 5_000);
      },
    }),
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(status, 0);
  assert.equal(shutdowns, 1);
  assert.equal(err.get(), '');
  let injectedShutdowns = 0;
  await runCli(['doctor'], {
    core: {
      job: async () => ({ health: {} }),
      shutdown: async () => {
        injectedShutdowns++;
      },
    },
    stdout: sink().stream,
    stderr: sink().stream,
  });
  assert.equal(injectedShutdowns, 0);
});
test('CLI maps the verifier options, and omits them entirely when absent', async () => {
  let seen;
  const run = (extra) =>
    runCli(['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--testCommand', 'node --test', ...extra], {
      core: { start: async (value) => (seen = value) },
      stdout: sink().stream,
      stderr: sink().stream,
    });
  assert.equal(await run(['--verifierMode', 'baseline-diff', '--verifierTimeoutSec', '120']), 0);
  assert.equal(seen.verifierMode, 'baseline-diff');
  assert.equal(seen.verifierTimeoutSec, 120);
  assert.equal(await run([]), 0);
  assert.equal(Object.hasOwn(seen, 'verifierMode'), false);
  assert.equal(Object.hasOwn(seen, 'verifierTimeoutSec'), false);
});
test('CLI maps --turnPolicy into the budget and rejects a bad value or a --budget conflict before any core call', async () => {
  let seen;
  const run = (extra, core = { start: async (value) => (seen = value) }, err = sink()) =>
    runCli(['start', '--task', 'x', '--ownedPaths', '["src/**"]', ...extra], { core, stdout: sink().stream, stderr: err.stream });
  assert.equal(await run(['--turnPolicy', 'auto']), 0);
  assert.deepEqual(seen.budget, { turnPolicy: 'auto' });
  assert.equal(await run(['--turnPolicy', 'fixed', '--maxTurns', '30', '--maxUsd', '2']), 0);
  assert.deepEqual(seen.budget, { maxUsd: 2, maxTurns: 30, turnPolicy: 'fixed' });
  assert.equal(await run([]), 0);
  assert.equal(seen.budget, undefined);
  const never = new Proxy(
    {},
    {
      get() {
        throw new Error('core must not be called');
      },
    },
  );
  for (const [flags, message] of [
    [['--turnPolicy', 'x'], /turnPolicy must be auto or fixed/],
    [['--budget', '{"maxUsd":1}', '--turnPolicy', 'auto'], /cannot be combined with individual budget options/],
  ]) {
    const err = sink();
    assert.equal(await run(flags, never, err), 2, flags.join(' '));
    assert.match(err.get(), message);
  }
});
test('doctor output carries the verifier temp probe from core health', async () => {
  const out = sink();
  const verifierTmp = { status: 'writable', reason: 'per-run-tmpdir-writable', systemTmp: 'denied', gitInit: 'ok', note: 'n' };
  const status = await runCli(['doctor'], {
    core: { job: async () => ({ health: { worker: true, sandbox: 'macos', verifierTmp } }) },
    stdout: out.stream,
    stderr: sink().stream,
  });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(out.get()).verifierTmp, verifierTmp);
});
test('CLI rejects invalid verifier options before any core call', async () => {
  const cases = [
    [['--verifierTimeoutSec', 'abc'], /verifierTimeoutSec must be an integer from 5 to 1800/],
    [['--verifierTimeoutSec', '4'], /verifierTimeoutSec must be an integer from 5 to 1800/],
    [['--verifierTimeoutSec', '1801'], /verifierTimeoutSec must be an integer from 5 to 1800/],
    [['--verifierTimeoutSec', '60.5'], /verifierTimeoutSec must be an integer from 5 to 1800/],
    [['--verifierMode', 'bogus'], /verifierMode must be standard or baseline-diff/],
    [['--verifierMode', 'baseline-diff', '--unsafe-policy-only-verifier'], /cannot use unsafePolicyOnlyVerifier/],
  ];
  for (const [flags, message] of cases) {
    const err = sink();
    let calls = 0;
    const status = await runCli(['start', '--task', 'x', '--ownedPaths', '["src/**"]', '--testCommand', 'true', ...flags], {
      core: new Proxy(
        {},
        {
          get() {
            calls += 1;
            throw new Error('core must not be called');
          },
        },
      ),
      stdout: sink().stream,
      stderr: err.stream,
    });
    assert.equal(status, 2, flags.join(' '));
    assert.equal(calls, 0);
    assert.match(err.get(), message);
  }
});
test('CLI forwards a validated log window as numbers and rejects a bad one before any core call', async () => {
  const seen = [];
  const core = { job: async (...value) => (seen.push(value), {}) };
  const ok = await runCli(['job', 'job1', '--include', 'log', '--tail', '5', '--limit', '3000'], {
    core,
    stdout: sink().stream,
    stderr: sink().stream,
  });
  assert.equal(ok, 0);
  assert.deepEqual(seen[0], ['job1', { include: 'log', tail: 5, limit: 3000, detail: 'full', repoPath: undefined }]);
  const bare = await runCli(['job', 'job1', '--include', 'log'], { core, stdout: sink().stream, stderr: sink().stream });
  assert.equal(bare, 0);
  assert.deepEqual(Object.keys(seen[1][1]).sort(), ['detail', 'include', 'repoPath'], 'no window flags, none forwarded');
  const zero = await runCli(['job', 'job1', '--include', 'log', '--tail', '0'], { core, stdout: sink().stream, stderr: sink().stream });
  assert.equal(zero, 0);
  assert.equal(seen[2][1].tail, 0);
  assert.equal(seen.length, 3);

  const bad = [
    [['job', 'job1', '--tail', '5'], /job --tail\/--limit require --include log/],
    [['job', 'job1', '--include', 'diff', '--limit', '3000'], /job --tail\/--limit require --include log/],
    [['job', 'job1', '--include', 'log', '--tail', 'abc'], /tail must be an integer from 0 to 1000/],
    [['job', 'job1', '--include', 'log', '--tail', '1001'], /tail must be an integer from 0 to 1000/],
    [['job', 'job1', '--include', 'log', '--tail', '1.5'], /tail must be an integer from 0 to 1000/],
    [['job', 'job1', '--include', 'log', '--limit', '10'], /limit must be an integer from 2000 to 60000/],
    [['job', 'job1', '--include', 'log', '--limit', '60001'], /limit must be an integer from 2000 to 60000/],
    [['job', '--include', 'log', '--tail', '5'], /job --include requires a job id/],
  ];
  for (const [argv, message] of bad) {
    const err = sink();
    const code = await runCli(argv, { core, stdout: sink().stream, stderr: err.stream });
    assert.equal(code, 2, argv.join(' '));
    assert.match(err.get(), message, argv.join(' '));
  }
  assert.equal(seen.length, 3, 'a rejected request never reaches core');
});
test('CLI lists every job by default, forwards --all and --maxJobs, and rejects misuse before any core call', async () => {
  assert.deepEqual(parseArgs(['job', '--all']), { command: 'job', positionals: [], flags: { all: true } });
  assert.deepEqual(parseArgs(['job', '--maxJobs', '5']).flags, { maxJobs: '5' });
  const seen = [];
  const core = { job: async (...value) => (seen.push(value), {}) };
  const run = (argv) => runCli(argv, { core, stdout: sink().stream, stderr: sink().stream });
  assert.equal(await run(['job']), 0);
  // A fresh CLI process has no "session", so the terminal list is complete unless asked otherwise.
  assert.deepEqual(seen[0], [undefined, { include: undefined, detail: 'full', all: true, repoPath: process.cwd() }]);
  assert.equal(await run(['job', '--all=false']), 0);
  assert.equal(seen[1][1].all, false);
  assert.equal(await run(['job', '--maxJobs', '7']), 0);
  assert.equal(seen[2][1].maxJobs, 7);
  assert.equal(seen[2][1].all, true);
  assert.equal(await run(['job', 'job1']), 0);
  assert.deepEqual(Object.keys(seen[3][1]).sort(), ['detail', 'include', 'repoPath'], 'a single-job read forwards no list option');
  assert.equal(seen.length, 4);
  const bad = [
    [['job', 'job1', '--all'], /job --all and --maxJobs apply only to the job list/],
    [['job', 'job1', '--maxJobs', '5'], /job --all and --maxJobs apply only to the job list/],
    [['job', '--maxJobs', '0'], /maxJobs/],
    [['job', '--maxJobs', '101'], /maxJobs/],
    [['job', '--maxJobs', 'abc'], /maxJobs/],
    [['job', '--maxJobs', '1.5'], /maxJobs/],
    [['job', '--all', 'false'], /boolean text/],
  ];
  for (const [argv, message] of bad) {
    const err = sink();
    const code = await runCli(argv, { core, stdout: sink().stream, stderr: err.stream });
    assert.equal(code, 2, argv.join(' '));
    assert.match(err.get(), message, argv.join(' '));
  }
  assert.equal(seen.length, 4, 'a rejected request never reaches core');
});

test('CLI retrospective reads the newest jobs or the named ones, prints the digest then the skeleton, and records nothing itself', async () => {
  const seen = [];
  const digest = {
    v: 1,
    totals: { jobs: 2 },
    maintainerPromptWarranted: true,
    maintainerPromptSkeleton: 'Improve Offload based on one real session',
  };
  const core = {
    retrospective: async (options) => (seen.push(['digest', options]), digest),
    retrospectiveHistory: async (options) => (
      seen.push(['history', options]),
      { path: '/state/retrospectives.jsonl', records: [{ v: 1 }], aggregate: { retrospectives: 1, warranted: 1, signals: [] } }
    ),
  };
  const run = async (argv) => {
    const out = sink(),
      err = sink();
    const code = await runCli(argv, { core, stdout: out.stream, stderr: err.stream });
    return { code, out: out.get(), err: err.get() };
  };
  const newest = await run(['retrospective']);
  assert.equal(newest.code, 0, newest.err);
  // A fresh CLI process has no session, so it reads the newest jobs of the working repository, and never persists.
  assert.deepEqual(seen[0], ['digest', { last: 5, repoPath: process.cwd(), persist: false }]);
  const [json, skeleton] = newest.out.split('\n\n--- maintainer prompt skeleton (edit before pasting) ---\n');
  assert.deepEqual(JSON.parse(json), { v: 1, totals: { jobs: 2 }, maintainerPromptWarranted: true });
  assert.equal(skeleton, 'Improve Offload based on one real session\n');
  assert.equal((await run(['retrospective', '--last', '3', '--repoPath', '/repo'])).code, 0);
  assert.deepEqual(seen[1], ['digest', { last: 3, repoPath: '/repo', persist: false }]);
  assert.equal((await run(['retrospective', '--jobs', 'oj-1,oj-2'])).code, 0);
  assert.deepEqual(seen[2], ['digest', { jobIds: ['oj-1', 'oj-2'], repoPath: process.cwd(), persist: false }]);

  const list = await run(['retrospective', 'list', '--last', '20']);
  assert.deepEqual(JSON.parse(list.out), { path: '/state/retrospectives.jsonl', retrospectives: 1, warranted: 1, signals: [] });
  assert.deepEqual(seen[3], ['history', { limit: 20 }]);
  assert.deepEqual(JSON.parse((await run(['retrospective', 'export'])).out), { path: '/state/retrospectives.jsonl', records: [{ v: 1 }] });
  assert.deepEqual(seen[4], ['history', {}]);

  const bad = [
    [['retrospective', 'dump'], /retrospective accepts only list or export/],
    [['retrospective', 'list', 'export'], /accepts at most one argument/],
    [['retrospective', '--jobs', 'oj-1', '--last', '2'], /--jobs cannot be combined/],
    [['retrospective', 'list', '--jobs', 'oj-1'], /--jobs cannot be combined/],
    [['retrospective', '--jobs', 'oj-1,oj-1'], /distinct valid job ids/],
    [['retrospective', '--jobs', 'bad id'], /distinct valid job ids/],
    [['retrospective', '--jobs', Array.from({ length: 17 }, (_, index) => `oj-${index}`).join(',')], /distinct valid job ids/],
    [['retrospective', '--last', '0'], /--last/],
    [['retrospective', '--last', '17'], /--last/],
    [['retrospective', 'list', '--last', '1001'], /--last/],
    [['retrospective', 'list', '--repoPath', '/repo'], /takes no --repoPath/],
    [['retrospective', '--bogus', '1'], /unknown option --bogus for retrospective/],
    [['job', 'oj-1', '--include', 'retrospective'], /job --include must be/],
  ];
  for (const [argv, message] of bad) {
    const result = await run(argv);
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.err, message, argv.join(' '));
  }
  assert.equal(seen.length, 5, 'a rejected request never reaches core');
});
