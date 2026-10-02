import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readRegularFileSync } from './regular-file.mjs';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const SNAPSHOT_ENV_ALLOW =
  /^(?:PATH|LANG|LC_[A-Z0-9_]*|TERM|TZ|HOME|XDG_CONFIG_HOME|SYSTEMROOT|COMSPEC|PATHEXT|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA)$/i;
const CREDENTIAL_ENV = /(?:^|_)(?:api[_-]?key|token|secret|password|authorization|credential)(?:$|_)/i;

export class GitSnapshotError extends Error {
  constructor(message, code = 'E_GIT_SNAPSHOT') {
    super(message);
    this.name = 'GitSnapshotError';
    this.code = code;
  }
}

/** Build a tree from all non-ignored working-tree files without changing the real index or HEAD. */
export function snapshotWorkingTree(repoPath) {
  const tempDir = mkdtempSync(join(tmpdir(), 'offload-index-'));
  const indexFile = join(tempDir, 'index');
  try {
    // A real empty directory is portable; /dev/null is not a hooks directory
    // on Git for Windows.  Passing it per invocation prevents repository hooks
    // from running while the temporary index is built.
    const hooksPath = join(tempDir, 'empty-hooks');
    mkdirSync(hooksPath);
    git(repoPath, ['add', '-A'], { GIT_INDEX_FILE: indexFile }, { hooksPath });
    return git(repoPath, ['write-tree'], { GIT_INDEX_FILE: indexFile }, { hooksPath }).trim();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Return the exact binary-safe diff between two git tree ids. */
export function diffTrees(repoPath, before, after, { paths, literalPaths = false } = {}) {
  assertTreeId(before);
  assertTreeId(after);
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', before, after];
  if (paths !== undefined) args.push('--', ...pathspecs(paths, { literal: literalPaths }));
  return git(repoPath, args, {}, { output: 'buffer' });
}

/** NUL-safe authoritative changed-path list. Never parse human diff headers. */
export function diffTreeFiles(repoPath, before, after) {
  assertTreeId(before);
  assertTreeId(after);
  const raw = git(
    repoPath,
    ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', before, after],
    {},
    { output: 'buffer' },
  );
  return parseNulNameStatus(raw);
}

/** Return a binary-safe tree diff constrained to validated repo-relative glob paths. */
export function diffTreePaths(repoPath, before, after, paths) {
  return diffTrees(repoPath, before, after, { paths });
}

/** Persist a generated patch atomically and return its content. */
export function createPatch(repoPath, before, after, patchPath, { paths } = {}) {
  const patch = diffTrees(repoPath, before, after, { paths });
  if (patchPath) atomicWrite(patchPath, patch);
  return patch;
}

/** Check a reverse patch by default; apply only when apply:true is explicitly supplied. */
export function revertPatch(repoPath, patchPath, { apply = false, gitCommand = git } = {}) {
  if (typeof apply !== 'boolean') throw new GitSnapshotError('apply must be boolean', 'E_REVERT_APPLY');
  if (typeof gitCommand !== 'function') throw new GitSnapshotError('gitCommand must be a function', 'E_REVERT_APPLY');
  let patch;
  try {
    patch = Buffer.isBuffer(patchPath) ? patchPath : readRegularFileSync(patchPath, GIT_MAX_BUFFER);
  } catch {
    throw new GitSnapshotError('Patch must be a bounded regular file', 'E_REVERT_PATCH');
  }
  // Feed both commands the exact checked bytes. Referencing a path twice lets
  // an attacker replace a patch after --check but before the mutating apply.
  try {
    gitCommand(repoPath, ['apply', '-R', '--check'], {}, { input: patch });
  } catch {
    throw new GitSnapshotError('Patch cannot be safely reversed against the current working tree', 'E_REVERT_CONFLICT');
  }
  if (apply) {
    try {
      gitCommand(repoPath, ['apply', '-R'], {}, { input: patch });
    } catch {
      throw new GitSnapshotError('Patch reverse application failed', 'E_REVERT_FAILED');
    }
  }
  return { dryRun: !apply, applied: apply };
}
function assertTreeId(value) {
  // Git diff revisions are command arguments, but accepting arbitrary values
  // still lets a library caller reinterpret them as revision syntax/options.
  // Every snapshot this module creates is a SHA-1 or SHA-256 tree id.
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value))
    throw new GitSnapshotError('Invalid tree id', 'E_GIT_TREE');
}

