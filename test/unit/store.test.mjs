import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { JobStore, atomicRename, readStoredBytes, readStoredFile, redact } from '../../src/store.mjs';
import { AgentContext } from '../../src/agent/context.mjs';
import { getGitDir } from '../../src/lease.mjs';
import { cleanup, tempDir } from './helpers.mjs';

test('atomic rename retries only transient Windows sharing failures', async () => {
  const attempts = [];
  const delays = [];
  await atomicRename('temporary', 'job.json', {
    platform: 'win32',
    renameFile: async () => {
      attempts.push('rename');
      if (attempts.length < 3) {
        const error = new Error('file is busy');
        error.code = 'EPERM';
        throw error;
      }
    },
    delay: async (ms) => delays.push(ms),
  });
  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [10, 20]);
  await assert.rejects(
    () =>
      atomicRename('temporary', 'job.json', {
        platform: 'linux',
        renameFile: async () => {
          const error = new Error('file is busy');
          error.code = 'EPERM';
          throw error;
        },
      }),
    /file is busy/,
  );
});

test('numeric budget reservation output tokens survive storage redaction while arbitrary token-shaped secrets remain redacted', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    await store.update(job.id, {
      budgetReservation: { conservativeInputTokens: 1234, minOutputTokens: 16, bearerToken: 'must-not-persist' },
    });
    const stored = await store.get(job.id);
    assert.equal(stored.budgetReservation.conservativeInputTokens, 1234);
    assert.equal(stored.budgetReservation.minOutputTokens, 16);
    assert.equal(stored.budgetReservation.bearerToken, '[REDACTED]');
    assert.deepEqual(redact({ conservativeInputTokens: 1234, minOutputTokens: 16, sessionToken: 'must-not-persist' }), {
      conservativeInputTokens: 1234,
      minOutputTokens: 16,
      sessionToken: '[REDACTED]',
    });
    assert.deepEqual(redact({ conservativeInputTokens: 'must-not-persist', minOutputTokens: 'not-a-count' }), {
      conservativeInputTokens: '[REDACTED]',
      minOutputTokens: '[REDACTED]',
    });
  } finally {
    cleanup(gitDir);
  }
});

test('failed preparation or initial record publication leaves no owned job directory', async () => {
  const gitDir = tempDir();
  try {
    const unavailable = new JobStore({ gitDir }).configureIntegrity({
      requiredFor: () => true,
      keyForId: () => 'key',
      prepare: async () => {
        throw new Error('unavailable');
      },
    });
    await assert.rejects(
      () => unavailable.create({ id: 'prepare-failure', task: 'x', ownedPaths: ['src/**'] }),
      /integrity key is unavailable/,
    );
    assert.throws(() => statSync(join(gitDir, 'offload', 'jobs', 'prepare-failure')));
    const oversized = new JobStore({ gitDir });
    await assert.rejects(
      () => oversized.create({ id: 'oversized-record', task: 'x'.repeat(1_100_000), ownedPaths: ['src/**'] }),
      /job exceeds size limit/,
    );
    assert.throws(() => statSync(join(gitDir, 'offload', 'jobs', 'oversized-record')));
  } finally {
    cleanup(gitDir);
  }
});

test('legacy store recovery stages interrupted jobs for JobManager cleanup instead of falsely publishing terminal completion', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    assert.equal(await store.recover(), 1);
    const staged = await store.get(job.id);
    assert.equal(staged.status, 'FINALIZING');
    assert.equal(staged.finalStatus, 'FAILED');
    assert.equal(staged.finishedAt, undefined);
    assert.equal((await store.readArtifact(job.id, 'events.jsonl')).includes('recovery-staged'), true);
  } finally {
    cleanup(gitDir);
  }
});

