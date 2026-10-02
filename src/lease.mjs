import {
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  closeSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  linkSync,
  lstatSync,
  constants,
  fstatSync,
  fchmodSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { normalizePath, pathsOverlap } from './glob.mjs';
import { snapshotGitEnv } from './git-snapshot.mjs';

const MAX_LEASE_FILES = 512;
const MAX_LOCK_BYTES = 64 * 1024;
const MAX_MUTEX_BYTES = 4 * 1024;
const MAX_PATHS = 128;
const MAX_PATH_LENGTH = 1024;
const MAX_TIMER_MS = 0x7fffffff;
const BIGINT_STAT_OPTIONS = Object.freeze({ bigint: true });
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

export class LeaseError extends Error {
  constructor(message, code = 'E_LEASE', holderJobId) {
    super(message);
    this.name = 'LeaseError';
    this.code = code;
    this.holderJobId = holderJobId;
  }
}

/** A cross-process lock store backed by atomic JSON lock files in gitdir/offload/locks. */
export class LeaseManager {
  constructor({
    gitDir,
    staleMs = 90_000,
    pidAlive = defaultPidAlive,
    now = () => Date.now(),
    mutexStaleMs = 5_000,
    mutexAttempts = 200,
    platform = process.platform,
    readLease = readLeaseJson,
  } = {}) {
    if (!gitDir) throw new LeaseError('gitDir is required', 'E_LEASE_CONFIG');
    if (
      !validDuration(staleMs) ||
      !validDuration(mutexStaleMs) ||
      !Number.isInteger(mutexAttempts) ||
      mutexAttempts < 1 ||
      mutexAttempts > 10_000 ||
      typeof pidAlive !== 'function' ||
      typeof now !== 'function' ||
      typeof readLease !== 'function' ||
      typeof platform !== 'string'
    )
      throw new LeaseError('lease timing and collaborators are invalid', 'E_LEASE_CONFIG');
    this.gitDir = realpathSync(resolve(gitDir));
    this.lockDir = join(this.gitDir, 'offload', 'locks');
    this.staleMs = staleMs;
    this.pidAlive = pidAlive;
    this.now = () => checkedNow(now());
    this.mutexStaleMs = mutexStaleMs;
    this.mutexAttempts = mutexAttempts;
    this.platform = platform;
    this.readLease = readLease;
    // Keep enough margin for timer jitter while remaining strictly below staleMs.
    this.heartbeatIntervalMs = Math.max(1, Math.floor(staleMs / 3));
  }
  acquire(jobId, ownedPaths, { pid = process.pid, ownerNonce } = {}) {
    if (!validJobId(jobId) || !validPaths(ownedPaths, this.platform) || !Number.isInteger(pid) || pid <= 0 || !validNonce(ownerNonce)) {
      throw new LeaseError('jobId, pid, and safe ownedPaths are required', 'E_LEASE_CONFIG');
    }
    this.#ensureLockDir();
    const releaseMutex = this.#lockAcquire();
    try {
      // We already own .acquire.  Calling the public destructive list here
      // would try to take it again and deadlock.
      for (const lease of this.#listUnlocked({ reclaimStale: true })) {
        if (lease.jobId !== jobId && pathsOverlap(ownedPaths, lease.ownedPaths, { platform: this.platform }))
          throw new LeaseError('Requested paths are held by another running job', 'E_LEASE_CONFLICT', lease.jobId);
      }
      const timestamp = this.now();
      const lease = { version: 1, jobId, pid, ownedPaths: [...ownedPaths], ownerNonce, createdAt: timestamp, heartbeatAt: timestamp };
      const file = this.#file(jobId);
      try {
        const fd = openSync(file, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify(lease));
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if (error?.code === 'EEXIST') throw new LeaseError('Job already has a lease', 'E_LEASE_EXISTS', jobId);
        throw error;
      }
      return lease;
    } finally {
      releaseMutex();
    }
  }
  heartbeat(jobId, { ownerNonce } = {}) {
    return this.#mutate(jobId, (current) => {
      this.#assertOwner(current, ownerNonce);
      current.heartbeatAt = this.now();
      return current;
    });
  }
  /** Atomically hand the short create/spawn lease to a detached child PID. */
  transfer(jobId, { pid, ownerNonce, nextOwnerNonce } = {}) {
    if (!Number.isInteger(pid) || pid <= 0 || !validNonce(nextOwnerNonce))
      throw new LeaseError('child pid and next owner nonce are required', 'E_LEASE_CONFIG');
    return this.#mutate(jobId, (current) => {
      this.#assertOwner(current, ownerNonce);
      current.pid = pid;
      current.ownerNonce = nextOwnerNonce;
      current.heartbeatAt = this.now();
      return current;
    });
  }
  release(jobId, { ownerNonce } = {}) {
    this.#ensureLockDir();
    const releaseMutex = this.#lockAcquire();
    try {
      const record = this.#readRecord(jobId);
      const current = record?.value;
      if (!current) return false;
      if (!validLease(current)) throw new LeaseError('Lease is invalid', 'E_LEASE_MISSING');
      this.#assertOwner(current, ownerNonce);
      // Although compliant writers hold .acquire, bind cleanup to the record
      // identity and owner nonce as well.  A replacement must never be
      // deleted by a delayed release callback.
      return retireIfSame(this.#file(jobId), record.identity, (path) => {
        try {
          const value = this.readLease(path, MAX_LOCK_BYTES, { platform: this.platform });
          return validLease(value, this.platform) && value.ownerNonce === current.ownerNonce;
        } catch {
          return false;
        }
      });
    } finally {
      releaseMutex();
    }
  }
  list({ reclaimStale = false } = {}) {
    this.#ensureLockDir();
    // Reclamation mutates the authority boundary.  In particular it must not
    // race a heartbeat's same-directory atomic replacement and mistake that
    // benign identity change for a corrupt/stale lease.
    if (reclaimStale) {
      const releaseMutex = this.#lockAcquire();
      try {
        return this.#listUnlocked({ reclaimStale: true });
      } finally {
        releaseMutex();
      }
    }
    return this.#listUnlocked({ reclaimStale: false });
  }
  #listUnlocked({ reclaimStale }) {
    const leases = [];
    const files = readdirSync(this.lockDir);
    if (files.length > MAX_LEASE_FILES) throw new LeaseError('Too many lease files', 'E_LEASE_LIMIT');
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const full = join(this.lockDir, file);
      try {
        const record = this.readLease(full, MAX_LOCK_BYTES, { platform: this.platform, record: true });
        const lease = record.value;
        if (!validLease(lease, this.platform)) {
          if (reclaimStale) this.#retireInvalidLease(full);
          continue;
        }
        if (file !== `${lease.jobId}.json`) {
          if (reclaimStale) retireIfSame(full, record.identity);
          continue;
        }
        if (this.#isStale(lease)) {
          if (reclaimStale) retireIfSame(full, record.identity);
          continue;
        }
        leases.push(lease);
      } catch (error) {
        // An identity-change error means the reader lost a race to an atomic
        // writer.  Never turn that safe failure into deletion of the writer's
        // replacement.  Static malformed records are reclaimed only after a
        // stale-age grace period.
        if (reclaimStale && error?.code !== 'E_LEASE_CHANGED') this.#retireInvalidLease(full);
      }
    }
    return leases;
  }
  #readRecord(jobId) {
    try {
      const record = this.readLease(this.#file(jobId), MAX_LOCK_BYTES, { platform: this.platform, record: true });
      return validLease(record.value, this.platform) && record.value.jobId === jobId ? record : null;
    } catch {
      return null;
    }
  }
  #read(jobId) {
    return this.#readRecord(jobId)?.value || null;
  }
  #mutate(jobId, mutator) {
    this.#ensureLockDir();
    const releaseMutex = this.#lockAcquire();
    try {
      const current = this.#read(jobId);
      if (!validLease(current)) throw new LeaseError('Lease not found', 'E_LEASE_MISSING');
      const next = mutator(current);
      atomicJson(this.#file(jobId), next);
      return next;
    } finally {
      releaseMutex();
    }
  }
  #assertOwner(current, ownerNonce) {
    if (current.ownerNonce && current.ownerNonce !== ownerNonce) throw new LeaseError('Lease owner nonce does not match', 'E_LEASE_OWNER');
  }
  #file(jobId) {
    if (!validJobId(jobId)) throw new LeaseError('Invalid job id', 'E_LEASE_CONFIG');
    return join(this.lockDir, `${jobId}.json`);
  }
  #ensureLockDir() {
    // Locks are durable authority boundaries. Creating with recursive:true
    // would silently traverse a repository-controlled offload/locks link.
    assertSafeGitAncestry(this.gitDir, this.platform);
    privateDirectory(join(this.gitDir, 'offload'), this.platform);
    privateDirectory(this.lockDir, this.platform);
  }
  #isStale(lease) {
    // A suspended owner can miss arbitrary heartbeats and later resume with
    // its still-valid owner nonce. Never reclaim that lease while its PID is
    // alive: availability loss from a reused PID is safer than allowing a
    // delayed worker to write through a lease we reassigned underneath it.
    return !this.pidAlive(lease.pid);
  }
  #lockAcquire() {
    const mutex = join(this.lockDir, '.acquire');
    for (let attempt = 0; attempt < this.mutexAttempts; attempt += 1) {
      try {
        const fd = openSync(mutex, 'wx', 0o600);
        const nonce = randomUUID();
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, at: this.now(), nonce }));
        } finally {
          closeSync(fd);
        }
        // Do not unlink by name: a waiter may have retired a dead owner and a
        // new owner may have recreated .acquire before this callback runs.
        return () => {
          this.#retireMutex({ nonce });
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const holder = this.readLease(mutex, MAX_MUTEX_BYTES, { platform: this.platform });
          // Age is not evidence that a living process has stopped.  A slow
          // filesystem or a long reclamation pass must result in E_LEASE_BUSY,
          // never concurrent critical sections.  Dead holders remain safely
          // reclaimable.
          if (validMutex(holder)) {
            if (!this.pidAlive(holder.pid)) this.#retireMutex({ nonce: holder.nonce });
          } else this.#retireInvalidMutex(mutex);
        } catch (readError) {
          // A newly-created mutex can be observed before its JSON write has
          // completed.  Give malformed records an mtime-based grace period;
          // identity races are always left alone.
          if (readError?.code !== 'E_LEASE_CHANGED') this.#retireInvalidMutex(mutex);
        }
        sleep(5);
      }
    }
    throw new LeaseError('Timed out waiting to acquire lease lock', 'E_LEASE_BUSY');
  }
  #retireInvalidLease(file) {
    let details;
    try {
      details = lstatSync(file);
    } catch {
      return false;
    }
    if (!details.isFile() || details.isSymbolicLink() || this.now() - details.mtimeMs <= this.staleMs) return false;
    return retireIfSame(file, identityFor(details));
  }
  #retireInvalidMutex(file) {
    let details;
    try {
      details = lstatSync(file);
    } catch {
      return false;
    }
    if (!details.isFile() || details.isSymbolicLink() || this.now() - details.mtimeMs <= this.mutexStaleMs) return false;
    return retireIfSame(file, identityFor(details));
  }
  #retireMutex({ nonce }) {
    if (!validNonce(nonce)) return false;
    let record;
    try {
      record = this.readLease(join(this.lockDir, '.acquire'), MAX_MUTEX_BYTES, { platform: this.platform, record: true });
    } catch {
      return false;
    }
    if (!validMutex(record.value) || record.value.nonce !== nonce) return false;
    return retireIfSame(join(this.lockDir, '.acquire'), record.identity, (path) => {
      try {
        const value = this.readLease(path, MAX_MUTEX_BYTES, { platform: this.platform });
        return validMutex(value) && value.nonce === nonce;
      } catch {
        return false;
      }
    });
  }
}