export function snapshotGitEnv(source = process.env) {
  const env = {};
  // A snapshot must not need a provider credential.  If a hostile or
  // misconfigured filter did execute, inheriting the host process environment
  // would otherwise turn a Git plumbing call into a credential disclosure.
  for (const [key, value] of Object.entries(source)) {
    if (!CREDENTIAL_ENV.test(key) && SNAPSHOT_ENV_ALLOW.test(key)) env[key] = value;
  }
  // Ambient Git variables can redirect config, hooks, worktree, or transport.
  // Deliberate per-call variables (notably the temporary index) are restored
  // only through extraEnv below.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

export function git(repoPath, args, extraEnv = {}, { hooksPath, execFile = execFileSync, output = 'text', input } = {}) {
  if (
    !extraEnv ||
    typeof extraEnv !== 'object' ||
    Array.isArray(extraEnv) ||
    Object.keys(extraEnv).some((key) => key !== 'GIT_INDEX_FILE') ||
    (extraEnv.GIT_INDEX_FILE !== undefined &&
      (typeof extraEnv.GIT_INDEX_FILE !== 'string' || !extraEnv.GIT_INDEX_FILE || /[\x00-\x1f\x7f]/.test(extraEnv.GIT_INDEX_FILE)))
  ) {
    throw new GitSnapshotError('Invalid Git snapshot environment override', 'E_GIT_ENV');
  }
  if (!['text', 'buffer'].includes(output)) throw new GitSnapshotError('Invalid Git snapshot output mode', 'E_GIT_OUTPUT');
  if (input !== undefined && !Buffer.isBuffer(input)) throw new GitSnapshotError('Invalid Git snapshot input', 'E_GIT_INPUT');
  const env = snapshotGitEnv();
  const inertHooks = hooksPath || (process.platform === 'win32' ? 'NUL' : '/dev/null');
  // Querying filters is itself part of the safety contract: falling back to
  // an empty override list after an error would let `git add` invoke a
  // repository/global clean or process filter outside the command sandbox.
  const hardening = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${inertHooks}`, ...disabledFilters(repoPath, env, execFile)];
  try {
    return execFile('git', [...hardening, ...args], {
      cwd: repoPath,
      encoding: output === 'buffer' ? 'buffer' : 'utf8',
      env: { ...env, ...extraEnv },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      ...(input === undefined ? {} : { input }),
    });
  } catch (error) {
    throw new GitSnapshotError(`git ${args[0]} failed`, 'E_GIT_COMMAND');
  }
}
export function parseNulNameStatus(raw) {
  if (!Buffer.isBuffer(raw)) throw new GitSnapshotError('Malformed NUL name-status output', 'E_GIT_DIFF');
  const fields = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    fields.push(raw.subarray(start, index));
    start = index + 1;
  }
  if (start !== raw.length || fields.length % 2 !== 0) throw new GitSnapshotError('Malformed NUL name-status output', 'E_GIT_DIFF');
  const decode = (value) => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(value);
    } catch {
      throw new GitSnapshotError('Git returned a filename that is not valid UTF-8', 'E_GIT_DIFF');
    }
  };
  const files = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = decode(fields[index]);
    const path = decode(fields[index + 1]);
    if (!status || !path) throw new GitSnapshotError('Malformed NUL name-status output', 'E_GIT_DIFF');
    files.push({ path, status: status[0] });
  }
  return files;
}
function atomicWrite(file, contents) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  renameSync(temp, file);
}
function pathspecs(paths, { literal = false } = {}) {
  if (!Array.isArray(paths) || paths.length === 0)
    throw new GitSnapshotError('paths must be a non-empty array of repo-relative globs', 'E_GIT_PATHSPEC');
  return paths.map((path) => {
    if (typeof path !== 'string' || path.includes('\0') || path.startsWith(':'))
      throw new GitSnapshotError('Invalid diff pathspec', 'E_GIT_PATHSPEC');
    let normalized;
    try {
      normalized = normalizeRepoPath(path, { literal });
    } catch {
      throw new GitSnapshotError('Invalid diff pathspec', 'E_GIT_PATHSPEC');
    }
    return literal ? `:(top,literal)${normalized}` : `:(top,glob)${normalized}`;
  });
}
function disabledFilters(repoPath, env, execFile = execFileSync) {
  try {
    // Include every effective scope: a global/system filter can be selected by
    // repository .gitattributes just as readily as a local one.
    const output = execFile('git', ['config', '--null', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], {
      cwd: repoPath,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    const names = new Set();
    for (const entry of output.split('\0')) {
      if (!entry) continue;
      const name = entry.split('\n')[0];
      const match = /^filter\.([A-Za-z0-9][A-Za-z0-9.-]*)\.(?:clean|smudge|process|required)$/.exec(name);
      // The output is produced by Git config, but it is still repository and
      // host-controlled input that becomes a later `-c` key. Unknown syntax
      // must not weaken filter isolation by being silently ignored.
      if (!match) throw new GitSnapshotError('Git filter configuration could not be safely enumerated', 'E_GIT_FILTER');
      names.add(match[1]);
    }
    // Empty commands disable the configured filter rather than invoking a
    // platform-specific replacement such as /bin/cat.  `required=false`
    // ensures a repository cannot make an external filter mandatory.
    return [...names].flatMap((name) => [
      '-c',
      `filter.${name}.clean=`,
      '-c',
      `filter.${name}.smudge=`,
      '-c',
      `filter.${name}.process=`,
      '-c',
      `filter.${name}.required=false`,
    ]);
  } catch (error) {
    // `git config --get-regexp` uses exit status 1 for an ordinary no-match.
    // Every other failure is an inability to establish the no-filter contract.
    if (error?.status === 1) return [];
    if (error instanceof GitSnapshotError) throw error;
    throw new GitSnapshotError('Git filter configuration could not be enumerated', 'E_GIT_FILTER');
  }
}
function normalizeRepoPath(path, { literal = false } = {}) {
  // Backslash is a path separator on Windows, but a valid literal POSIX
  // filename byte. Keep it intact only for a Git literal pathspec, which is
  // fed by the authoritative NUL-delimited Git file list rather than worker
  // glob input. Worker-facing glob pathspecs retain their cross-platform
  // slash-normalized behavior.
  if (literal && process.platform === 'win32' && path.includes('\\')) throw new Error('unsafe');
  const normalized = (literal ? path : path.replaceAll('\\', '/')).replace(/\/+/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..'))
    throw new Error('unsafe');
  const result = normalized
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/');
  if (!result) throw new Error('unsafe');
  return result;
}
