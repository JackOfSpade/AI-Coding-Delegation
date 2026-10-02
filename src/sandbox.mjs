/** Dependency-free, scrubbed command execution with best-effort OS sandboxing. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep, relative, isAbsolute } from 'node:path';
import { globToRegExp, normalizePath } from './glob.mjs';
import { DEFAULT_DENY_READ, DEFAULT_DENY_WRITE } from './policy.mjs';

const SECRET =
  /(?:^|_)(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|token|secret|password|authorization|credential(?:s)?|private[_-]?key)(?:$|_)/i;
// These names are capabilities even though their spelling does not always
// contain a singular "secret" token. A command inheriting an SSH-agent socket
// or a cloud credential-file location can use the host identity directly.
const CAPABILITY_ENV =
  /^(?:SSH_AUTH_SOCK|SSH_AGENT_PID|GPG_AGENT_INFO|GNUPGHOME|GOOGLE_APPLICATION_CREDENTIALS|AWS_SHARED_CREDENTIALS_FILE|AWS_CONFIG_FILE)$/i;
const CAP = 256 * 1024;
// `/usr/local` and `/opt/homebrew` are broadly readable for interpreters and
// libraries.  Their etc trees are host configuration, however, and `/Library`
// includes machine credentials and management policy.  These denies appear
// after the broad toolchain reads in the generated profile intentionally.
const MACOS_HOST_CONFIG_DENY = Object.freeze([
  '/usr/local/etc',
  '/opt/homebrew/etc',
  '/Library/Keychains',
  '/Library/Preferences',
  '/Library/Managed Preferences',
  '/Library/Application Support/com.apple.TCC',
  '/Library/Security',
]);
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
/** A binary on PATH is not enough: managed macOS hosts can forbid applying a profile. */
export function sandboxAvailable(platform = process.platform, profile) {
  if (platform !== 'darwin') return false;
  // The binary can be present and permissive profiles can compile while a
  // real restrictive profile aborts under managed/macOS entitlement setups.
  // Probe the same profile shape used by commands and fail closed to the
  // policy-only runner when sandbox-exec cannot actually apply it.
  const probe = profile ?? macosProfile({ repoPath: process.cwd(), tempPath: tmpdir() });
  try {
    return spawnSync('sandbox-exec', ['-p', probe, '/usr/bin/true'], { stdio: 'ignore', timeout: 2_000 }).status === 0;
  } catch {
    return false;
  }
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
const regexEscape = (value) => String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
function sandboxGlobFilter(kind, repoPath, value) {
  const root = resolve(repoPath);
  const raw = typeof value === 'string' ? value : String(value);
  seatbeltPath(raw);
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const rel = relative(root, absolute).replaceAll('\\', '/');
  if (!rel || rel.startsWith('../') || rel === '..') throw new TypeError(`sandbox path is outside repository: ${value}`);
  const source = globToRegExp(rel).source.replace(/^\^/, '').replace(/\$$/, '');
  return `(${kind} file-write* (regex #"^${seatbeltString(regexEscape(root))}/${seatbeltString(source)}$"))`;
}
function denyFilter(kind, repoPath, pattern) {
  const safePattern = normalizePath(pattern);
  const source = globToRegExp(safePattern).source.replace(/^\^/, '').replace(/\$$/, '');
  const root = seatbeltString(regexEscape(resolve(repoPath)));
  // Repository secret conventions are case-insensitive: macOS volumes often
  // are too, and `.ENV`/`ID_RSA` should not become readable on a Linux volume.
  return `(deny file-${kind}* (regex #"(?i)^${root}/${seatbeltString(source)}$"))`;
}
export function macosProfile({
  repoPath,
  gitDir = join(repoPath, '.git'),
  writablePaths = [],
  denyRead = [],
  denyWrite = DEFAULT_DENY_WRITE,
  tempPath,
  cachePaths = [],
  allowNetwork = false,
}) {
  if (!Array.isArray(denyRead) || denyRead.some((path) => typeof path !== 'string'))
    throw new TypeError('denyRead must be relative glob strings');
  if (!Array.isArray(denyWrite) || denyWrite.some((path) => typeof path !== 'string'))
    throw new TypeError('denyWrite must be relative glob strings');
  if (!Array.isArray(writablePaths) || !Array.isArray(cachePaths)) throw new TypeError('sandbox writable/cache paths must be arrays');
  for (const value of [repoPath, gitDir, tempPath, ...writablePaths, ...cachePaths].filter((value) => value !== undefined))
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
  const resolvedCache = cachePaths.map((value) => (isAbsolute(value) ? resolve(value) : resolve(root, value)));
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
    ...resolvedCache,
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
    ...read.map((path) => `(allow file-read* (subpath ${q(path)}))`),
    ...MACOS_HOST_CONFIG_DENY.map((path) => `(deny file-read* (subpath ${q(path)}))`),
    ...protectedGitPaths.map((path) => `(deny file-read* (subpath ${q(path)}))`),
    ...writablePaths.map((path) => sandboxGlobFilter('allow', root, path)),
    ...write.map((path) => `(allow file-write* (subpath ${q(path)}))`),
    ...protectedGitPaths.map((path) => `(deny file-write* (subpath ${q(path)}))`),
    ...denyWrite.map((pattern) => denyFilter('write', root, pattern)),
    ...protectedRead.map((pattern) => denyFilter('read', root, pattern)),
    ...(allowNetwork ? ['(allow network*)'] : []),
  ].join('\n');
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
  const profileInput = {
    repoPath: cwd,
    gitDir: options.gitDir,
    writablePaths: options.writablePaths || [],
    denyRead: options.denyRead || [],
    denyWrite: options.denyWrite || DEFAULT_DENY_WRITE,
    tempPath: options.tempPath || tmpdir(),
    cachePaths: options.cachePaths || [],
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
  if (canSandbox) {
    // Validate before creating a temp directory so a rejection has no residue.
    dir = await mkdtemp(join(tmpdir(), 'offload-sandbox-'));
    sandbox = 'macos';
  } else dir = await mkdtemp(join(tmpdir(), 'offload-run-'));
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
    const environment = { ...scrubEnv(options.env, { home: dir, temp: dir, platform }), OFFLOAD_COMMAND_CWD: cwd };
    const sandboxProfile =
      sandbox === 'macos'
        ? macosProfile({
            repoPath: cwd,
            gitDir: options.gitDir,
            writablePaths: options.writablePaths || [],
            denyRead: options.denyRead || [],
            denyWrite: options.denyWrite || DEFAULT_DENY_WRITE,
            // The private script directory must be readable by the sandboxed
            // interpreter. A separately requested temporary directory remains
            // an explicit cache capability rather than replacing that root.
            tempPath: dir,
            cachePaths: [...(options.cachePaths || []), ...(options.tempPath ? [options.tempPath] : [])],
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
      if (sandbox === 'macos') child = spawnProcess('sandbox-exec', ['-p', sandboxProfile, '/bin/sh', scriptName], spawnOptions);
      else if (platform === 'win32') child = spawnProcess('cmd.exe', ['/d', '/s', '/c', scriptName], spawnOptions);
      else child = spawnProcess('/bin/sh', [scriptName], spawnOptions);
      child.stdout.on('data', (value) => stdout.add(value));
      child.stderr.on('data', (value) => stderr.add(value));
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
