import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { PathPolicy } from '../policy.mjs';
import { redactText } from '../redact.mjs';
import { snapshotGitEnv } from '../git-snapshot.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const MAX_READ_CAP = 256_000;
const MAX_OUTPUT_CAP = 128_000;
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;
const MAX_EDIT_ARG_CAP = 64_000;
const MAX_GREP_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_WALK_ENTRIES = 10_000;
const MAX_WALK_DEPTH = 32;
const GIT_TIMEOUT_MS = 2_000;
const GIT_OUTPUT_CAP = 16_384;
const BIGINT_STAT_OPTIONS = Object.freeze({ bigint: true });
const execFileAsync = promisify(execFile);
const boundedInt = (value, fallback, max, name) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${name} must be an integer between 0 and ${max}`);
  return value;
};
const capText = (value, cap) =>
  value.length <= cap
    ? value
    : `${value.slice(0, Math.floor(cap / 2))}\n…[${value.length - cap} chars omitted]…\n${value.slice(-Math.floor(cap / 2))}`;
// Tool text crosses the provider boundary. Keep line structure but prevent
// terminal escapes/control injection and mask common accidental credentials.
const sanitizeToolText = (value) =>
  redactText(
    String(value)
      .replace(/\x1B(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''),
  );
const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
const statTimestamp = (details, name) => {
  const nanoseconds = details?.[`${name}Ns`];
  if (typeof nanoseconds === 'bigint') return nanoseconds;
  const milliseconds = details?.[`${name}Ms`];
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds)) return milliseconds;
  const date = details?.[name];
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : undefined;
};
const safeStatSize = (value) => {
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};
// A Windows path can have both an 8.3 spelling and a long-name spelling. Once
// both paths have been resolved by the filesystem, comparison is
// case-insensitive; lexical equality would reject the same directory on the
// hosted Windows runners.
const sameResolvedPath = (left, right) => {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
const schema = (name, description, properties, required) =>
  Object.freeze({
    type: 'function',
    function: Object.freeze({
      name,
      description,
      parameters: Object.freeze({
        type: 'object',
        properties: Object.freeze(properties),
        required: Object.freeze(required),
        additionalProperties: false,
      }),
    }),
  });
const str = { type: 'string' };
const EXECUTABLE_TOOL_NAMES = new Set(['read_file', 'list_dir', 'glob', 'grep', 'edit_file', 'write_file', 'run_command']);

export const TOOL_DEFINITIONS = Object.freeze([
  schema(
    'read_file',
    'Read a bounded UTF-8 byte window of a repository file before editing it.',
    { path: str, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: MAX_READ_CAP } },
    ['path'],
  ),
  schema('list_dir', 'List a repository directory.', { path: str }, []),
  schema('glob', 'Find repository files matching a glob.', { pattern: { type: 'string', minLength: 1, maxLength: 1024 } }, ['pattern']),
  schema(
    'grep',
    'Search literal text in readable repository files (not regular expressions).',
    { pattern: { type: 'string', minLength: 1, maxLength: 4096 }, path: str },
    ['pattern'],
  ),
  schema(
    'edit_file',
    'Replace an exact previously-read string in one owned file.',
    {
      path: str,
      old_string: { ...str, maxLength: MAX_EDIT_ARG_CAP },
      new_string: { ...str, maxLength: MAX_EDIT_ARG_CAP },
      replace_all: { type: 'boolean' },
    },
    ['path', 'old_string', 'new_string'],
  ),
  schema('write_file', 'Write one owned repository file.', { path: str, content: { type: 'string', maxLength: MAX_READ_CAP } }, [
    'path',
    'content',
  ]),
  schema(
    'run_command',
    'Run a command through the configured sandbox runner.',
    { command: { type: 'string', minLength: 1, maxLength: 8192 }, timeoutSec: { type: 'integer', minimum: 1, maximum: 3600 } },
    ['command'],
  ),
  schema(
    'finish',
    'Finish as the sole tool call with a structured report.',
    {
      summary: { type: 'string', minLength: 1, maxLength: 1500 },
      concerns: { type: 'array', items: str, maxItems: 100 },
      testsRun: { type: 'array', items: str, maxItems: 100 },
    },
    ['summary'],
  ),
]);

/** Return the exact schemas a particular job can actually execute. */
export function availableToolDefinitions({ allowCommand = true } = {}) {
  if (typeof allowCommand !== 'boolean') throw new TypeError('allowCommand must be boolean');
  return allowCommand ? TOOL_DEFINITIONS : Object.freeze(TOOL_DEFINITIONS.filter((tool) => tool.function.name !== 'run_command'));
}

/** PathPolicy is the sole authority for lexical/canonical scope and deny rules. */
export class LocalTools {
  constructor({
    repoPath,
    ownedPaths = [],
    extraWritable = [],
    denyRead = [],
    policy,
    runCommand,
    readCap = 64_000,
    outputCap = 24_000,
    fileSystem = fs,
    gitExec = execFileAsync,
  } = {}) {
    if (!repoPath) throw new TypeError('repoPath is required');
    if (!Number.isSafeInteger(readCap) || readCap < 1 || readCap > MAX_READ_CAP) throw new TypeError(`readCap must be 1-${MAX_READ_CAP}`);
    if (!Number.isSafeInteger(outputCap) || outputCap < 128 || outputCap > MAX_OUTPUT_CAP)
      throw new TypeError(`outputCap must be 128-${MAX_OUTPUT_CAP}`);
    this.policy = policy ?? new PathPolicy({ repoPath, ownedPaths, extraWritable, denyRead });
    for (const method of ['resolve', 'assertReadable', 'assertWritable'])
      if (typeof this.policy[method] !== 'function') throw new TypeError(`policy.${method} is required`);
    if (
      !fileSystem ||
      typeof fileSystem.open !== 'function' ||
      typeof fileSystem.lstat !== 'function' ||
      typeof fileSystem.realpath !== 'function'
    )
      throw new TypeError('fileSystem must implement file operations');
    if (typeof gitExec !== 'function') throw new TypeError('gitExec must be a function');
    this.root = this.policy.repoPath;
    this.runner = runCommand;
    this.readCap = readCap;
    this.outputCap = outputCap;
    this.fs = fileSystem;
    this.gitExec = gitExec;
    this.readHashes = new Map();
  }
  #relative(canonical) {
    return path.relative(this.root, canonical).split(path.sep).join('/');
  }
  #identity(stat) {
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mode: stat.mode,
      mtime: statTimestamp(stat, 'mtime'),
      ctime: statTimestamp(stat, 'ctime'),
    };
  }
  #sameIdentity(left, right) {
    return (
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mode === right.mode &&
      left.mtime === right.mtime &&
      left.ctime === right.ctime
    );
  }
  async #git(args) {
    // Ignore checks are a repository-controlled Git invocation. Give it the
    // same minimal plumbing environment as snapshots: no provider secrets,
    // ambient Git redirects, hooks, or fsmonitor helpers.
    const inertHooks = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const hardened = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${inertHooks}`, ...args];
    try {
      const result = await this.gitExec('git', hardened, {
        cwd: this.root,
        env: snapshotGitEnv(),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_OUTPUT_CAP,
        windowsHide: true,
      });
      return { status: 0, stdout: result.stdout };
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'ENOENT' };
      if (error?.killed || error?.code === 'ETIMEDOUT' || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        throw new Error('Refusing write: Git ignore safety check did not complete');
      return { status: error?.code ?? 1 };
    }
  }
  async #rejectIgnoredUntracked(canonical) {
    const relative = this.#relative(canonical);
    // A LocalTools root is normally the repository root.  Still verify that
    // Git agrees before asking it to interpret ignore rules, so non-Git test
    // fixtures and ordinary directories keep their existing behavior.
    const repository = await this.#git(['rev-parse', '--is-inside-work-tree']);
    if (repository.status !== 0 || String(repository.stdout).trim() !== 'true') {
      // A .git directory and a linked-worktree .git *file* are both evidence
      // that this path is intended to be a repository. Do not silently skip
      // ignore protection when Git cannot prove the worktree state.
      try {
        await this.fs.lstat(path.join(this.root, '.git'));
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw new Error('Refusing write: Git ignore safety check is unavailable');
      }
      throw new Error('Refusing write: Git ignore safety check is unavailable');
    }
    // Check tracked status first: `--no-index` is needed for absent paths and
    // parent-directory ignore rules, but deliberately reports tracked files
    // as ignored too.  Tracked files remain legitimate write targets.
    const tracked = await this.#git(['ls-files', '--error-unmatch', '--', relative]);
    if (tracked.status === 0) return;
    if (tracked.status !== 1) throw new Error('Refusing write: Git tracked-file safety check failed');
    const ignored = await this.#git(['check-ignore', '--quiet', '--no-index', '--', relative]);
    if (ignored.status === 0) throw new Error(`Refusing write to Git-ignored untracked path: ${relative}`);
    if (ignored.status !== 1) throw new Error('Refusing write: Git ignore safety check failed');
  }
  #readable(input, { directory = false } = {}) {
    if (typeof input !== 'string' || path.isAbsolute(input) || input.includes('\\') || /[\x00-\x1f\x7f]/.test(input))
      throw new Error('Path must be a slash-normalized relative repository path');
    if (directory && (input === '.' || input === '')) return this.root; // root listing grants no child read
    const canonical = this.policy.assertReadable(input);
    if (directory) this.policy.assertReadable(path.posix.join(String(input), '.offload-directory-probe'));
    return canonical;
  }
  #writable(input) {
    if (typeof input !== 'string' || path.isAbsolute(input) || input.includes('\\') || /[\x00-\x1f\x7f]/.test(input))
      throw new Error('Path must be a slash-normalized relative repository path');
    return this.policy.assertWritable(input);
  }
  async #openText(canonical, logical, { writable = false } = {}) {
    // Re-check immediately before open. O_NOFOLLOW protects the final path on
    // POSIX; Windows does not expose it, so lstat/fstat identity comparison is
    // the portable best effort. Parent-directory replacement remains a narrow
    // filesystem race outside Node's descriptor-relative API.
    const current = writable ? this.#writable(logical) : this.#readable(logical);
    if (current !== canonical) throw new Error('Refusing path changed since policy check');
    const before = await this.fs.lstat(canonical, BIGINT_STAT_OPTIONS);
    if (before.isSymbolicLink()) throw new Error('Refusing symbolic link');
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW || 0;
    const handle = await this.fs.open(canonical, constants.O_RDONLY | noFollow);
    const stat = await handle.stat(BIGINT_STAT_OPTIONS);
    // Windows supplies a file identity from fstat too.  Skipping this check
    // there turns the documented lstat/fstat fallback into a TOCTOU gap when
    // a reparse point or regular file is swapped between the policy check and
    // open.  O_NOFOLLOW is unavailable on Windows, but identity comparison is
    // still meaningful and is the portable best available guard.
    if (!stat.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) {
      await handle.close();
      throw new Error('Refusing path changed while opening');
    }
    const size = safeStatSize(stat.size);
    if (size === undefined) {
      await handle.close();
      throw new Error('Refusing file too large to address safely');
    }
    return { handle, size, mode: Number(stat.mode), identity: this.#identity(stat) };
  }
  async #prepareWriteParent(logical, canonical) {
    // `mkdir(..., { recursive: true })` follows a substituted intermediate
    // symlink.  Besides escaping the repository, that can create a directory
    // outside it before the later atomic-write check notices the redirect.
    // Walk each logical parent explicitly, resolving every existing component
    // before creating the next one.  Internal symlinks remain supported only
    // when their canonical target remains inside the repository.
    const parentParts = logical.split('/').slice(0, -1);
    // Use the filesystem's spelling of the root for the whole walk. On
    // Windows, `realpath` may expand an 8.3 temp-directory alias while the
    // original caller path remains short; that is not a repository swap.
    const root = await this.fs.realpath(this.root);
    let cursor = root;
    for (const part of parentParts) {
      if (!part || part === '.' || part === '..') throw new Error('Refusing invalid write parent');
      const candidate = path.join(cursor, part);
      try {
        const details = await this.fs.lstat(candidate);
        if (!details.isDirectory() && !details.isSymbolicLink()) throw new Error('Refusing non-directory write parent');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        // The parent was just canonicalized in the previous iteration.  Use
        // a non-recursive create so an unchecked descendant can never be
        // traversed by this operation.
        await this.fs.mkdir(candidate, { mode: 0o700 });
      }
      let resolved;
      try {
        resolved = await this.fs.realpath(candidate);
      } catch {
        throw new Error('Refusing write parent changed while creating');
      }
      const rel = path.relative(root, resolved);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Refusing write outside repository');
      const details = await this.fs.lstat(resolved);
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Refusing invalid write parent');
      cursor = resolved;
    }
    // A writable path may resolve through a safe internal symlink.  Confirm
    // the parent we prepared is exactly the parent selected by PathPolicy;
    // otherwise a concurrent replacement changed the logical destination.
    const expected = await this.fs.realpath(path.dirname(canonical));
    if (!sameResolvedPath(cursor, expected)) throw new Error('Refusing write parent changed since policy check');
  }
  async #atomicWrite(logical, canonical, content, { mode = 0o600, expected, staleLabel = 'edit' } = {}) {
    const current = this.#writable(logical);
    if (current !== canonical) throw new Error('Refusing path changed since policy check');
    const parent = await this.fs.realpath(path.dirname(canonical));
    const root = await this.fs.realpath(this.root);
    const rel = path.relative(root, parent);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Refusing write outside repository');
    const temp = path.join(parent, `.${path.basename(canonical)}.${process.pid}.${randomUUID()}.offload.tmp`);
    let handle;
    try {
      handle = await this.fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.fs.chmod(temp, mode);
      if (this.#writable(logical) !== canonical) throw new Error('Refusing path changed before replace');
      if (expected?.absent) {
        try {
          await this.fs.lstat(canonical);
          throw new Error(`Refusing stale ${staleLabel}: target appeared before publication`);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      } else if (expected) {
        const current = await this.fs.lstat(canonical, BIGINT_STAT_OPTIONS);
        if (current.isSymbolicLink() || !this.#sameIdentity(this.#identity(current), expected))
          throw new Error(`Refusing stale ${staleLabel}: file changed before replace`);
      }
      // Ignore rules are repository-controlled state too. Re-check at the
      // publication boundary so a concurrent .gitignore update cannot turn a
      // just-created worker artifact into invisible ignored output.
      await this.#rejectIgnoredUntracked(canonical);
      if (expected?.absent) {
        // `rename` overwrites on POSIX, so it cannot publish a new file after
        // an absence check. A same-directory hard link has no-replace
        // semantics on POSIX and NTFS: EEXIST preserves a concurrent creator.
        try {
          await this.fs.link(temp, canonical);
        } catch (error) {
          if (error?.code === 'EEXIST') throw new Error(`Refusing stale ${staleLabel}: target appeared before publication`);
          throw new Error(`Refusing ${staleLabel}: cannot publish a new file without replacing an existing target`);
        }
        // The destination is already atomically published. A leftover temp
        // is preferable to reporting a false failure after successful link.
        try {
          await this.fs.unlink(temp);
        } catch {}
      } else {
        // The final ignore query awaits a child process. Rebind the atomic
        // replacement to the target identity again afterwards so a human
        // write during that query cannot be silently overwritten by rename.
        const current = await this.fs.lstat(canonical, BIGINT_STAT_OPTIONS);
        if (current.isSymbolicLink() || !this.#sameIdentity(this.#identity(current), expected))
          throw new Error(`Refusing stale ${staleLabel}: file changed before replace`);
        await this.fs.rename(temp, canonical);
      }
      // Best effort metadata durability; directory fsync is not supported on
      // Windows and some filesystems, where rename still remains atomic.
      if (process.platform !== 'win32') {
        let directory;
        try {
          directory = await this.fs.open(parent, constants.O_RDONLY);
          await directory.sync();
        } catch {
        } finally {
          await directory?.close();
        }
      }
    } catch (error) {
      try {
        await handle?.close();
      } catch {}
      try {
        await this.fs.unlink(temp);
      } catch {}
      throw error;
    }
  }
  #decode(bytes) {
    if (bytes.includes(0)) throw new Error('Refusing binary file');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Refusing invalid UTF-8 file');
    }
  }
  #decodeWindow(bytes, requestedLength) {
    let start = 0;
    // A caller may give a byte offset in the middle of a valid multibyte
    // scalar. Advance at most three continuation bytes to the next boundary.
    while (start < bytes.length && start < 3 && (bytes[start] & 0xc0) === 0x80) start++;
    if (start === 3 && start < bytes.length && (bytes[start] & 0xc0) === 0x80) throw new Error('Refusing invalid UTF-8 file');
    // Permit a final scalar to extend slightly past the requested byte limit,
    // rather than emitting a malformed fragment. If extending three bytes
    // cannot produce valid UTF-8, reject the file rather than corrupting it.
    const initialEnd = Math.max(Math.min(requestedLength, bytes.length), Math.min(bytes.length, start + 1));
    for (let end = initialEnd; end <= bytes.length && end <= initialEnd + 3; end++) {
      try {
        return { content: this.#decode(bytes.subarray(start, end)), skipped: start, consumed: end };
      } catch (error) {
        if (!/invalid UTF-8/.test(error.message)) throw error;
      }
    }
    throw new Error('Refusing invalid UTF-8 file');
  }
  async #hashText(handle, size) {
    const digest = createHash('sha256');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw new Error('File changed while being read');
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) throw new Error('Refusing binary file');
      try {
        decoder.decode(bytes, { stream: position + bytesRead < size });
      } catch {
        throw new Error('Refusing invalid UTF-8 file');
      }
      digest.update(bytes);
      position += bytesRead;
    }
    try {
      decoder.decode();
    } catch {
      throw new Error('Refusing invalid UTF-8 file');
    }
    return digest.digest('hex');
  }
  async #readAll(handle, size) {
    const bytes = Buffer.allocUnsafe(size);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(bytes, position, size - position, position);
      if (!bytesRead) throw new Error('File changed while being read');
      position += bytesRead;
    }
    return bytes;
  }
  async read_file({ path: file, offset, limit } = {}) {
    const canonical = this.#readable(file);
    const { handle, size, identity } = await this.#openText(canonical, file);
    try {
      const start = boundedInt(offset, 0, size, 'offset');
      const window = boundedInt(limit, this.readCap, this.readCap, 'limit');
      const bytes = Buffer.allocUnsafe(Math.min(window + 3, Math.max(0, size - start)));
      const { bytesRead } = bytes.length ? await handle.read(bytes, 0, bytes.length, start) : { bytesRead: 0 };
      const decoded = this.#decodeWindow(bytes.subarray(0, bytesRead), window);
      const content = decoded.content;
      // Retain a full content fingerprint only for files we will permit an
      // exact edit on.  It is streamed, never loaded as one unbounded string.
      if (size <= MAX_EDITABLE_BYTES) {
        const fingerprint = await this.#hashText(handle, size);
        const afterHash = await handle.stat(BIGINT_STAT_OPTIONS);
        const finalPath = await this.fs.lstat(canonical, BIGINT_STAT_OPTIONS);
        if (!this.#sameIdentity(identity, this.#identity(afterHash)) || !this.#sameIdentity(identity, this.#identity(finalPath)))
          throw new Error('File changed while being read');
        this.readHashes.set(canonical, { hash: fingerprint, size, identity: this.#identity(afterHash) });
      } else this.readHashes.set(canonical, { size, tooLarge: true });
      const end = start + decoded.consumed;
      return capText(sanitizeToolText(content), this.outputCap) + (end < size ? `\n[truncated; next offset ${end}]` : '');
    } finally {
      await handle.close();
    }
  }
  async list_dir({ path: dir = '.' } = {}) {
    const canonical = this.#readable(dir, { directory: true });
    const safe = [];
    let visited = 0,
      truncated = false;
    const handle = await this.fs.opendir(canonical);
    try {
      for await (const entry of handle) {
        if (entry.name === '.git') continue;
        if (++visited > MAX_DIRECTORY_ENTRIES) {
          truncated = true;
          break;
        }
        const child = dir === '.' || dir === '' ? entry.name : `${dir.replace(/\/$/, '')}/${entry.name}`;
        try {
          this.#readable(child, { directory: entry.isDirectory() });
          safe.push(entry);
        } catch {
          /* hide protected paths */
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }
    return (
      sanitizeToolText(safe.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n')) +
      (truncated ? `\n[truncated after ${MAX_DIRECTORY_ENTRIES} entries]` : '')
    );
  }
  async glob({ pattern } = {}) {
    if (typeof pattern !== 'string' || !pattern || pattern.includes('\\') || pattern.length > 1024)
      throw new Error('pattern must be a slash-normalized non-empty string up to 1024 chars');
    const { matchGlob } = await import('../glob.mjs');
    const found = [];
    let visited = 0,
      truncated = false;
    const walk = async (absolute, logical = '', depth = 0) => {
      if (depth > MAX_WALK_DEPTH) {
        truncated = true;
        return;
      }
      let handle;
      try {
        handle = await this.fs.opendir(absolute);
      } catch {
        return;
      }
      try {
        for await (const entry of handle) {
          if (++visited > MAX_WALK_ENTRIES) {
            truncated = true;
            return;
          }
          if (entry.name === '.git') continue;
          const child = logical ? `${logical}/${entry.name}` : entry.name;
          try {
            this.#readable(child, { directory: entry.isDirectory() });
          } catch {
            continue;
          }
          if (entry.isDirectory()) await walk(this.policy.resolve(child), child, depth + 1);
          else if (matchGlob(child, pattern)) found.push(child);
          if (found.length >= 500) {
            truncated = true;
            return;
          }
        }
      } finally {
        await handle.close().catch(() => {});
      }
    };
    await walk(this.root);
    return sanitizeToolText(found.join('\n')) + (truncated ? '\n[truncated: result, traversal, or depth limit reached]' : '');
  }
  async grep({ pattern, path: base = '.' } = {}) {
    if (typeof pattern !== 'string' || !pattern || pattern.length > 4096)
      throw new Error('pattern must be a non-empty string up to 4096 chars');
    this.#readable(base, { directory: true });
    const discovered = await this.glob({ pattern: '**' });
    const discoveryTruncated = discovered.split('\n').some((line) => line.startsWith('[truncated:'));
    const files = discovered.split('\n').filter((line) => line && !line.startsWith('['));
    const prefix = base === '.' ? '' : `${String(base).replace(/\/$/, '')}/`;
    const lines = [];
    let skippedLarge = false;
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      try {
        const canonical = this.#readable(file);
        const { handle, size } = await this.#openText(canonical, file);
        try {
          const decoder = new TextDecoder('utf-8', { fatal: true });
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let position = 0,
            tail = '',
            tailLine = 1;
          const scanLimit = Math.min(size, MAX_GREP_FILE_BYTES);
          while (position < scanLimit) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, scanLimit - position), position);
            if (!bytesRead) break;
            const bytes = buffer.subarray(0, bytesRead);
            if (bytes.includes(0)) throw new Error('binary');
            let text;
            try {
              text = decoder.decode(bytes, { stream: position + bytesRead < scanLimit });
            } catch {
              throw new Error('invalid utf8');
            }
            const priorTailLength = tail.length;
            const combined = tail + text;
            let from = 0;
            while (true) {
              const index = combined.indexOf(pattern, from);
              if (index < 0) break;
              if (index + pattern.length > priorTailLength) {
                const line = tailLine + (combined.slice(0, index).match(/\n/g)?.length ?? 0);
                const snippet = combined
                  .slice(Math.max(0, index - 120), Math.min(combined.length, index + pattern.length + 120))
                  .replaceAll('\n', '↩');
                lines.push(`${file}:${line}:${snippet}`);
                if (lines.length >= 300)
                  return capText(sanitizeToolText(`${lines.join('\n')}\n[truncated after 300 matches]`), this.outputCap);
              }
              from = index + Math.max(1, pattern.length);
            }
            const keep = Math.min(Math.max(pattern.length - 1, 4), combined.length);
            const cut = combined.length - keep;
            tailLine += combined.slice(0, cut).match(/\n/g)?.length ?? 0;
            tail = combined.slice(cut);
            position += bytesRead;
          }
          try {
            decoder.decode();
          } catch {
            /* invalid tail: omit file */
          }
          if (size > scanLimit) skippedLarge = true;
        } finally {
          await handle.close();
        }
      } catch {
        /* unreadable/non-text */
      }
    }
    return capText(
      sanitizeToolText(
        `${lines.join('\n')}${discoveryTruncated ? '\n[file discovery truncated before all files were searched]' : ''}${skippedLarge ? '\n[files truncated at 8388608 bytes each]' : ''}`,
      ),
      this.outputCap,
    );
  }
  async edit_file({ path: file, old_string, new_string, replace_all = false } = {}) {
    if (
      typeof old_string !== 'string' ||
      typeof new_string !== 'string' ||
      old_string.length > MAX_EDIT_ARG_CAP ||
      new_string.length > MAX_EDIT_ARG_CAP ||
      typeof replace_all !== 'boolean'
    )
      throw new Error('edit arguments are invalid');
    const canonical = this.#writable(file);
    await this.#rejectIgnoredUntracked(canonical);
    const seen = this.readHashes.get(canonical);
    if (!seen) throw new Error(`Refusing edit without prior read: ${this.#relative(canonical)}`);
    const { handle, size, mode, identity } = await this.#openText(canonical, file, { writable: true });
    let before;
    try {
      if (size > MAX_EDITABLE_BYTES) throw new Error(`Refusing edit of file larger than ${MAX_EDITABLE_BYTES} bytes`);
      const raw = await this.#readAll(handle, size);
      before = this.#decode(raw);
      if (seen.size !== size || seen.hash !== hash(raw) || !seen.identity || !this.#sameIdentity(identity, seen.identity))
        throw new Error(`Refusing stale edit: ${this.#relative(canonical)} changed since read`);
    } finally {
      await handle.close();
    }
    if (!old_string) throw new Error('old_string must not be empty');
    const hits = before.split(old_string).length - 1;
    if (!hits) throw new Error('old_string was not found');
    if (!replace_all && hits !== 1) throw new Error(`old_string must match exactly once (matched ${hits})`);
    const eol = before.includes('\r\n') ? '\r\n' : '\n';
    const replacement = new_string.replace(/\r\n|\r|\n/g, eol);
    const after = replace_all ? before.split(old_string).join(replacement) : before.replace(old_string, replacement);
    await this.#atomicWrite(file, canonical, after, { mode: mode & 0o777, expected: identity });
    this.readHashes.delete(canonical);
    return `Edited ${this.#relative(canonical)} (${replace_all ? hits : 1} replacement${hits === 1 ? '' : 's'}).`;
  }
  async write_file({ path: file, content } = {}) {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_READ_CAP)
      throw new Error(`content must be a string up to ${MAX_READ_CAP} UTF-8 bytes`);
    const canonical = this.#writable(file);
    await this.#rejectIgnoredUntracked(canonical);
    await this.#prepareWriteParent(file, canonical);
    let mode = 0o600,
      expected = { absent: true };
    try {
      const existing = await this.fs.lstat(canonical);
      if (existing.isSymbolicLink()) throw new Error('Refusing symbolic link');
      if (!existing.isFile()) throw new Error('Refusing non-regular file');
      const seen = this.readHashes.get(canonical);
      if (!seen) throw new Error(`Refusing overwrite without prior complete read: ${this.#relative(canonical)}`);
      const opened = await this.#openText(canonical, file, { writable: true });
      try {
        if (opened.size > MAX_EDITABLE_BYTES || seen.tooLarge)
          throw new Error(`Refusing overwrite of file larger than ${MAX_EDITABLE_BYTES} bytes`);
        const raw = await this.#readAll(opened.handle, opened.size);
        this.#decode(raw);
        if (seen.size !== opened.size || seen.hash !== hash(raw) || !seen.identity || !this.#sameIdentity(opened.identity, seen.identity))
          throw new Error(`Refusing stale write: ${this.#relative(canonical)} changed since read`);
        mode = opened.mode & 0o777;
        expected = opened.identity;
      } finally {
        await opened.handle.close();
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await this.#atomicWrite(file, canonical, content, { mode, expected, staleLabel: 'write' });
    this.readHashes.delete(canonical);
    return `Wrote ${this.#relative(canonical)} (${content.length} chars).`;
  }
  async run_command({ command, timeoutSec = 60 } = {}, { signal } = {}) {
    if (typeof command !== 'string' || !command || command.length > 8192)
      throw new Error('command must be a non-empty string up to 8192 chars');
    const timeout = boundedInt(timeoutSec, 60, 3600, 'timeoutSec');
    if (typeof this.runner !== 'function') throw new Error('run_command requires a configured sandbox runner');
    // The loop's single deadline signal is deliberately forwarded rather than
    // manufacturing a per-tool timeout.  The runner owns process-group
    // termination, so this abort reaches a command that is already running.
    return capText(
      sanitizeToolText(asText(await this.runner({ command, timeoutSec: timeout, cwd: this.root, policy: this.policy, signal }))),
      this.outputCap,
    );
  }
  async execute(name, args = {}, options = {}) {
    if (name === 'finish') {
      const list = (value) =>
        value === undefined ||
        (Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === 'string' && item.length <= 1000));
      const valid =
        typeof args.summary === 'string' &&
        args.summary.length > 0 &&
        args.summary.length <= 1500 &&
        list(args.concerns) &&
        list(args.testsRun);
      if (!valid) throw new Error('finish requires a 1-1500 character summary and up to 100 short string concerns/testsRun entries');
      return { finish: { summary: args.summary, concerns: args.concerns ?? [], testsRun: args.testsRun ?? [] } };
    }
    if (!EXECUTABLE_TOOL_NAMES.has(name)) throw new Error(`Unknown tool: ${name}`);
    const fn = this[name];
    return asText(await fn.call(this, args, options));
  }
}
export const isReadOnlyTool = (name) => ['read_file', 'list_dir', 'glob', 'grep'].includes(name);
