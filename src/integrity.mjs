import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { WINDOWS_INTEGRITY_ROOT_CREDENTIAL } from './secrets.mjs';

const ROOT_FILE = 'integrity-root-v1';
const ROOT_RE = /^[A-Za-z0-9_-]{43}$/;
const ROOT_DOMAIN = 'offload integrity root v1\0';
const JOB_DOMAIN = 'offload job mac key v2\0';
const FINGERPRINT_DOMAIN = 'offload credential fingerprint v1\0';
const BIGINT_STAT_OPTIONS = Object.freeze({ bigint: true });

function rootError(message = 'integrity root is unavailable') {
  return new Error(message);
}
function owner() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}
function secureDirectory(details) {
  if (!details.isDirectory() || details.isSymbolicLink()) throw rootError('integrity state directory is invalid');
  const uid = owner();
  if ((uid !== undefined && details.uid !== uid) || (details.mode & 0o022) !== 0) throw rootError('integrity state directory is insecure');
}

/** Resolve a future POSIX path without traversing a symlinked existing part. */
export function canonicalIntegrityStatePath(path) {
  let current = resolve(path);
  const tail = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw rootError();
    tail.unshift(basename(current));
    current = parent;
  }
  if (lstatSync(current).isSymbolicLink()) throw rootError('integrity state directory is invalid');
  // Keep the spelling consistent with Git/Node's native Windows APIs. The
  // JavaScript resolver can preserve an 8.3 alias while the native resolver
  // expands it, which would otherwise make an in-repository state path look
  // unrelated to its repository root.
  return join((realpathSync.native || realpathSync)(current), ...tail);
}

export async function ensurePrivateIntegrityDirectory(path) {
  const missing = [];
  let current = resolve(path);
  try {
    for (;;) {
      try {
        secureDirectory(await lstat(current));
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = dirname(current);
        if (parent === current) throw rootError();
        missing.unshift(current);
        current = parent;
      }
    }
    for (const next of missing) {
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const details = await lstat(next);
      secureDirectory(details);
      await chmod(next, 0o700);
    }
  } catch (error) {
    if (/^integrity state directory/.test(error?.message || '')) throw error;
    throw rootError();
  }
}

async function readRootFile(path, fs = defaultRootFileSystem) {
  let details;
  try {
    details = await fs.lstat(path, BIGINT_STAT_OPTIONS);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw rootError();
  }
  const uid = owner();
  if (!validRootMetadata(details, uid) || !sameStatValue(details.size, 44)) throw rootError('integrity root is invalid');
  let handle, opened, text;
  try {
    // lstat alone is insufficient: a same-user attacker could replace the
    // final component with a link before readFile opens it. O_NOFOLLOW and the
    // lstat/fstat identity comparison make the opened descriptor authoritative.
    if (!constants.O_NOFOLLOW) throw rootError('integrity root is unavailable');
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    opened = await handle.stat(BIGINT_STAT_OPTIONS);
    if (!validRootMetadata(opened, uid) || !sameRootMetadata(details, opened)) throw rootError('integrity root is invalid');
    text = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat(BIGINT_STAT_OPTIONS);
    if (!validRootMetadata(after, uid) || !sameRootMetadata(opened, after)) throw rootError('integrity root is invalid');
  } catch (error) {
    if (error?.message === 'integrity root is invalid') throw error;
    throw rootError();
  } finally {
    await handle?.close().catch(() => {});
  }
  if (text.length !== 44 || !text.endsWith('\n') || !ROOT_RE.test(text.slice(0, -1))) throw rootError('integrity root is invalid');
  return text.slice(0, -1);
}

function sameStatValue(first, second) {
  if (first === second) return true;
  if (typeof first === 'bigint' && Number.isSafeInteger(second)) return first === BigInt(second);
  if (typeof second === 'bigint' && Number.isSafeInteger(first)) return BigInt(first) === second;
  return false;
}
function statTimestamp(details, name) {
  const nanoseconds = details?.[`${name}Ns`];
  if (typeof nanoseconds === 'bigint') return nanoseconds;
  const milliseconds = details?.[`${name}Ms`];
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds)) return milliseconds;
  const date = details?.[name];
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : undefined;
}
function sameRootMetadata(first, second) {
  return (
    ['dev', 'ino', 'uid', 'size', 'mode'].every((name) => sameStatValue(first?.[name], second?.[name])) &&
    sameTimestamp(first, second, 'mtime') &&
    sameTimestamp(first, second, 'ctime')
  );
}
function sameTimestamp(first, second, name) {
  const left = statTimestamp(first, name),
    right = statTimestamp(second, name);
  return left !== undefined && right !== undefined && sameStatValue(left, right);
}
function modeIsPrivate(mode) {
  return typeof mode === 'bigint' ? (mode & 0o077n) === 0n : (mode & 0o077) === 0;
}
function validRootMetadata(details, uid) {
  return (
    !!details?.isFile?.() &&
    !details.isSymbolicLink() &&
    (uid === undefined || sameStatValue(details.uid, uid)) &&
    modeIsPrivate(details.mode)
  );
}
const defaultRootFileSystem = Object.freeze({ lstat, open, writeFile });