/** Resolve a repository's actual git directory, including linked worktrees. */
export function getGitDir(repoPath, { execFile = execFileSync, env = process.env, platform = process.platform } = {}) {
  const inertHooks = platform === 'win32' ? 'NUL' : '/dev/null';
  // This is a local plumbing query, so it needs neither provider credentials
  // nor repository hook/fsmonitor execution. Keep its environment contract
  // aligned with the snapshot path used for tree construction.
  const value = execFile('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${inertHooks}`, 'rev-parse', '--git-dir'], {
    cwd: repoPath,
    encoding: 'utf8',
    env: snapshotGitEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).trim();
  return resolve(repoPath, value);
}
function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {}
  }
}
function currentUserOwns(details) {
  if (typeof process.getuid !== 'function') return true;
  return details.uid === process.getuid();
}
function ownerOrRoot(details) {
  if (typeof process.getuid !== 'function') return true;
  return details.uid === process.getuid() || details.uid === 0;
}
function assertSafeGitAncestry(path, platform) {
  if (platform === 'win32') return;
  for (let current = path; ; current = dirname(current)) {
    let details;
    try {
      details = lstatSync(current);
    } catch {
      throw new LeaseError('lease storage ancestry is invalid', 'E_LEASE_STORAGE');
    }
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      !ownerOrRoot(details) ||
      ((details.mode & 0o022) !== 0 && (details.mode & 0o1000) === 0)
    )
      throw new LeaseError('lease storage ancestry is insecure', 'E_LEASE_STORAGE');
    if (dirname(current) === current) return;
  }
}
function checkedManagedDirectory(path, platform) {
  let fd;
  try {
    const before = lstatSync(path);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new LeaseError('lease storage directory is invalid', 'E_LEASE_STORAGE');
    if (platform === 'win32') return;
    if (!currentUserOwns(before) || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
      throw new LeaseError('lease storage directory is insecure', 'E_LEASE_STORAGE');
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino || !currentUserOwns(opened))
      throw new LeaseError('lease storage directory is invalid', 'E_LEASE_STORAGE');
    fchmodSync(fd, 0o700);
    const after = fstatSync(fd);
    if (
      !after.isDirectory() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      !currentUserOwns(after) ||
      (after.mode & 0o077) !== 0
    )
      throw new LeaseError('lease storage directory is insecure', 'E_LEASE_STORAGE');
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
}
function privateDirectory(path, platform) {
  // Match JobStore's race-tolerant contract without following a link. The
  // retry handles another process creating the same managed directory.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      checkedManagedDirectory(path, platform);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        mkdirSync(path, { recursive: false, mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
    }
  }
  checkedManagedDirectory(path, platform);
}
/** Read a lock/mutex record through one checked descriptor. */
export function readLeaseJson(file, cap, { platform = process.platform, fs = defaultFileSystem, record = false } = {}) {
  let fd;
  try {
    if (!validByteCap(cap)) throw lockReadError('lock size limit is invalid', 'E_LEASE_CONFIG');
    const before = fs.lstatSync(file, BIGINT_STAT_OPTIONS);
    const beforeSize = checkedLockSize(before.size, cap);
    if (!before.isFile() || before.isSymbolicLink() || beforeSize === undefined || beforeSize < 1)
      throw lockReadError('lock exceeds size limit', 'E_LEASE_INVALID');
    const noFollow = platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd, BIGINT_STAT_OPTIONS);
    const openedSize = checkedLockSize(opened.size, cap);
    if (!opened.isFile() || !sameLockMetadata(before, opened) || openedSize === undefined || openedSize < 1)
      throw lockReadError('lock is invalid or changed while opening', 'E_LEASE_CHANGED');
    const bytes = Buffer.allocUnsafe(openedSize);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw lockReadError('lock changed while reading', 'E_LEASE_CHANGED');
      offset += count;
    }
    const after = fs.fstatSync(fd, BIGINT_STAT_OPTIONS);
    if (!after.isFile() || !sameLockMetadata(opened, after)) throw lockReadError('lock changed while reading', 'E_LEASE_CHANGED');
    let value;
    try {
      value = JSON.parse(UTF8_FATAL.decode(bytes));
    } catch {
      throw lockReadError('lock contains invalid JSON', 'E_LEASE_INVALID');
    }
    return record ? { value, identity: identityFor(opened) } : value;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
}
const defaultFileSystem = Object.freeze({ constants, lstatSync, openSync, fstatSync, readSync, closeSync });
// Job ids are also used as Git ref components by isolated-worktree recovery.
// Do not grant a lease to an id that durable snapshot pinning will reject.
function validJobId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}
function validPaths(paths, platform) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS) return false;
  try {
    const normalized = paths.map((path) => {
      if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes('\\'))
        throw new Error('invalid path');
      const result = normalizePath(path, { platform });
      if (result !== path) throw new Error('non-canonical path');
      return result;
    });
    return new Set(normalized).size === normalized.length;
  } catch {
    return false;
  }
}
function validNonce(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value);
}
function validLease(value, platform) {
  return (
    value &&
    value.version === 1 &&
    validJobId(value.jobId) &&
    validPaths(value.ownedPaths, platform) &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    Number.isFinite(value.createdAt) &&
    Number.isFinite(value.heartbeatAt) &&
    validNonce(value.ownerNonce)
  );
}
function validMutex(value) {
  return value && Number.isInteger(value.pid) && value.pid > 0 && Number.isFinite(value.at) && validNonce(value.nonce);
}
function lockReadError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function checkedLockSize(value, cap) {
  if (!validByteCap(cap)) return undefined;
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Math.min(cap, Number.MAX_SAFE_INTEGER))) return undefined;
    return Number(value);
  }
  return Number.isSafeInteger(value) && value >= 0 && value <= cap ? value : undefined;
}
function validByteCap(cap) {
  return Number.isSafeInteger(cap) && cap >= 1;
}
function validDuration(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMER_MS;
}
function checkedNow(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new LeaseError('lease clock is invalid', 'E_LEASE_CONFIG');
  return value;
}
function sameLockMetadata(first, second) {
  return (
    ['dev', 'ino', 'size', 'mode'].every((name) => sameStatValue(first?.[name], second?.[name])) &&
    sameTimestamp(first, second, 'mtime') &&
    sameTimestamp(first, second, 'ctime')
  );
}
function sameStatValue(first, second) {
  if (first === second) return true;
  if (typeof first === 'bigint' && Number.isSafeInteger(second)) return first === BigInt(second);
  if (typeof second === 'bigint' && Number.isSafeInteger(first)) return BigInt(first) === second;
  return false;
}
function sameTimestamp(first, second, name) {
  const left = statTimestamp(first, name),
    right = statTimestamp(second, name);
  return left !== undefined && right !== undefined && sameStatValue(left, right);
}
function statTimestamp(details, name) {
  const nanoseconds = details?.[`${name}Ns`];
  if (typeof nanoseconds === 'bigint') return nanoseconds;
  const milliseconds = details?.[`${name}Ms`];
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds)) return milliseconds;
  const date = details?.[name];
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : undefined;
}
function identityFor(details) {
  return { dev: details.dev, ino: details.ino };
}
function sameIdentity(details, identity) {
  return sameStatValue(details?.dev, identity?.dev) && sameStatValue(details?.ino, identity?.ino);
}
/** Atomically quarantine only the exact pathname object we inspected.  If an
 * ABA replacement wins before rename, restore the captured replacement rather
 * than deleting it; a concurrent new pathname is always preferred. */
function retireIfSame(file, identity, verify = () => true) {
  const tombstone = `${file}.${process.pid}.${randomUUID()}.retired`;
  try {
    renameSync(file, tombstone);
  } catch {
    return false;
  }
  let details;
  try {
    details = lstatSync(tombstone);
  } catch {
    return false;
  }
  if (!sameIdentity(details, identity) || !verify(tombstone)) {
    // `rename` would overwrite a replacement created after the absence check.
    // A hard link has no-replace semantics, so it is safe to restore only when
    // the original name remains absent (and works on both POSIX and NTFS).
    try {
      linkSync(tombstone, file);
      unlinkSync(tombstone);
    } catch {}
    return false;
  }
  try {
    unlinkSync(tombstone);
    return true;
  } catch {
    return false;
  }
}
function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
