import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from '../../src/job-manager.mjs';
import { JobStore } from '../../src/store.mjs';
import { LeaseManager } from '../../src/lease.mjs';
import { AgentLoop } from '../../src/agent/loop.mjs';
import { AnthropicMessagesProvider } from '../../src/provider/anthropic-messages.mjs';

const model = 'claude-opus-5-5';
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

for (const stop of ['local cancel', 'peer cancel', 'attempt deadline', 'round deadline', 'loop deadline']) {
  test(`hung Opus stream: ${stop} ends the job and releases its real lease`, async (t) => {
    const gitDir = await mkdtemp(join(tmpdir(), 'offload-provider-lifecycle-'));
    const store = new JobStore({ gitDir });
    const leases = new LeaseManager({ gitDir });
    let started,
      armStop,
      requestSignal,
      cancels = 0,
      requests = 0,
      watchdogMs;
    const requestStarted = new Promise((resolve) => (started = resolve));
    const stopArmed = new Promise((resolve) => (armStop = resolve));
    const realSetTimeout = globalThis.setTimeout;
    if (stop === 'attempt deadline' || stop === 'loop deadline') {
      // Advance only this deadline, after the request starts. Slow setup must
      // not turn a pending-request regression into a pre-launch timeout.
      const limit = stop === 'attempt deadline' ? 30_000 : 60_000;
      t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) =>
        ms === limit ? realSetTimeout(() => stopArmed.then(() => fn(...args)), 20) : realSetTimeout(fn, ms, ...args),
      );
    }
    const provider = new AnthropicMessagesProvider({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      model,
      timeoutMs: stop === 'attempt deadline' ? 30_000 : 300_000,
      retries: 0,
      fetchImpl: async (_url, { signal }) => {
        requests++;
        requestSignal = signal;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"ping"}\n\n'));
          },
          // No abort listener: this stream keeps reading forever unless the
          // adapter cancels the reader. Even cancellation itself never settles.
          cancel() {
            cancels++;
            return new Promise(() => {});
          },
        });
        started();
        return new Response(body);
      },
    });
    const manager = new JobManager({
      store,
      leases,
      worker: {
        run: async (_job, { signal, progress }) =>
          new AgentLoop({
            provider,
            model,
            tools: { execute: async () => assert.fail('no incomplete response may execute tools') },
            signal,
            progress,
            timeoutMs: 60_000,
          }).run({ task: 'wait for a provider response' }),
      },
      snapshots: { create: async () => 'a'.repeat(40), diff: async () => '', files: async () => [] },
      setTimeoutFn: (fn, ms) => {
        watchdogMs = ms;
        return stop === 'round deadline' ? realSetTimeout(() => stopArmed.then(fn), 30) : realSetTimeout(fn, ms);
      },
      config: {
        repoPath: process.cwd(),
        git: { branch: async () => 'main', head: async () => 'a'.repeat(40) },
      },
    });
    try {
      const job = await manager.start({
        repoPath: process.cwd(),
        task: 'hung provider regression',
        ownedPaths: ['src/**'],
        budget: { timeoutMinutes: 1 },
      });
      await requestStarted;
      await flush();
      assert.equal(leases.list().length, 1);
      const begin = performance.now();
      armStop();
      if (stop.endsWith('cancel')) {
        const caller = stop === 'peer cancel' ? new JobManager({ store, config: { repoPath: process.cwd() } }) : manager;
        await caller.cancel(job.jobId);
      }
      const done = await manager.wait(job.jobId, { timeoutSec: 5 });
      assert.equal(done.status, stop.endsWith('cancel') ? 'CANCELLED' : 'TIMEOUT');
      assert.ok(performance.now() - begin < 3_000, 'no wait for transport or cleanup promises');
      assert.equal(requestSignal.aborted, true);
      assert.equal(cancels, 1);
      assert.equal(requests, 1);
      assert.equal(leases.list().length, 0, 'ownedPaths is available before wait reports done');
      if (stop === 'attempt deadline')
        assert.deepEqual(done.providerFailure, { kind: 'attempt_timeout', retryable: true, attempts: 1, timeoutMs: 30_000 });
      else assert.equal(done.providerFailure, undefined, 'outer deadlines and cancels retain their classification');
      if (stop === 'round deadline') assert.ok(watchdogMs <= 60_000 && watchdogMs > 59_000, `deadline ${watchdogMs}`);
      if (stop.endsWith('cancel')) assert.match(await store.readArtifact(job.jobId, 'events.jsonl'), /cancel_requested/);
    } finally {
      await manager.shutdown();
      await rm(gitDir, { recursive: true, force: true });
    }
  });
}