test('legacy recovery CAS does not overwrite a handoff that wins after its stale read', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir });
    const job = await store.create({
      task: 'handoff race',
      ownedPaths: ['src/**'],
      handoffState: 'PARENT_QUEUED',
      leaseOwnerNonce: 'parent',
    });
    const updateOperationalIf = store.updateOperationalIf.bind(store);
    let injected = false;
    store.updateOperationalIf = async (id, expected, changes) => {
      if (!injected && changes.status === 'FINALIZING') {
        injected = true;
        await store.update(id, {
          status: 'QUEUED',
          handoffState: 'CHILD_ASSIGNED',
          leaseOwnerNonce: 'child',
          runnerPid: process.pid,
          runnerHeartbeatAt: new Date().toISOString(),
        });
      }
      return updateOperationalIf(id, expected, changes);
    };
    assert.equal(await store.recover(), 0);
    const assigned = await store.get(job.id);
    assert.equal(assigned.status, 'QUEUED');
    assert.equal(assigned.handoffState, 'CHILD_ASSIGNED');
    assert.equal((await store.readArtifact(job.id, 'events.jsonl')).includes('recovery-staged'), false);
  } finally {
    cleanup(gitDir);
  }
});

test('sealed transcript batches publish all-or-nothing and recover a sealed interrupted rename', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir }).configureIntegrity({ requiredFor: () => true, keyForId: () => 'key' });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    const tooLarge = Array.from({ length: 5 }, () => ({ role: 'user', content: 'x'.repeat(1_000_000) }));
    await assert.rejects(() => store.messagesBatch(job.id, tooLarge), /transcript exceeds size limit/);
    assert.deepEqual(await store.readMessages(job.id), []);

    const text = `${JSON.stringify({ role: 'system', content: 'system' })}\n${JSON.stringify({ role: 'user', content: 'task' })}\n`;
    await store.update(job.id, {
      transcriptPendingDigest: createHash('sha256').update(text).digest('hex'),
      transcriptPendingBytes: Buffer.byteLength(text),
    });
    writeFileSync(join(gitDir, 'offload', 'jobs', job.id, 'messages.jsonl'), text);
    assert.deepEqual(
      (await store.readMessages(job.id)).map((message) => message.content),
      ['system', 'task'],
    );
    const healed = await store.healPublications(job.id);
    assert.equal(healed.transcriptPendingDigest, undefined);
    assert.deepEqual(await store.healPublications(job.id), healed, 'healing is idempotent');
    writeFileSync(join(gitDir, 'offload', 'jobs', job.id, 'messages.jsonl'), `${text}forged`);
    await assert.rejects(() => store.readMessages(job.id), /transcript integrity check failed/);
  } finally {
    cleanup(gitDir);
  }
});

test('publication intents are schema-checked and concurrent stores retain both transcript turns', async () => {
  const gitDir = tempDir();
  try {
    const first = new JobStore({ gitDir }).configureIntegrity({ requiredFor: () => true, keyForId: () => 'key' });
    const second = new JobStore({ gitDir }).configureIntegrity({ requiredFor: () => true, keyForId: () => 'key' });
    const job = await first.create({ task: 'x', ownedPaths: ['src/**'] });
    await assert.rejects(() => first.update(job.id, { transcriptPendingDigest: '0'.repeat(64) }), /publication intent is invalid/);
    await assert.rejects(
      () => first.update(job.id, { artifactPendingDigests: { 'messages.jsonl': '0'.repeat(64) } }),
      /publication intent is invalid/,
    );
    await Promise.all([
      first.messagesBatch(job.id, [{ role: 'user', content: 'first process' }]),
      second.messagesBatch(job.id, [{ role: 'user', content: 'second process' }]),
    ]);
    assert.deepEqual((await first.readMessages(job.id)).map((message) => message.content).sort(), ['first process', 'second process']);
  } finally {
    cleanup(gitDir);
  }
});

test('sealed transcripts retain explicit nullable assistant reasoning for provider replay', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir }).configureIntegrity({ requiredFor: () => true, keyForId: () => 'key' });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    const transcript = [
      {
        role: 'assistant',
        content: '',
        reasoning_content: null,
        tool_calls: [
          { id: 'write-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/a.mjs","content":"x"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'write-1', content: 'WROTE: src/a.mjs' },
    ];
    await store.messagesBatch(job.id, transcript);
    const restored = await store.readMessages(job.id);
    assert.equal(restored[0].reasoning_content, null);
    assert.equal((await store.get(job.id)).transcriptReplayable, true);
    assert.deepEqual(new AgentContext(restored).snapshot(), transcript);
  } finally {
    cleanup(gitDir);
  }
});

