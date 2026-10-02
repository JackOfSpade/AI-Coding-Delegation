import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { ensurePrivateDirectory, LeaseManager, getGitDir, readLeaseJson } from '../../src/lease.mjs';
import { cleanup, tempDir } from './helpers.mjs';
const nonce = (value) => `${value}-owner-nonce`.padEnd(16, 'x');

test('private directory creation rejects a symlinked namespace intermediate', () => {
  const root = tempDir();
  const outside = tempDir();
  try {
    symlinkSync(outside, join(root, 'namespace'));
    assert.throws(() => ensurePrivateDirectory(join(root, 'namespace', 'child')), /directory is invalid|ancestry is insecure/);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('LeaseManager creates absent managed lock parents below an existing git directory', () => {
  const gitDir = tempDir();
  try {
    const manager = new LeaseManager({ gitDir, pidAlive: () => true });
    assert.equal(manager.acquire('parent', ['src/**'], { pid: 1, ownerNonce: nonce('parent') }).jobId, 'parent');
    assert.equal(existsSync(join(gitDir, 'offload', 'locks', 'parent.json')), true);
    assert.equal(manager.release('parent', { ownerNonce: nonce('parent') }), true);
  } finally {
    cleanup(gitDir);
  }
});

test('leases reject overlapping live scopes and allow disjoint jobs', () => {
  const gitDir = tempDir();
  let now = 1000;
  try {
    const manager = new LeaseManager({ gitDir, now: () => now, pidAlive: () => true });
    manager.acquire('one', ['src/**'], { pid: 1, ownerNonce: nonce('one') });
    assert.throws(
      () => manager.acquire('two', ['src/a.mjs'], { pid: 2, ownerNonce: nonce('two') }),
      (error) => error.code === 'E_LEASE_CONFLICT' && error.holderJobId === 'one',
    );
    assert.equal(manager.acquire('two', ['test/**'], { pid: 2, ownerNonce: nonce('two') }).jobId, 'two');
    now += 10;
    assert.equal(manager.heartbeat('one', { ownerNonce: nonce('one') }).heartbeatAt, 1010);
    assert.equal(manager.release('one', { ownerNonce: nonce('one') }), true);
    assert.equal(manager.release('one', { ownerNonce: nonce('one') }), false);
    assert.throws(
      () => manager.acquire('bad', [42], { pid: 1 }),
      (error) => error.code === 'E_LEASE_CONFIG',
    );
    assert.throws(
      () => manager.acquire('badpid', ['src/**'], { pid: 0 }),
      (error) => error.code === 'E_LEASE_CONFIG',
    );
  } finally {
    cleanup(gitDir);
  }
});
test('stale locks are reclaimed only after the owner PID exits', () => {
  const gitDir = tempDir();
  let now = 1000;
  try {
    const creator = new LeaseManager({ gitDir, staleMs: 10, now: () => now, pidAlive: () => true });
    creator.acquire('old', ['src/**'], { pid: 99, ownerNonce: nonce('old') });
    now = 1020;
    assert.deepEqual(
      creator.list({ reclaimStale: true }).map((lease) => lease.jobId),
      ['old'],
      'an old heartbeat cannot fence a suspended live owner',
    );
    assert.throws(
      () => creator.acquire('blocked', ['src/**'], { pid: 2, ownerNonce: nonce('blocked') }),
      (error) => error.code === 'E_LEASE_CONFLICT',
    );
    const reclaimer = new LeaseManager({ gitDir, staleMs: 10, now: () => now, pidAlive: () => false });
    assert.deepEqual(reclaimer.list({ reclaimStale: true }), []);
    assert.equal(reclaimer.acquire('fresh', ['src/**'], { pid: 2, ownerNonce: nonce('fresh') }).jobId, 'fresh');
  } finally {
    cleanup(gitDir);
  }
});
test('lease transfer atomically changes owner and requires its token for heartbeats', () => {
  const gitDir = tempDir();
  let now = 1000;
  try {
    const manager = new LeaseManager({ gitDir, now: () => now, pidAlive: () => true });
    manager.acquire('handoff', ['src/**'], { pid: 11, ownerNonce: 'parent-owner-nonce' });
    now += 1;
    const moved = manager.transfer('handoff', { pid: 22, ownerNonce: 'parent-owner-nonce', nextOwnerNonce: 'child-owner-nonce' });
    assert.equal(moved.pid, 22);
    assert.equal(moved.ownerNonce, 'child-owner-nonce');
    assert.throws(
      () => manager.heartbeat('handoff', { ownerNonce: 'parent-owner-nonce' }),
      (error) => error.code === 'E_LEASE_OWNER',
    );
    now += 1;
    assert.equal(manager.heartbeat('handoff', { ownerNonce: 'child-owner-nonce' }).heartbeatAt, 1002);
  } finally {
    cleanup(gitDir);
  }
});
test('corrupt lock files are ignored read-only and reclaimed only while acquiring', () => {
  const gitDir = tempDir();
  try {
    const manager = new LeaseManager({ gitDir, pidAlive: () => true });
    mkdirSync(join(gitDir, 'offload', 'locks'), { recursive: true });
    writeFileSync(join(gitDir, 'offload', 'locks', 'corrupt.json'), '{not json');
    assert.deepEqual(manager.list(), []);
    assert.equal(manager.acquire('valid', ['src/**'], { pid: 1, ownerNonce: nonce('valid') }).jobId, 'valid');
    assert.deepEqual(
      manager.list().map((lease) => lease.jobId),
      ['valid'],
    );
  } finally {
    cleanup(gitDir);
  }
});
test('a lease held in a separate process blocks an overlapping acquisition and is reclaimed after exit', async () => {
  const gitDir = tempDir();
  let child;
  try {
    const modulePath = fileURLToPath(new URL('../../src/lease.mjs', import.meta.url));
    const program = `import { LeaseManager } from ${JSON.stringify(pathToFileURL(modulePath).href)}; const m = new LeaseManager({gitDir: ${JSON.stringify(gitDir)}}); m.acquire('child', ['src/**'], {ownerNonce:'child-owner-nonce'}); console.log('ready'); setTimeout(() => {}, 10000);`;
    child = spawn(process.execPath, ['--input-type=module', '--eval', program], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForReady(child);
    const manager = new LeaseManager({ gitDir });
    assert.throws(
      () => manager.acquire('parent', ['src/a.mjs'], { ownerNonce: nonce('parent') }),
      (error) => error.code === 'E_LEASE_CONFLICT' && error.holderJobId === 'child',
    );
    child.kill('SIGTERM');
    await onceExit(child);
    assert.equal(manager.acquire('parent', ['src/a.mjs'], { ownerNonce: nonce('parent') }).jobId, 'parent');
  } finally {
    child?.kill('SIGKILL');
    cleanup(gitDir);
  }
});
test('Windows leases fold case and reject aliasing path components', () => {
  const gitDir = tempDir();
  try {
    const manager = new LeaseManager({ gitDir, platform: 'win32', pidAlive: () => true });
    manager.acquire('one', ['SRC/**'], { pid: 1, ownerNonce: nonce('one') });
    assert.throws(
      () => manager.acquire('two', ['src/a.txt'], { pid: 2, ownerNonce: nonce('two') }),
      (error) => error.code === 'E_LEASE_CONFLICT',
    );
    for (const path of ['src/file. ', 'src/CON', 'src/file:stream'])
      assert.throws(
        () => manager.acquire('bad', [path], { pid: 3, ownerNonce: nonce('bad') }),
        (error) => error.code === 'E_LEASE_CONFIG',
      );
    assert.throws(
      () => manager.acquire('missing', ['src/**'], { pid: 4 }),
      (error) => error.code === 'E_LEASE_CONFIG',
    );
  } finally {
    cleanup(gitDir);
  }
});
test('leases reject non-canonical scope aliases and retain a live PID despite an impossible heartbeat', () => {
  const gitDir = tempDir();
  let now = 1_000;
  try {
    const manager = new LeaseManager({ gitDir, staleMs: 10, now: () => now, pidAlive: () => true });
    for (const path of ['.', './src/**', 'src/./a.mjs', 'src//a.mjs', 'src\\a.mjs']) {
      assert.throws(
        () => manager.acquire('bad', [path], { pid: 1, ownerNonce: nonce('bad') }),
        (error) => error.code === 'E_LEASE_CONFIG',
      );
    }
    manager.acquire('future', ['src/**'], { pid: 1, ownerNonce: nonce('future') });
    const lock = join(gitDir, 'offload', 'locks', 'future.json');
    const value = JSON.parse(readFileSync(lock, 'utf8'));
    value.heartbeatAt = now + 100;
    writeFileSync(lock, JSON.stringify(value));
    assert.deepEqual(
      manager.list({ reclaimStale: true }).map((lease) => lease.jobId),
      ['future'],
      'heartbeat anomalies do not fence a potentially suspended live owner',
    );
  } finally {
    cleanup(gitDir);
  }
});
test('destructive lease listing cannot delete an atomic replacement it observed changing', () => {
  const gitDir = tempDir();
  let armed = false,
    swapped = false,
    target;
  try {
    const readLease = (file, cap, options = {}) => {
      if (armed && file === target && !swapped) {
        const fs = {
          constants: nodeFs.constants,
          lstatSync: nodeFs.lstatSync,
          fstatSync: nodeFs.fstatSync,
          readSync: nodeFs.readSync,
          closeSync: nodeFs.closeSync,
          openSync(path, flags) {
            if (!swapped) {
              swapped = true;
              const replacement = `${path}.replacement`;
              const value = JSON.parse(readFileSync(path, 'utf8'));
              value.heartbeatAt += 1;
              writeFileSync(replacement, JSON.stringify(value));
              nodeFs.renameSync(replacement, path);
            }
            return nodeFs.openSync(path, flags);
          },
        };
        return readLeaseJson(file, cap, { ...options, fs });
      }
      return readLeaseJson(file, cap, options);
    };
    const manager = new LeaseManager({ gitDir, now: () => 1_000, pidAlive: () => true, readLease });
    manager.acquire('live', ['src/**'], { pid: 1, ownerNonce: nonce('live') });
    target = join(manager.gitDir, 'offload', 'locks', 'live.json');
    armed = true;
    assert.deepEqual(manager.list({ reclaimStale: true }), []);
    assert.equal(swapped, true);
    assert.equal(
      JSON.parse(readFileSync(target, 'utf8')).heartbeatAt,
      1001,
      'the live replacement must remain after the checked reader reports an identity race',
    );
  } finally {
    cleanup(gitDir);
  }
});
test('lease release cannot delete a replacement after its ownership check', () => {
  const gitDir = tempDir();
  let armed = false,
    swapped = false,
    target;
  try {
    const readLease = (file, cap, options = {}) => {
      const result = readLeaseJson(file, cap, options);
      if (armed && file === target && options.record && !swapped) {
        swapped = true;
        const replacement = `${file}.replacement`;
        const value = JSON.parse(readFileSync(file, 'utf8'));
        value.ownerNonce = 'replacement-owner-nonce';
        writeFileSync(replacement, JSON.stringify(value));
        nodeFs.renameSync(replacement, file);
      }
      return result;
    };
    const manager = new LeaseManager({ gitDir, pidAlive: () => true, readLease });
    manager.acquire('owned', ['src/**'], { pid: 1, ownerNonce: nonce('owned') });
    target = join(manager.gitDir, 'offload', 'locks', 'owned.json');
    armed = true;
    assert.equal(manager.release('owned', { ownerNonce: nonce('owned') }), false);
    assert.equal(swapped, true);
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).ownerNonce, 'replacement-owner-nonce');
  } finally {
    cleanup(gitDir);
  }
});
test('a live mutex older than its stale threshold is busy, while only stale malformed mutexes are cleaned', () => {
  const gitDir = tempDir();
  const now = Date.now();
  try {
    const lockDir = join(gitDir, 'offload', 'locks');
    mkdirSync(lockDir, { recursive: true });
    const mutex = join(lockDir, '.acquire');
    writeFileSync(mutex, JSON.stringify({ pid: process.pid, at: 0, nonce: 'live-mutex-owner-nonce' }));
    const live = new LeaseManager({ gitDir, now: () => now, mutexStaleMs: 1, mutexAttempts: 2, pidAlive: (pid) => pid === process.pid });
    assert.throws(
      () => live.acquire('blocked', ['src/**'], { pid: 2, ownerNonce: nonce('blocked') }),
      (error) => error.code === 'E_LEASE_BUSY',
    );
    assert.equal(existsSync(mutex), true, 'a live owner must not be reaped solely because at is old');
    rmSync(mutex);
    writeFileSync(mutex, '{partial');
    const malformed = new LeaseManager({ gitDir, now: () => now, mutexStaleMs: 1_000, mutexAttempts: 2, pidAlive: () => false });
    assert.throws(
      () => malformed.acquire('new-corrupt', ['test/**'], { pid: 3, ownerNonce: nonce('new-corrupt') }),
      (error) => error.code === 'E_LEASE_BUSY',
    );
    assert.equal(existsSync(mutex), true, 'a newly created partial mutex gets a grace period');
    utimesSync(mutex, new Date(now - 5_000), new Date(now - 5_000));
    assert.equal(malformed.acquire('recovered', ['test/**'], { pid: 3, ownerNonce: nonce('recovered') }).jobId, 'recovered');
  } finally {
    cleanup(gitDir);
  }
});
test(
  'lease storage refuses offload and locks symlinks before creating or reclaiming locks',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  () => {
    const gitDir = tempDir(),
      outside = tempDir();
    try {
      symlinkSync(outside, join(gitDir, 'offload'));
      const manager = new LeaseManager({ gitDir, pidAlive: () => false });
      assert.throws(
        () => manager.acquire('one', ['src/**'], { pid: 1, ownerNonce: nonce('one') }),
        (error) => error.code === 'E_LEASE_STORAGE',
      );
      assert.equal(existsSync(join(outside, 'locks')), false);
      rmSync(join(gitDir, 'offload'));
      mkdirSync(join(gitDir, 'offload'));
      symlinkSync(outside, join(gitDir, 'offload', 'locks'));
      assert.throws(
        () => manager.list({ reclaimStale: true }),
        (error) => error.code === 'E_LEASE_STORAGE',
      );
      assert.equal(existsSync(join(outside, 'one.json')), false);
    } finally {
      cleanup(gitDir);
      cleanup(outside);
    }
  },
);
test(
  'POSIX lease storage rejects a non-sticky writable git ancestry',
  { skip: process.platform === 'win32' && 'POSIX ownership/mode checks are not applicable on Windows' },
  () => {
    const gitDir = tempDir();
    try {
      chmodSync(gitDir, 0o777);
      const manager = new LeaseManager({ gitDir });
      assert.throws(
        () => manager.acquire('one', ['src/**'], { pid: 1, ownerNonce: nonce('one') }),
        (error) => error.code === 'E_LEASE_STORAGE' && /ancestry is insecure/.test(error.message),
      );
    } finally {
      try {
        chmodSync(gitDir, 0o700);
      } catch {}
      cleanup(gitDir);
    }
  },
);
test(
  'lease reader rejects a deterministic final-component symlink swap',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  () => {
    const dir = tempDir(),
      outside = tempDir(),
      file = join(dir, 'lock.json');
    try {
      writeFileSync(file, '{"safe":true}');
      writeFileSync(join(outside, 'lock.json'), '{"redirected":true}');
      let swapped = false;
      const fs = {
        constants: nodeFs.constants,
        lstatSync: nodeFs.lstatSync,
        fstatSync: nodeFs.fstatSync,
        readSync: nodeFs.readSync,
        closeSync: nodeFs.closeSync,
        openSync(path, flags) {
          if (!swapped) {
            swapped = true;
            nodeFs.rmSync(path);
            nodeFs.symlinkSync(join(outside, 'lock.json'), path);
          }
          return nodeFs.openSync(path, flags);
        },
      };
      // Exercise the Windows lstat/fstat fallback even where O_NOFOLLOW is
      // available on the host.
      assert.throws(() => readLeaseJson(file, 1024, { platform: 'win32', fs }), /lock is invalid or changed while opening/);
    } finally {
      cleanup(dir);
      cleanup(outside);
    }
  },
);
test('lease reader rejects a same-inode same-size rewrite detected only by nanosecond metadata', () => {
  const content = '{"version":1}';
  const metadata = (overrides) => ({
    dev: 1n,
    ino: 2n,
    mode: 0o100600n,
    size: BigInt(Buffer.byteLength(content)),
    mtimeNs: 7_000_000_001n,
    ctimeNs: 7_000_000_001n,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  });
  const before = metadata();
  const after = metadata({ mtimeNs: before.mtimeNs + 1n, ctimeNs: before.ctimeNs + 1n });
  let fstats = 0;
  const fs = {
    constants: nodeFs.constants,
    lstatSync: () => before,
    openSync: () => 7,
    fstatSync: () => (++fstats === 1 ? before : after),
    readSync: (_fd, bytes, offset, length) => {
      Buffer.from(content).copy(bytes, offset, 0, length);
      return length;
    },
    closeSync: () => {},
  };
  assert.throws(
    () => readLeaseJson('/private/offload-lease-race.json', 1024, { fs }),
    (error) => error.code === 'E_LEASE_CHANGED',
  );
});
test('lease reader rejects malformed UTF-8 instead of replacement-decoding it', () => {
  const dir = tempDir(),
    file = join(dir, 'lock.json');
  try {
    // U+FFFD is valid inside a JSON string, so Buffer#toString used to turn
    // these invalid source bytes into a successfully parsed lock record.
    writeFileSync(file, Buffer.from([0x7b, 0x22, 0x6a, 0x6f, 0x62, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
    assert.throws(
      () => readLeaseJson(file, 1024),
      (error) => error.code === 'E_LEASE_INVALID',
    );
  } finally {
    cleanup(dir);
  }
});
test('lease construction rejects timer values that would overflow worker intervals', () => {
  const gitDir = tempDir();
  try {
    for (const options of [{ staleMs: 0 }, { staleMs: Infinity }, { mutexStaleMs: -1 }, { mutexAttempts: 0 }, { mutexAttempts: 10_001 }]) {
      assert.throws(
        () => new LeaseManager({ gitDir, ...options }),
        (error) => error.code === 'E_LEASE_CONFIG',
      );
    }
    assert.throws(
      () => new LeaseManager({ gitDir, now: () => NaN }).acquire('one', ['src/**'], { pid: 1, ownerNonce: nonce('one') }),
      (error) => error.code === 'E_LEASE_CONFIG',
    );
  } finally {
    cleanup(gitDir);
  }
});
test('lease rejects job ids that cannot name the durable Git-ref component', () => {
  const gitDir = tempDir();
  try {
    const manager = new LeaseManager({ gitDir });
    for (const id of ['_private', '-private', '', 'x'.repeat(129)]) {
      assert.throws(
        () => manager.acquire(id, ['src/**'], { pid: 1, ownerNonce: nonce('safe') }),
        (error) => error.code === 'E_LEASE_CONFIG',
      );
    }
    assert.equal(manager.acquire('safe_lease-1', ['src/**'], { pid: 1, ownerNonce: nonce('safe-lease') }).jobId, 'safe_lease-1');
  } finally {
    cleanup(gitDir);
  }
});
test('getGitDir uses a scrubbed, non-interactive Git plumbing environment', () => {
  let invocation;
  const gitDir = getGitDir('/workspace/repo', {
    platform: 'linux',
    env: {
      PATH: '/usr/bin',
      HOME: '/safe-home',
      LANG: 'C',
      OPENAI_API_KEY: 'must-not-reach-git',
      AWS_ACCESS_KEY_ID: 'also-secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GIT_CONFIG_GLOBAL: '/attacker/global',
      NODE_OPTIONS: '--require /tmp/evil',
    },
    execFile(command, args, options) {
      invocation = { command, args, options };
      return '.git\n';
    },
  });
  assert.equal(gitDir, '/workspace/repo/.git');
  assert.equal(invocation.command, 'git');
  assert.deepEqual(invocation.args, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'rev-parse', '--git-dir']);
  assert.deepEqual(invocation.options.env, { PATH: '/usr/bin', HOME: '/safe-home', LANG: 'C', GIT_TERMINAL_PROMPT: '0' });
});

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    child.stdout.on('data', (data) => {
      output += data;
      if (output.includes('ready')) resolve();
    });
    child.stderr.on('data', (data) => {
      errors += data;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes('ready')) reject(new Error(`holder exited early (${code}): ${errors}`));
    });
  });
}
function onceExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}
