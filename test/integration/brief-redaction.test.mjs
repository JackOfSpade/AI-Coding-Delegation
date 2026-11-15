import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { JobStore } from '../../src/store.mjs';
import { JobManager } from '../../src/job-manager.mjs';
import { gitSnapshots } from '../../src/core.mjs';
import { cleanup, git, makeRepo } from '../unit/helpers.mjs';

const TERMINAL_WAIT_SEC = 55;
const FLASH = { type: 'openai-chat', baseUrl: 'https://api.deepseek.com', keyRef: 'env:deepseek', model: 'deepseek-flash' };

// The real JobManager over the real JobStore, with a scripted worker standing in
// for the provider loop: `run(job)` is where the production worker builds its
// first user message from `job.task` and `job.acceptanceCriteria`, so what it
// sees here is what the provider request carries.
const start = async ({ task, acceptanceCriteria }) => {
  const repo = makeRepo();
  const received = [];
  const manager = new JobManager({
    store: new JobStore({ gitDir: await mkdtemp(`${tmpdir()}/offload-jobs-`) }),
    snapshots: gitSnapshots(),
    worker: {
      run: async (job) => {
        received.push({ task: job.task, acceptanceCriteria: job.acceptanceCriteria });
        return { status: 'DONE', summary: 'done', turns: 1, costUsd: 0.01 };
      },
    },
    runner: { verify: async (command) => ({ command, verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
    config: {
      repoPath: repo,
      git: { branch: async (path) => git(path, ['branch', '--show-current']), head: async (path) => git(path, ['rev-parse', 'HEAD']) },
    },
  });
  const started = await manager.start({
    task,
    ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
    ownedPaths: ['src/**'],
    testCommand: 'verify',
    executionProfile: FLASH,
    repoPath: repo,
    budget: { maxTurns: 8, maxUsd: 1, timeoutMinutes: 10 },
  });
  await manager.wait(started.jobId, { timeoutSec: TERMINAL_WAIT_SEC });
  return { repo, received, started, stored: await manager.store.get(started.jobId) };
};

test('start reports brief redaction spans and warns when a header value was replaced', async () => {
  const run = await start({
    task: 'Send x-api-key: ak9f8d7s6a5q4w3e2r1t0zz, then the body {"id":1} and accept 201 or 204.',
    acceptanceCriteria: ['Use authorization: Basic dXNlcjpwYXNzd29yZA== for the check.'],
  });
  try {
    assert.deepEqual(run.started.briefRedaction, { spans: 2, task: 1, acceptanceCriteria: 1 });
    assert.deepEqual(run.started.warnings, [
      'brief redaction: 2 span(s) of the task brief were replaced with [REDACTED] before the worker saw them (task 1, acceptanceCriteria 1); ' +
        'if that text was not a real credential, offload_cancel this job and restart with the wording changed (for example write a placeholder such as <key>)',
    ]);
    assert.deepEqual(run.stored.briefRedaction, { spans: 2, task: 1, acceptanceCriteria: 1 }, 'the counts are durable');
    assert.deepEqual(run.received, [
      {
        task: 'Send x-api-key: [REDACTED], then the body {"id":1} and accept 201 or 204.',
        acceptanceCriteria: ['Use authorization: Basic [REDACTED] for the check.'],
      },
    ]);
  } finally {
    cleanup(run.repo);
  }
});

test('start carries neither brief redaction nor a warning when the brief uses a placeholder', async () => {
  const task = 'Send x-api-key: <key>, then the body {"id":1} and accept 201 or 204.';
  const run = await start({ task });
  try {
    assert.equal('briefRedaction' in run.started, false);
    assert.equal('warnings' in run.started, false);
    assert.equal('briefRedaction' in run.stored, false);
    assert.deepEqual(run.received, [{ task, acceptanceCriteria: undefined }]);
  } finally {
    cleanup(run.repo);
  }
});
