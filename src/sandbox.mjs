/** Dependency-free, scrubbed command execution with best-effort OS sandboxing. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep, relative, isAbsolute } from 'node:path';
import { normalizePath } from './glob.mjs';
import { DEFAULT_DENY_READ, DEFAULT_DENY_WRITE } from './policy.mjs';

const SECRET =
  /(?:^|_)(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|token|secret|password|authorization|credential(?:s)?|private[_-]?key)(?:$|_)/i;
// These names are capabilities even though their spelling does not always
// contain a singular "secret" token. A command inheriting an SSH-agent socket
// or a cloud credential-file location can use the host identity directly.
const CAPABILITY_ENV =
  /^(?:SSH_AUTH_SOCK|SSH_AGENT_PID|GPG_AGENT_INFO|GNUPGHOME|GOOGLE_APPLICATION_CREDENTIALS|AWS_SHARED_CREDENTIALS_FILE|AWS_CONFIG_FILE)$/i;
const CAP = 256 * 1024;
// This Apple system binary is the enforcement boundary. Never resolve it via
// PATH, which an untrusted repository command environment can influence.
const SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';
const MACOS_SHELL_SELECTOR = '/private/var/select/sh';
const COMMAND_LINE_TOOLS = '/Library/Developer/CommandLineTools';
// `/usr/local` and `/opt/homebrew` are broadly readable for interpreters and
// libraries.  Their etc trees are host configuration, however, and `/Library`
// includes machine credentials and management policy.  These denies appear
// after the broad toolchain reads in the generated profile intentionally.
export const MACOS_HOST_CONFIG_DENY = Object.freeze([
  '/usr/local/etc',
  '/opt/homebrew/etc',
  '/Library/Keychains',
  '/Library/Preferences',
  '/Library/Managed Preferences',
  '/Library/Application Support/com.apple.TCC',
  '/Library/Security',
]);
const denyPath = (kind, path) => [`(deny file-${kind}* (literal ${q(path)}))`, `(deny file-${kind}* (subpath ${q(path)}))`];
export function scrubEnv(env = process.env, { home, temp, platform = process.platform } = {}) {
  const result = {};
  const windows = platform === 'win32';
  for (const [key, value] of Object.entries(env)) {
    const name = windows ? key.toUpperCase() : key;
    if (!SECRET.test(key) && !CAPABILITY_ENV.test(key) && /^(PATH|LANG|LC_[A-Z0-9_]*|TERM|TZ|SYSTEMROOT|COMSPEC|PATHEXT)$/i.test(name))
      result[name] = value;
  }
  const safeHome = home || tmpdir();
  result.HOME = safeHome;
  // Many Windows tools use USERPROFILE rather than HOME.  Point both at the
  // disposable directory so commands cannot discover the real user profile.
  if (windows) result.USERPROFILE = safeHome;
  result.TMPDIR = result.TMP = result.TEMP = temp || safeHome;
  result.NO_COLOR = '1';
  return result;
}
/**
 * Extra environment for tools that cannot otherwise start under the macOS
 * profile. It is applied only after a real sandbox was applied, and never
 * widens the profile: both variables below just stop a tool from reading a path
 * the profile already denies.
 */
export function sandboxToolEnv({ exists = existsSync } = {}) {
  return {
    // /etc is unreadable in the profile: without these, git dies on
    // "unable to access '/etc/gitconfig'".
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    // /usr/bin/{git,python3} are xcode-select shims that read
    // /var/select/developer_dir, which is denied. A fixed /Library path (already
    // readable) skips that lookup. It is never taken from the caller's
    // environment: scrubEnv drops DEVELOPER_DIR.
    ...(exists(`${COMMAND_LINE_TOOLS}/usr/bin/git`) ? { DEVELOPER_DIR: COMMAND_LINE_TOOLS } : {}),
  };
}
const SANDBOX_PROBE_COMMAND = `${SANDBOX_EXECUTABLE} -p <generated-offload-profile> /usr/bin/true`;
const SANDBOX_PROBE_OUTPUT_CAP = 4 * 1024;
const probeText = (value) =>
  String(value || '')
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim()
    .slice(0, SANDBOX_PROBE_OUTPUT_CAP);

/**
 * Establish whether Seatbelt can apply the exact restrictive profile we use.
 *
 * The boolean API below remains deliberately small for execution decisions,
 * while this structured form preserves the otherwise easy-to-lose host
 * failure.  In particular, a present sandbox-exec binary is not evidence of
 * isolation: managed hosts can deny sandbox_apply even for a permissive
 * profile.
 */