/** One owner-private root file in the caller-selected hardened state directory. */
export class PosixIntegrityRoot {
  constructor({ statePath, fs = defaultRootFileSystem } = {}) {
    if (!statePath || !fs || typeof fs.lstat !== 'function' || typeof fs.open !== 'function' || typeof fs.writeFile !== 'function')
      throw rootError();
    this.statePath = canonicalIntegrityStatePath(statePath);
    this.path = join(this.statePath, ROOT_FILE);
    this.value = undefined;
    this.fs = fs;
  }
  async load({ create = false } = {}) {
    await ensurePrivateIntegrityDirectory(this.statePath);
    let value = await readRootFile(this.path, this.fs);
    if (!value && !create) throw rootError();
    if (!value) {
      const candidate = randomBytes(32).toString('base64url');
      try {
        await this.fs.writeFile(this.path, `${candidate}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw rootError();
      }
      value = await readRootFile(this.path, this.fs);
      if (!value) throw rootError();
    }
    this.value = value;
    return value;
  }
}

export { WINDOWS_INTEGRITY_ROOT_CREDENTIAL } from './secrets.mjs';
/** A fixed raw Credential Locker item. It deliberately has no repository/job
 * data and is not addressable by the generic keychain:service mapping. */
export class WindowsIntegrityRoot {
  constructor({ vault } = {}) {
    if (!vault || typeof vault.read !== 'function' || typeof vault.writeIfAbsent !== 'function') throw rootError();
    this.vault = vault;
    this.value = undefined;
  }
  #check(value) {
    if (typeof value !== 'string' || !ROOT_RE.test(value)) throw rootError('integrity root is invalid');
    return value;
  }
  async load({ create = false } = {}) {
    let value;
    try {
      value = await this.vault.read(WINDOWS_INTEGRITY_ROOT_CREDENTIAL);
    } catch {
      throw rootError();
    }
    if (value === undefined && !create) throw rootError();
    if (value === undefined) {
      const candidate = randomBytes(32).toString('base64url');
      try {
        await this.vault.writeIfAbsent(WINDOWS_INTEGRITY_ROOT_CREDENTIAL, candidate);
      } catch {
        /* another process may have won; re-read is authoritative */
      }
      try {
        value = await this.vault.read(WINDOWS_INTEGRITY_ROOT_CREDENTIAL);
      } catch {
        throw rootError();
      }
    }
    this.value = this.#check(value);
    return this.value;
  }
}

export function deriveJobMacKey(root, { repoPath, gitDir, id } = {}) {
  if (!ROOT_RE.test(root || '') || typeof repoPath !== 'string' || typeof gitDir !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id || ''))
    throw rootError('integrity key is unavailable');
  return createHmac('sha256', root)
    .update(ROOT_DOMAIN)
    .update(JOB_DOMAIN)
    .update(repoPath)
    .update('\0')
    .update(gitDir)
    .update('\0')
    .update(id)
    .digest('hex');
}
export function credentialFingerprint(root, credential) {
  if (!ROOT_RE.test(root || '') || typeof credential !== 'string' || !credential) throw rootError('credential fingerprint is unavailable');
  return {
    version: 1,
    algorithm: 'hmac-sha256',
    value: createHmac('sha256', root).update(ROOT_DOMAIN).update(FINGERPRINT_DOMAIN).update(credential, 'utf8').digest('hex'),
  };
}
export function validCredentialFingerprint(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.version === 1 &&
    value.algorithm === 'hmac-sha256' &&
    typeof value.value === 'string' &&
    /^[0-9a-f]{64}$/.test(value.value) &&
    Object.keys(value).every((key) => ['version', 'algorithm', 'value'].includes(key))
  );
}
export function sameCredentialFingerprint(left, right) {
  if (!validCredentialFingerprint(left) || !validCredentialFingerprint(right)) return false;
  return timingSafeEqual(Buffer.from(left.value, 'hex'), Buffer.from(right.value, 'hex'));
}