test('redacted assistant reasoning is durably marked non-replayable without retaining the secret', async () => {
  const gitDir = tempDir();
  const secret = 'sk-abcdefghijklmnop';
  try {
    const store = new JobStore({ gitDir }).configureIntegrity({ requiredFor: () => true, keyForId: () => 'key' });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    await store.messagesBatch(job.id, [
      {
        role: 'assistant',
        content: '',
        reasoning_content: `credential ${secret}`,
        tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.mjs"}' } }],
      },
      { role: 'tool', tool_call_id: 'read-1', content: 'READ: src/a.mjs' },
    ]);
    const stored = await store.get(job.id);
    const transcript = await store.readMessages(job.id);
    assert.equal(stored.transcriptReplayable, false);
    assert.match(transcript[0].reasoning_content, /\[REDACTED\]/);
    const durable = JSON.stringify({ stored, transcript });
    assert.doesNotMatch(durable, new RegExp(secret));
    assert.doesNotMatch(durable, /credential [a-z0-9_-]{12,}/i);
  } finally {
    cleanup(gitDir);
  }
});

test('clean assistant reasoning remains durably replayable', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir }).configureIntegrity({ requiredFor: () => true, keyForId: () => 'key' });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    await store.messagesBatch(job.id, [
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'inspect the local README',
        tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
      },
      { role: 'tool', tool_call_id: 'read-1', content: 'READ: README.md' },
    ]);
    const restored = await store.readMessages(job.id);
    assert.equal((await store.get(job.id)).transcriptReplayable, true);
    assert.equal(restored[0].reasoning_content, 'inspect the local README');
  } finally {
    cleanup(gitDir);
  }
});

test('publication locks grace a partial owner and serialize concurrent event records', async () => {
  const gitDir = tempDir();
  try {
    const first = new JobStore({ gitDir }),
      second = new JobStore({ gitDir });
    const job = await first.create({ task: 'x', ownedPaths: ['src/**'] });
    const directory = join(gitDir, 'offload', 'jobs', job.id);
    const lock = join(directory, '.publication-lock');
    // Simulate a contender observing the O_EXCL file between creation and its
    // atomic owner publication. It must wait rather than reject as malformed.
    writeFileSync(lock, '{');
    const append = first.messages(job.id, { role: 'user', content: 'after partial owner' });
    setTimeout(() => rmSync(lock, { force: true }), 20);
    await append;
    const payload = 'x'.repeat(500_000);
    await Promise.all(
      Array.from({ length: 4 }, (_, index) => (index % 2 ? first : second).event(job.id, { type: 'concurrent', index, payload })),
    );
    const lines = (await first.readArtifact(job.id, 'events.jsonl'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 4);
    assert.deepEqual(lines.map((event) => event.index).sort(), [0, 1, 2, 3]);
    assert.ok(lines.every((event) => event.payload === payload));
  } finally {
    cleanup(gitDir);
  }
});

test('event envelopes retain the store timestamp when a caller supplies at', async () => {
  const gitDir = tempDir();
  try {
    const at = new Date('2026-10-05T12:34:56.000Z');
    const store = new JobStore({ gitDir, now: () => at });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    await store.event(job.id, { type: 'progress', at: 'forged-time' });
    const [event] = (await store.readArtifact(job.id, 'events.jsonl'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(event.at, at.toISOString());
  } finally {
    cleanup(gitDir);
  }
});

test('two stale publication-lock reclaimers cannot lose either concurrent append', async () => {
  const gitDir = tempDir();
  try {
    const first = new JobStore({ gitDir }),
      second = new JobStore({ gitDir });
    const job = await first.create({ task: 'x', ownedPaths: ['src/**'] });
    const lock = join(gitDir, 'offload', 'jobs', job.id, '.publication-lock');
    writeFileSync(lock, JSON.stringify({ pid: 999_999_999, token: 'dead-owner' }));
    const old = new Date(Date.now() - 130_000);
    nodeFs.utimesSync(lock, old, old);
    await Promise.all([
      first.messages(job.id, { role: 'user', content: 'first reclaimer' }),
      second.messages(job.id, { role: 'user', content: 'second reclaimer' }),
    ]);
    assert.deepEqual((await first.readMessages(job.id)).map((message) => message.content).sort(), ['first reclaimer', 'second reclaimer']);
  } finally {
    cleanup(gitDir);
  }
});

test('resume durably replaces only an abandoned trailing tool transaction before a repair turn', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir }).configureIntegrity({ requiredFor: () => true, keyForId: () => 'key' });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    await store.messages(job.id, {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    });
    const resumed = new AgentContext(await store.readMessages(job.id), {
      onAppendBatch: (messages) => store.messagesBatch(job.id, messages),
    });
    assert.equal(resumed.trimmedIncomplete, true);
    await resumed.addBatch([{ role: 'user', content: 'repair after crash' }]);
    assert.deepEqual(
      (await store.readMessages(job.id)).map((message) => message.content),
      ['repair after crash'],
    );
  } finally {
    cleanup(gitDir);
  }
});

