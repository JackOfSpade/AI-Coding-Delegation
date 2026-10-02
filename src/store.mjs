import { mkdir, open as openFile, opendir, rename, rm, rmdir, writeFile, chmod, lstat, realpath, link, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { redact as foundationRedact, redactText } from './redact.mjs';
import { validJobId } from './job-manager.mjs';

// Accounting names such as inputTokens are not credentials.  Never redact a
// numeric count merely because it contains the word "token".
const usageTokenKey = (key) =>
  /^(?:tokens|(?:input|output|prompt|completion|total|cached|cachehit|cachemiss|reasoning)(?:tokens?|tokencount))$/i.test(
    String(key).replace(/[-_ ]/g, ''),
  );
const secretKey = (key) =>
  key !== 'credentialFingerprint' &&
  !usageTokenKey(key) &&
  /(?:api[_-]?key|authorization|secret|password|credential|bearer|(?:access|refresh|auth|session|id)?[_-]?token)/i.test(key);
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_JOB_BYTES = 1024 * 1024;
const MAX_RECORDS = 20_000;
const MAX_JOB_DIRS = 2_000;
const INTEGRITY_VERSION = 1;
const INTEGRITY_DOMAIN = 'offload job integrity v1\0';
const PUBLICATION_ARTIFACTS = new Set(['patch.diff', 'revert.diff', 'report.md']);
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 120_000;
const WINDOWS_RENAME_ATTEMPTS = 8;
const validId = validJobId;
const lifecycleIdentity = (job) => ({
  status: job?.status,
  handoffState: job?.handoffState,
  leaseOwnerNonce: job?.leaseOwnerNonce,
  runnerPid: job?.runnerPid,
  runnerHeartbeatAt: job?.runnerHeartbeatAt,
});

/**
 * Antivirus/indexing can briefly hold a just-read destination on Windows.
 * A same-directory replacement remains atomic; retry only those transient
 * sharing failures and leave every other publication error fail-closed.
 */
export async function atomicRename(path, destination, { platform = process.platform, renameFile = rename, delay = sleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(path, destination);
      return;
    } catch (error) {
      const transient = platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
      if (!transient || attempt >= WINDOWS_RENAME_ATTEMPTS - 1) throw error;
      await delay(Math.min(10 * 2 ** attempt, 160));
    }
  }
}