export function sandboxStatus(platform = process.platform, profile, { spawnProcess = spawnSync } = {}) {
  if (platform !== 'darwin')
    return { available: false, reason: 'platform-not-darwin', probe: SANDBOX_PROBE_COMMAND, error: `platform is ${platform}` };
  const canonicalPath = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return resolve(value);
    }
  };
  const generatedProfile = profile ?? macosProfile({ repoPath: canonicalPath(process.cwd()), tempPath: canonicalPath(tmpdir()) });
  let result;
  try {
    result = spawnProcess(SANDBOX_EXECUTABLE, ['-p', generatedProfile, '/usr/bin/true'], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: SANDBOX_PROBE_OUTPUT_CAP,
      windowsHide: true,
    });
  } catch (error) {
    return {
      available: false,
      reason: 'sandbox-exec-spawn-failed',
      probe: SANDBOX_PROBE_COMMAND,
      error: probeText(error?.message || error),
    };
  }
  if (result?.status === 0) return { available: true, reason: 'profile-applied', probe: SANDBOX_PROBE_COMMAND };

  const error = probeText(result?.stderr || result?.error?.message || result?.stdout || 'sandbox-exec did not apply the profile');
  let reason = 'sandbox-exec-failed';
  if (result?.error?.code === 'ENOENT') reason = 'sandbox-exec-missing';
  else if (result?.error?.code === 'ETIMEDOUT') reason = 'sandbox-exec-probe-timed-out';
  else if (typeof result?.signal === 'string' && result.signal) reason = 'sandbox-exec-signaled';
  else if (/sandbox_apply:\s*operation not permitted/i.test(error)) reason = 'sandbox-apply-not-permitted';
  else if (result?.status === 65 || /(?:parse|syntax|unexpected).*(?:error|operator)|(?:parse|syntax) error/i.test(error))
    reason = 'sandbox-profile-rejected';
  return {
    available: false,
    reason,
    probe: SANDBOX_PROBE_COMMAND,
    ...(Number.isInteger(result?.status) ? { exitCode: result.status } : {}),
    ...(typeof result?.signal === 'string' && result.signal ? { signal: result.signal } : {}),
    ...(error ? { error } : {}),
  };
}

/** A binary on PATH is not enough: managed macOS hosts can forbid applying a profile. */
export function sandboxAvailable(platform = process.platform, profile) {
  return sandboxStatus(platform, profile).available;
}
const q = (value) => JSON.stringify(String(value));
function seatbeltPath(value) {
  if (typeof value !== 'string' || /[\0-\x1f\x7f]/.test(value)) throw new TypeError('sandbox paths must not contain control characters');
  return value;
}
/** Turn a glob into the ancestor it can safely need; sandbox-exec receives no glob syntax. */
export function staticWritableRoot(value, repoPath) {
  const base = resolve(repoPath || process.cwd());
  const absolute = isAbsolute(value) ? resolve(value) : resolve(base, value);
  const parts = absolute.split(sep);
  const magic = parts.findIndex((part) => /[*?\[]/.test(part));
  const root = magic < 0 ? absolute : parts.slice(0, magic).join(sep) || sep;
  return root === sep && repoPath ? base : root;
}
const seatbeltString = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
const asciiPair = (character) =>
  character === character.toLowerCase() ? `${character}${character.toUpperCase()}` : `${character}${character.toLowerCase()}`;
const asciiLetter = (character) => /[A-Za-z]/.test(character);
const SEATBELT_CLASS_LITERAL = new Set(['.', '/', '*', '+', '?', '(', ')', '{', '}', '|', '$']);
/**
 * Encode one exact pathname character without JavaScript-style regex escapes.
 * Allow rules fail closed for uncommon syntax; deny rules use `.` only as a
 * conservative one-character superset.
 */
function seatbeltLiteralCharacter(character, { deny = false } = {}) {
  if (SEATBELT_CLASS_LITERAL.has(character)) return `[${character}]`;
  // The remaining regex delimiters cannot be represented in an exact raw
  // Seatbelt expression without another escape dialect. Denies may broaden
  // by one byte; allows must fail closed. Ordinary Unicode and punctuation
  // (including # and ~) are literal and remain supported.
  if (/["\\[\]\^]/.test(character)) {
    if (deny) return '.';
    throw new TypeError(`sandbox path has unsupported regex character: ${character}`);
  }
  return character;
}
function seatbeltLiteral(value, options) {
  return [...String(value)].map((character) => seatbeltLiteralCharacter(character, options)).join('');
}
/** Compile a normalized glob in Seatbelt's native regex dialect, never JS escapes. */
function seatbeltGlobSource(pattern, { deny = false } = {}) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        while (pattern[index + 1] === '*') index += 1;
        if (pattern[index + 1] === '/') {
          // sandbox-exec accepts ordinary capture groups but silently ignores
          // the non-capturing `(?:...)` form for path matching.
          source += '(.*[/])?';
          index += 1;
        } else source += '.*';
      } else source += '[^/]*';
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    if (character === '[') {
      const close = pattern.indexOf(']', index + 1);
      const raw = close === -1 ? null : pattern.slice(index + 1, close);
      const characterClass = raw?.startsWith('!') ? `^${raw.slice(1)}` : raw;
      try {
        if (raw === null || !characterClass || characterClass === '^' || /[\\/]/.test(characterClass)) throw new Error('invalid class');
        new RegExp(`[${characterClass}]`);
        // Negated classes must not consume a separator; put `/` directly in
        // the excluded class rather than relying on unsupported lookaround.
        source += characterClass.startsWith('^') ? `[^/${characterClass.slice(1)}]` : `[${characterClass}]`;
        index = close;
        continue;
      } catch {
        if (deny) {
          source += '.';
          continue;
        }
        throw new TypeError(`sandbox glob has unsupported character class: ${pattern}`);
      }
    }
    source += seatbeltLiteralCharacter(character, { deny });
  }
  return source;
}
/** Compile literal path text to a Seatbelt regex fragment with ASCII case folding. */
function caseInsensitiveLiteral(value) {
  return [...String(value)]
    .map((character) => (asciiLetter(character) ? `[${asciiPair(character)}]` : seatbeltLiteralCharacter(character, { deny: true })))
    .join('');
}
/**
 * Case-fold the literal portions of a validated glob before compiling it.
 * A bracket class has subtle regex semantics (`[A-z]`, negation, and malformed
 * classes included), so do not reinterpret it.  A whole `*` segment is a
 * conservative superset of every one-segment class match, which protects the
 * caller's intent without risking a case-folding under-match.
 */