test('a new publication heals an earlier pre-rename intent before replacing transcript or artifact state', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir }).configureIntegrity({ requiredFor: () => true, keyForId: () => 'key' });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    await store.messages(job.id, { role: 'user', content: 'committed' });
    const oldText = `${JSON.stringify({ role: 'user', content: 'committed' })}\n`;
    const abandoned = `${oldText}${JSON.stringify({ role: 'user', content: 'abandoned' })}\n`;
    await store.update(job.id, {
      transcriptPendingDigest: createHash('sha256').update(abandoned).digest('hex'),
      transcriptPendingBytes: Buffer.byteLength(abandoned),
    });
    await store.messages(job.id, { role: 'user', content: 'next' });
    assert.deepEqual(
      (await store.readMessages(job.id)).map((message) => message.content),
      ['committed', 'next'],
    );

    await store.writeArtifact(job.id, 'report.md', 'old report');
    await store.update(job.id, { artifactPendingDigests: { 'report.md': createHash('sha256').update('abandoned report').digest('hex') } });
    await store.writeArtifact(job.id, 'report.md', 'next report');
    assert.equal(await store.readArtifact(job.id, 'report.md'), 'next report');
  } finally {
    cleanup(gitDir);
  }
});

test(
  'job storage refuses symlinked managed directories and artifacts',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  async () => {
    const gitDir = tempDir(),
      outside = tempDir();
    try {
      symlinkSync(outside, join(gitDir, 'offload'));
      await assert.rejects(() => new JobStore({ gitDir }).init(), /job storage directory is invalid/);
      rmSync(join(gitDir, 'offload'));
      const store = new JobStore({ gitDir });
      const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
      await store.requestCancel(job.id);
      await store.requestCancel(job.id);
      assert.equal(await store.cancelRequested(job.id), true);
      const artifact = join(gitDir, 'offload', 'jobs', job.id, 'patch.diff');
      writeFileSync(join(outside, 'outside.patch'), 'outside');
      symlinkSync(join(outside, 'outside.patch'), artifact);
      await assert.rejects(() => store.readArtifact(job.id, 'patch.diff'), /stored file is invalid/);
      const transcript = join(gitDir, 'offload', 'jobs', job.id, 'messages.jsonl');
      symlinkSync(join(outside, 'outside.patch'), transcript);
      await assert.rejects(() => store.messages(job.id, { role: 'user', content: 'x' }), /transcript file is invalid/);
    } finally {
      cleanup(gitDir);
      cleanup(outside);
    }
  },
);

test(
  'transcript append refuses a final-component symlink swap and remove initializes a fresh store',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  async () => {
    const gitDir = tempDir(),
      outside = tempDir();
    try {
      const store = new JobStore({ gitDir });
      const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
      const messages = join(gitDir, 'offload', 'jobs', job.id, 'messages.jsonl');
      const target = join(outside, 'messages.jsonl');
      writeFileSync(target, 'outside\n');
      symlinkSync(target, messages);
      await assert.rejects(() => store.messages(job.id, { role: 'user', content: 'x' }), /transcript file is invalid/);
      assert.equal(readFileSync(target, 'utf8'), 'outside\n');

      const fresh = new JobStore({ gitDir });
      await fresh.remove(job.id);
      assert.throws(() => statSync(join(gitDir, 'offload', 'jobs', job.id)));
    } finally {
      cleanup(gitDir);
      cleanup(outside);
    }
  },
);