// JSON.stringify is deliberately not used as the canonical representation:
// object insertion order can otherwise turn an equivalent durable record into
// a different MAC input.  Match JSON's omission/null rules so the bytes we
// authenticate are exactly the record representation that can be persisted.
function stableJson(value, arrayMember = false) {
  if (value === undefined) return arrayMember ? 'null' : undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, true)).join(',')}]`;
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const encoded = stableJson(value[key]);
    if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
}
function unsignedJob(job) {
  const { integrity: _integrity, ...rest } = job;
  return stableJson(rest);
}
function integrityKey(secret) {
  return createHash('sha256').update(INTEGRITY_DOMAIN).update(String(secret), 'utf8').digest();
}
function macFor(job, secret) {
  return createHmac('sha256', integrityKey(secret)).update(unsignedJob(job), 'utf8').digest();
}
function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}
function validEnvelope(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.version === INTEGRITY_VERSION &&
    value.algorithm === 'hmac-sha256' &&
    typeof value.mac === 'string' &&
    /^[0-9a-f]{64}$/i.test(value.mac) &&
    Object.keys(value).every((key) => ['version', 'algorithm', 'mac'].includes(key))
  );
}
const validDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
function validDigestMap(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => PUBLICATION_ARTIFACTS.has(key) && validDigest(value[key]))
  );
}
// Pending records are a small, authenticated write-ahead journal.  Validate
// their complete shape before any caller can act on a record: a valid MAC is
// not a reason to let an old/broken writer manufacture an ambiguous state.
function validPublicationState(value) {
  const hasPendingDigest = Object.hasOwn(value, 'transcriptPendingDigest');
  const hasPendingBytes = Object.hasOwn(value, 'transcriptPendingBytes');
  if (hasPendingDigest !== hasPendingBytes) return false;
  if (Object.hasOwn(value, 'transcriptDigest') && !validDigest(value.transcriptDigest)) return false;
  if (
    Object.hasOwn(value, 'transcriptBytes') &&
    (!Number.isSafeInteger(value.transcriptBytes) || value.transcriptBytes < 0 || value.transcriptBytes > MAX_TRANSCRIPT_BYTES)
  )
    return false;
  if (
    hasPendingDigest &&
    (!validDigest(value.transcriptPendingDigest) ||
      !Number.isSafeInteger(value.transcriptPendingBytes) ||
      value.transcriptPendingBytes < 0 ||
      value.transcriptPendingBytes > MAX_TRANSCRIPT_BYTES)
  )
    return false;
  return (
    (value.artifactDigests === undefined || validDigestMap(value.artifactDigests)) &&
    (value.artifactPendingDigests === undefined ||
      (validDigestMap(value.artifactPendingDigests) && Object.keys(value.artifactPendingDigests).length > 0))
  );
}
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretKey(k) ? '[REDACTED]' : redact(v)]));
  if (typeof value === 'string') return value.replace(/\b(?:sk|rk|key|bearer)[-_A-Za-z0-9]{12,}\b/gi, '[REDACTED]');
  return value;
}
function validStoredReadStat(details, cap) {
  return (
    !!details &&
    details.isFile() &&
    !details.isSymbolicLink() &&
    typeof details.dev === 'bigint' &&
    typeof details.ino === 'bigint' &&
    typeof details.size === 'bigint' &&
    typeof details.mode === 'bigint' &&
    typeof details.mtimeNs === 'bigint' &&
    typeof details.ctimeNs === 'bigint' &&
    details.size >= 0n &&
    details.size <= BigInt(cap)
  );
}
function sameStoredReadStat(left, right) {
  return ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]);
}
function decodeStoredUtf8(bytes, description = 'stored file') {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${description} is not valid UTF-8`);
  }
}
const LOSSY_PATCH_DISPLAY = '[Lossy display: exact patch bytes are retained for apply/revert.]\n';
function safePatchDisplay(bytes) {
  let text;
  let transformed = false;
  try {
    text = decodeStoredUtf8(bytes, 'patch artifact');
  } catch {
    // U+FFFD is intentionally only a display replacement. The raw artifact
    // remains authenticated and is used by integration/revert paths.
    text = new TextDecoder('utf-8').decode(bytes);
    transformed = true;
  }
  // Newlines, carriage returns and tabs are necessary patch formatting. All
  // other C0/C1 controls and bidi formatting controls can alter a terminal
  // reviewer's interpretation, so render their code points visibly.
  const safe = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, (character) => {
    transformed = true;
    return `<U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`;
  });
  return transformed ? `${LOSSY_PATCH_DISPLAY}${safe}` : safe;
}
/** Read one regular managed file through a checked descriptor without altering its bytes. */
export async function readStoredBytes(path, cap, fallback = null, { platform = process.platform, fs = defaultFileSystem } = {}) {
  if (!Number.isSafeInteger(cap) || cap < 0) throw new TypeError('stored file size limit must be a non-negative safe integer');
  let handle;
  try {
    const before = await fs.lstat(path, { bigint: true });
    if (!validStoredReadStat(before, cap)) throw new Error('stored file is invalid or exceeds its size limit');
    // O_NOFOLLOW closes the final-component swap on POSIX. Windows falls
    // back to lstat/fstat identity comparison, which detects a redirected
    // target after the initial check.
    const noFollow = platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW || 0;
    handle = await fs.open(path, fs.constants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!validStoredReadStat(opened, cap) || !sameStoredReadStat(before, opened))
      throw new Error('stored file is invalid or changed while opening');
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('stored file changed while reading');
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!validStoredReadStat(after, cap) || !sameStoredReadStat(opened, after)) throw new Error('stored file changed while reading');
    return bytes;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
/** Read strict UTF-8 JSON/text storage. Binary artifacts must use readStoredBytes. */
export async function readStoredFile(path, cap, fallback = null, options = {}) {
  const bytes = await readStoredBytes(path, cap, null, options);
  return bytes === null ? fallback : decodeStoredUtf8(bytes);
}
const defaultFileSystem = Object.freeze({ constants, lstat, open: openFile });
async function json(path, fallback = null) {
  const text = await readStoredFile(path, MAX_JOB_BYTES, null);
  if (text === null) return fallback;
  try {
    const value = JSON.parse(text);
    if (!validStoredJob(value)) throw new Error('stored job is invalid');
    return value;
  } catch (error) {
    throw new Error(`stored job is corrupt: ${error.message || error}`);
  }
}

export class JobStore {
  constructor({ gitDir, repoPath, now = () => new Date(), id = () => randomUUID().replaceAll('-', ''), secrets = [], integrity } = {}) {
    this.gitDir = gitDir && resolve(gitDir);
    this.repoPath = repoPath;
    this.now = now;
    this.id = id;
    this.secrets = secrets.filter((x) => typeof x === 'string' && x);
    this.writes = Promise.resolve();
    this.integrity = integrity;
    this.platform = process.platform;
  }
  configureIntegrity(integrity) {
    if (!integrity || typeof integrity.keyForId !== 'function') throw new TypeError('integrity keyForId is required');
    this.integrity = integrity;
    return this;
  }
  integrityRequired(job) {
    return !!this.integrity && (this.integrity.requiredFor ? !!this.integrity.requiredFor(job) : true);
  }
  verifyJob(job) {
    if (!this.integrityRequired(job)) return true;
    if (!validEnvelope(job?.integrity)) return false;
    let expected, received;
    try {
      const secret = this.integrity.keyForId(job.id);
      if (typeof secret !== 'string' || !secret) return false;
      expected = macFor(job, secret);
      received = Buffer.from(job.integrity.mac, 'hex');
    } catch {
      return false;
    }
    return expected.length === received.length && timingSafeEqual(expected, received);
  }
  #seal(job) {
    if (!this.integrityRequired(job)) return job;
    let secret;
    try {
      secret = this.integrity.keyForId(job.id);
    } catch {
      throw new Error('job integrity key is unavailable');
    }
    if (typeof secret !== 'string' || !secret) throw new Error('job integrity key is unavailable');
    return { ...job, integrity: { version: INTEGRITY_VERSION, algorithm: 'hmac-sha256', mac: macFor(job, secret).toString('hex') } };
  }
  async #authenticate(job) {
    // Optional adapters can perform an asynchronous credential check, but
    // only after the synchronous record MAC above has succeeded.
    if (!this.integrityRequired(job) || typeof this.integrity.authenticate !== 'function') return job;
    try {
      await this.integrity.authenticate(job);
    } catch {
      throw new Error('stored job integrity check failed');
    }
    return job;
  }
  async init(repoPath = this.repoPath) {
    if (!this.gitDir) {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
      const gd = execFileSync('git', ['-C', resolve(repoPath || process.cwd()), 'rev-parse', '--git-dir'], {
        encoding: 'utf8',
        env,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }).trim();
      this.gitDir = resolve(repoPath || process.cwd(), gd);
    }
    // Canonicalize before checking ancestry: macOS exposes /tmp through a
    // system link, but no repository-controlled link may survive this point.
    this.gitDir = await realpath(this.gitDir);
    await this.#assertSafeGitAncestry();
    const offload = join(this.gitDir, 'offload');
    // A job record can contain paths, provider metadata, and an ownership
    // nonce. Never follow a repository-controlled link out of the gitdir.
    await this.#privateDirectory(offload);
    this.root = join(offload, 'jobs');
    await this.#privateDirectory(this.root);
    return this;
  }
  path(id) {
    if (!validId(id)) throw new Error('invalid job id');
    return join(this.root, id);
  }
  async create(input) {
    await this.init();
    const id = input.id || `oj-${this.now().toISOString().slice(0, 10).replaceAll('-', '')}-${this.id()}`;
    const directory = this.path(id);
    const base = redact({
      ...input,
      id,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      status: input.status || 'QUEUED',
    });
    let prepared = base;
    if (this.integrityRequired(base) && typeof this.integrity.prepare === 'function') {
      try {
        prepared = await this.integrity.prepare(base);
      } catch {
        throw new Error('job integrity key is unavailable');
      }
    }
    const job = this.integrityRequired(prepared)
      ? { ...prepared, transcriptDigest: digest(''), transcriptBytes: 0, artifactDigests: {} }
      : prepared;
    // Preparing/signing can fail (and #writeJob can reject an overlarge or
    // unserializable record).  Do all of that before claiming a durable name,
    // then remove only the empty directory this invocation successfully made.
    return this.#serial(async () => {
      let created = false;
      try {
        await mkdir(directory, { recursive: false, mode: 0o700 });
        created = true;
        await this.#assertJobDirectory(id);
        return await this.#writeJob(job);
      } catch (error) {
        if (created) await this.#removeEmptyJobDirectory(id);
        throw error;
      }
    });
  }
  async #writeJob(job) {
    // ownerNonce is an opaque local synchronization capability, not a secret
    // sent to a provider. Preserve it in this 0600 artifact without allowing
    // generic key-name redaction to turn it into an unusable placeholder.
    const ownerNonce = job.leaseOwnerNonce;
    // A root-keyed fingerprint is opaque verification metadata, not a
    // credential. Preserve its already validated adapter-generated shape.
    const credentialFingerprint = job.credentialFingerprint;
    const copy = foundationRedact(redact({ ...job, updatedAt: this.now().toISOString() }), this.secrets);
    if (ownerNonce) copy.leaseOwnerNonce = ownerNonce;
    if (credentialFingerprint) copy.credentialFingerprint = credentialFingerprint;
    // Normalize through the exact JSON representation before signing. This
    // handles Date/toJSON values and rejects values JSON cannot persist rather
    // than emitting a record whose subsequent read has different MAC bytes.
    let normalized;
    try {
      normalized = JSON.parse(JSON.stringify(copy));
    } catch {
      throw new Error('job cannot be serialized safely');
    }
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) throw new Error('job cannot be serialized safely');
    if (!validStoredJob(normalized)) throw new Error('job publication intent is invalid');
    const sealed = this.#seal(normalized);
    const path = join(await this.#assertJobDirectory(sealed.id), 'job.json');
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const encoded = `${JSON.stringify(sealed, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > MAX_JOB_BYTES) throw new Error('job exceeds size limit');
    try {
      await writeFile(tmp, encoded, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await atomicRename(tmp, path, { platform: this.platform });
      return sealed;
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
  async get(id) {
    return this.#readJob(id, { authenticate: true });
  }
  // Operational lifecycle work (durable cancellation, crash recovery and
  // lease cleanup) must survive a credential rotation.  This deliberately
  // skips only the credential-fingerprint check; the complete record MAC is
  // still required before any record field is returned to the caller.
  async getOperational(id) {
    return this.#readJob(id, { authenticate: false });
  }
  async #readJob(id, { authenticate }) {
    await this.init();
    const path = join(await this.#assertJobDirectory(id), 'job.json');
    let job;
    // A normal writer publishes with same-directory rename. Retry one checked
    // read if that benign replacement races our descriptor identity check;
    // a persistent link/corruption still fails closed.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        job = await json(path);
        break;
      } catch (error) {
        if (attempt === 0 && /^stored file .*changed/.test(error.message || '')) continue;
        throw error;
      }
    }
    if (!job) throw new Error(`job not found: ${id}`);
    if (job.id !== id) throw new Error('stored job id does not match its directory');
    if (this.integrityRequired(job) && !this.verifyJob(job)) throw new Error('stored job integrity check failed');
    return authenticate ? this.#authenticate(job) : job;
  }
  async update(id, changes) {
    return this.#withJobLock(id, () =>
      this.#serial(async () => {
        let job = await this.get(id);
        job = await this.#healPublicationsUnlocked(job, await this.#assertJobDirectory(id));
        if (!this.verifyJob(job)) throw new Error('stored job integrity check failed');
        const safe = redact(changes);
        if (safe.id !== undefined && safe.id !== id) throw new Error('job id cannot be changed');
        return this.#writeJob({ ...job, ...safe });
      }),
    );
  }
  async updateOperational(id, changes) {
    return this.#withJobLock(id, () =>
      this.#serial(async () => {
        let job = await this.getOperational(id);
        job = await this.#healPublicationsUnlocked(job, await this.#assertJobDirectory(id));
        if (!this.verifyJob(job)) throw new Error('stored job integrity check failed');
        const safe = redact(changes);
        if (safe.id !== undefined && safe.id !== id) throw new Error('job id cannot be changed');
        return this.#writeJob({ ...job, ...safe });
      }),
    );
  }
  /**
   * Atomically publish an operational lifecycle transition only if the small
   * ownership tuple observed by the caller still names this exact owner. A
   * recovery process uses this before taking cleanup authority: an ordinary
   * read followed by update could overwrite a detached parent-to-child
   * handoff that won between those two operations.
   *
   * `null` is an expected compare-and-swap miss, not a failed publication.
   * Keep this operational: credential rotation must not prevent a worker
   * lifecycle safety check.
   */
  async updateOperationalIf(id, expected, changes) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new TypeError('expected job state is required');
    return this.#withJobLock(id, () =>
      this.#serial(async () => {
        let job = await this.getOperational(id);
        job = await this.#healPublicationsUnlocked(job, await this.#assertJobDirectory(id));
        if (!this.verifyJob(job)) throw new Error('stored job integrity check failed');
        if (!Object.entries(expected).every(([key, value]) => Object.is(job[key], value))) return null;
        const safe = redact(changes);
        if (safe.id !== undefined && safe.id !== id) throw new Error('job id cannot be changed');
        return this.#writeJob({ ...job, ...safe });
      }),
    );
  }
  async requestCancel(id) {
    await this.init();
    const path = join(await this.#assertJobDirectory(id), 'cancel.request');
    // Cancellation is a durable flag, so a second request need not replace its
    // timestamp. This also avoids Windows rename's no-replace behavior.
    try {
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('cancel request file is invalid');
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, `${this.now().toISOString()}\n`, { mode: 0o600 });
      try {
        await rename(tmp, path);
      } catch (error) {
        // Another process may have won this idempotent request. Accept only a
        // normal file; a link must never be treated as a trusted signal.
        if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
        const existing = await lstat(path);
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('cancel request file is invalid');
      }
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
  async cancelRequested(id) {
    await this.init();
    const request = await readStoredFile(join(await this.#assertJobDirectory(id), 'cancel.request'), MAX_JOB_BYTES, null);
    return request !== null;
  }
  async clearCancel(id) {
    await this.init();
    await rm(join(await this.#assertJobDirectory(id), 'cancel.request'), { force: true });
  }
  async event(id, event) {
    await this.init();
    const directory = await this.#assertJobDirectory(id);
    const line = JSON.stringify(foundationRedact(redact({ at: this.now().toISOString(), ...event }), this.secrets)) + '\n';
    return this.#withJobLock(id, () => this.#serial(() => this.#appendBounded(join(directory, 'events.jsonl'), line)));
  }
  async messages(id, message) {
    return this.messagesBatch(id, [message]);
  }
  /** Persist a logical transcript batch with one authenticated publication.
   * A caller never observes a durable prefix of this batch. */
  async messagesBatch(id, messages) {
    await this.init();
    const directory = await this.#assertJobDirectory(id);
    if (!Array.isArray(messages) || messages.length === 0 || messages.some((message) => !validMessage(message)))
      throw new Error('invalid transcript message');
    const lines = messages.map((message) => JSON.stringify(foundationRedact(redact(message), this.secrets)) + '\n');
    if (lines.some((line) => Buffer.byteLength(line) > MAX_TRANSCRIPT_BYTES)) throw new Error('transcript record exceeds size limit');
    return this.#withJobLock(id, () =>
      this.#serial(async () => {
        let job = await this.get(id);
        job = await this.#healPublicationsUnlocked(job, directory);
        const path = join(directory, 'messages.jsonl');
        const current = await this.#readTranscript(path, job);
        const prior = this.#parseTranscript(current, { allowTornTail: !this.integrityRequired(job) });
        let retained = prior;
        if (!validTranscript([...prior, ...messages])) {
          // Resuming a crashed tool turn starts a new user/assistant turn, not a
          // late tool result. Discard only that final incomplete transaction;
          // incoming tool results still complete the durable assistant call.
          const start = messages[0]?.role === 'tool' ? -1 : incompleteToolTailStart(prior);
          if (start < 0 || !validTranscript([...prior.slice(0, start), ...messages]))
            throw new Error('invalid transcript role/tool ordering');
          retained = prior.slice(0, start);
        }
        // Legacy unsealed append files can end in a torn/non-terminated record.
        // Rebuild the accepted prefix before adding a new batch; concatenating
        // onto raw torn bytes would otherwise manufacture invalid JSONL.
        const prefix =
          retained === prior && current.endsWith('\n') ? current : retained.map((message) => `${JSON.stringify(message)}\n`).join('');
        const text = `${prefix}${lines.join('')}`;
        const bytes = Buffer.byteLength(text);
        if (bytes > MAX_TRANSCRIPT_BYTES) throw new Error('transcript exceeds size limit');
        if (this.integrityRequired(job)) {
          // The sealed intent makes either side of a crash unambiguous: readers
          // accept precisely the old or the new full digest, never arbitrary
          // JSON that happens to be parseable at EOF.
          const pending = {
            ...job,
            transcriptDigest: digest(current),
            transcriptBytes: Buffer.byteLength(current),
            transcriptPendingDigest: digest(text),
            transcriptPendingBytes: bytes,
          };
          await this.#writeJob(pending);
        }
        await this.#replaceStoredFile(path, text);
        if (this.integrityRequired(job)) {
          const committed = { ...job, transcriptDigest: digest(text), transcriptBytes: bytes };
          delete committed.transcriptPendingDigest;
          delete committed.transcriptPendingBytes;
          await this.#writeJob(committed);
        }
      }),
    );
  }
  /** Integrity accepts only a sealed predecessor or sealed successor after an
   * interrupted publication; malformed/tampered suffixes are never parsed. */
  async readMessages(id) {
    await this.init();
    const directory = await this.#assertJobDirectory(id);
    const job = await this.get(id);
    const text = await this.#readTranscript(join(directory, 'messages.jsonl'), job);
    const values = this.#parseTranscript(text, { allowTornTail: !this.integrityRequired(job) });
    if (!validTranscript(values)) throw new Error('corrupt transcript: invalid role/tool ordering');
    return values;
  }
  async readArtifactBytes(id, name) {
    await this.init();
    if (!['patch.diff', 'revert.diff', 'report.md', 'events.jsonl', 'messages.jsonl'].includes(name)) throw new Error('invalid artifact');
    const directory = await this.#assertJobDirectory(id);
    const job = await this.get(id);
    const bytes = await readStoredBytes(join(directory, name), MAX_ARTIFACT_BYTES, Buffer.alloc(0));
    if (
      this.integrityRequired(job) &&
      ['patch.diff', 'revert.diff', 'report.md'].includes(name) &&
      (bytes.length > 0 || job.artifactDigests?.[name])
    ) {
      const actual = digest(bytes),
        committed = job.artifactDigests?.[name],
        pending = job.artifactPendingDigests?.[name];
      if ((typeof committed !== 'string' || actual !== committed) && (typeof pending !== 'string' || actual !== pending))
        throw new Error('stored artifact integrity check failed');
    }
    return bytes;
  }
  async readArtifact(id, name) {
    const bytes = await this.readArtifactBytes(id, name);
    if (['patch.diff', 'revert.diff'].includes(name)) return safePatchDisplay(bytes);
    return decodeStoredUtf8(bytes, 'stored artifact');
  }
  /** Resolve a sealed publication intent after a process crash.  This is
   * deliberately operational: the record MAC is still required, but a
   * rotated provider credential must not strand transcript/artifact recovery. */
  async healPublications(id) {
    await this.init();
    return this.#withJobLock(id, () =>
      this.#serial(async () => {
        const job = await this.getOperational(id);
        const directory = await this.#assertJobDirectory(id);
        return this.#healPublicationsUnlocked(job, directory);
      }),
    );
  }
  async #healPublicationsUnlocked(job, directory) {
    if (job.transcriptPendingDigest === undefined && job.artifactPendingDigests === undefined) return job;
    const healed = { ...job };
    if (job.transcriptPendingDigest !== undefined) {
      const text = await this.#readTranscript(join(directory, 'messages.jsonl'), job);
      // #readTranscript already proved this is exactly the old or the new
      // publication. Bind the committed side to the bytes that survived.
      healed.transcriptDigest = digest(text);
      healed.transcriptBytes = Buffer.byteLength(text);
      delete healed.transcriptPendingDigest;
      delete healed.transcriptPendingBytes;
    }
    if (job.artifactPendingDigests !== undefined) {
      const committed = { ...(job.artifactDigests || {}) };
      for (const [name, pending] of Object.entries(job.artifactPendingDigests)) {
        const bytes = await readStoredBytes(join(directory, name), MAX_ARTIFACT_BYTES, Buffer.alloc(0));
        const actual = digest(bytes),
          previous = committed[name];
        if (actual === pending) committed[name] = pending;
        else if (previous && actual === previous) {
          /* publication did not reach rename */
        } else if (!previous && bytes.length === 0) {
          /* no prior artifact */
        } else throw new Error('stored artifact integrity check failed');
      }
      healed.artifactDigests = committed;
      delete healed.artifactPendingDigests;
    }
    return this.#writeJob(healed);
  }
  async writeArtifact(id, name, content) {
    return this.#writeArtifact(id, name, content, { authenticate: true });
  }
  // Recovery can persist an authenticated terminal report after a credential
  // rotation, but it must not be able to use this path to launch execution.
  async writeArtifactOperational(id, name, content) {
    return this.#writeArtifact(id, name, content, { authenticate: false });
  }
  async #writeArtifact(id, name, content, { authenticate }) {
    await this.init();
    if (!['patch.diff', 'revert.diff', 'report.md'].includes(name)) throw new Error('invalid artifact');
    if (!Buffer.isBuffer(content) && typeof content !== 'string') throw new TypeError('artifact content must be a string or Buffer');
    const raw = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, 'utf8');
    if (raw.length > MAX_ARTIFACT_BYTES) throw new Error('artifact exceeds size limit');
    const patchArtifact = ['patch.diff', 'revert.diff'].includes(name);
    if (patchArtifact && this.secrets.some((secret) => raw.includes(Buffer.from(secret, 'utf8'))))
      throw new Error('refusing to persist patch containing configured secret');
    const path = join(await this.#assertJobDirectory(id), name);
    return this.#withJobLock(id, () =>
      this.#serial(async () => {
        let job = authenticate ? await this.get(id) : await this.getOperational(id);
        job = await this.#healPublicationsUnlocked(job, await this.#assertJobDirectory(id));
        // Reports are human-facing strict UTF-8 text. Patches are deliberately
        // opaque bytes: Git can produce a textual-looking patch containing an
        // invalid UTF-8 blob and applying it must remain lossless.
        const stored = patchArtifact ? raw : Buffer.from(redactText(decodeStoredUtf8(raw, 'artifact'), this.secrets), 'utf8');
        if (this.integrityRequired(job))
          await this.#writeJob({ ...job, artifactPendingDigests: { ...(job.artifactPendingDigests || {}), [name]: digest(stored) } });
        await this.#replaceStoredFile(path, stored);
        if (this.integrityRequired(job)) {
          const pending = { ...(job.artifactPendingDigests || {}) };
          delete pending[name];
          const committed = { ...job, artifactDigests: { ...(job.artifactDigests || {}), [name]: digest(stored) } };
          if (Object.keys(pending).length) committed.artifactPendingDigests = pending;
          else delete committed.artifactPendingDigests;
          await this.#writeJob(committed);
        }
      }),
    );
  }
  async list(options = {}) {
    return this.#list(options, { authenticate: true });
  }
  async listOperational(options = {}) {
    return this.#list(options, { authenticate: false });
  }
  async #list({ limit = 20 } = {}, { authenticate }) {
    await this.init();
    const ids = [];
    let directory;
    try {
      directory = await opendir(this.root);
      for await (const entry of directory) {
        if (entry.isDirectory() && validId(entry.name)) {
          if (ids.length >= MAX_JOB_DIRS) throw new Error('too many stored jobs');
          ids.push(entry.name);
        }
      }
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    } finally {
      await directory?.close().catch(() => {});
    }
    const jobs = [];
    for (let start = 0; start < ids.length; start += 16)
      jobs.push(
        ...(await Promise.all(
          ids.slice(start, start + 16).map(async (id) => {
            const directory = await this.#assertJobDirectory(id).catch(() => null);
            const job = directory && (await json(join(directory, 'job.json')).catch(() => null));
            // Listing is also an authority boundary: callers feed these records to
            // lifecycle recovery. A plain/injected store must not surface a record
            // whose embedded id points at another directory (or an invalid path),
            // even when integrity MACs are intentionally disabled for a test/local
            // adapter.
            if (!job?.id || !validId(job.id) || job.id !== id || (this.integrityRequired(job) && !this.verifyJob(job))) return null;
            if (!authenticate) return job;
            try {
              return await this.#authenticate(job);
            } catch {
              return null;
            }
          }),
        )),
      );
    return jobs
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  // This is intentionally a raw presence check, rather than a list/get
  // variant: missing integrity state must never look like an empty store just
  // because a durable record is corrupt or otherwise unreadable.  Do not
  // parse records or invoke integrity/credential adapters here.
  async hasDurableEntries() {
    await this.init();
    let directory;
    try {
      directory = await opendir(this.root);
      for await (const entry of directory) {
        const details = await lstat(join(this.root, entry.name));
        if (details.isSymbolicLink()) throw new Error('job storage entry is invalid');
        return true;
      }
      return false;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    } finally {
      await directory?.close().catch(() => {});
    }
  }
  /**
   * Mark interrupted work as failed before it is shown to a newly started
   * server. A live detached CLI worker is deliberately not an interruption:
   * its pid is recorded by JobManager and remains responsible for the job.
   */
  async recover({ exceptIds = [], pidAlive = defaultPidAlive } = {}) {
    const except = new Set(exceptIds);
    const jobs = await this.listOperational({ limit: Number.MAX_SAFE_INTEGER });
    let recovered = 0;
    for (const job of jobs) {
      if (!['QUEUED', 'RUNNING', 'REPAIRING'].includes(job.status) || except.has(job.id)) continue;
      // A suspended worker can miss this durable heartbeat and resume with an
      // otherwise valid lease. Conservatively leave every live PID alone;
      // PID reuse can delay recovery, but cannot authorize recovery to fence
      // a process which may still write its private workspace.
      if (Number.isInteger(job.runnerPid) && pidAlive(job.runnerPid)) continue;
      // JobStore has no lease or workspace authority. Do not falsely publish
      // a terminal outcome here: JobManager recovery will release/clean while
      // this record remains FINALIZING, then publish its terminal status.
      const staged = await this.updateOperationalIf(job.id, lifecycleIdentity(job), {
        status: 'FINALIZING',
        finalStatus: 'FAILED',
        error: 'server restarted',
      });
      if (!staged) continue;
      await this.event(job.id, { type: 'recovery-staged', message: 'server restarted' });
      recovered += 1;
    }
    return recovered;
  }
  async remove(id) {
    // Keep deletion on the same managed-directory boundary as every other
    // operation.  In particular, a freshly constructed store has no `root`
    // yet, and a repository-controlled symlink must not be accepted merely
    // because `rm` happens to unlink it on one platform.
    await this.init();
    const directory = await this.#assertJobDirectory(id);
    await rm(directory, { recursive: true, force: true });
  }
  #posix() {
    return this.platform !== 'win32';
  }
  #ownedByCurrentUserOrRoot(details) {
    if (!this.#posix()) return true;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    return uid === undefined || details.uid === uid || details.uid === 0;
  }
  #ownedByCurrentUser(details) {
    if (!this.#posix()) return true;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    return uid === undefined || details.uid === uid;
  }
  #safeAncestor(details) {
    if (!details.isDirectory() || details.isSymbolicLink() || !this.#ownedByCurrentUserOrRoot(details)) return false;
    // A sticky directory prevents another user from replacing an entry owned by
    // us (or root). Non-sticky group/world-writable ancestors do not.
    return (details.mode & 0o022) === 0 || (details.mode & 0o1000) !== 0;
  }
  async #assertSafeGitAncestry() {
    if (!this.#posix()) return;
    let current = this.gitDir;
    for (;;) {
      let details;
      try {
        details = await lstat(current);
      } catch {
        throw new Error('job storage ancestry is invalid');
      }
      if (!this.#safeAncestor(details)) throw new Error('job storage ancestry is insecure');
      const parent = resolve(current, '..');
      if (parent === current) return;
      current = parent;
    }
  }
  async #checkedManagedDirectory(path) {
    let before, handle;
    try {
      before = await lstat(path);
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('job storage directory is invalid');
      if (!this.#posix()) return;
      if (!this.#ownedByCurrentUser(before)) throw new Error('job storage directory is insecure');
      if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw new Error('job storage directory is unavailable');
      handle = await openFile(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino || !this.#ownedByCurrentUser(opened))
        throw new Error('job storage directory is invalid');
      // chmod by descriptor closes the lstat/chmod replacement gap. Do not
      // chmod an attacker-owned directory merely because a privileged process
      // happened to inspect it first.
      await handle.chmod(0o700);
      const after = await handle.stat();
      if (
        !after.isDirectory() ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        !this.#ownedByCurrentUser(after) ||
        (after.mode & 0o077) !== 0
      )
        throw new Error('job storage directory is insecure');
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  async #privateDirectory(path) {
    // A second CLI/MCP process can create the same directory after lstat but
    // before mkdir. Retry inspection on EEXIST; never turn this into a
    // recursive create that could traverse a symlink introduced in the gap.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.#checkedManagedDirectory(path);
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try {
          await mkdir(path, { recursive: false, mode: 0o700 });
        } catch (mkdirError) {
          if (mkdirError.code !== 'EEXIST') throw mkdirError;
        }
      }
    }
    // The only possible remaining outcome is a raced replacement. Inspect it
    // once more and fail closed if it is not our private directory.
    await this.#checkedManagedDirectory(path);
  }
  async #assertJobDirectory(id) {
    const directory = this.path(id);
    try {
      await this.#checkedManagedDirectory(directory);
      return directory;
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`job not found: ${id}`);
      throw error;
    }
  }
  async #serial(action) {
    const prior = this.writes;
    let release;
    this.writes = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }
  async #withJobLock(id, action) {
    // `this.writes` protects one JobStore instance only.  Use an O_EXCL lock
    // file for CLI/MCP/worker coordination.  Lock retirement is identity-bound
    // and quarantined, so a delayed stale reclaimer cannot delete a newly
    // acquired lock at the original pathname.
    await this.init();
    const directory = await this.#assertJobDirectory(id);
    const lock = join(directory, '.publication-lock');
    const token = randomUUID();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      if (await this.#publicationTombstonePending(directory)) {
        if (Date.now() >= deadline) throw new Error('job publication lock is busy');
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
        continue;
      }
      let handle, createdIdentity;
      try {
        const noFollow = this.platform === 'win32' ? 0 : constants.O_NOFOLLOW || 0;
        handle = await openFile(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
        const opened = await handle.stat({ bigint: true });
        createdIdentity = { dev: opened.dev, ino: opened.ino };
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8');
        await handle.chmod(0o600);
        await handle.close();
        handle = undefined;
        // A reclaimer may have quarantined an old lock between the preflight
        // and O_EXCL create.  Cooperating contenders never enter while its
        // tombstone remains, which closes that ABA window.
        if (await this.#publicationTombstonePending(directory)) {
          await this.#retirePublicationLock(lock, { token });
          continue;
        }
        break;
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error?.code !== 'EEXIST') {
          // If setup failed after O_EXCL creation, retire only that exact
          // inode. Leaving it behind would turn a local I/O failure into a
          // stale-grace publication outage for every other process.
          if (createdIdentity) await this.#retirePublicationLock(lock, { identity: createdIdentity });
          throw error;
        }
        let details;
        try {
          details = await lstat(lock, { bigint: true });
        } catch (race) {
          if (race?.code === 'ENOENT') continue;
          throw race;
        }
        if (!details.isFile() || details.isSymbolicLink()) throw new Error('job publication lock is invalid');
        const owner = await this.#readPublicationOwner(lock);
        // A delayed stale reclaimer can quarantine then restore our own
        // just-created file. Recognize that token instead of waiting for
        // ourselves; a pending tombstone still prevents early entry.
        if (owner?.token === token && !(await this.#publicationTombstonePending(directory))) break;
        const ownerAlive = Number.isInteger(owner?.pid) && owner.pid > 0 && defaultPidAlive(owner.pid);
        // A newly-created lock can be observed before its owner JSON reaches
        // the file. Malformed/missing state is therefore busy until the same
        // stale grace period as a known-dead owner, never a transient error.
        if (!ownerAlive && Date.now() - Number(details.mtimeMs) > LOCK_STALE_MS) {
          await this.#retirePublicationLock(lock, { identity: { dev: details.dev, ino: details.ino } });
          continue;
        }
        if (Date.now() >= deadline) throw new Error('job publication lock is busy');
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
      }
    }
    try {
      return await action();
    } finally {
      await this.#retirePublicationLock(lock, { token });
    }
  }
  async #readPublicationOwner(path) {
    try {
      const text = await readStoredFile(path, 4096, null);
      if (text === null) return null;
      const owner = JSON.parse(text);
      return owner &&
        typeof owner === 'object' &&
        !Array.isArray(owner) &&
        Object.keys(owner).every((key) => ['pid', 'token'].includes(key)) &&
        Number.isInteger(owner.pid) &&
        owner.pid > 0 &&
        typeof owner.token === 'string' &&
        owner.token.length > 0
        ? owner
        : null;
    } catch {
      return null;
    }
  }
  async #publicationTombstonePending(directory) {
    let handle;
    try {
      handle = await opendir(directory);
      for await (const entry of handle) {
        if (!entry.name.startsWith('.publication-lock.') || !entry.name.endsWith('.retired')) continue;
        const tombstone = join(directory, entry.name);
        let details;
        try {
          details = await lstat(tombstone, { bigint: true });
        } catch {
          continue;
        }
        if (!details.isFile() || details.isSymbolicLink()) throw new Error('job publication lock is invalid');
        const owner = await this.#readPublicationOwner(tombstone);
        if ((!Number.isInteger(owner?.pid) || !defaultPidAlive(owner.pid)) && Date.now() - Number(details.mtimeMs) > LOCK_STALE_MS) {
          // Tombstones have unique names and are never a live lock pathname,
          // so their stale cleanup cannot erase a subsequent owner.
          await unlink(tombstone).catch(() => {});
          continue;
        }
        return true;
      }
      return false;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  async #retirePublicationLock(lock, { identity, token } = {}) {
    const tombstone = `${lock}.${process.pid}.${randomUUID()}.retired`;
    try {
      await rename(lock, tombstone);
    } catch {
      return false;
    }
    let details;
    try {
      details = await lstat(tombstone, { bigint: true });
    } catch {
      return false;
    }
    const same =
      details.isFile() && !details.isSymbolicLink() && (!identity || (details.dev === identity.dev && details.ino === identity.ino));
    const owner = await this.#readPublicationOwner(tombstone);
    if (same && (!token || owner?.token === token)) {
      await unlink(tombstone).catch(() => {});
      return true;
    }
    // A replacement won between inspection and rename. Restore only with a
    // no-replace hard link; contenders observe the tombstone and withdraw
    // their own provisional lock before they can enter the critical section.
    try {
      await link(tombstone, lock);
      await unlink(tombstone);
    } catch {}
    return false;
  }
  async #removeEmptyJobDirectory(id) {
    // Creation is the only caller. Re-check the managed boundary, then remove
    // only an empty directory so a racing process can never lose its files.
    const directory = await this.#assertJobDirectory(id).catch(() => null);
    if (!directory) return;
    let handle;
    try {
      handle = await opendir(directory);
      for await (const _entry of handle) return;
    } finally {
      await handle?.close().catch(() => {});
    }
    await rmdir(directory).catch((error) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    });
  }
  async #replaceStoredFile(path, content) {
    // Same-directory rename gives readers either complete old bytes or
    // complete new bytes. Never follow an existing final-component symlink.
    const before = await lstat(path).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (before && (!before.isFile() || before.isSymbolicLink())) throw new Error('transcript file is invalid');
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, content, { mode: 0o600 });
      await chmod(tmp, 0o600);
      // Rename replaces the link itself rather than following it, but reject a
      // swap before publication to retain the managed-file invariant.
      const current = await lstat(path).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
      if (
        (before &&
          (!current || !current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino)) ||
        (!before && current)
      )
        throw new Error('transcript file is invalid');
      await atomicRename(tmp, path, { platform: this.platform });
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
  async #readTranscript(path, job) {
    let text;
    try {
      text = await readStoredFile(path, MAX_TRANSCRIPT_BYTES, '');
    } catch (error) {
      if (/^stored file is invalid/.test(error.message || '')) throw new Error('transcript file is invalid');
      throw error;
    }
    if (!this.integrityRequired(job)) return text;
    const committed = job.transcriptDigest;
    if (typeof committed !== 'string' || !/^[0-9a-f]{64}$/i.test(committed)) throw new Error('stored transcript integrity check failed');
    const actual = digest(text),
      bytes = Buffer.byteLength(text);
    const committedBytes = job.transcriptBytes;
    const committedMatches =
      actual === committed &&
      (committedBytes === undefined || (Number.isSafeInteger(committedBytes) && committedBytes >= 0 && committedBytes === bytes));
    const pending = job.transcriptPendingDigest;
    if (pending === undefined) {
      if (!committedMatches) throw new Error('stored transcript integrity check failed');
      return text;
    }
    const pendingBytes = job.transcriptPendingBytes;
    // Both possibilities are a deterministic consequence of a crash between
    // the sealed intent, same-directory rename, and final sealed commit.
    if (
      typeof pending !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(pending) ||
      !Number.isSafeInteger(pendingBytes) ||
      pendingBytes < 0 ||
      pendingBytes > MAX_TRANSCRIPT_BYTES
    )
      throw new Error('stored transcript integrity check failed');
    if (committedMatches || (actual === pending && bytes === pendingBytes)) return text;
    throw new Error('stored transcript integrity check failed');
  }
  #parseTranscript(text, { allowTornTail = false } = {}) {
    if (text === '') return [];
    const lines = text.split('\n');
    const terminated = text.endsWith('\n');
    const limit = terminated ? lines.length - 1 : lines.length;
    if (limit > MAX_RECORDS) throw new Error('corrupt transcript: too many records');
    const values = [];
    for (let index = 0; index < limit; index += 1) {
      if (!lines[index]) throw new Error('corrupt transcript: empty interior record');
      try {
        const value = JSON.parse(lines[index]);
        if (!validMessage(value)) throw new Error('invalid');
        values.push(value);
      } catch {
        if (allowTornTail && index === lines.length - 1 && !terminated) break;
        throw new Error('corrupt transcript: invalid interior JSON');
      }
    }
    if (!terminated && !allowTornTail) throw new Error('corrupt transcript: unterminated record');
    return values;
  }
  async #appendBounded(path, line) {
    if (Buffer.byteLength(line) > MAX_TRANSCRIPT_BYTES) throw new Error('transcript record exceeds size limit');
    const bytes = Buffer.byteLength(line);
    const before = await lstat(path).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (before && (!before.isFile() || before.isSymbolicLink())) throw new Error('transcript file is invalid');
    let handle;
    try {
      // appendFile(path) re-opens by pathname after the lstat above.  That
      // makes messages/events vulnerable to a final-component symlink swap.
      // Use one checked descriptor instead, with O_NOFOLLOW where Node
      // exposes it; the identity checks remain the Windows fallback.
      const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW || 0;
      try {
        handle = await openFile(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow, 0o600);
      } catch (error) {
        if (error?.code === 'ELOOP') throw new Error('transcript file is invalid');
        throw error;
      }
      const opened = await handle.stat();
      const current = await lstat(path);
      if (
        !opened.isFile() ||
        current.isSymbolicLink() ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino ||
        (before && (opened.dev !== before.dev || opened.ino !== before.ino))
      )
        throw new Error('transcript file is invalid');
      if (opened.size + bytes > MAX_TRANSCRIPT_BYTES) throw new Error('transcript exceeds size limit');
      await handle.writeFile(line, 'utf8');
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}

const messageText = (value, cap = 1_000_000) => typeof value === 'string' && value.length <= cap;
const messageId = (value, cap) => messageText(value, cap) && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
function validCall(call) {
  return (
    call &&
    typeof call === 'object' &&
    !Array.isArray(call) &&
    call.type === 'function' &&
    messageId(call.id, 512) &&
    call.function &&
    typeof call.function === 'object' &&
    messageId(call.function.name, 128) &&
    messageText(call.function.arguments, 512_000)
  );
}
function validMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['system', 'user', 'assistant', 'tool'].includes(value.role))
    return false;
  if (value.role === 'system' || value.role === 'user')
    return messageText(value.content) && Object.keys(value).every((key) => ['role', 'content'].includes(key));
  if (value.role === 'assistant')
    return (
      messageText(value.content) &&
      (value.reasoning_content === undefined || messageText(value.reasoning_content)) &&
      (value.tool_calls === undefined ||
        (Array.isArray(value.tool_calls) &&
          value.tool_calls.length > 0 &&
          value.tool_calls.length <= 64 &&
          value.tool_calls.every(validCall) &&
          new Set(value.tool_calls.map((call) => call.id)).size === value.tool_calls.length)) &&
      Object.keys(value).every((key) => ['role', 'content', 'reasoning_content', 'tool_calls'].includes(key))
    );
  return (
    messageId(value.tool_call_id, 512) &&
    messageText(value.content) &&
    (value.name === undefined || messageId(value.name, 128)) &&
    Object.keys(value).every((key) => ['role', 'tool_call_id', 'content', 'name', 'elided'].includes(key))
  );
}
function validTranscript(messages) {
  let pending = new Set();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) return false;
      continue;
    }
    // A new conversation turn cannot interleave an unfinished tool batch.
    if (pending.size) return false;
    if (message.role === 'assistant' && message.tool_calls) pending = new Set(message.tool_calls.map((call) => call.id));
  }
  // A final assistant tool batch may be crash residue and is trimmed by the
  // agent context; an interior mismatch was rejected above.
  return true;
}
function incompleteToolTailStart(messages) {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.tool_calls) continue;
    const calls = message.tool_calls;
    const results = messages.slice(index + 1);
    if (results.length >= calls.length) continue;
    const ids = new Set(calls.map((call) => call.id));
    if (
      results.every((result) => result.role === 'tool' && ids.has(result.tool_call_id)) &&
      new Set(results.map((result) => result.tool_call_id)).size === results.length
    )
      return index;
  }
  return -1;
}
function validStoredJob(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    validId(value.id) &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'string' &&
    validPublicationState(value)
  );
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
