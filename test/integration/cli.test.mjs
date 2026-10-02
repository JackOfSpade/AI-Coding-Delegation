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