test('store initialization is race-tolerant and uses a linked worktree gitdir', async () => {
  const root = tempDir(),
    worktree = `${root}-worktree`;
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    writeFileSync(join(root, 'README'), 'base\n');
    execFileSync('git', ['-C', root, 'add', 'README']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', worktree]);
    const first = new JobStore({ repoPath: worktree }),
      second = new JobStore({ repoPath: worktree });
    await Promise.all([first.init(), second.init()]);
    const gitDir = getGitDir(worktree);
    assert.equal(first.root, join(gitDir, 'offload', 'jobs'));
    assert.equal(second.root, first.root);
    assert.match((await first.create({ task: 'x', ownedPaths: ['src/**'] })).id, /^oj-/);
  } finally {
    cleanup(worktree);
    cleanup(root);
  }
});

test(
  'POSIX store rejects a non-sticky writable git ancestry and hardens managed directories by descriptor',
  { skip: process.platform === 'win32' && 'POSIX ownership/mode checks are not applicable on Windows' },
  async () => {
    const gitDir = tempDir();
    try {
      chmodSync(gitDir, 0o777);
      await assert.rejects(() => new JobStore({ gitDir }).init(), /job storage ancestry is insecure/);
      chmodSync(gitDir, 0o700);
      mkdirSync(join(gitDir, 'offload', 'jobs'), { recursive: true, mode: 0o755 });
      chmodSync(join(gitDir, 'offload'), 0o755);
      chmodSync(join(gitDir, 'offload', 'jobs'), 0o755);
      const store = new JobStore({ gitDir });
      await store.init();
      assert.equal(statSync(join(gitDir, 'offload')).mode & 0o777, 0o700);
      assert.equal(statSync(join(gitDir, 'offload', 'jobs')).mode & 0o777, 0o700);
    } finally {
      try {
        chmodSync(gitDir, 0o700);
      } catch {}
      cleanup(gitDir);
    }
  },
);

test(
  'POSIX store rejects managed directories owned by another user before chmod/write',
  { skip: process.platform === 'win32' && 'POSIX ownership/mode checks are not applicable on Windows' },
  () => {
    const gitDir = tempDir();
    try {
      mkdirSync(join(gitDir, 'offload', 'jobs'), { recursive: true, mode: 0o700 });
      const result = spawnSync(process.execPath, ['test/fixtures/store-ownership-probe.mjs'], {
        encoding: 'utf8',
        env: { ...process.env, OFFLOAD_TEST_GIT_DIR: gitDir },
      });
      assert.equal(result.status, 0, result.stderr);
    } finally {
      cleanup(gitDir);
    }
  },
);

test(
  'checked store reads reject a deterministic final-component symlink swap',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  async () => {
    const dir = tempDir(),
      outside = tempDir(),
      file = join(dir, 'artifact');
    try {
      writeFileSync(file, 'trusted');
      writeFileSync(join(outside, 'artifact'), 'outside');
      let swapped = false;
      const fs = {
        constants: nodeFs.constants,
        lstat: (path, options) => nodeFs.promises.lstat(path, options),
        open: async (path, flags) => {
          if (!swapped) {
            swapped = true;
            nodeFs.rmSync(path);
            nodeFs.symlinkSync(join(outside, 'artifact'), path);
          }
          return nodeFs.promises.open(path, flags);
        },
      };
      // Exercise the Windows lstat/fstat fallback even on a POSIX host where
      // O_NOFOLLOW would otherwise reject the link before it is opened.
      await assert.rejects(
        () => readStoredFile(file, 100, null, { platform: 'win32', fs }),
        /stored file is invalid or changed while opening/,
      );
    } finally {
      cleanup(dir);
      cleanup(outside);
    }
  },
);

