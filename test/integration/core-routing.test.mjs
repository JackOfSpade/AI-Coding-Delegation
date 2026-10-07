import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createCore,
  defaultIntegrityStatePath,
  insidePath,
  integrityStateHintAllowed,
  isolatedWorkspaceReadablePaths,
} from '../../src/core.mjs';
import { validateJobRequest } from '../../src/job-manager.mjs';
import { WINDOWS_INTEGRITY_ROOT_CREDENTIAL } from '../../src/integrity.mjs';
import { JobStore } from '../../src/store.mjs';
import { getGitDir } from '../../src/lease.mjs';
import {
  cleanupIsolatedWorktree,
  createIsolatedWorktree,
  integrateRecordedTree,
  openIsolatedWorktree,
  snapshotPrimaryWorkingTree,
} from '../../src/worktree.mjs';
import { sandboxAvailable } from '../../src/sandbox.mjs';
import { installedSkillHealth } from '../../src/skill-health.mjs';
import { createMockOpenAIServer } from '../mock-openai-server.mjs';

async function repo(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'config', 'user.email', 'offload@example.test']);
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Offload Test']);
  await writeFile(join(path, 'README.md'), 'base\n');
  execFileSync('git', ['-C', path, 'add', 'README.md']);
  execFileSync('git', ['-C', path, 'commit', '-qm', 'base']);
  return path;
}
// Keep this injected config valid under the persisted execution-profile
// contract: cleartext provider endpoints are only permitted for loopback
// integration mocks.
const loaded = {
  disabled: false,
  repoConfig: {},
  config: {
    default: 'test',
    profiles: { test: { provider: 'test', model: 'test-model' } },
    providers: { test: { type: 'openai-chat', keyRef: 'env:IGNORED', baseUrl: 'https://example.test' } },
    limits: { maxTurns: 2, timeoutMinutes: 1, maxUsd: 1 },
  },
};
// Health compares the client's installed skill with the server's: keep these cores
// off the developer's real ~/.claude, whose copy may legitimately be stale.
const noInstalledSkill = (options) => installedSkillHealth({ ...options, home: join(tmpdir(), 'offload-no-installed-skill'), env: {} });
function testCore() {
  return createCore({
    config: { loaded, skillHealth: noInstalledSkill },
    worker: { run: async () => ({ status: 'DONE', summary: 'ok' }) },
    runner: { verify: async (command) => ({ command, verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
}
function memoryWindowsIntegrityVault(values = new Map()) {
  return {
    read: (credential) => values.get(credential.resource),
    writeIfAbsent: (credential, value) => {
      if (values.has(credential.resource)) throw new Error('exists');
      values.set(credential.resource, value);
    },
  };
}
function integrityTestConfig({ loaded: loadedConfig = loaded, statePath, resolveKey, integrityVault } = {}) {
  if (process.platform !== 'win32') return { loaded: loadedConfig, integrityStatePath: statePath, resolveKey };
  return {
    loaded: loadedConfig,
    integrityPlatform: 'win32',
    integrityVault: integrityVault || memoryWindowsIntegrityVault(),
    resolveKey,
  };
}
test('Core rejects malformed raw starts before initializing durable state', async () => {
  let initialized = 0;
  const core = createCore({
    store: {
      init: async () => {
        initialized += 1;
      },
    },
  });
  await assert.rejects(() => core.start({ task: 'x', ownedPaths: [] }), /ownedPaths/);
  await assert.rejects(() => core.start({ task: 'x', ownedPaths: ['src/**'], inputFiles: ['/tmp/result.json'] }), /inputFiles/);
  assert.doesNotThrow(() => validateJobRequest({ task: 'report', mode: 'report' }));
  const sensitiveInput = '/tmp/customer-秘密-export.json';
  for (const request of [
    { task: `review ${sensitiveInput}`, inputFiles: [sensitiveInput] },
    { task: 'review input one', inputFiles: [sensitiveInput], acceptanceCriteria: ['summarize customer-秘密-export.json'] },
    { task: 'review input one', inputFiles: [sensitiveInput], relevantPaths: ['customer-秘密-export.json'] },
    { task: 'review input one', inputFiles: [sensitiveInput], denyRead: ['customer-秘密-export.json'] },
  ])
    assert.throws(
      () => validateJobRequest({ mode: 'report', ...request }),
      /use input ordinals or generic private paths/,
      'report request text must not retain a raw external input reference',
    );
  assert.doesNotThrow(() =>
    validateJobRequest({
      mode: 'report',
      task: 'review input 01',
      inputFiles: [sensitiveInput],
      acceptanceCriteria: ['summarize the private manifest input'],
      relevantPaths: ['.offload-report-inputs/input-01'],
    }),
  );
  assert.doesNotThrow(() => validateJobRequest({ mode: 'report', task: 'analyze data', inputFiles: ['/tmp/a'] }));
  await assert.rejects(
    () => core.start({ mode: 'report', task: `review ${sensitiveInput}`, inputFiles: [sensitiveInput] }),
    /use input ordinals or generic private paths/,
  );
  assert.doesNotThrow(() => validateJobRequest({ task: 'report', mode: 'report', extraWritable: [] }));
  assert.throws(() => validateJobRequest({ task: 'report', mode: 'report', extraWritable: ['tmp/**'] }), /writable paths/);
  assert.throws(() => validateJobRequest({ task: 'report', mode: 'report', extraWritable: null }), /writable paths/);
  await assert.rejects(() => core.start({ task: '', ownedPaths: ['src/**'] }), /task/);
  await assert.rejects(() => core.start({ task: 'x', ownedPaths: ['src/**'], budget: { maxUSd: 1 } }), /budget/);
  await assert.rejects(() => core.start({ task: 'x', ownedPaths: ['src/**'], repoPath: '' }), /repoPath/);
  await assert.rejects(() => core.start({ task: 'x', ownedPaths: ['src/**'], repoPaht: '/wrong-repository' }), /unknown property/);
  await assert.rejects(() => core.start(Object.assign(Object.create(null), { task: 'x', ownedPaths: ['src/**'] })), /plain object/);
  await assert.rejects(() => core.job(undefined, { repoPath: '' }), /repoPath/);
  // The log window is validated at the boundary, not silently dropped from a job list.
  await assert.rejects(() => core.job(undefined, { tail: 5 }), /tail and limit require a jobId/);
  await assert.rejects(() => core.job(undefined, { include: 'log', limit: 3000 }), /tail and limit require a jobId/);
  await assert.rejects(() => core.job(undefined, { tail: 99_999 }), /tail must be an integer from 0 to 1000/);
  await assert.rejects(() => core.job(undefined, { limit: 1 }), /limit must be an integer from 2000 to 60000/);
  await assert.rejects(() => core.wait('job', { repoPath: 'relative-repo' }), /repoPath/);
  for (const operation of [
    () => core.assignWorkerPid('', 1),
    () => core.failDetached('', undefined, new Error('spawn failed')),
    () => core.resume('x'.repeat(129)),
    () => core.runDetached(''),
    () => core.wait(''),
    () => core.job(null),
    () => core.repair('x'.repeat(129), ['fix']),
    () => core.cancel(''),
    () => core.revert('x'.repeat(129)),
  ])
    await assert.rejects(operation, /valid job id/);
  await assert.rejects(() => core.recover('relative-repo'), /repoPath/);
  assert.equal(initialized, 0);
});

test('Core refuses stale server or skill state before it creates a durable job', async () => {
  for (const [label, runtimeHealth, skillHealth, expected] of [
    [
      'server',
      () => ({ name: 'offload', stale: true, restartRequired: true, restartAction: 'Restart the MCP client.' }),
      () => ({ stale: false, state: 'current' }),
      /server runtime is STALE.*No job was created.*Restart the MCP client/i,
    ],
    [
      'skill',
      () => ({ name: 'offload', stale: false, restartRequired: false }),
      () => ({ stale: true, state: 'stale' }),
      /installed Offload skill is STALE.*No job was created.*node install\.mjs.*restart/i,
    ],
  ]) {
    let initialized = 0;
    const core = createCore({
      store: {
        init: async () => {
          initialized += 1;
        },
      },
      config: { loaded, runtimeHealth, skillHealth, enforceInstalledSkillPreflight: true },
    });
    await assert.rejects(() => core.start({ task: `stale ${label}`, ownedPaths: ['src/**'] }), expected);
    assert.equal(initialized, 0, `${label} preflight runs before the job store`);
    assert.equal(core.manager, undefined);
    await core.shutdown();
  }
});
test('Core grants command parent traversal only to an isolated workspace', () => {
  const workspace = '/private/var/folders/test/offload-worktree-1/workspace';
  assert.deepEqual(isolatedWorkspaceReadablePaths({ workspacePath: workspace }, workspace), [dirname(workspace)]);
  assert.deepEqual(isolatedWorkspaceReadablePaths({ workspacePath: workspace }, '/repo'), []);
  assert.deepEqual(isolatedWorkspaceReadablePaths({}, '/repo'), []);
  assert.deepEqual(isolatedWorkspaceReadablePaths({ workspacePath: 'relative-workspace' }, 'relative-workspace'), []);
});
test('Core grants an isolated worker command the linked primary node_modules as its only extra read root', async () => {
  const path = await repo('offload-core-deps-read-');
  await writeFile(join(path, '.gitignore'), 'node_modules/\n');
  await mkdir(join(path, 'node_modules', 'dep-pkg'), { recursive: true });
  await writeFile(join(path, 'node_modules', 'dep-pkg', 'index.js'), 'module.exports = 1;\n');
  const isolated = createIsolatedWorktree({ repoPath: path, baselineTree: snapshotPrimaryWorkingTree(path) });
  try {
    const job = { workspacePath: isolated.path, repoPath: path };
    const nodeModules = await realpath(join(path, 'node_modules'));
    assert.deepEqual(isolatedWorkspaceReadablePaths(job, isolated.path), [dirname(isolated.path), nodeModules]);
    // A job without its own repoPath, or pointing at a different checkout, gets no dependency root.
    assert.deepEqual(isolatedWorkspaceReadablePaths({ workspacePath: isolated.path }, isolated.path), [dirname(isolated.path)]);
    assert.deepEqual(isolatedWorkspaceReadablePaths({ ...job, repoPath: tmpdir() }, isolated.path), [dirname(isolated.path)]);
  } finally {
    isolated.cleanup();
    await rm(path, { recursive: true, force: true });
  }
});
test('Core rejects report input references introduced by merged repository denyRead policy', async () => {
  const path = await repo('offload-core-report-deny-reference-');
  const sensitiveInput = '/tmp/customer-秘密-export.json';
  const configured = { ...loaded, repoConfig: { denyRead: ['customer-秘密-export.json'] } };
  const core = createCore({
    config: { loaded: configured, resolveKey: () => 'credential' },
    worker: { run: async () => assert.fail('report worker must not launch') },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  try {
    await assert.rejects(
      () => core.start({ mode: 'report', task: 'review input 01', inputFiles: [sensitiveInput], repoPath: path }),
      /use input ordinals or generic private paths/,
    );
  } finally {
    await core.shutdown();
    await rm(path, { recursive: true, force: true });
  }
});
test('Core starts a report job without injecting write or verifier fields', async () => {
  const path = await repo('offload-core-report-projection-');
  const isolation = { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree };
  const core = createCore({
    config: { loaded, resolveKey: () => 'credential', isolation },
    isolation,
    worker: { run: async () => ({ status: 'DONE', report: 'private analysis complete' }) },
  });
  try {
    const started = await core.start({ mode: 'report', task: 'analyze only', repoPath: path });
    const done = await core.wait(started.jobId, { repoPath: path, timeoutSec: 15 });
    assert.equal(done.status, 'DONE_UNVERIFIED');
    assert.equal(done.mode, 'report');
  } finally {
    await core.shutdown();
    await rm(path, { recursive: true, force: true });
  }
});
test('a report job sizes its turn cap from the copied input bytes and echoes only the private path', async () => {
  const path = await repo('offload-core-report-sizing-');
  const scratch = await mkdtemp(join(tmpdir(), 'offload-report-sizing-input-'));
  const input = join(scratch, 'customer-sizing-export.json');
  await writeFile(input, 'x'.repeat(100_000));
  const isolation = { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree };
  const core = createCore({
    config: { loaded, resolveKey: () => 'credential', isolation, reportInputRoots: [scratch] },
    isolation,
    worker: { run: async () => ({ status: 'DONE', report: 'analysis complete' }) },
  });
  try {
    const started = await core.start({ mode: 'report', task: 'analyze input one', inputFiles: [input], repoPath: path });
    // 100,000 bytes need 5 pages; report mode is finish + slack + reads, with headroom.
    assert.equal(started.budgetSizing.readTurns, 5);
    assert.equal(started.budgetSizing.recommendedTurns, Math.ceil((2 + 5) * 1.25));
    assert.equal(started.budgetSizing.maxTurns, 9);
    assert.equal(started.budgetSizing.turnsSource, 'scaled');
    assert.deepEqual(
      started.budgetSizing.files.map((file) => file.path),
      ['.offload-report-inputs/input-01'],
    );
    assert.doesNotMatch(JSON.stringify(started), /customer-sizing-export/);
    await core.wait(started.jobId, { repoPath: path, timeoutSec: 15 });
  } finally {
    await core.shutdown();
    await rm(path, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});
test('report worker external input transcript is ephemeral while its report remains durable', async (t) => {
  const path = await repo('offload-core-private-report-');
  const scratch = await mkdtemp(join(tmpdir(), 'offload-private-report-input-'));
  const sensitiveName = 'customer-acme-secret-export.json';
  const sensitiveBody = 'EXTERNAL_BODY_DO_NOT_PERSIST_8c093ed6';
  const input = join(scratch, sensitiveName);
  const isolation = { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree };
  let server;
  try {
    await writeFile(input, sensitiveBody);
    server = await createMockOpenAIServer([
      { chunks: [toolChunk('read-private-input', 'read_file', { path: '.offload-report-inputs/input-01' }), usageChunk] },
      {
        chunks: [
          toolChunk('finish-private-report', 'finish', {
            summary: 'read private input',
            report: 'Private input was reviewed.',
            concerns: [],
            testsRun: ['read input'],
          }),
          usageChunk,
        ],
      },
    ]);
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('loopback networking is unavailable in this sandbox');
      return;
    }
    throw error;
  }
  try {
    const secureLoaded = structuredClone(loaded);
    secureLoaded.config.providers.test.baseUrl = server.baseUrl;
    // The mock streams `mock-model`; bind this fixture's configured profile to
    // that exact priced model instead of weakening production model checks.
    secureLoaded.config.profiles.test.model = 'mock-model';
    const pricingTable = {
      fetched_at: '2026-10-01',
      models: {
        'mock-model': {
          usd_per_1m: {
            input_cache_hit: { off_peak: 0, peak: 0 },
            input_cache_miss: { off_peak: 0, peak: 0 },
            output: { off_peak: 0, peak: 0 },
          },
        },
      },
    };
    const core = createCore({
      config: { loaded: secureLoaded, pricingTable, resolveKey: () => 'credential', isolation, reportInputRoots: [scratch] },
      isolation,
    });
    try {
      const started = await core.start({
        mode: 'report',
        task: 'review private connector result',
        inputFiles: [input],
        // The mock must make one read tool turn and a separate finish turn.
        budget: { maxTurns: 2 },
        repoPath: path,
      });
      const done = await core.wait(started.jobId, { repoPath: path, timeoutSec: 15 });
      assert.equal(done.status, 'DONE_UNVERIFIED');
      assert.equal(done.reportResult.text, 'Private input was reviewed.');
      assert.deepEqual(done.reportResult.inputs, [{ path: '.offload-report-inputs/input-01', bytes: Buffer.byteLength(sensitiveBody) }]);
      const store = core.manager.store;
      assert.match(await store.readArtifact(started.jobId, 'report.md'), /worker summary: read private input/);
      assert.deepEqual(await store.readMessages(started.jobId), []);
      const messagePath = join(getGitDir(path), 'offload', 'jobs', started.jobId, 'messages.jsonl');
      assert.equal(existsSync(messagePath), false, 'report jobs do not create a durable transcript');
      const record = JSON.stringify(await store.get(started.jobId));
      assert.doesNotMatch(record, new RegExp(sensitiveName));
      assert.doesNotMatch(JSON.stringify(done), new RegExp(sensitiveName));
      assert.doesNotMatch(JSON.stringify(server.requests[0].body), new RegExp(sensitiveName));
      assert.match(JSON.stringify(server.requests[0].body), /\.offload-report-inputs\/input-01/);
      assert.doesNotMatch(record, new RegExp(sensitiveBody));
      assert.equal(server.requests.length, 2);
      assert.match(JSON.stringify(server.requests[1].body), new RegExp(sensitiveBody), 'worker can read the generic private copy');
    } finally {
      await core.shutdown();
    }
  } finally {
    await server.close();
    await rm(path, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});
test('Core passes the current write-job turn allowance into the initial system prompt', async (t) => {
  const path = await repo('offload-core-turn-guidance-');
  const noteLines = Array.from({ length: 30 }, (_, i) => `note line ${i + 1} ${i % 2 ? 'é€' : 'ascii'}`);
  await writeFile(join(path, 'notes.txt'), `${noteLines.join('\n')}\n`);
  execFileSync('git', ['-C', path, 'add', 'notes.txt']);
  execFileSync('git', ['-C', path, 'commit', '-qm', 'notes']);
  let server;
  try {
    server = await createMockOpenAIServer([{ chunks: [finishChunk('guided'), usageChunk] }]);
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('loopback networking is unavailable in this sandbox');
      return;
    }
    throw error;
  }
  try {
    const configured = structuredClone(loaded);
    configured.config.providers.test.baseUrl = server.baseUrl;
    configured.config.profiles.test.model = 'mock-model';
    const pricingTable = {
      fetched_at: '2026-10-01',
      models: {
        'mock-model': {
          usd_per_1m: {
            input_cache_hit: { off_peak: 0, peak: 0 },
            input_cache_miss: { off_peak: 0, peak: 0 },
            output: { off_peak: 0, peak: 0 },
          },
        },
      },
    };
    const core = createCore({ config: { loaded: configured, pricingTable, resolveKey: () => 'credential' } });
    try {
      const started = await core.start({
        task: 'write a focused change',
        ownedPaths: ['src/**'],
        relevantPaths: ['notes.txt:21-25', 'README.md'],
        budget: { maxTurns: 2 },
        repoPath: path,
      });
      const done = await core.wait(started.jobId, { repoPath: path, timeoutSec: 15 });
      assert.equal(done.status, 'DONE_UNVERIFIED');
      const system = server.requests[0].body.messages.find((message) => message.role === 'system')?.content;
      assert.match(system, /2 model turns available/);
      assert.ok(system.split('\n').includes('Assertions must be falsifiable; no substring checks that match unrelated text.'));
      // The range is converted to the exact byte offset of line 21, and a plain entry is untouched.
      const offset = Buffer.byteLength(`${noteLines.slice(0, 20).join('\n')}\n`);
      assert.ok(
        system.split('\n').includes(`- notes.txt:21-25 (read_file offset ${offset}, about 1 read; read outside the range only if needed)`),
        system,
      );
      assert.ok(system.split('\n').includes('- README.md'));
      assert.match(system, /Entries suffixed :START-END are caller-selected line ranges/);
      assert.match(system, /Batch independent reads and lists/);
      assert.doesNotMatch(system, /write a focused change/, 'the task remains a separate user turn');
    } finally {
      await core.shutdown();
    }
  } finally {
    await server.close();
    await rm(path, { recursive: true, force: true });
  }
});
const finishChunk = (summary = 'ok') => ({
  model: 'mock-model',
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: `finish-${summary}`,
            type: 'function',
            function: { name: 'finish', arguments: JSON.stringify({ summary, concerns: [], testsRun: [] }) },
          },
        ],
      },
    },
  ],
});
const toolChunk = (id, name, args) => ({
  model: 'mock-model',
  choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});
const usageChunk = { model: 'mock-model', choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
test('Core restart of a queued budget finish uses only the trusted finish projection', async () => {
  const path = await repo('offload-core-budget-finish-restart-');
  const originalFetch = globalThis.fetch;
  const requests = [];
  const sse = (chunks) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(sse([finishChunk('recovered'), usageChunk]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const configured = structuredClone(loaded);
    configured.config.providers.test.baseUrl = 'http://127.0.0.1:4321/v1';
    configured.config.profiles.test.model = 'mock-model';
    const pricingTable = {
      fetched_at: '2026-10-01',
      models: {
        'mock-model': {
          usd_per_1m: {
            input_cache_hit: { off_peak: 0, peak: 0 },
            input_cache_miss: { off_peak: 0, peak: 0 },
            output: { off_peak: 0, peak: 0 },
          },
        },
      },
    };
    const core = createCore({ config: { loaded: configured, pricingTable, resolveKey: () => 'credential' } });
    try {
      const started = await core.start(
        { task: 'TASK_MUST_NOT_REACH_RECOVERED_PROVIDER', ownedPaths: ['src/**'], budget: { maxTurns: 2 }, repoPath: path },
        { launch: false },
      );
      const store = core.manager.store;
      const initial = await store.get(started.jobId);
      await store.messagesBatch(started.jobId, [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'durable-write',
              type: 'function',
              function: { name: 'write_file', arguments: '{"path":"src/recovered.mjs","content":"SOURCE_MUST_NOT_REACH_PROVIDER"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'durable-write', name: 'write_file', content: 'written' },
      ]);
      // This simulates a dead active owner. Release its old start lease first;
      // recovery must acquire a new nonce before the private restart handoff.
      await core.manager.releaseLease(started.jobId, { ownerNonce: initial.leaseOwnerNonce });
      await store.update(started.jobId, {
        status: 'RUNNING',
        handoffState: 'RUNNING',
        runnerPid: 999999999,
        runnerHeartbeatAt: new Date(0).toISOString(),
        budgetFinishRecovery: 'queued',
      });
      assert.equal(await core.manager.recover(), 1);
      const done = await core.wait(started.jobId, { repoPath: path, timeoutSec: 15 });
      assert.equal(done.status, 'DONE_UNVERIFIED');
      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.deepEqual(request.messages, [{ role: 'user', content: 'Call the finish tool now.' }]);
      assert.deepEqual(
        request.tools.map((tool) => tool.function.name),
        ['finish'],
      );
      assert.doesNotMatch(JSON.stringify(request), /(?:TASK|SOURCE)_MUST_NOT_REACH_(?:RECOVERED_)?PROVIDER/);
    } finally {
      await core.shutdown();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(path, { recursive: true, force: true });
  }
});
test('manual repair gets a fresh worker timeout round after a stale original wall clock and records repair lifecycle events', async () => {
  const path = await repo('offload-core-repair-timeout-');
  const originalFetch = globalThis.fetch;
  const requests = [];
  const sse = (chunks) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  const responses = [
    () => new Response(JSON.stringify({ error: { message: 'mock error' } }), { status: 503 }),
    () => new Response(sse([finishChunk('repaired'), usageChunk]), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  ];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return responses.shift()();
  };
  try {
    const configured = structuredClone(loaded);
    configured.config.providers.test.baseUrl = 'http://127.0.0.1:4321/v1';
    configured.config.profiles.test.model = 'mock-model';
    configured.config.limits = { maxTurns: 1, timeoutMinutes: 1, maxUsd: 1 };
    const pricingTable = {
      fetched_at: '2026-10-01',
      models: {
        'mock-model': {
          usd_per_1m: {
            input_cache_hit: { off_peak: 0, peak: 0 },
            input_cache_miss: { off_peak: 0, peak: 0 },
            output: { off_peak: 0, peak: 0 },
          },
        },
      },
    };
    const core = createCore({ config: { loaded: configured, pricingTable, resolveKey: () => 'credential' } });
    try {
      const started = await core.start({ task: 'retry provider failure', ownedPaths: ['src/**'], repoPath: path });
      const failed = await core.wait(started.jobId, { repoPath: path, timeoutSec: 15 });
      assert.equal(failed.status, 'FAILED');
      assert.deepEqual(failed.providerFailure, { kind: 'http', attempts: 1, status: 503 });
      // This is the observed failure mode: a repair requested much later than
      // the original wall start must still run its own active worker round.
      // Simulate a durable record created before attemptTimeoutMs was added;
      // repairs must safely use the adapter default rather than rejecting it.
      const legacyRecord = await core.manager.store.get(started.jobId);
      const legacyProfile = { ...legacyRecord.executionProfile };
      delete legacyProfile.attemptTimeoutMs;
      await core.manager.store.update(started.jobId, { executionProfile: legacyProfile });
      await core.manager.store.update(started.jobId, { wallStartedAt: new Date(Date.now() - 113 * 60_000).toISOString() });
      await core.repair(started.jobId, ['retry the transient provider failure'], { repoPath: path });
      const repaired = await core.wait(started.jobId, { repoPath: path, timeoutSec: 15 });
      assert.equal(repaired.status, 'DONE_UNVERIFIED');
      assert.equal(requests.length, 2, 'repair must make at least one new worker request');
      const events = (await core.manager.store.readArtifact(started.jobId, 'events.jsonl'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert(events.some((event) => event.type === 'started' && event.reason === 'repair'));
      assert(events.some((event) => event.type === 'progress' && event.recentActions?.includes('repair_queued')));
      const providerFinished = events.find((event) => event.type === 'finished' && event.providerFailure?.kind === 'http');
      assert.deepEqual(providerFinished.providerFailure, { kind: 'http', attempts: 1, status: 503 });
      assert.doesNotMatch(JSON.stringify(providerFinished), /127\.0\.0\.1|mock error/i);
    } finally {
      await core.shutdown();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(path, { recursive: true, force: true });
  }
});
async function writeMockConfig(home, server, extra = {}) {
  const configDir = join(home, 'config', 'offload');
  await mkdir(configDir, { recursive: true });
  const pricingPath = join(configDir, 'pricing.json');
  await writeFile(
    pricingPath,
    JSON.stringify({
      fetched_at: '2026-10-01',
      models: {
        'mock-model': {
          usd_per_1m: {
            input_cache_hit: { off_peak: 0, peak: 0 },
            input_cache_miss: { off_peak: 0, peak: 0 },
            output: { off_peak: 0, peak: 0 },
          },
        },
      },
    }),
  );
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      providers: { mock: { type: 'openai-chat', baseUrl: server.baseUrl, keyRef: 'env:OFFLOAD_E2E_KEY', pricingFile: 'pricing.json' } },
      profiles: { mock: { provider: 'mock', model: 'mock-model' } },
      default: 'mock',
      ...extra,
    }),
  );
  return { configDir, pricingPath };
}
test('Core normalizes malformed pricing JSON without reflecting parser content', async () => {
  const path = await repo('offload-invalid-pricing-'),
    home = await mkdtemp(join(tmpdir(), 'offload-invalid-pricing-home-'));
  try {
    const configDir = join(home, 'config', 'offload');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'pricing.json'), '{"models":\nnot-json-secret');
    await writeFile(
      join(configDir, 'config.json'),
      JSON.stringify({
        providers: { mock: { type: 'openai-chat', baseUrl: 'http://127.0.0.1:1', keyRef: 'env:IGNORED', pricingFile: 'pricing.json' } },
        profiles: { mock: { provider: 'mock', model: 'mock-model' } },
        default: 'mock',
      }),
    );
    const core = createCore({ config: { configPath: join(configDir, 'config.json'), resolveKey: () => 'credential' } });
    await assert.rejects(
      () => core.start({ repoPath: path, task: 'must not start', ownedPaths: ['src/**'] }),
      (error) => /pricing file contains invalid JSON/.test(error.message) && !/Unexpected token|not-json-secret/.test(error.message),
    );
  } finally {
    await rm(path, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
test('Core refuses any Pro model whether it arrives from a config file or an injected snapshot', async () => {
  const path = await repo('offload-pro-policy-'),
    home = await mkdtemp(join(tmpdir(), 'offload-pro-policy-home-'));
  try {
    const configDir = join(home, 'config', 'offload');
    await mkdir(configDir, { recursive: true });
    const provider = { type: 'openai-chat', baseUrl: 'https://api.deepseek.com', keyRef: 'env:IGNORED' };
    await writeFile(
      join(configDir, 'config.json'),
      JSON.stringify({
        providers: { deepseek: provider },
        profiles: { pro: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
        default: 'pro',
      }),
    );
    const fromFile = createCore({ config: { configPath: join(configDir, 'config.json'), resolveKey: () => 'credential' } });
    await assert.rejects(
      () => fromFile.start({ repoPath: path, task: 'must not start', ownedPaths: ['src/**'] }),
      /model "deepseek-v4-pro" is disabled/,
    );
    // config.loaded bypasses file validation, so Core must enforce the policy itself.
    const injected = createCore({
      config: {
        loaded: {
          disabled: false,
          repoConfig: {},
          config: {
            default: 'pro',
            profiles: { pro: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
            providers: { deepseek: provider },
            limits: { maxTurns: 2, timeoutMinutes: 1, maxUsd: 1 },
          },
        },
        resolveKey: () => 'credential',
      },
    });
    await assert.rejects(
      () => injected.start({ repoPath: path, task: 'must not start', ownedPaths: ['src/**'] }),
      /Offload model policy: model "deepseek-v4-pro" is disabled/,
    );
  } finally {
    await rm(path, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
const cliEnv = (home, extra = {}) => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, 'config'),
  OFFLOAD_E2E_KEY: 'not-in-output',
  ...extra,
});
function cli(argv, env) {
  return spawnSync(process.execPath, ['bin/offload.mjs', ...argv], { cwd: process.cwd(), encoding: 'utf8', env, timeout: 5_000 });
}
async function pollJob(id, path, env, predicate, attempts = 120) {
  let inspected;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const query = cli(['job', id, '--repoPath', path], env);
    assert.equal(query.status, 0, query.stderr);
    inspected = JSON.parse(query.stdout);
    if (predicate(inspected)) return inspected;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return inspected;
}
async function pollStoredJob(id, path, predicate, attempts = 160) {
  const store = new JobStore({ gitDir: getGitDir(path) });
  await store.init(path);
  let job;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      job = await store.get(id);
    } catch (error) {
      // A child atomically replaces its durable record. The checked store
      // reader intentionally fails closed if this poll catches that exact
      // lstat/open race; polling should wait for the replacement rather than
      // turn the safe transient into a platform-specific test failure.
      if (!/^stored file is invalid or changed while (opening|reading)$/.test(error?.message || '')) throw error;
    }
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return job;
}

test('pollStoredJob retries only the expected atomic stored-record race', async () => {
  const path = await repo('offload-poll-stored-job-');
  const originalGet = JobStore.prototype.get;
  let calls = 0;
  try {
    JobStore.prototype.get = async () => {
      calls += 1;
      if (calls === 1) throw new Error('stored file is invalid or changed while opening');
      if (calls === 2) throw new Error('stored file is invalid or changed while reading');
      return { status: 'DONE_VERIFIED' };
    };
    const done = await pollStoredJob('job-id', path, (job) => job.status === 'DONE_VERIFIED');
    assert.equal(done.status, 'DONE_VERIFIED');
    assert.equal(calls, 3);

    JobStore.prototype.get = async () => {
      throw new Error('unexpected store failure');
    };
    await assert.rejects(() => pollStoredJob('job-id', path, () => false, 1), /unexpected store failure/);
  } finally {
    JobStore.prototype.get = originalGet;
    await rm(path, { recursive: true, force: true });
  }
});

test('one core routes durable jobs across canonical repository roots', async () => {
  const a = await repo('offload-core-a-'),
    b = await repo('offload-core-b-');
  const core = testCore();
  const first = await core.start({ repoPath: a, task: 'first', ownedPaths: ['src/**'], testCommand: 'true' });
  const second = await core.start({ repoPath: b, task: 'second', ownedPaths: ['lib/**'], testCommand: 'true' });
  await assert.rejects(() => core.wait(first.jobId, { repoPath: b, timeoutSec: 2 }), /job not found/);
  await assert.rejects(() => core.wait(second.jobId, { repoPath: a, timeoutSec: 2 }), /job not found/);
  assert.equal((await core.wait(first.jobId, { timeoutSec: 2 })).status, 'DONE_VERIFIED');
  assert.equal((await core.wait(second.jobId, { timeoutSec: 2 })).status, 'DONE_VERIFIED');
  const listed = await core.job(undefined, { repoPath: b });
  assert.deepEqual(
    listed.jobs.map((job) => job.jobId),
    [second.jobId],
  );
});

test('Core persists explicit policy-only verifier consent and preserves caller policy tightening', async () => {
  const path = await repo('offload-core-verifier-consent-');
  const verifyOptions = [];
  const configured = { ...loaded, repoConfig: { denyRead: ['repo-secret/**'] } };
  const core = createCore({
    config: { loaded: configured },
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: {
      verify: async (_command, options) => {
        verifyOptions.push(options);
        return { verdict: 'PASS', result: { code: 0, sandbox: 'policy-only' } };
      },
    },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  const started = await core.start({
    repoPath: path,
    task: 'explicit exception',
    ownedPaths: ['src/**'],
    extraWritable: ['build/**'],
    denyRead: ['caller-secret/**'],
    testCommand: 'true',
    unsafePolicyOnlyVerifier: true,
  });
  const done = await core.wait(started.jobId, { repoPath: path, timeoutSec: 1 });
  assert.equal(done.status, 'DONE_VERIFIED');
  assert.equal(done.unsafePolicyOnlyVerifier, true);
  assert.equal(verifyOptions[0].requireSandbox, false);
  assert.deepEqual(verifyOptions[0].denyRead, ['caller-secret/**', 'repo-secret/**']);
  await assert.rejects(() => core.repair(started.jobId, ['must not repair'], { repoPath: path }), /policy-only or unknown verifier result/);
});

test('Core never applies the policy-only exception to a repository verifier', async () => {
  const path = await repo('offload-core-repo-verifier-');
  const configured = { ...loaded, repoConfig: { testCommand: 'true' } };
  const core = createCore({
    config: { loaded: configured },
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: { verify: async () => ({ verdict: 'PASS', result: { code: 0, sandbox: 'policy-only' } }) },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  await assert.rejects(
    () => core.start({ repoPath: path, task: 'repo verifier', ownedPaths: ['src/**'], unsafePolicyOnlyVerifier: true }),
    /requires a caller-supplied testCommand/,
  );
  const started = await core.start({ repoPath: path, task: 'repo verifier', ownedPaths: ['src/**'] });
  assert.equal((await core.wait(started.jobId, { repoPath: path, timeoutSec: 1 })).status, 'VERIFY_FAILED');
});

async function seedQueuedJob(path, id) {
  const store = new JobStore({ repoPath: path });
  const branch = execFileSync('git', ['-C', path, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  const head = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await store.create({
    id,
    task: 'routing fixture',
    ownedPaths: ['src/**'],
    repoPath: path,
    branch,
    head,
    status: 'QUEUED',
    runnerPid: process.pid,
    runnerHeartbeatAt: new Date().toISOString(),
    handoffState: 'PARENT_QUEUED',
  });
  return store;
}

test('explicit repo hints select the matching duplicate id for reads and cancellation', async () => {
  const a = await repo('offload-core-duplicate-a-'),
    b = await repo('offload-core-duplicate-b-');
  const id = 'duplicate-routing-job';
  const storeA = await seedQueuedJob(a, id),
    storeB = await seedQueuedJob(b, id);
  const core = testCore();
  await core.job(undefined, { repoPath: a });
  await core.job(undefined, { repoPath: b });

  assert.equal((await core.job(id, { repoPath: b })).repo, b);
  assert.equal((await core.cancel(id, { repoPath: b })).repo, b);
  assert.equal((await storeA.get(id)).status, 'QUEUED');
  assert.equal((await storeB.get(id)).status, 'QUEUED');
  assert.equal(
    await storeB.cancelRequested(id),
    true,
    'a non-owner control plane records cancellation without deleting a live handoff workspace',
  );
});

test('a wrong explicit repo hint cannot inspect or cancel an already-loaded job', async () => {
  const path = await repo('offload-core-wrong-hint-');
  const id = 'wrong-hint-routing-job';
  const store = await seedQueuedJob(path, id);
  const core = testCore();
  await core.job(undefined, { repoPath: path });
  const missing = join(path, 'not-a-repository');

  await assert.rejects(() => core.job(id, { repoPath: missing }), /repoPath must be inside a git working tree/);
  await assert.rejects(() => core.cancel(id, { repoPath: missing }), /repoPath must be inside a git working tree/);
  assert.equal((await store.get(id)).status, 'QUEUED');
});

test('a no-id server listing does not bind its incidental cwd as a repository', async () => {
  const core = testCore();
  const result = await core.job();
  assert.deepEqual(result.jobs, []);
  assert.deepEqual(result.health.repositories, []);
  // Nothing is bound, so there is no working tree to report and nothing to count.
  assert.equal(result.health.workingTree, undefined);
  assert.equal(result.listing.shown, 0);
  assert.equal(result.listing.omitted, 0);
  assert.equal(result.listing.totalCostUsd, 0);
  assert.ok(['macos', 'policy-only'].includes(result.health.sandbox));
  assert.equal(typeof result.health.sandboxReason, 'string');
  assert.equal(result.health.sandboxStatus.reason, result.health.sandboxReason);
  assert.equal(result.health.sandboxStatus.signal, result.health.sandboxProbeSignal);
  assert.equal(result.health.sandboxProbeCommand, '/usr/bin/sandbox-exec -p <generated-offload-profile> /usr/bin/true');
  assert.equal(result.health.server.name, 'offload');
  assert.equal(result.health.server.version, '0.1.0');
  assert.equal(result.health.server.schemaRevision, 2);
  assert.deepEqual(result.health.server.capabilities, {
    reportMode: true,
    inputFiles: true,
    continueJob: true,
    lateApply: true,
    failedApply: true,
    compactReports: true,
    verifierDeps: true,
    baselineVerifier: true,
    applyThenVerify: true,
    budgetSizing: true,
    failureDiagnostics: true,
    timingBreakdown: true,
    verifierInterpreter: true,
    retrospective: true,
  });
  assert.match(result.health.server.buildHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.health.server.skillHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.health.server.restartRequired, false);
  assert.equal(core.manager, undefined);
});

test('health reports the verifier temp probe verbatim, caches it for a minute, and survives a failing probe', async () => {
  const probe = { status: 'writable', reason: 'per-run-tmpdir-writable', systemTmp: 'denied', gitInit: 'ok', note: 'n' };
  let calls = 0;
  let clock = 1_000_000;
  const core = createCore({
    now: () => clock,
    config: {
      loaded,
      probeVerifierTemp: async () => {
        calls += 1;
        return probe;
      },
    },
  });
  const [first, concurrent] = await Promise.all([core.job(), core.job()]);
  assert.deepEqual(first.health.verifierTmp, probe);
  assert.deepEqual(concurrent.health.verifierTmp, probe);
  assert.equal(calls, 1, 'concurrent health calls share one probe');
  clock += 59_000;
  await core.job();
  assert.equal(calls, 1, 'inside the TTL the cached answer is reused');
  clock += 2_000;
  await core.job();
  assert.equal(calls, 2, 'past the TTL the probe runs again');

  const failing = createCore({
    config: {
      loaded,
      probeVerifierTemp: async () => {
        throw new Error('probe exploded at /private/secret/path');
      },
    },
  });
  const health = (await failing.job()).health;
  assert.deepEqual(health.verifierTmp, { status: 'unknown', reason: 'probe-failed', systemTmp: 'unknown', gitInit: 'unknown', note: '' });
  assert.ok(['macos', 'policy-only'].includes(health.sandbox), 'a failing probe does not fail health');
});

test('a no-id listing with an explicit repository also carries the verifier temp probe', async () => {
  const path = await repo('offload-core-health-tmp-');
  const probe = { status: 'unwritable', reason: 'host-tmpdir-unwritable', systemTmp: 'unknown', gitInit: 'unknown', note: 'n' };
  const core = createCore({
    config: { loaded, probeVerifierTemp: async () => probe },
    worker: { run: async () => ({ status: 'DONE' }) },
  });
  try {
    assert.deepEqual((await core.job(undefined, { repoPath: path })).health.verifierTmp, probe);
  } finally {
    await core.shutdown();
    await rm(path, { recursive: true, force: true });
  }
});

test('Core validates baseline-diff and verifier timeout requests before any durable state', async () => {
  const path = await repo('offload-core-baseline-validate-');
  const isolation = { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree };
  const core = createCore({
    config: { loaded, resolveKey: () => 'credential', isolation },
    isolation,
    worker: { run: async () => ({ status: 'DONE' }) },
  });
  const base = { repoPath: path, task: 'validate', ownedPaths: ['src/**'] };
  try {
    await assert.rejects(
      () => core.start({ ...base, verifierMode: 'baseline-diff' }),
      /^Error: baseline-diff verification requires a testCommand \(supply one or configure the repository testCommand\)$/,
    );
    await assert.rejects(
      () => core.start({ ...base, verifierMode: 'baseline-diff', testCommand: 'true', unsafePolicyOnlyVerifier: true }),
      /^Error: baseline-diff verification requires the macOS sandbox and cannot use unsafePolicyOnlyVerifier$/,
    );
    await assert.rejects(
      () => core.start({ ...base, verifierMode: 'x', testCommand: 'true' }),
      /^Error: verifierMode must be standard or baseline-diff$/,
    );
    for (const verifierTimeoutSec of [4, 1801, 5.5, '60', Number.NaN])
      await assert.rejects(
        () => core.start({ ...base, testCommand: 'true', verifierTimeoutSec }),
        /^Error: verifierTimeoutSec must be an integer from 5 to 1800$/,
        String(verifierTimeoutSec),
      );
    for (const extra of [{ verifierMode: 'baseline-diff' }, { verifierTimeoutSec: 60 }])
      await assert.rejects(
        () => core.start({ repoPath: path, task: 'report', mode: 'report', ...extra }),
        /^Error: report jobs do not use verifier sandbox options$/,
      );
    assert.deepEqual((await core.job(undefined, { repoPath: path })).jobs, [], 'every rejection happened before a job existed');
  } finally {
    await core.shutdown();
    await rm(path, { recursive: true, force: true });
  }
});

test('Core persists baseline-diff options and hands the verifier its timeout', async () => {
  const path = await repo('offload-core-baseline-persist-');
  const isolation = { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree };
  const verifyOptions = [];
  const core = createCore({
    config: { loaded, resolveKey: () => 'credential', isolation },
    isolation,
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: {
      verify: async (command, options) => {
        verifyOptions.push(options);
        return { command, verdict: 'PASS', result: { code: 0, sandbox: 'macos' } };
      },
    },
  });
  try {
    const started = await core.start({
      repoPath: path,
      task: 'baseline',
      ownedPaths: ['src/**'],
      testCommand: 'true',
      verifierMode: 'baseline-diff',
      verifierTimeoutSec: 90,
    });
    assert.equal(started.verifierMode, 'baseline-diff');
    const done = await core.wait(started.jobId, { repoPath: path, timeoutSec: 15 });
    assert.equal(done.status, 'DONE_VERIFIED');
    const stored = await new JobStore({ repoPath: path }).get(started.jobId);
    assert.equal(stored.verifierMode, 'baseline-diff');
    assert.equal(stored.verifierTimeoutSec, 90);
    assert.equal(verifyOptions.length, 1, 'a passing result needs no baseline run');
    assert.equal(verifyOptions[0].timeoutSec, 90);
  } finally {
    await core.shutdown();
    await rm(path, { recursive: true, force: true });
  }
});

test('Core sizes the turn cap from file sizes, honors an explicit cap, and echoes budgetSizing', async () => {
  const path = await repo('offload-core-turn-sizing-');
  await mkdir(join(path, 'src'));
  // 733,780 bytes of 80-byte lines: the 14k-line file from the field report.
  await writeFile(join(path, 'src', 'big.js'), ('a'.repeat(79) + '\n').repeat(9_173).slice(0, 733_780));
  execFileSync('git', ['-C', path, 'add', 'src/big.js']);
  execFileSync('git', ['-C', path, 'commit', '-qm', 'big']);
  const isolation = { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree };
  const configured = structuredClone(loaded);
  configured.config.limits.maxTurns = 20;
  const core = createCore({
    config: { loaded: configured, resolveKey: () => 'credential', isolation },
    isolation,
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: { verify: async (command) => ({ command, verdict: 'PASS', result: { code: 0, sandbox: 'macos' } }) },
  });
  const store = new JobStore({ repoPath: path });
  const run = async (budget, extra = {}) => {
    const started = await core.start({
      repoPath: path,
      task: 'sizing',
      ownedPaths: ['src/big.js'],
      relevantPaths: ['src/big.js'],
      ...(budget ? { budget } : {}),
      ...extra,
    });
    await core.wait(started.jobId, { repoPath: path, timeoutSec: 15 });
    return { started, stored: await store.get(started.jobId) };
  };
  try {
    const scaled = await run(undefined);
    assert.equal(scaled.started.budgetSizing.maxTurns, 54);
    assert.equal(scaled.started.budgetSizing.turnsSource, 'scaled');
    assert.equal(scaled.started.budgetSizing.recommendedTurns, 54);
    assert.equal(scaled.started.budgetSizing.readTurns, 31);
    assert.deepEqual(scaled.started.budgetSizing.files, [{ path: 'src/big.js', bytes: 733_780, readTurns: 31, ranged: false }]);
    // 54 turns at ~45 s outlast the fixture's 1 minute allowance. The caller did not choose a timeout, so the
    // stored allowance is scaled to what the turns need (and the record says so) rather than ending in TIMEOUT.
    assert.equal(scaled.started.budgetSizing.warnings.length, 1);
    assert.match(scaled.started.budgetSizing.warnings[0], /budget\.timeoutMinutes was not set: scaled from 1 to 41 minutes/);
    assert.equal(scaled.started.budgetSizing.timeoutMinutes, 41);
    assert.equal(scaled.stored.budget.maxTurns, 54);
    assert.equal(scaled.stored.budget.timeoutMinutes, 41);
    // A timeout the caller chose is only warned about, never changed.
    const chosen = await run({ timeoutMinutes: 1 });
    assert.equal(chosen.stored.budget.timeoutMinutes, 1);
    assert.equal(chosen.started.budgetSizing.timeoutMinutes, undefined);
    assert.match(chosen.started.budgetSizing.warnings[0], /about 54 turns .* but budget\.timeoutMinutes is 1;.*TIMEOUT/);
    // Other budget fields do not count as choosing a timeout.
    assert.equal((await run({ maxUsd: 1 })).stored.budget.timeoutMinutes, 41);
    const roomy = await run({ timeoutMinutes: 60 });
    assert.equal(roomy.started.budgetSizing.maxTurns, 54);
    assert.deepEqual(roomy.started.budgetSizing.warnings, [], 'a timeout that covers the turns is not warned about');
    assert.deepEqual(Object.keys(scaled.stored.budget).sort(), ['maxTurns', 'maxUsd', 'timeoutMinutes'], 'turnPolicy is never persisted');

    // Only the cap that was asked for is used when the caller sets one, but the primary is told what was recommended.
    const explicit = await run({ maxTurns: 30 });
    assert.equal(explicit.stored.budget.maxTurns, 30);
    assert.equal(explicit.started.budgetSizing.turnsSource, 'caller');
    assert.match(explicit.started.budgetSizing.warnings[0], /maxTurns 30 is below the recommended 54/);
    assert.equal(explicit.started.budgetSizing.recommendedTurns, 54);

    const floor = await run({ maxTurns: 30, turnPolicy: 'auto' });
    assert.equal(floor.stored.budget.maxTurns, 54);
    assert.equal(floor.started.budgetSizing.turnsSource, 'raised');

    const pinned = await run({ turnPolicy: 'fixed' });
    assert.equal(pinned.stored.budget.maxTurns, 20);
    assert.equal(pinned.started.budgetSizing.turnsSource, 'default');
    assert.equal(pinned.started.budgetSizing.warnings.filter((warning) => /below the recommended 54/.test(warning)).length, 1);

    // A line range shrinks the recommendation, which never drops below the configured default.
    const ranged = await run(undefined, { relevantPaths: ['src/big.js:100-160'], ownedPaths: ['src/big.js'] });
    assert.equal(ranged.started.budgetSizing.recommendedTurns, 18);
    assert.equal(ranged.stored.budget.maxTurns, 20);
    assert.equal(ranged.started.budgetSizing.turnsSource, 'default');
    assert.equal(ranged.stored.relevantPaths[0], 'src/big.js:100-160');

    await assert.rejects(
      () => core.start({ repoPath: path, task: 'x', ownedPaths: ['src/**'], budget: { turnPolicy: 'bogus' } }),
      /budget/,
    );
    await assert.rejects(
      () => core.start({ repoPath: path, task: 'x', ownedPaths: ['src/**'], relevantPaths: ['src/big.js:9-1'] }),
      /relevantPaths must be relative paths\/globs, optionally suffixed :START-END/,
    );
    await assert.rejects(
      () => core.manager.start({ task: 'x', ownedPaths: ['src/**'], budget: { turnPolicy: 'auto' } }),
      /resolved by Core/,
    );
  } finally {
    await core.shutdown();
    await rm(path, { recursive: true, force: true });
  }
});
test('Core forwards applyThenVerify, its timeout and the request signal to the manager, and a plain apply is unchanged', async () => {
  const path = await repo('offload-core-apply-verify-');
  const isolation = {
    create: createIsolatedWorktree,
    open: openIsolatedWorktree,
    cleanup: cleanupIsolatedWorktree,
    integrateRecorded: integrateRecordedTree,
  };
  const commands = [];
  const core = createCore({
    config: { loaded, resolveKey: () => 'credential', isolation },
    isolation,
    worker: {
      run: async (job) => {
        await mkdir(join(job.workspacePath, 'src'), { recursive: true });
        await writeFile(join(job.workspacePath, 'src', 'a.js'), 'export const a = 1;\n');
        return { status: 'DONE' };
      },
    },
    runner: {
      sandboxAvailable: () => true,
      verify: async (command, options) => {
        if (command === 'npm test')
          return { command, verdict: 'FAIL', result: { code: 1, stderr: 'AssertionError: no', sandbox: 'macos' } };
        commands.push({ command, options, seen: existsSync(join(options.cwd, 'src', 'a.js')) });
        return { command, verdict: 'PASS', result: { code: 0, stdout: 'checked\n', sandbox: 'macos' } };
      },
    },
  });
  try {
    const started = await core.start({
      repoPath: path,
      task: 'apply',
      ownedPaths: ['src/**'],
      testCommand: 'npm test',
      maxRepairRounds: 0,
    });
    const done = await core.wait(started.jobId, { repoPath: path, timeoutSec: 15 });
    assert.equal(done.status, 'VERIFY_FAILED');
    // A plain dry run is exactly what it was.
    assert.deepEqual(await core.apply(started.jobId, { repoPath: path }), {
      dryRun: true,
      applied: false,
      files: ['src/a.js'],
      fromStatus: 'VERIFY_FAILED',
    });
    // The timeout and a pre-aborted signal reach the manager: the command is never started and nothing is left applied.
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      () => core.apply(started.jobId, { repoPath: path, apply: true, applyThenVerify: 'node check.js', signal: cancelled.signal }),
      /cancelled/,
    );
    assert.equal(commands.length, 0);
    assert.equal(existsSync(join(path, 'src', 'a.js')), false);
    const result = await core.apply(started.jobId, {
      repoPath: path,
      apply: true,
      applyThenVerify: 'node check.js',
      applyThenVerifyTimeoutSec: 45,
    });
    assert.equal(result.applied, true);
    assert.equal(result.applyThenVerify.outcome, 'PASSED');
    assert.equal(result.applyThenVerify.outputTail, 'checked');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].seen, true, 'the command ran after the diff landed');
    assert.equal(commands[0].options.timeoutMs, 45_000);
    assert.equal(commands[0].options.requireSandbox, true);
    assert.deepEqual(commands[0].options.writablePaths, []);
    // A plain apply still demands the primary's own evidence.
    await assert.rejects(() => core.apply(started.jobId, { repoPath: path, apply: true }), /verifiedBy must state the check you ran/);
  } finally {
    await core.shutdown();
    await rm(path, { recursive: true, force: true });
  }
});

test('invalid pricing is rejected before creating a job or acquiring a lease', async () => {
  const path = await repo('offload-invalid-pricing-');
  let acquired = 0;
  const malformed = { models: { 'test-model': { usd_per_1m: {} } } };
  const core = createCore({
    config: { loaded, pricingTable: malformed },
    leases: {
      acquire: async () => {
        acquired += 1;
      },
      list: async () => [],
    },
    worker: { run: async () => ({ status: 'DONE' }) },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  await assert.rejects(
    () => core.start({ repoPath: path, task: 'invalid pricing', ownedPaths: ['src/**'] }, { launch: false }),
    /pricing rate/,
  );
  assert.equal(acquired, 0);
  const store = new JobStore({ gitDir: getGitDir(path) });
  assert.deepEqual(await store.list(), []);
});

test('late detached handoff observes cancellation, preserves it, and releases the transferred lease', async () => {
  const path = await repo('offload-handoff-cancel-');
  const releases = [];
  let core;
  const leases = {
    acquire: async () => {},
    list: async () => [],
    transfer: async () => {
      await core.cancel(started.jobId, { repoPath: path });
    },
    release: async (_id, owner) => {
      releases.push(owner.ownerNonce);
      return true;
    },
  };
  core = createCore({
    config: { loaded },
    leases,
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: { verify: async () => ({ verdict: 'PASS', result: { code: 0 } }) },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  const started = await core.start({ repoPath: path, task: 'handoff cancel', ownedPaths: ['src/**'] }, { launch: false });
  const parentNonce = (await core.manager.store.get(started.jobId)).leaseOwnerNonce;
  const handoff = await core.assignWorkerPid(started.jobId, process.pid, path);
  const job = await core.manager.store.get(started.jobId);
  assert.deepEqual(handoff, { assigned: false, status: 'CANCELLED' });
  assert.equal(job.status, 'CANCELLED');
  assert.equal(job.handoffState, 'CANCELLED');
  assert.equal(releases.length, 1);
  assert.notEqual(releases[0], parentNonce, 'only the transferred child lease is released by its authenticated owner');
});

test('a cancellation written at the child-assignment update boundary wins the handoff', async () => {
  const path = await repo('offload-handoff-boundary-');
  const store = new JobStore({ repoPath: path });
  const releases = [];
  const leases = {
    acquire: async () => {},
    list: async () => [],
    transfer: async () => {},
    release: async (_id, owner) => {
      releases.push(owner.ownerNonce);
      return true;
    },
  };
  const core = createCore({
    store,
    config: { loaded },
    leases,
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: { verify: async () => ({ verdict: 'PASS', result: { code: 0 } }) },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  const started = await core.start({ repoPath: path, task: 'assignment boundary', ownedPaths: ['src/**'] }, { launch: false });
  const updateOperationalIf = store.updateOperationalIf.bind(store);
  let injected = false;
  store.updateOperationalIf = async (id, expected, changes) => {
    const result = await updateOperationalIf(id, expected, changes);
    if (!injected && changes.handoffState === 'CHILD_ASSIGNED') {
      injected = true;
      await core.cancel(id, { repoPath: path });
    }
    return result;
  };
  const handoff = await core.assignWorkerPid(started.jobId, process.pid, path);
  const queued = await store.get(started.jobId);
  // CHILD_ASSIGNED hands exclusive cleanup authority to the child. The parent
  // returns a valid assignment even when it sees a late marker; resume then
  // consumes that marker without ever launching the worker.
  assert.deepEqual(handoff, { assigned: true, status: 'QUEUED' });
  assert.equal(queued.status, 'QUEUED');
  assert.equal(queued.handoffState, 'CHILD_ASSIGNED');
  await core.resume(started.jobId, path);
  const job = await store.get(started.jobId);
  assert.equal(injected, true);
  assert.equal(job.status, 'CANCELLED');
  assert.equal(releases.length, 1, 'the handoff owner consumes the marker once using the transferred lease nonce');
});

test('a recovery stage between parent handoff read and child assignment wins the CAS', async () => {
  const path = await repo('offload-handoff-recovery-cas-');
  const store = new JobStore({ repoPath: path });
  const releases = [];
  const leases = {
    acquire: async () => {},
    list: async () => [],
    transfer: async () => {},
    release: async (_id, owner) => {
      releases.push(owner.ownerNonce);
      return true;
    },
  };
  const core = createCore({
    store,
    config: { loaded },
    leases,
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: { verify: async () => ({ verdict: 'PASS', result: { code: 0 } }) },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  const started = await core.start({ repoPath: path, task: 'assignment recovery race', ownedPaths: ['src/**'] }, { launch: false });
  const parentNonce = (await store.get(started.jobId)).leaseOwnerNonce;
  const updateOperationalIf = store.updateOperationalIf.bind(store);
  let staged = false;
  store.updateOperationalIf = async (id, expected, changes) => {
    if (!staged && changes.handoffState === 'CHILD_ASSIGNED') {
      staged = true;
      await store.update(id, { status: 'FINALIZING', finalStatus: 'FAILED', error: 'recovery won handoff' });
    }
    return updateOperationalIf(id, expected, changes);
  };
  const handoff = await core.assignWorkerPid(started.jobId, process.pid, path);
  const settled = await store.get(started.jobId);
  assert.deepEqual(handoff, { assigned: false, status: 'FINALIZING' });
  assert.equal(settled.status, 'FINALIZING');
  assert.equal(settled.handoffState, 'PARENT_QUEUED');
  assert.equal(releases.length, 1);
  assert.notEqual(releases[0], parentNonce, 'only the transferred nonce is released after a lost child-assignment CAS');
});

test('a post-assignment marker read failure cannot release the child-owned lease', async () => {
  const path = await repo('offload-handoff-post-read-');
  const store = new JobStore({ repoPath: path });
  const releases = [];
  const leases = {
    acquire: async () => {},
    list: async () => [],
    transfer: async () => {},
    release: async (_id, owner) => {
      releases.push(owner.ownerNonce);
      return true;
    },
  };
  const core = createCore({
    store,
    config: { loaded },
    leases,
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: { verify: async () => ({ verdict: 'PASS', result: { code: 0 } }) },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  const started = await core.start({ repoPath: path, task: 'post assignment read', ownedPaths: ['src/**'] }, { launch: false });
  const cancelRequested = store.cancelRequested.bind(store);
  let markerReads = 0;
  store.cancelRequested = async (id) => {
    markerReads += 1;
    if (markerReads === 2) throw new Error('marker read interrupted');
    return cancelRequested(id);
  };
  const handoff = await core.assignWorkerPid(started.jobId, process.pid, path);
  const job = await store.get(started.jobId);
  assert.deepEqual(handoff, { assigned: true, status: 'QUEUED' });
  assert.equal(job.handoffState, 'CHILD_ASSIGNED');
  assert.equal(releases.length, 0, 'the parent must not steal the child lease after publishing its tuple');
});

test('a transfer error after cancellation cannot turn a detached job into FAILED', async () => {
  const path = await repo('offload-handoff-error-');
  const releases = [];
  let core;
  const leases = {
    acquire: async () => {},
    list: async () => [],
    transfer: async () => {
      await core.cancel(started.jobId, { repoPath: path });
      throw new Error('late transfer failure');
    },
    release: async (_id, owner) => {
      releases.push(owner.ownerNonce);
      return true;
    },
  };
  core = createCore({
    config: { loaded },
    leases,
    worker: { run: async () => ({ status: 'DONE' }) },
    runner: { verify: async () => ({ verdict: 'PASS', result: { code: 0 } }) },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  const started = await core.start({ repoPath: path, task: 'handoff error', ownedPaths: ['src/**'] }, { launch: false });
  const handoff = await core.assignWorkerPid(started.jobId, process.pid, path);
  const job = await core.manager.store.get(started.jobId);
  assert.deepEqual(handoff, { assigned: false, status: 'CANCELLED' });
  assert.equal(job.status, 'CANCELLED');
  assert.equal(releases.length, 1, 'cancellation releases the parent-owned lease; a throwing transfer never claimed the child nonce');
});

test('an MCP root hint becomes the canonical default only when no explicit repo is supplied', async () => {
  const a = await repo('offload-core-hint-a-'),
    b = await repo('offload-core-hint-b-');
  const core = testCore();
  const canonicalA = core.setDefaultRepo(a);
  const hinted = await core.start({ task: 'hinted', ownedPaths: ['src/**'] });
  const explicit = await core.start({ repoPath: b, task: 'explicit', ownedPaths: ['lib/**'] });
  assert.equal(hinted.repo, canonicalA);
  assert.equal(explicit.repo, core.setDefaultRepo(b));
});

test('Core snapshots the configured provider attempt timeout and resolves the adapter default for legacy provider config', async () => {
  const path = await repo('offload-core-attempt-timeout-'),
    legacyPath = await repo('offload-core-attempt-timeout-legacy-');
  const configured = structuredClone(loaded);
  configured.config.providers.test.attemptTimeoutMs = 45_000;
  const explicit = createCore({
    config: { loaded: configured },
    worker: { run: async () => ({ status: 'DONE' }) },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  const legacy = testCore();
  try {
    const custom = await explicit.start({ repoPath: path, task: 'snapshot timeout', ownedPaths: ['src/**'] }, { launch: false });
    assert.equal((await explicit.manager.store.get(custom.jobId)).executionProfile.attemptTimeoutMs, 45_000);
    const defaulted = await legacy.start({ repoPath: legacyPath, task: 'default timeout', ownedPaths: ['src/**'] }, { launch: false });
    assert.equal((await legacy.manager.store.get(defaulted.jobId)).executionProfile.attemptTimeoutMs, 300_000);
  } finally {
    await explicit.shutdown();
    await legacy.shutdown();
    await rm(path, { recursive: true, force: true });
    await rm(legacyPath, { recursive: true, force: true });
  }
});

test('Core forwards the accepted provider attempt timeout to the worker adapter', async () => {
  const path = await repo('offload-core-forward-attempt-timeout-');
  const configured = structuredClone(loaded);
  configured.config.providers.test = {
    ...configured.config.providers.test,
    baseUrl: 'http://127.0.0.1:4321/v1',
    attemptTimeoutMs: 45_000,
  };
  configured.config.profiles.test.model = 'mock-model';
  const pricingTable = {
    fetched_at: '2026-10-01',
    models: {
      'mock-model': {
        usd_per_1m: {
          input_cache_hit: { off_peak: 0, peak: 0 },
          input_cache_miss: { off_peak: 0, peak: 0 },
          output: { off_peak: 0, peak: 0 },
        },
      },
    },
  };
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const seenDelays = [];
  globalThis.fetch = async (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true }));
  globalThis.setTimeout = (callback, delay, ...args) => {
    seenDelays.push(delay);
    if (delay === 45_000) {
      queueMicrotask(() => callback(...args));
      return { unref() {} };
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  const core = createCore({ config: { loaded: configured, pricingTable, resolveKey: () => 'credential' } });
  try {
    const started = await core.start({ repoPath: path, task: 'forward provider timeout', ownedPaths: ['src/**'] });
    const done = await core.wait(started.jobId, { repoPath: path, timeoutSec: 5 });
    assert.equal(done.status, 'TIMEOUT');
    assert.deepEqual(done.providerFailure, { kind: 'attempt_timeout', attempts: 1, timeoutMs: 45_000 });
    assert.ok(seenDelays.includes(45_000));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    await core.shutdown();
    await rm(path, { recursive: true, force: true });
  }
});

test('initializing a repo recovers interrupted jobs before job visibility', async () => {
  const path = await repo('offload-core-recover-');
  const store = new JobStore({ gitDir: getGitDir(path) });
  const stale = await store.create({
    repoPath: path,
    task: 'interrupted',
    ownedPaths: ['src/**'],
    branch: 'main',
    head: 'a'.repeat(40),
    status: 'RUNNING',
  });
  const core = testCore();
  const inspected = await core.job(stale.id, { repoPath: path });
  assert.match(inspected.report, /FAILED/);
  assert.match(inspected.report, /server restarted/);
});

test('a raw-tampered sealed Core job never reaches the provider', async (t) => {
  let server;
  try {
    server = await createMockOpenAIServer([{ chunks: [finishChunk(), usageChunk] }]);
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('loopback networking is unavailable in this sandbox');
      return;
    }
    throw error;
  }
  try {
    const path = await repo('offload-integrity-tamper-');
    const secureLoaded = structuredClone(loaded);
    secureLoaded.config.providers.test.baseUrl = server.baseUrl;
    const pricingTable = {
      fetched_at: '2026-10-01',
      models: {
        'test-model': {
          usd_per_1m: {
            input_cache_hit: { off_peak: 0, peak: 0 },
            input_cache_miss: { off_peak: 0, peak: 0 },
            output: { off_peak: 0, peak: 0 },
          },
        },
      },
    };
    const core = createCore({
      config: { loaded: secureLoaded, pricingTable, resolveKey: () => 'integrity-test-key' },
      snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
    });
    const started = await core.start({ repoPath: path, task: 'do not send', ownedPaths: ['src/**'] }, { launch: false });
    await core.assignWorkerPid(started.jobId, process.pid, path);
    const record = join(getGitDir(path), 'offload', 'jobs', started.jobId, 'job.json');
    const tampered = JSON.parse(await readFile(record, 'utf8'));
    tampered.executionProfile.baseUrl = server.baseUrl.replace('127.0.0.1', 'localhost');
    await writeFile(record, JSON.stringify(tampered));
    await assert.rejects(() => core.resume(started.jobId, path), /integrity check failed/);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('credential rotation invalidates a sealed queued Core job in the same and a new Core', async () => {
  const path = await repo('offload-integrity-rotation-');
  const statePath = await mkdtemp(join(tmpdir(), 'offload-integrity-state-'));
  const integrityVault = memoryWindowsIntegrityVault();
  let credential = 'first-credential';
  const first = createCore({
    config: integrityTestConfig({ statePath, integrityVault, resolveKey: () => credential }),
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  const started = await first.start({ repoPath: path, task: 'rotate', ownedPaths: ['src/**'] }, { launch: false });
  credential = 'rotated-credential';
  await assert.rejects(() => first.resume(started.jobId, path), /integrity check failed/);
  const second = createCore({
    config: integrityTestConfig({ statePath, integrityVault, resolveKey: () => credential }),
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  await assert.rejects(() => second.resume(started.jobId, path), /integrity check failed/);
});

test('credential rotation permits only MAC-verified detached cancellation and recovery cleanup', async () => {
  const path = await repo('offload-integrity-operational-');
  const statePath = await mkdtemp(join(tmpdir(), 'offload-integrity-state-'));
  const integrityVault = memoryWindowsIntegrityVault();
  let credential = 'first-credential';
  const calls = [];
  const resolveKey = (ref) => {
    calls.push(ref);
    return credential;
  };
  const first = createCore({
    config: integrityTestConfig({ statePath, integrityVault, resolveKey }),
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  const cancellable = await first.start({ repoPath: path, task: 'detached running', ownedPaths: ['src/**'] }, { launch: false });
  const recoverable = await first.start({ repoPath: path, task: 'detached stale', ownedPaths: ['lib/**'] }, { launch: false });
  await first.manager.store.update(cancellable.jobId, {
    status: 'RUNNING',
    handoffState: 'RUNNING',
    runnerPid: process.pid,
    runnerHeartbeatAt: new Date().toISOString(),
  });
  await first.manager.store.update(recoverable.jobId, {
    status: 'RUNNING',
    handoffState: 'RUNNING',
    runnerPid: 999999999,
    runnerHeartbeatAt: new Date(0).toISOString(),
  });
  credential = 'rotated-credential';
  calls.length = 0;
  const second = createCore({
    config: integrityTestConfig({ statePath, integrityVault, resolveKey }),
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  await second.recover(path);
  assert.equal(
    (await second.manager.store.getOperational(recoverable.jobId)).status,
    'FAILED',
    'recovery sees and finalizes the root-MAC-authenticated stale job',
  );
  const cancelled = await second.cancel(cancellable.jobId, { repoPath: path });
  assert.equal(cancelled.status, 'RUNNING');
  assert.equal(await second.manager.store.cancelRequested(cancellable.jobId), true, 'cross-process cancel leaves its durable marker');
  assert.deepEqual(calls, [], 'operational cleanup never resolves the persisted keyRef');
  await assert.rejects(
    () => second.resume(cancellable.jobId, path),
    /integrity check failed/,
    'execution still requires the original credential fingerprint',
  );
});

test(
  'a missing integrity root is never recreated over a corrupt orphan job entry',
  { skip: process.platform === 'win32' && 'Windows stores integrity roots in Credential Locker' },
  async () => {
    const path = await repo('offload-integrity-orphan-');
    const statePath = await mkdtemp(join(tmpdir(), 'offload-integrity-state-'));
    const first = createCore({
      config: { loaded, integrityStatePath: statePath, resolveKey: () => 'credential' },
      snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
    });
    const started = await first.start({ repoPath: path, task: 'establish root', ownedPaths: ['src/**'] }, { launch: false });
    const jobs = join(getGitDir(path), 'offload', 'jobs');
    await rm(join(jobs, started.jobId), { recursive: true, force: true });
    await mkdir(join(jobs, 'oj-corrupt-orphan'));
    await writeFile(join(jobs, 'oj-corrupt-orphan', 'job.json'), '{"id":"oj-corrupt-orphan"');
    await rm(join(statePath, 'integrity-root-v1'));
    const resolverCalls = [];
    const restarted = createCore({
      config: {
        loaded,
        integrityStatePath: statePath,
        resolveKey: (ref) => {
          resolverCalls.push(ref);
          return 'credential';
        },
      },
    });
    await assert.rejects(
      () => restarted.start({ repoPath: path, task: 'must not recreate root', ownedPaths: ['lib/**'] }, { launch: false }),
      /integrity root is unavailable/,
    );
    assert.deepEqual(resolverCalls, [], 'raw durable-entry detection neither parses the orphan nor resolves credentials');
  },
);

test('initial sealed records redact the freshly preflighted literal credential', async () => {
  const path = await repo('offload-integrity-initial-redaction-');
  const statePath = await mkdtemp(join(tmpdir(), 'offload-integrity-state-'));
  const integrityVault = memoryWindowsIntegrityVault();
  const credential = 'unusual-literal-credential-123456';
  const core = createCore({
    config: integrityTestConfig({ statePath, integrityVault, resolveKey: () => credential }),
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  const started = await core.start(
    {
      repoPath: path,
      task: `never persist ${credential}`,
      ownedPaths: ['src/**'],
      testCommand: `echo ${credential}`,
      unsafePolicyOnlyVerifier: true,
    },
    { launch: false },
  );
  const raw = await readFile(join(getGitDir(path), 'offload', 'jobs', started.jobId, 'job.json'), 'utf8');
  assert.equal(raw.includes(credential), false);
  assert.match(raw, /\[REDACTED\]/);
});

test('tampered keyRef never reaches a resolver before MAC verification', async () => {
  const path = await repo('offload-integrity-keyref-');
  const statePath = await mkdtemp(join(tmpdir(), 'offload-integrity-state-'));
  const integrityVault = memoryWindowsIntegrityVault();
  const calls = [];
  const resolveKey = (ref) => {
    calls.push(ref);
    if (ref === 'env:IGNORED') return 'original-credential';
    if (ref === 'env:ATTACKER') return 'attacker-known-credential';
    throw new Error('unknown ref');
  };
  const first = createCore({
    config: integrityTestConfig({ statePath, integrityVault, resolveKey }),
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  const started = await first.start({ repoPath: path, task: 'bound', ownedPaths: ['src/**'] }, { launch: false });
  const record = join(getGitDir(path), 'offload', 'jobs', started.jobId, 'job.json');
  const tampered = JSON.parse(await readFile(record, 'utf8'));
  tampered.executionProfile.keyRef = 'env:ATTACKER';
  await writeFile(record, JSON.stringify(tampered));
  calls.length = 0;
  const resumed = createCore({
    config: integrityTestConfig({ statePath, integrityVault, resolveKey }),
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  await assert.rejects(() => resumed.resume(started.jobId, path), /integrity check failed/);
  assert.deepEqual(calls, [], 'job.json must not select a credential resolver before its MAC passes');
});

test('sealed keyRef remains authoritative across later config edits', async () => {
  const path = await repo('offload-integrity-config-change-');
  const statePath = await mkdtemp(join(tmpdir(), 'offload-integrity-state-'));
  const integrityVault = memoryWindowsIntegrityVault();
  const calls = [];
  const resolveKey = (ref) => {
    calls.push(ref);
    if (ref === 'env:IGNORED') return 'original-credential';
    if (ref === 'env:ATTACKER') return 'changed-config-credential';
    throw new Error('unknown ref');
  };
  const original = createCore({
    config: integrityTestConfig({ statePath, integrityVault, resolveKey }),
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  const started = await original.start({ repoPath: path, task: 'stable config', ownedPaths: ['src/**'] }, { launch: false });
  const changed = structuredClone(loaded);
  changed.config.providers.test.keyRef = 'env:ATTACKER';
  changed.config.providers.test.baseUrl = 'https://changed.example.test';
  calls.length = 0;
  const afterEdit = createCore({
    config: integrityTestConfig({ loaded: changed, statePath, integrityVault, resolveKey }),
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  await assert.rejects(
    () => afterEdit.resume(started.jobId, path),
    /cannot be resumed/,
    'the expected handoff-state error proves MAC validation succeeded',
  );
  assert.ok(calls.length > 0 && calls.every((ref) => ref === 'env:IGNORED'));
});

test('root state rejects in-repo paths and Windows ignores hostile APPDATA/XDG', async () => {
  const path = await repo('offload-integrity-state-path-');
  assert.equal(insidePath('ignored', 'ignored', { relativePath: () => 'D:\\state', isAbsolutePath: () => true, platform: 'win32' }), false);
  assert.equal(
    defaultIntegrityStatePath({ platform: 'win32', home: 'C:\\Users\\A', env: { XDG_CONFIG_HOME: 'D:\\shared', APPDATA: 'D:\\evil' } }),
    undefined,
  );
  assert.equal(integrityStateHintAllowed('D:\\shared', { platform: 'win32' }), false);
  const unsafe = createCore({
    config: { loaded, integrityPlatform: 'darwin', integrityStatePath: join(path, 'integrity-state'), resolveKey: () => 'credential' },
  });
  await assert.rejects(
    () => unsafe.start({ repoPath: path, task: 'unsafe hook', ownedPaths: ['src/**'] }, { launch: false }),
    /must not be inside the repository/,
  );
  const windowsCustom = createCore({
    config: {
      loaded,
      integrityPlatform: 'win32',
      integrityStatePath: join(tmpdir(), 'hostile'),
      integrityVault: { read: () => undefined, writeIfAbsent: () => {} },
      resolveKey: () => 'credential',
    },
  });
  await assert.rejects(
    () => windowsCustom.start({ repoPath: path, task: 'windows custom path', ownedPaths: ['src/**'] }, { launch: false }),
    /custom integrity state paths/,
  );
  const values = new Map(),
    writes = [];
  const core = createCore({
    config: {
      loaded,
      integrityPlatform: 'win32',
      integrityVault: {
        read: (credential) => values.get(credential.resource),
        writeIfAbsent: (credential, value) => {
          writes.push(credential);
          if (values.has(credential.resource)) throw new Error('exists');
          values.set(credential.resource, value);
        },
      },
      resolveKey: () => 'credential',
    },
    snapshots: { create: async () => 'a'.repeat(40), diff: async () => '' },
  });
  await core.start({ repoPath: path, task: 'windows root', ownedPaths: ['src/**'] }, { launch: false });
  await core.start({ repoPath: path, task: 'windows root again', ownedPaths: ['lib/**'] }, { launch: false });
  assert.deepEqual(writes, [WINDOWS_INTEGRITY_ROOT_CREDENTIAL]);
  assert.deepEqual([...values.keys()], [WINDOWS_INTEGRITY_ROOT_CREDENTIAL.resource]);
});

test(
  'explicit integrity state rejects symlinked and insecure parent directories',
  { skip: process.platform === 'win32' && 'POSIX ownership/mode checks are not applicable on Windows' },
  async () => {
    const path = await repo('offload-integrity-parent-');
    const base = await mkdtemp(join(tmpdir(), 'offload-integrity-parent-'));
    const outside = await mkdtemp(join(tmpdir(), 'offload-integrity-outside-'));
    try {
      const link = join(base, 'linked');
      await symlink(outside, link);
      const linked = createCore({ config: { loaded, integrityStatePath: link, resolveKey: () => 'credential' } });
      await assert.rejects(
        () => linked.start({ repoPath: path, task: 'linked state', ownedPaths: ['src/**'] }, { launch: false }),
        /integrity state directory/,
      );
      await chmod(base, 0o777);
      const insecure = createCore({ config: { loaded, integrityStatePath: join(base, 'state'), resolveKey: () => 'credential' } });
      await assert.rejects(
        () => insecure.start({ repoPath: path, task: 'insecure state', ownedPaths: ['lib/**'] }, { launch: false }),
        /integrity state directory/,
      );
    } finally {
      await chmod(base, 0o700).catch(() => {});
    }
  },
);

test('real CLI start with a missing key fails before creating a job or lease', async () => {
  const path = await repo('offload-cli-child-');
  const home = await mkdtemp(join(tmpdir(), 'offload-cli-home-'));
  const startedAt = Date.now();
  const start = spawnSync(
    process.execPath,
    ['bin/offload.mjs', 'start', '--task', 'no configured key', '--ownedPaths', '["src/**"]', '--repoPath', path],
    { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config') }, timeout: 5_000 },
  );
  assert.equal(start.status, 2);
  assert.ok(Date.now() - startedAt < 4_000, 'key preflight should fail promptly');
  assert.equal(start.stdout, '');
  assert.match(start.stderr, /worker key is unavailable/);
  const store = new JobStore({ gitDir: getGitDir(path) });
  await store.init(path);
  assert.deepEqual(await store.list({ limit: 100 }), [], 'missing credentials must not create a job before lease acquisition');
});

test('detached CLI worker inherits env keyRef without putting it in argv or output', async (t) => {
  const path = await repo('offload-cli-env-key-'),
    home = await mkdtemp(join(tmpdir(), 'offload-cli-env-home-'));
  let server;
  try {
    server = await createMockOpenAIServer([
      {
        chunks: [
          {
            model: 'mock-model',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'finish',
                      type: 'function',
                      function: { name: 'finish', arguments: '{"summary":"ok","concerns":[],"testsRun":[]}' },
                    },
                  ],
                },
              },
            ],
          },
          { model: 'mock-model', choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
        ],
      },
    ]);
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('loopback networking is unavailable in this sandbox');
      return;
    }
    throw error;
  }
  try {
    const configDir = join(home, 'config', 'offload');
    await mkdir(configDir, { recursive: true });
    const pricingPath = join(configDir, 'pricing.json');
    await writeFile(
      pricingPath,
      JSON.stringify({
        fetched_at: '2026-10-01',
        models: {
          'mock-model': {
            usd_per_1m: {
              input_cache_hit: { off_peak: 0, peak: 0 },
              input_cache_miss: { off_peak: 0, peak: 0 },
              output: { off_peak: 0, peak: 0 },
            },
          },
        },
      }),
    );
    await writeFile(
      join(configDir, 'config.json'),
      JSON.stringify({
        providers: { mock: { type: 'openai-chat', baseUrl: server.baseUrl, keyRef: 'env:OFFLOAD_E2E_KEY', pricingFile: 'pricing.json' } },
        profiles: { mock: { provider: 'mock', model: 'mock-model' } },
        default: 'mock',
      }),
    );
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), OFFLOAD_E2E_KEY: 'not-in-output' };
    const start = spawnSync(
      process.execPath,
      ['bin/offload.mjs', 'start', '--task', 'finish', '--ownedPaths', '["src/**"]', '--repoPath', path],
      { cwd: process.cwd(), encoding: 'utf8', env, timeout: 5_000 },
    );
    assert.equal(start.status, 0, start.stderr);
    assert.doesNotMatch(`${start.stdout}${start.stderr}`, /not-in-output/);
    const jobId = JSON.parse(start.stdout).jobId;
    let inspected;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const query = spawnSync(process.execPath, ['bin/offload.mjs', 'job', jobId, '--repoPath', path], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env,
        timeout: 5_000,
      });
      assert.equal(query.status, 0, query.stderr);
      inspected = JSON.parse(query.stdout);
      if (inspected.status === 'DONE_UNVERIFIED') break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(inspected.status, 'DONE_UNVERIFIED');
    assert.equal(server.requests[0].headers.authorization, 'Bearer not-in-output');
  } finally {
    await server.close();
  }
});

test('detached worker remains alive across automatic repair and publishes the repaired result', async (t) => {
  if (!sandboxAvailable()) {
    t.skip('automatic repair requires an actual macOS verifier sandbox');
    return;
  }
  const path = await repo('offload-cli-auto-repair-'),
    home = await mkdtemp(join(tmpdir(), 'offload-cli-auto-home-'));
  let server;
  try {
    server = await createMockOpenAIServer([
      { chunks: [finishChunk('first pass'), usageChunk] },
      { chunks: [toolChunk('write-repair', 'write_file', { path: 'src/repaired.txt', content: 'ok\n' }), usageChunk] },
      { chunks: [finishChunk('repaired'), usageChunk] },
    ]);
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('loopback networking is unavailable in this sandbox');
      return;
    }
    throw error;
  }
  try {
    await mkdir(join(path, 'src'));
    await writeMockConfig(home, server);
    const env = cliEnv(home);
    const verifier =
      process.platform === 'win32'
        ? `${JSON.stringify(process.execPath)} -e ${JSON.stringify("const fs=require('fs');process.exit(fs.existsSync('src/repaired.txt') ? 0 : 1)")}`
        : 'test -f src/repaired.txt';
    const started = cli(
      ['start', '--task', 'repair after verifier failure', '--ownedPaths', '["src/**"]', '--testCommand', verifier, '--repoPath', path],
      env,
    );
    assert.equal(started.status, 0, started.stderr);
    const id = JSON.parse(started.stdout).jobId;
    const done = await pollStoredJob(id, path, (job) => job.status === 'DONE_VERIFIED');
    assert.equal(done.status, 'DONE_VERIFIED', JSON.stringify(done));
    assert.equal(server.requests.length, 3, 'the child must make the repair round request before exiting');
  } finally {
    await server.close();
  }
});

test('cross-process cancel aborts a detached provider request and preserves the partial patch', async (t) => {
  const path = await repo('offload-cli-cancel-provider-'),
    home = await mkdtemp(join(tmpdir(), 'offload-cli-cancel-home-'));
  let server;
  try {
    server = await createMockOpenAIServer([
      { chunks: [toolChunk('partial-write', 'write_file', { path: 'src/partial.txt', content: 'partial\n' }), usageChunk] },
      { chunks: [{ model: 'mock-model', choices: [{ delta: { content: 'waiting' } }] }], stallAfterChunks: 1, stallMs: 30_000 },
    ]);
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('loopback networking is unavailable in this sandbox');
      return;
    }
    throw error;
  }
  try {
    await mkdir(join(path, 'src'));
    await writeMockConfig(home, server);
    const env = cliEnv(home);
    const started = cli(['start', '--task', 'write then wait', '--ownedPaths', '["src/**"]', '--repoPath', path], env);
    assert.equal(started.status, 0, started.stderr);
    const id = JSON.parse(started.stdout).jobId;
    await pollJob(id, path, env, () => server.requests.length >= 2, 80);
    const cancelled = cli(['cancel', id, '--repoPath', path], env);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    const done = await pollJob(id, path, env, (job) => job.status === 'CANCELLED');
    assert.equal(done.status, 'CANCELLED');
    const diff = cli(['job', id, '--include', 'diff', '--repoPath', path], env);
    assert.equal(diff.status, 0, diff.stderr);
    assert.match(JSON.parse(diff.stdout).diff, /partial\.txt/);
  } finally {
    await server.close();
  }
});

test('child uses its accepted execution, policy, and pricing snapshot after config changes', async (t) => {
  const path = await repo('offload-cli-stable-config-'),
    home = await mkdtemp(join(tmpdir(), 'offload-cli-stable-home-'));
  let server;
  try {
    server = await createMockOpenAIServer([{ chunks: [finishChunk('snapshot'), usageChunk] }]);
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('loopback networking is unavailable in this sandbox');
      return;
    }
    throw error;
  }
  const oldXdg = process.env.XDG_CONFIG_HOME,
    oldKey = process.env.OFFLOAD_E2E_KEY;
  let child;
  try {
    const { configDir, pricingPath } = await writeMockConfig(home, server);
    const env = cliEnv(home);
    process.env.XDG_CONFIG_HOME = join(home, 'config');
    process.env.OFFLOAD_E2E_KEY = env.OFFLOAD_E2E_KEY;
    const core = createCore({ config: { configPath: join(configDir, 'config.json') } });
    const started = await core.start(
      { repoPath: path, task: 'persist snapshot', ownedPaths: ['src/**', '.offload.json'] },
      { launch: false },
    );
    await writeFile(join(path, '.offload.json'), JSON.stringify({ disabled: true, denyRead: ['**'] }));
    await writeFile(pricingPath, '{"models": "changed-invalid"}');
    await writeFile(
      join(configDir, 'config.json'),
      JSON.stringify({
        providers: { mock: { type: 'openai-chat', baseUrl: 'http://127.0.0.1:1', keyRef: 'env:OTHER', pricingFile: 'pricing.json' } },
        profiles: { mock: { provider: 'mock', model: 'other-model' } },
        default: 'mock',
      }),
    );
    child = spawn(process.execPath, ['bin/offload.mjs', 'worker', started.jobId, '--repoPath', path], {
      cwd: process.cwd(),
      env,
      stdio: 'ignore',
    });
    await core.assignWorkerPid(started.jobId, child.pid, path);
    const result = await pollStoredJob(started.jobId, path, (job) => job.status === 'DONE_UNVERIFIED');
    assert.equal(result.status, 'DONE_UNVERIFIED', JSON.stringify(result));
    assert.equal(server.requests.length, 1);
  } finally {
    if (child && child.exitCode == null) child.kill('SIGTERM');
    if (oldXdg == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldKey == null) delete process.env.OFFLOAD_E2E_KEY;
    else process.env.OFFLOAD_E2E_KEY = oldKey;
    await server.close();
  }
});
test('a real worker loop on a failing call ends FAILED with the redacted call, then continue resumes it with that call in the prompt', async () => {
  const path = await repo('offload-core-loop-failure-');
  const originalFetch = globalThis.fetch;
  const requests = [];
  const sse = (chunks) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  const script = [
    [toolChunk('write-new', 'write_file', { path: 'src/new.js', content: 'export const n = 1;\n' }), usageChunk],
    ...[1, 2, 3].map((n) => [toolChunk(`read-missing-${n}`, 'read_file', { path: 'src/missing.js' }), usageChunk]),
    [finishChunk('resumed'), usageChunk],
  ];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(sse(script.shift()), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const isolation = { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree };
  try {
    const configured = structuredClone(loaded);
    configured.config.providers.test.baseUrl = 'http://127.0.0.1:4321/v1';
    configured.config.profiles.test.model = 'mock-model';
    const pricingTable = {
      fetched_at: '2026-10-01',
      models: {
        'mock-model': {
          usd_per_1m: {
            input_cache_hit: { off_peak: 0, peak: 0 },
            input_cache_miss: { off_peak: 0, peak: 0 },
            output: { off_peak: 0, peak: 0 },
          },
        },
      },
    };
    const core = createCore({ config: { loaded: configured, pricingTable, resolveKey: () => 'credential', isolation }, isolation });
    try {
      const started = await core.start({ repoPath: path, task: 'loop on a missing file', ownedPaths: ['src/**'] });
      const failed = await core.wait(started.jobId, { repoPath: path, timeoutSec: 20 });
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.failureKind, 'tool-loop');
      const { toolFailure } = failed;
      assert.equal(toolFailure.tool, 'read_file');
      assert.equal(toolFailure.args, '{"path":"src/missing.js"}');
      assert.equal(toolFailure.turn, 4);
      assert.equal(toolFailure.repeats, 3);
      // The recorded error is the real one, but no directory of this machine is in it.
      const shown = JSON.stringify([toolFailure, failed.report]);
      for (const private_ of [path, await realpath(path), tmpdir(), process.env.HOME])
        assert.ok(!private_ || !shown.includes(private_), private_);
      assert.equal(toolFailure.error, "ENOENT: no such file or directory, lstat '<worktree>/src/missing.js'");
      assert.ok(
        failed.report
          .split('\n')
          .some((line) => line.startsWith('last failing tool call: read_file {"path":"src/missing.js"} (turn 4, failed 3x) -- ')),
      );
      assert.match(failed.report, /next: .*\bcontinue\b/);
      // The worker itself only ever got the generic text (plus a fixed hint, if any).
      const replies = requests[3].messages
        .filter((message) => message.role === 'tool' && message.content.startsWith('TOOL_ERROR'))
        .map((message) => message.content);
      assert.deepEqual(replies, Array(2).fill('TOOL_ERROR: Tool execution failed'));
      assert.doesNotMatch(JSON.stringify(requests), new RegExp(toolFailure.error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      await core.continue(started.jobId, { repoPath: path });
      const done = await core.wait(started.jobId, { repoPath: path, timeoutSec: 20 });
      assert.equal(done.status, 'DONE_UNVERIFIED');
      const prompt = requests[4].messages.at(-1);
      assert.equal(prompt.role, 'user');
      // A missing path carries no hint, and the recorded error never reaches the worker.
      assert.ok(prompt.content.includes('Last failing call (turn 4): read_file {"path":"src/missing.js"}. Do NOT repeat that call'));
      assert.ok(!prompt.content.includes('ENOENT'));
      assert.ok(prompt.content.includes('Do NOT repeat that call'));
      assert.deepEqual(
        requests[4].messages
          .filter((message) => message.role === 'assistant' && message.tool_calls)
          .map((message) => message.tool_calls[0].id),
        ['write-new', 'read-missing-1', 'read-missing-2'],
        'the abandoned third failing call is not replayed',
      );
    } finally {
      await core.shutdown();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(path, { recursive: true, force: true });
  }
});
test('a real worker loop through Core records provider calls, tool timings and a time breakdown that adds up', async () => {
  const path = await repo('offload-core-timing-');
  const originalFetch = globalThis.fetch;
  const sse = (chunks) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  const script = [
    [toolChunk('write-a', 'write_file', { path: 'src/a.js', content: 'export const a = 1;\n' }), usageChunk],
    [toolChunk('read-a', 'read_file', { path: 'src/a.js' }), usageChunk],
    [finishChunk('timed'), usageChunk],
  ];
  globalThis.fetch = async () => new Response(sse(script.shift()), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const isolation = { create: createIsolatedWorktree, open: openIsolatedWorktree, cleanup: cleanupIsolatedWorktree };
  try {
    const configured = structuredClone(loaded);
    configured.config.providers.test.baseUrl = 'http://127.0.0.1:4321/v1';
    configured.config.profiles.test.model = 'mock-model';
    const zero = {
      input_cache_hit: { off_peak: 0, peak: 0 },
      input_cache_miss: { off_peak: 0, peak: 0 },
      output: { off_peak: 0, peak: 0 },
    };
    const pricingTable = { fetched_at: '2026-10-01', models: { 'mock-model': { usd_per_1m: zero } } };
    const core = createCore({ config: { loaded: configured, pricingTable, resolveKey: () => 'credential', isolation }, isolation });
    try {
      const started = await core.start({ repoPath: path, task: 'time a real loop', ownedPaths: ['src/**'] });
      const done = await core.wait(started.jobId, { repoPath: path, timeoutSec: 20, detail: 'full' });
      assert.equal(done.status, 'DONE_UNVERIFIED');
      const [round] = done.timing.rounds;
      assert.equal(round.providerCalls, 3, 'one completed request per scripted turn');
      assert.equal(round.toolCalls, 2, 'the write and the read; finish is not a tool batch');
      assert.equal(round.toolMaxName === 'write_file' || round.toolMaxName === 'read_file', true);
      assert.equal(round.activeMs, round.startupMs + round.providerMs + round.toolMs + round.verifyMs + round.finalizeMs + round.otherMs);
      assert.ok(round.queueMs >= 0 && round.setupMs >= 0, 'the queue and setup figures come from the real start path');
      assert.ok(done.report.split('\n').some((line) => line.startsWith('timing round 0 (start): ')));
      // The log shows each provider call's latency as `prevMs` on the event after it.
      const log = await core.job(started.jobId, { repoPath: path, include: 'log', limit: 60_000, tail: 1000 });
      const progress = log.log
        .split('\n')
        .filter((line) => line.startsWith('{"type":"progress"'))
        .map((line) => JSON.parse(line));
      const afterProvider = progress.filter((event) => event.prevPhase === 'provider');
      assert.equal(afterProvider.length, 3);
      for (const event of afterProvider) assert.ok(Number.isInteger(event.prevMs) && event.prevMs >= 0);
      assert.equal(
        progress.filter((event) => event.phase === 'tool').length,
        2,
        'a phase marker precedes each tool batch (and the finish turn has none)',
      );
      assert.equal(JSON.stringify(progress).includes('"timing"'), false, 'the job-state record is not copied into event history');
    } finally {
      await core.shutdown();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(path, { recursive: true, force: true });
  }
});
