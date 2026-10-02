import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PosixIntegrityRoot,
  WINDOWS_INTEGRITY_ROOT_CREDENTIAL,
  WindowsIntegrityRoot,
  credentialFingerprint,
  deriveJobMacKey,
  validCredentialFingerprint,
} from '../../src/integrity.mjs';

test(
  'POSIX integrity root is owner-private, non-symlinked, and malformed roots fail closed',
  { skip: process.platform === 'win32' && 'POSIX root checks require POSIX metadata' },
  async () => {
    const statePath = await mkdtemp(join(tmpdir(), 'offload-root-'));
    const rootPath = join(statePath, 'integrity-root-v1');
    try {
      const first = new PosixIntegrityRoot({ statePath });
      const value = await first.load({ create: true });
      assert.match(value, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(await new PosixIntegrityRoot({ statePath }).load({ create: false }), value);
      await rm(rootPath);
      await assert.rejects(() => new PosixIntegrityRoot({ statePath }).load({ create: false }), /integrity root is unavailable/);
      await writeFile(rootPath, `${value}\n`, { mode: 0o600, flag: 'wx' });
      await chmod(rootPath, 0o644);
      await assert.rejects(() => new PosixIntegrityRoot({ statePath }).load({ create: false }), /integrity root is invalid/);
      await chmod(rootPath, 0o600);
      await writeFile(rootPath, 'bad\n', { mode: 0o600 });
      await assert.rejects(() => new PosixIntegrityRoot({ statePath }).load({ create: false }), /integrity root is invalid/);
      await rm(rootPath);
      await symlink(join(statePath, 'outside'), rootPath);
      await assert.rejects(() => new PosixIntegrityRoot({ statePath }).load({ create: false }), /integrity root is invalid/);
    } finally {
      await rm(statePath, { recursive: true, force: true });
    }
  },
);

test(
  'POSIX integrity root rejects a same-inode same-size rewrite detected only by nanosecond metadata',
  { skip: process.platform === 'win32' && 'POSIX root checks require POSIX metadata' },
  async () => {
    const statePath = await mkdtemp(join(tmpdir(), 'offload-root-race-'));
    const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : 0n;
    const metadata = (overrides) => ({
      dev: 1n,
      ino: 2n,
      uid,
      mode: 0o100600n,
      size: 44n,
      mtimeNs: 5_000_000_001n,
      ctimeNs: 5_000_000_001n,
      isFile: () => true,
      isSymbolicLink: () => false,
      ...overrides,
    });
    const before = metadata();
    const after = metadata({ mtimeNs: before.mtimeNs + 1n, ctimeNs: before.ctimeNs + 1n });
    let stats = 0;
    const fs = {
      lstat: async (_path, options) => {
        assert.equal(options.bigint, true);
        return before;
      },
      open: async (_path, _flags) => ({
        stat: async (options) => {
          assert.equal(options.bigint, true);
          return ++stats === 1 ? before : after;
        },
        readFile: async () => `${'A'.repeat(43)}\n`,
        close: async () => {},
      }),
      writeFile: async () => {
        throw new Error('must not create');
      },
    };
    try {
      await assert.rejects(() => new PosixIntegrityRoot({ statePath, fs }).load({ create: false }), /integrity root is invalid/);
    } finally {
      await rm(statePath, { recursive: true, force: true });
    }
  },
);

test('Windows root uses one fixed vault item and a create race re-reads the winner', async () => {
  const values = new Map(),
    writes = [];
  const winner = 'A'.repeat(43);
  const vault = {
    read: (credential) => values.get(credential.resource),
    writeIfAbsent: (credential, value) => {
      writes.push([credential, value]);
      if (values.has(credential.resource)) throw new Error('exists');
      values.set(credential.resource, winner);
    },
  };
  const root = new WindowsIntegrityRoot({ vault });
  assert.equal(await root.load({ create: true }), winner);
  assert.deepEqual(
    writes.map(([credential]) => credential),
    [WINDOWS_INTEGRITY_ROOT_CREDENTIAL],
  );
  assert.deepEqual([...values.keys()], [WINDOWS_INTEGRITY_ROOT_CREDENTIAL.resource]);
  const key = deriveJobMacKey(root.value, { repoPath: '/repo', gitDir: '/repo/.git', id: 'oj-one' });
  assert.equal(typeof key, 'string');
  assert.equal(validCredentialFingerprint(credentialFingerprint(root.value, 'credential')), true);
});