test('checked byte reads reject a same-inode same-size metadata change', async () => {
  const stat = ({ mtimeNs = 10n, ctimeNs = 10n } = {}) => ({
    dev: 1n,
    ino: 2n,
    size: 7n,
    mode: 0o100600n,
    mtimeNs,
    ctimeNs,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  let statCalls = 0;
  const fs = {
    constants: nodeFs.constants,
    lstat: async () => stat(),
    open: async () => ({
      stat: async () => (statCalls++ === 0 ? stat() : stat({ mtimeNs: 11n, ctimeNs: 11n })),
      read: async (buffer, offset) => {
        buffer.write('trusted', offset, 'utf8');
        return { bytesRead: 7 };
      },
      close: async () => {},
    }),
  };
  await assert.rejects(
    () => readStoredBytes('/managed/artifact', 100, null, { platform: 'win32', fs }),
    /stored file changed while reading/,
  );
});

test('patch artifacts retain raw bytes, authenticate their digest, and expose only a safe display', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir, secrets: ['sëcret'] }).configureIntegrity({
      requiredFor: () => true,
      keyForId: () => 'credential',
    });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    const raw = Buffer.from([0x64, 0x69, 0x66, 0x66, 0x0a, 0x2b, 0xff, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x0a]);
    await store.writeArtifact(job.id, 'patch.diff', raw);
    assert.deepEqual(await store.readArtifactBytes(job.id, 'patch.diff'), raw);
    const display = await store.readArtifact(job.id, 'patch.diff');
    assert.match(display, /^\[Lossy display: exact patch bytes are retained for apply\/revert\.\]\n/);
    assert.doesNotMatch(display, /\x1b/);
    await assert.rejects(() => store.writeArtifact(job.id, 'patch.diff', Buffer.from('prefix sëcret suffix', 'utf8')), /configured secret/);
    const artifact = join(gitDir, 'offload', 'jobs', job.id, 'patch.diff');
    writeFileSync(artifact, Buffer.from([0x64, 0x69, 0x66, 0x66, 0x0a, 0x2b, 0xfe, 0x0a]));
    await assert.rejects(() => store.readArtifactBytes(job.id, 'patch.diff'), /artifact integrity check failed/);
    writeFileSync(artifact, raw);
    const recordPath = join(gitDir, 'offload', 'jobs', job.id, 'job.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    record.artifactDigests['patch.diff'] = '0'.repeat(64);
    writeFileSync(recordPath, JSON.stringify(record));
    await assert.rejects(() => store.readArtifactBytes(job.id, 'patch.diff'), /stored job integrity check failed/);
  } finally {
    cleanup(gitDir);
  }
});

test('text artifacts remain strict UTF-8 while terminal controls mark a patch display as lossy', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    await assert.rejects(() => store.writeArtifact(job.id, 'report.md', Buffer.from([0xff])), /not valid UTF-8/);
    await store.writeArtifact(job.id, 'patch.diff', 'diff --git a/a b/a\n+safe\u202Etext\n');
    const display = await store.readArtifact(job.id, 'patch.diff');
    assert.match(display, /^\[Lossy display:/);
    assert.match(display, /<U\+202E>/);
  } finally {
    cleanup(gitDir);
  }
});