export function caseInsensitiveGlob(value) {
  return value
    .split('/')
    .map((segment) => {
      if (
        segment.includes('[') ||
        [...segment].some((character) => !asciiLetter(character) && character.toLowerCase() !== character.toUpperCase())
      )
        return '*';
      return [...segment].map((character) => (asciiLetter(character) ? `[${asciiPair(character)}]` : character)).join('');
    })
    .join('/');
}
function sandboxGlobFilter(kind, repoPath, value) {
  const root = resolve(repoPath);
  const raw = typeof value === 'string' ? value : String(value);
  seatbeltPath(raw);
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const rel = relative(root, absolute).replaceAll('\\', '/');
  if (!rel || rel.startsWith('../') || rel === '..') throw new TypeError(`sandbox path is outside repository: ${value}`);
  const source = seatbeltGlobSource(normalizePath(rel));
  return `(${kind} file-write* (regex #"^${seatbeltString(seatbeltLiteral(root))}[/]${seatbeltString(source)}$"))`;
}
function denyFilter(kind, repoPath, pattern) {
  const safePattern = normalizePath(pattern);
  // Seatbelt accepts scoped `(?i:...)` syntax but does not apply it when
  // matching `regex` path filters. Compile ordinary literal portions into
  // explicit ASCII case pairs; bracket-containing segments intentionally
  // become `*` in caseInsensitiveGlob, conservatively over-denying rather
  // than risking a narrower credential rule.
  const insensitive = caseInsensitiveGlob(safePattern);
  const source = seatbeltGlobSource(insensitive, { deny: true });
  const root = seatbeltString(caseInsensitiveLiteral(resolve(repoPath)));
  // Repository secret conventions are case-insensitive: macOS volumes often
  // are too, and `.ENV`/`ID_RSA` should not become readable on a Linux volume.
  return `(deny file-${kind}* (regex #"^${root}[/]${seatbeltString(source)}$"))`;
}
// Extra read roots (a worktree's linked dependency directory) sit outside the
// repository root, so the root-anchored DEFAULT_DENY_READ regexes never see
// them. Re-anchor the credential conventions at each such root. Directories
// named `credentials` are ordinary module code in dependencies (for example
// aws-sdk's lib/credentials), so only their credential-shaped *files* stay
// denied. Dependency caches are denied too: they are rebuildable, read-only
// here anyway, and can embed environment values.
const EXTRA_READ_ROOT_DENY = Object.freeze([
  ...DEFAULT_DENY_READ.filter((pattern) => !/(?:^|\/)credentials(?:\/\*\*)?$/.test(pattern)),
  '.cache',
  '.cache/**',
  '**/.cache',
  '**/.cache/**',
]);
export function macosProfile({
  repoPath,
  gitDir = join(repoPath, '.git'),
  writablePaths = [],
  readablePaths = [],
  denyRead = [],
  denyWrite = DEFAULT_DENY_WRITE,
  tempPath,
  cachePaths = [],
  interpreterPaths = [],
  allowNetwork = false,
}) {
  if (!Array.isArray(denyRead) || denyRead.some((path) => typeof path !== 'string'))
    throw new TypeError('denyRead must be relative glob strings');
  if (!Array.isArray(denyWrite) || denyWrite.some((path) => typeof path !== 'string'))
    throw new TypeError('denyWrite must be relative glob strings');
  if (!Array.isArray(writablePaths) || !Array.isArray(readablePaths) || !Array.isArray(cachePaths) || !Array.isArray(interpreterPaths))
    throw new TypeError('sandbox writable/readable/cache/interpreter paths must be arrays');
  for (const value of [repoPath, gitDir, tempPath, ...writablePaths, ...readablePaths, ...cachePaths, ...interpreterPaths].filter(
    (value) => value !== undefined,
  ))
    seatbeltPath(value);
  const root = resolve(repoPath);
  const resolvedGit = isAbsolute(gitDir) ? resolve(gitDir) : resolve(root, gitDir);
  // Command callers include the worker shell and verifier. Neither can opt
  // out of the repository credential baseline by omitting denyRead; callers
  // may only add project-specific read denials.
  const protectedRead = [...new Set([...DEFAULT_DENY_READ, ...denyRead])];
  // A linked worktree's `git rev-parse --git-dir` is normally
  // <primary>/.git/worktrees/<name>.  Protect its parent common directory as
  // well: it contains config, hooks, offload state, and other worktrees.  The
  // worktree-local .git pointer is separately denied so `**` cannot rewrite
  // it to retarget future Git invocations.
  const commonGit = basename(dirname(resolvedGit)) === 'worktrees' ? dirname(dirname(resolvedGit)) : resolvedGit;
  const protectedGitPaths = [...new Set([join(root, '.git'), resolvedGit, commonGit])];
  const resolvedTemp = tempPath && resolve(tempPath);
  // This is an explicit read capability for server-authenticated paths that
  // sit outside the repository root (currently, only a private worktree's
  // parent). It is deliberately distinct from cache/writable capabilities:
  // never add it to `write`.
  const resolvedReadable = readablePaths.map((value) => (isAbsolute(value) ? resolve(value) : resolve(root, value)));
  const resolvedCache = cachePaths.map((value) => (isAbsolute(value) ? resolve(value) : resolve(root, value)));
  // A caller-declared interpreter or virtualenv, and the installation it was
  // built from, are the one external tree a verifier may read AND execute. The
  // server authenticates and canonicalizes these roots before they get here
  // (see verify-interpreter.mjs); like every read root they are never added to
  // `write`, and the credential conventions are re-anchored at each of them.
  const resolvedInterpreter = interpreterPaths.map((value) => {
    if (!isAbsolute(value)) throw new TypeError('sandbox interpreter paths must be absolute');
    return resolve(value);
  });
  // Exact metadata on each server-controlled path ancestor permits path
  // traversal/getcwd without granting directory contents. This matters when
  // macOS presents a lexical `/var` path physically under `/private/var`.
  // Homebrew toolchains are installed below /opt/homebrew. macOS needs to
  // stat the literal /opt ancestor while resolving those binaries and
  // libraries; this grants no child data (and /opt/homebrew/etc remains
  // explicitly denied below).
  const traversalMetadata = new Set(['/opt']);
  for (const path of [
    root,
    resolvedTemp,
    ...resolvedReadable,
    ...resolvedCache,
    ...resolvedInterpreter,
    dirname(MACOS_SHELL_SELECTOR),
  ].filter(Boolean))
    for (let parent = dirname(path); parent !== sep; parent = dirname(parent)) traversalMetadata.add(parent);
  // CPython resolves its own executable with realpath(3), which stats every
  // component starting at `/`: without the exact root node an interpreter dies
  // at startup ("realpath: ...: Operation not permitted"), even a system one.
  // This is metadata of the single directory node, never its contents.
  if (resolvedInterpreter.length) traversalMetadata.add(sep);
  const read = [
    root,
    '/System',
    '/usr',
    '/usr/local',
    '/bin',
    '/sbin',
    '/Library',
    '/opt/homebrew',
    '/dev/null',
    resolvedTemp,
    ...resolvedReadable,
    ...resolvedCache,
    ...resolvedInterpreter,
  ].filter(Boolean);
  const write = [resolvedTemp, ...resolvedCache].filter(Boolean);
  // Denies follow broad workspace/temp permits. Seatbelt evaluates deny rules
  // as prohibitions, and this ordering keeps the intended precedence obvious
  // in generated profiles and resilient to profile-reader implementations.
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    // Current sandbox-exec builds can abort a child with sysctl-read and a
    // restrictive profile unless the root directory node itself is readable.
    // `literal "/"` exposes directory data only, never descendants; explicit
    // deny rules still protect every host subtree below it.
    '(allow file-read-data (literal "/"))',
    // macOS resolves /bin/sh through this system selector on current hosts.
    // Allow that one executable and its exact metadata node, never the
    // selector directory subtree. The selector is a symlink on current
    // hosts; launching it otherwise emits a noisy metadata denial.
    `(allow file-read-data (literal ${q(MACOS_SHELL_SELECTOR)}))`,
    `(allow file-read-metadata (literal ${q(MACOS_SHELL_SELECTOR)}))`,
    // Shell redirections commonly target this null device; it is a sink, not
    // a readable host tree.
    '(allow file-write-data (literal "/dev/null"))',
    ...[...traversalMetadata].sort().map((path) => `(allow file-read-metadata (literal ${q(path)}))`),
    // `subpath` does not grant the directory node itself. Permit each exact
    // root as data too, so the shell can enter its physical cwd without
    // broadening access to any descendant beyond the paired subpath rule.
    ...read.flatMap((path) => [`(allow file-read-data (literal ${q(path)}))`, `(allow file-read* (subpath ${q(path)}))`]),
    // `process*` above already permits exec; naming it for the declared roots
    // keeps their grant (read and exec, never write) legible in the profile.
    ...resolvedInterpreter.map((path) => `(allow process-exec (subpath ${q(path)}))`),
    // `subpath` does not include the directory node. Pair exact and
    // descendant denies so broad toolchain/cache grants cannot rename, remove,
    // or inspect a protected Git/config directory itself.
    ...MACOS_HOST_CONFIG_DENY.flatMap((path) => denyPath('read', path)),
    ...protectedGitPaths.flatMap((path) => denyPath('read', path)),
    ...writablePaths.map((path) => sandboxGlobFilter('allow', root, path)),
    ...write.map((path) => `(allow file-write* (subpath ${q(path)}))`),
    ...protectedGitPaths.flatMap((path) => denyPath('write', path)),
    ...denyWrite.map((pattern) => denyFilter('write', root, pattern)),
    ...protectedRead.map((pattern) => denyFilter('read', root, pattern)),
    ...resolvedReadable.flatMap((readable) => EXTRA_READ_ROOT_DENY.map((pattern) => denyFilter('read', readable, pattern))),
    ...resolvedInterpreter.flatMap((interpreter) => EXTRA_READ_ROOT_DENY.map((pattern) => denyFilter('read', interpreter, pattern))),
    ...(allowNetwork ? ['(allow network*)'] : []),
  ].join('\n');
}
/** Map an absolute lexical path under a canonical sandbox root to that root. */
export function sandboxCanonicalPath(value, cwd, sandboxCwd) {
  if (typeof value !== 'string' || !isAbsolute(value)) return value;
  const rel = relative(cwd, resolve(value));
  if (!rel) return sandboxCwd;
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? value : join(sandboxCwd, rel);
}
/** Best-effort descendant termination on Windows; Windows has no POSIX process groups. */
export function terminateWindowsTree(pid, taskkill = spawnSync) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    const result = taskkill('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return result?.status === 0 || result?.status == null;
  } catch {
    return false;
  }
}
function safeUtf8(buffer, edge) {
  let value = Buffer.from(buffer);
  if (edge === 'start') while (value.length && (value[0] & 0xc0) === 0x80) value = value.subarray(1);
  if (edge === 'end') {
    let cut = value.length;
    while (cut && (value[cut - 1] & 0xc0) === 0x80) cut--;
    if (cut && value.length - cut < 4) {
      const lead = value[cut - 1];
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (value.length - (cut - 1) < need) value = value.subarray(0, cut - 1);
    }
  }
  return new TextDecoder().decode(value);
}
function capture(limit) {
  const headLimit = Math.floor(limit / 2),
    tailLimit = limit - headLimit;
  let head = Buffer.alloc(0),
    tail = Buffer.alloc(0),
    omitted = 0;
  return {
    add(chunk) {
      let value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (head.length < headLimit) {
        const take = Math.min(headLimit - head.length, value.length);
        head = Buffer.concat([head, value.subarray(0, take)]);
        value = value.subarray(take);
      }
      if (!value.length) return;
      // Streams normally emit small chunks, but a custom spawn adapter or a
      // platform buffering anomaly can deliver one arbitrarily large Buffer.
      // Never concatenate that whole chunk only to trim it back to the cap.
      if (value.length >= tailLimit) {
        omitted += tail.length + value.length - tailLimit;
        tail = value.subarray(value.length - tailLimit);
        return;
      }
      if (tail.length + value.length > tailLimit) {
        const drop = tail.length + value.length - tailLimit;
        omitted += drop;
        tail = Buffer.concat([tail.subarray(drop), value]);
        return;
      }
      tail = Buffer.concat([tail, value]);
    },
    value() {
      return omitted
        ? `${safeUtf8(head, 'end')}\n… output truncated (${omitted} bytes omitted) …\n${safeUtf8(tail, 'start')}`
        : new TextDecoder().decode(Buffer.concat([head, tail]));
    },
  };
}
function commandScript(command, platform) {
  // The command itself is deliberately data written to a private script, not
  // an argument concatenated into a shell launch. The working directory is
  // expanded by the interpreter from an environment value and remains quoted
  // even when its path contains shell metacharacters.
  if (platform === 'win32') return `@echo off\r\ncd /d "%OFFLOAD_COMMAND_CWD%" || exit /b 1\r\n${command}\r\n`;
  return `cd -- "$OFFLOAD_COMMAND_CWD" || exit 1\n${command}\n`;
}
/** Resolves only once process close proves the process group leader has exited. */
export async function runCommand(command, options = {}) {
  if (typeof command !== 'string' || !command.trim()) throw new TypeError('command must be a non-empty string');
  const cwd = resolve(options.cwd || process.cwd());
  const supplied = options.timeoutMs ?? (options.timeoutSec == null ? undefined : Number(options.timeoutSec) * 1000);
  const timeoutMs = Number.isFinite(supplied) ? Math.max(1, Number(supplied)) : 60_000;
  const cap = Number.isFinite(options.outputCap) ? Math.max(1024, Number(options.outputCap)) : CAP;
  if (options.signal?.aborted)
    return {
      code: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: true,
      sandbox: 'policy-only',
      durationMs: 0,
      command,
    };
  const platform = options.platform || process.platform;
  let dir;
  // Never use an inherited or caller-selected value to choose a command
  // interpreter. In particular, COMSPEC is mutable process environment and
  // can point at an arbitrary program. Windows commands always use the fixed
  // system command name, resolved by CreateProcess rather than shell text.
  const suppliedComspec = options.comspec;
  if (platform === 'win32' && suppliedComspec && String(suppliedComspec).split(/[\\/]/).at(-1).toLowerCase() !== 'cmd.exe')
    throw new TypeError('Windows command interpreter must be cmd.exe');
  let sandbox = 'policy-only';
  if (options.requireSandbox !== undefined && typeof options.requireSandbox !== 'boolean')
    throw new TypeError('requireSandbox must be boolean');
  if (options.sandboxProbe !== undefined && typeof options.sandboxProbe !== 'function')
    throw new TypeError('sandboxProbe must be a function');
  if (options.onOutput !== undefined && typeof options.onOutput !== 'function') throw new TypeError('onOutput must be a function');
  const profileInput = {
    repoPath: cwd,
    gitDir: options.gitDir,
    writablePaths: options.writablePaths || [],
    readablePaths: options.readablePaths || [],
    denyRead: options.denyRead || [],
    denyWrite: options.denyWrite || DEFAULT_DENY_WRITE,
    tempPath: options.tempPath || tmpdir(),
    cachePaths: options.cachePaths || [],
    interpreterPaths: options.interpreterPaths || [],
    allowNetwork: options.allowNetwork === true,
  };
  const probeProfile = options.sandbox !== false && platform === 'darwin' ? macosProfile(profileInput) : undefined;
  const canSandbox = probeProfile && (options.sandboxProbe || sandboxAvailable)(platform, probeProfile);
  // Worker shell calls are untrusted model output. A job-specific profile can
  // fail even after a general availability check passed, so never silently
  // run that command outside OS isolation. Verifiers may opt into the
  // documented policy-only fallback by leaving requireSandbox false.
  // `requireSandbox` is an absolute safety contract, not merely a request to
  // try sandbox-exec. In particular a caller must not bypass it with
  // sandbox:false or inherit a policy-only non-macOS runner.
  if (options.requireSandbox && !canSandbox) throw new Error('Required macOS sandbox is unavailable for this command');
  const sandboxCwd = canSandbox ? await realpath(cwd) : cwd;
  // Rewrite absolute paths beneath a lexical `/var` worktree to the same
  // physical worktree spelling. Relative globs remain relative so their
  // existing scope validation is unchanged.
  const sandboxPath = (value) => (canSandbox ? sandboxCanonicalPath(value, cwd, sandboxCwd) : value);
  const sandboxWritablePaths = (options.writablePaths || []).map(sandboxPath);
  // Canonicalize explicit external read roots too. In particular, macOS
  // renders a lexical `/var/...` worktree under `/private/var/...`; handing
  // Seatbelt the former makes an otherwise authorized cwd fail at runtime.
  // Missing roots fail before execution rather than becoming an ambient,
  // best-effort read grant.
  const sandboxReadablePaths = canSandbox
    ? await Promise.all(
        (options.readablePaths || []).map(async (value) => {
          const path = sandboxPath(value);
          if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('sandbox readable paths must be absolute');
          return realpath(path);
        }),
      )
    : options.readablePaths || [];
  // Declared interpreter roots are canonicalized like the read roots above, and
  // a root that vanished fails before execution instead of granting nothing.
  const sandboxInterpreterPaths = canSandbox
    ? await Promise.all(
        (options.interpreterPaths || []).map(async (value) => {
          if (typeof value !== 'string' || !isAbsolute(value)) throw new TypeError('sandbox interpreter paths must be absolute');
          return realpath(value);
        }),
      )
    : options.interpreterPaths || [];
  const sandboxCachePaths = (options.cachePaths || []).map(sandboxPath);
  const sandboxGitDir = sandboxPath(options.gitDir);
  if (canSandbox) {
    // Validate before creating a temp directory so a rejection has no residue.
    dir = await mkdtemp(join(tmpdir(), 'offload-sandbox-'));
    sandbox = 'macos';
  } else dir = await mkdtemp(join(tmpdir(), 'offload-run-'));
  // The macOS sandbox resolves its current directory through physical paths.
  // Grant the freshly created private directory by that spelling so a lexical
  // `/var` temporary path cannot lose its `/private/var` ancestry at launch.
  const sandboxTempPath = sandbox === 'macos' ? await realpath(dir) : dir;
  const scriptName = platform === 'win32' ? 'offload-command.cmd' : 'offload-command.sh';
  const scriptPath = join(dir, scriptName);
  const stdout = capture(Math.floor(cap / 2)),
    stderr = capture(Math.ceil(cap / 2));
  const started = Date.now();
  let child;
  let timedOut = false;
  let cancelled = false;
  try {
    await writeFile(scriptPath, commandScript(command, platform), { mode: 0o700 });
    const environment = {
      // TMPDIR/TMP/TEMP/HOME name the one physical, per-command, disposable
      // directory the profile can write. Node's os.tmpdir(), `mktemp -t`,
      // `getconf DARWIN_USER_TEMP_DIR` and Python's tempfile all honor it. A
      // hard-coded /tmp, or a child spawned with an environment that drops
      // these variables, is denied by design and is deliberately not widened
      // here. A directory shared across a job's commands is rejected on purpose:
      // it would carry worker-written state into the verifier.
      // Seatbelt evaluates the physical path. Using the lexical `/var` alias
      // here causes Node's os.tmpdir()/mkdtemp to target a path the profile
      // has not granted on macOS. Keep policy-only behavior unchanged.
      ...scrubEnv(options.env, {
        home: sandbox === 'macos' ? sandboxTempPath : dir,
        temp: sandbox === 'macos' ? sandboxTempPath : dir,
        platform,
      }),
      OFFLOAD_COMMAND_CWD: sandbox === 'macos' ? sandboxCwd : cwd,
    };
    // Homebrew Node may otherwise load its host OpenSSL configuration before
    // the command starts. Never inherit a caller-selected configuration path:
    // use the inert null device only after a real macOS sandbox was applied.
    if (sandbox === 'macos') {
      environment.OPENSSL_CONF = '/dev/null';
      Object.assign(environment, sandboxToolEnv());
    }
    const sandboxProfile =
      sandbox === 'macos'
        ? macosProfile({
            repoPath: sandboxCwd,
            gitDir: sandboxGitDir,
            writablePaths: sandboxWritablePaths,
            readablePaths: sandboxReadablePaths,
            denyRead: options.denyRead || [],
            denyWrite: options.denyWrite || DEFAULT_DENY_WRITE,
            // The private script directory must be readable by the sandboxed
            // interpreter. A separately requested temporary directory remains
            // an explicit cache capability rather than replacing that root.
            tempPath: sandboxTempPath,
            cachePaths: [...sandboxCachePaths, ...(options.tempPath ? [sandboxPath(options.tempPath)] : [])],
            interpreterPaths: sandboxInterpreterPaths,
            allowNetwork: options.allowNetwork === true,
          })
        : undefined;
    const result = await new Promise((done, fail) => {
      let timer;
      let ultimate;
      let settled = false;
      let force;
      const killGroup = (signal) => {
        try {
          if (platform === 'win32') return terminateWindowsTree(child?.pid, options.taskkill || spawnSync);
          if (child?.pid) {
            process.kill(-child.pid, signal);
            return true;
          }
        } catch {
          try {
            return !!child?.kill(signal);
          } catch {
            return false;
          }
        }
        return false;
      };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(force);
        clearTimeout(ultimate);
        options.signal?.removeEventListener('abort', abort);
        fn(value);
      };
      const terminate = (reason) => {
        if (!child || settled) return;
        timedOut ||= reason === 'timeout';
        cancelled ||= reason === 'cancel';
        killGroup('SIGTERM');
        if (platform !== 'win32') force ||= setTimeout(() => killGroup('SIGKILL'), 750);
        ultimate ||= setTimeout(() => settle(done, { code: null, signal: 'SIGKILL' }), 1_750);
      };
      const abort = () => terminate('cancel');
      const spawnOptions = {
        // A fixed, private launch directory prevents an uncontrolled absolute
        // path from becoming an interpreter argument or current directory.
        cwd: dir,
        env: environment,
        detached: platform !== 'win32',
        windowsHide: platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      };
      const spawnProcess = options.spawnProcess || spawn;
      // Keep each interpreter launch syntactically separate. Besides making
      // the trust boundary obvious, this lets static analysis prove that the
      // shell only receives the fixed private script name.
      if (sandbox === 'macos') child = spawnProcess(SANDBOX_EXECUTABLE, ['-p', sandboxProfile, '/bin/sh', scriptName], spawnOptions);
      else if (platform === 'win32') child = spawnProcess('cmd.exe', ['/d', '/s', '/c', scriptName], spawnOptions);
      else child = spawnProcess('/bin/sh', [scriptName], spawnOptions);
      // A caller's output hook (the baseline-diff verifier's streaming failure
      // parser) can never change the retained capture or the exit result.
      const observe = (stream) => (value) => {
        (stream === 'stdout' ? stdout : stderr).add(value);
        try {
          options.onOutput?.(value, stream);
        } catch {}
      };
      child.stdout.on('data', observe('stdout'));
      child.stderr.on('data', observe('stderr'));
      timer = setTimeout(() => terminate('timeout'), timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      child.once('error', (error) => settle(fail, error));
      child.once('close', (code, signal) => {
        // The shell may have exited while a background descendant survives.
        if (killGroup('SIGTERM')) {
          force ||= setTimeout(() => killGroup('SIGKILL'), 750);
          setTimeout(() => settle(done, { code, signal }), 800);
        } else settle(done, { code, signal });
      });
    });
    return {
      ...result,
      stdout: stdout.value(),
      stderr: stderr.value(),
      timedOut,
      cancelled,
      sandbox,
      durationMs: Date.now() - started,
      command,
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
export async function assertWithin(path, root) {
  const [target, base] = await Promise.all([realpath(path), realpath(root)]);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`path escapes repository: ${path}`);
  return target;
}

const TEMP_PROBE_SCRIPT = [
  'd=$(mktemp -d "${TMPDIR:-/nonexistent}/offload-probe.XXXXXX" 2>/dev/null) && echo tmpdir=ok || echo tmpdir=denied',
  's=$(mktemp -d /tmp/offload-probe.XXXXXX 2>/dev/null) && { rmdir "$s"; echo system-tmp=writable; } || echo system-tmp=denied',
  'if [ -n "$d" ] && git init -q "$d/g" >/dev/null 2>&1; then echo git-init=ok; else echo git-init=failed; fi',
].join('\n');
const probeKey = (stdout, key, values) => {
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = new RegExp(`^${key}=(${values.join('|')})$`).exec(line);
    if (match) return match[1];
  }
  return undefined;
};
// A closed-vocabulary token (an errno name or a fixed label), never message
// text: exception and sandboxed-stderr text can carry host paths.
const errorToken = (value, fallback = 'unknown') =>
  String(value ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 40) || fallback;
const tempProbe = (status, reason, extra = {}) => ({
  status,
  reason,
  systemTmp: 'unknown',
  gitInit: 'unknown',
  note: '',
  ...extra,
});

/**
 * Exercise the verifier's temp-directory contract the way a verifier sees it,
 * so health can say whether a testCommand can create temp directories at all.
 *
 * On macOS this runs a tiny script through the real sandboxed `runCommand`
 * path (same profile, same environment): it creates a directory under the
 * per-run TMPDIR, checks that a hard-coded /tmp is still denied (the expected,
 * safe answer), and runs `git init` there. Without a macOS sandbox it can only
 * check the host's os.tmpdir(). The result is bounded and never carries a path: an `error` is an errno name or a fixed label.
 */
export async function probeVerifierTemp({
  platform = process.platform,
  run = runCommand,
  mkdtemp = mkdtempSync,
  rm = rmSync,
  tmp = tmpdir,
  timeoutSec = 10,
} = {}) {
  let scratch;
  try {
    scratch = mkdtemp(join(tmp(), 'offload-probe-'));
  } catch (error) {
    // Only the error code: a message can carry the (host-specific) path.
    return tempProbe('unwritable', 'host-tmpdir-unwritable', {
      error: errorToken(error?.code),
      note: "the server's os.tmpdir() is not writable, so a verifier cannot create its per-run temp directory",
    });
  }
  try {
    if (platform !== 'darwin')
      return tempProbe('writable', 'policy-only-host-tmpdir-writable', {
        note: 'no macOS sandbox on this host; only the host os.tmpdir() could be checked',
      });
    let result;
    try {
      result = await run(TEMP_PROBE_SCRIPT, { cwd: scratch, requireSandbox: true, timeoutSec });
    } catch (error) {
      if (/Required macOS sandbox is unavailable/.test(String(error?.message))) return tempProbe('not-probed', 'sandbox-unavailable');
      return tempProbe('unknown', 'probe-failed', { error: errorToken(error?.code, 'exception') });
    }
    if (result?.timedOut) return tempProbe('unknown', 'probe-timed-out');
    const tmpdirState = probeKey(result?.stdout, 'tmpdir', ['ok', 'denied']);
    if (!tmpdirState)
      return tempProbe('unknown', 'probe-failed', { error: Number.isInteger(result?.code) ? `exit-${result.code}` : 'no-output' });
    const systemTmp = probeKey(result?.stdout, 'system-tmp', ['writable', 'denied']) ?? 'unknown';
    const gitInit = probeKey(result?.stdout, 'git-init', ['ok', 'failed']) ?? 'unknown';
    const common = {
      systemTmp,
      gitInit,
      ...(systemTmp === 'writable' ? { warning: 'system temp is writable inside the verifier; the sandbox profile has regressed' } : {}),
    };
    return tmpdirState === 'ok'
      ? tempProbe('writable', 'per-run-tmpdir-writable', {
          ...common,
          note: 'a verifier can create temp dirs under its per-run TMPDIR; a hard-coded /tmp is denied by design',
        })
      : tempProbe('unwritable', 'per-run-tmpdir-denied', {
          ...common,
          note: 'the verifier sandbox could not create a temp directory under its own per-run TMPDIR',
        });
  } finally {
    try {
      rm(scratch, { recursive: true, force: true });
    } catch {}
  }
}