test('configured store seals canonical persisted jobs and refuses tampered updates', async () => {
  const gitDir = tempDir(),
    keys = new Map([
      ['env:GOOD', 'good-credential'],
      ['env:OTHER', 'other-credential'],
    ]);
  try {
    const store = new JobStore({ gitDir }).configureIntegrity({ requiredFor: () => true, keyForId: () => keys.get('env:GOOD') });
    assert.equal(typeof store.writeJob, 'undefined', 'callers cannot use a whole-record re-sign primitive');
    const job = await store.create({
      task: 'x',
      ownedPaths: ['src/**'],
      metadata: new Date('2026-01-01T00:00:00.000Z'),
      budget: { maxUsd: 1 },
      status: 'QUEUED',
      executionProfile: { type: 'openai-chat', baseUrl: 'https://provider.example.test/v1', keyRef: 'env:GOOD', model: 'model' },
    });
    assert.equal(store.verifyJob(await store.get(job.id)), true);
    assert.equal(store.verifyJob(await store.get(job.id)), true, 'non-JSON object input is normalized before sealing');
    const path = join(gitDir, 'offload', 'jobs', job.id, 'job.json');
    const original = readFileSync(path, 'utf8');
    for (const alter of [
      (value) => {
        value.executionProfile.baseUrl = 'https://attacker.example.test/v1';
      },
      (value) => {
        value.executionProfile.keyRef = 'env:OTHER';
      },
      (value) => {
        delete value.executionProfile;
      },
      (value) => {
        value.pricingSnapshot = { models: { model: { usd_per_1m: { output: { peak: 0, off_peak: 0 } } } } };
      },
      (value) => {
        value.costUsd = 0;
      },
      (value) => {
        value.budget.maxUsd = 9999;
      },
      (value) => {
        value.ownedPaths = ['**'];
      },
      (value) => {
        value.status = 'DONE_VERIFIED';
      },
      (value) => {
        value.revertFiles = ['.git/config'];
      },
    ]) {
      const value = JSON.parse(original);
      alter(value);
      writeFileSync(path, JSON.stringify(value));
      await assert.rejects(() => store.get(job.id), /integrity check failed/);
      await assert.rejects(() => store.update(job.id, { runnerHeartbeatAt: new Date().toISOString() }), /integrity check failed/);
      writeFileSync(path, original);
    }
    const updated = await store.update(job.id, { runnerHeartbeatAt: new Date().toISOString() });
    assert.equal(store.verifyJob(updated), true, 'legitimate lifecycle updates are re-sealed');
  } finally {
    cleanup(gitDir);
  }
});

test('listing drops a record whose embedded id does not match its managed directory', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    const record = JSON.parse(readFileSync(join(gitDir, 'offload', 'jobs', job.id, 'job.json'), 'utf8'));
    record.id = 'other-valid-job';
    writeFileSync(join(gitDir, 'offload', 'jobs', job.id, 'job.json'), JSON.stringify(record));
    assert.deepEqual(await store.listOperational({ limit: 20 }), []);
  } finally {
    cleanup(gitDir);
  }
});

test('operational reads require the full job MAC but do not authenticate a rotated credential', async () => {
  const gitDir = tempDir();
  let authenticated = 0;
  try {
    const store = new JobStore({ gitDir }).configureIntegrity({
      requiredFor: () => true,
      keyForId: () => 'root-mac-key',
      authenticate: async () => {
        authenticated += 1;
        throw new Error('credential rotated');
      },
    });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    await assert.rejects(() => store.get(job.id), /integrity check failed/);
    assert.equal((await store.getOperational(job.id)).id, job.id);
    assert.equal(authenticated, 1, 'operational read never invokes the credential-fingerprint adapter');
    const path = join(gitDir, 'offload', 'jobs', job.id, 'job.json');
    const tampered = JSON.parse(readFileSync(path, 'utf8'));
    tampered.status = 'DONE_VERIFIED';
    writeFileSync(path, JSON.stringify(tampered));
    await assert.rejects(() => store.getOperational(job.id), /integrity check failed/);
    assert.deepEqual(await store.listOperational(), [], 'operational listing drops records whose complete MAC does not verify');
  } finally {
    cleanup(gitDir);
  }
});

test('sealed transcripts and revert artifacts are bound before they are read', async () => {
  const gitDir = tempDir();
  try {
    const store = new JobStore({ gitDir }).configureIntegrity({ requiredFor: () => true, keyForId: () => 'credential' });
    const job = await store.create({ task: 'x', ownedPaths: ['src/**'] });
    await store.messages(job.id, { role: 'user', content: 'trusted' });
    await store.writeArtifact(job.id, 'patch.diff', 'trusted patch');
    const directory = join(gitDir, 'offload', 'jobs', job.id);
    writeFileSync(join(directory, 'messages.jsonl'), '{"role":"user","content":"forged"}\n');
    await assert.rejects(() => store.readMessages(job.id), /transcript integrity check failed/);
    writeFileSync(join(directory, 'messages.jsonl'), '{"role":"user","content":"trusted"}\n');
    writeFileSync(join(directory, 'patch.diff'), 'forged patch');
    await assert.rejects(() => store.readArtifact(job.id, 'patch.diff'), /artifact integrity check failed/);
  } finally {
    cleanup(gitDir);
  }
});
