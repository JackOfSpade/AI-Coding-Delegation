/**
 * Caller-declared Python interpreters and virtualenvs for the verifier sandbox.
 *
 * The verifier profile reads only the private worktree, the temp root and the
 * system toolchain, so a `testCommand` that runs `/Users/me/.venv/bin/python`
 * is refused by the sandbox ("Operation not permitted"). A caller may declare
 * such an interpreter (`verifierInterpreter`); the server then resolves it to
 * canonical directories and the sandbox grants READ and EXEC of exactly those
 * roots to the verifier. Nothing here ever widens a write scope, and nothing
 * under a credential, host-configuration or home-directory root is grantable.
 */
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { matchesAny, pathsOverlap } from './glob.mjs';
import { DEFAULT_DENY_READ } from './policy.mjs';
import { MACOS_HOST_CONFIG_DENY, runCommand } from './sandbox.mjs';

export const MAX_VERIFIER_INTERPRETERS = 4;
const MAX_ROOTS = 8;
const MAX_PATH = 4096;
const MAX_DETAIL = 200;
const PYVENV_CFG_BYTES = 8 * 1024;
const PYTHON_NAME = /^(?:python|pypy)[0-9.]*[a-z]?$/i;
const PYTHON_MARKERS = Object.freeze(['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini', 'Pipfile']);
const REQUIREMENTS = /^requirements[\w.-]*\.txt$/i;
// Directories below the user's home that hold credentials, client sessions or
// this server's own state. A declared root may be neither inside one nor above
// one: the grant is a whole subtree.
const HOME_PROTECTED = Object.freeze([
  '.ssh',
  '.aws',
  '.azure',
  '.kube',
  '.gnupg',
  '.docker',
  '.password-store',
  '.config/gcloud',
  '.config/gh',
  '.config/offload',
  '.claude',
  '.claude.json',
  '.codex',
  '.cursor',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Mail',
  'Library/Messages',
  'Library/Safari',
  'Library/Application Support/com.apple.TCC',
]);

/** `reason` is a closed vocabulary; `message` is for the caller who made the declaration. */
export class VerifierInterpreterError extends Error {
  constructor(message, reason = 'invalid') {
    super(message);
    this.name = 'VerifierInterpreterError';
    this.code = 'E_VERIFIER_INTERPRETER';
    this.reason = reason;
  }
}
const reject = (message, reason) => new VerifierInterpreterError(message, reason);

// macOS and Windows volumes are usually case- and normalization-insensitive, so
// a protected directory must not be reachable through a differently spelled
// path. Folding only ever widens a refusal.
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';
const fold = (value) => (FOLD_CASE ? value.normalize('NFC').toLowerCase() : value);
const within = (path, root) => {
  const target = fold(path);
  const base = fold(root);
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
};
const CASE_INSENSITIVE = Object.freeze({ caseInsensitive: true });
const unique = (values) => [...new Set(values)];
const safeRealpath = (path) => {
  try {
    return (realpathSync.native || realpathSync)(path);
  } catch {
    return undefined;
  }
};
const statOf = (path, { follow = true } = {}) => {
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch {
    return undefined;
  }
};
const isFile = (path) => statOf(path, { follow: false })?.isFile() === true;
const clip = (value, max = MAX_DETAIL) =>
  String(value ?? '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .trim()
    .slice(0, max);

function checkedPath(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH || /[\x00-\x1f\x7f]/.test(value))
    throw reject('verifierInterpreter entries must be non-empty absolute path strings without control characters', 'invalid');
  if (!isAbsolute(value) || !value.startsWith('/')) throw reject('verifierInterpreter entries must be absolute paths', 'invalid');
  if (value.split(/[\\/]/).includes('..')) throw reject('verifierInterpreter paths must not contain ".." segments', 'invalid');
  return value;
}

/** Syntax only (no filesystem): a path string or a short array of them, deduplicated in order. */
export function normalizeInterpreterDeclaration(value) {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.length)
    throw reject('verifierInterpreter must be an absolute path or a non-empty array of them', 'invalid');
  if (list.length > MAX_VERIFIER_INTERPRETERS)
    throw reject(`verifierInterpreter accepts at most ${MAX_VERIFIER_INTERPRETERS} paths`, 'too-many');
  return unique(list.map(checkedPath));
}

/** Syntax of the server-derived roots a job record carries (see Core.start). */
export function validateInterpreterRoots(value) {
  if (!Array.isArray(value) || value.length > MAX_ROOTS)
    throw reject('verifierInterpreterRoots must be a short array of absolute paths', 'invalid');
  for (const entry of value) checkedPath(entry);
  return value;
}

function protectedRoots({ home, env }) {
  const list = [];
  for (const relativePath of HOME_PROTECTED) list.push(join(home, relativePath));
  for (const variable of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME'])
    if (typeof env[variable] === 'string' && isAbsolute(env[variable])) list.push(join(env[variable], 'offload'));
  for (const variable of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'])
    if (typeof env[variable] === 'string' && isAbsolute(env[variable])) list.push(env[variable]);
  return unique([...list, ...list.map(safeRealpath).filter(Boolean)]);
}

/** One grantable root: a whole subtree, so it may not contain or sit inside anything sensitive. */
function assertGrantable(root, { repoPath, writeScope = [], denyRead = [], home, env }) {
  const homes = unique([home, safeRealpath(home)].filter(Boolean));
  if (root === sep || homes.some((candidate) => within(candidate, root)))
    throw reject(`${root} is the home directory or contains it; declare the virtualenv or interpreter itself`, 'denied-root');
  for (const protectedRoot of protectedRoots({ home, env }))
    if (within(root, protectedRoot) || within(protectedRoot, root))
      throw reject(`${root} is, contains or sits inside a credential or server-state directory`, 'denied-root');
  // The profile denies host configuration after every read grant, so a broad
  // toolchain prefix (/opt/homebrew, /usr) that merely contains it exposes
  // nothing; only a root inside it is refused.
  for (const hostConfig of MACOS_HOST_CONFIG_DENY)
    if (within(root, hostConfig)) throw reject(`${root} sits inside a host-configuration directory`, 'denied-root');
  const parts = root.split(sep).filter(Boolean);
  for (let index = 1; index <= parts.length; index += 1)
    if (matchesAny(parts.slice(0, index).join('/'), DEFAULT_DENY_READ, CASE_INSENSITIVE))
      throw reject(`${root} has a credential-shaped path component (for example a virtualenv named .env); rename it`, 'denied-root');
  if (!repoPath) return;
  const repo = safeRealpath(repoPath) ?? resolve(repoPath);
  if (within(repo, root)) throw reject(`${root} contains the repository; declare the virtualenv or interpreter itself`, 'denied-root');
  if (!within(root, repo)) return;
  const inside = relative(repo, root).split(sep).join('/');
  if (writeScope.length && pathsOverlap([`${inside}/**`], writeScope))
    throw reject(
      `${root} is inside the job's writable scope; narrow ownedPaths/extraWritable or move the virtualenv outside the repository`,
      'in-write-scope',
    );
  const insideParts = inside.split('/');
  // The root itself counts as a directory whose contents would be read.
  for (const candidate of [...insideParts.map((_, index) => insideParts.slice(0, index + 1).join('/')), `${inside}/x`])
    if (matchesAny(candidate, [...DEFAULT_DENY_READ, ...denyRead], CASE_INSENSITIVE))
      throw reject(`${root} is under a path the job may not read`, 'denied-root');
}

const prefixOf = (file) => {
  const directory = dirname(file);
  return basename(directory) === 'bin' ? dirname(directory) : directory;
};
const prefixOfDirectory = (directory) => (basename(directory) === 'bin' ? dirname(directory) : directory);
const runnableIn = (root) => ['python3', 'python'].map((name) => join(root, 'bin', name)).find((path) => statOf(path)?.isFile());

function pyvenvHome(root) {
  try {
    const text = readFileSync(join(root, 'pyvenv.cfg'), 'utf8').slice(0, PYVENV_CFG_BYTES);
    const line = text.split(/\r?\n/).find((entry) => /^home\s*=/i.test(entry));
    const value = line?.slice(line.indexOf('=') + 1).trim();
    return value && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
function startsWithShebang(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const bytes = Buffer.alloc(2);
    return readSync(fd, bytes, 0, 2, 0) === 2 && bytes.toString('latin1') === '#!';
  } catch {
    return false;
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
}
// Roots that contain nothing outside another root add no access.
const minimal = (roots) => roots.filter((root) => !roots.some((other) => other !== root && within(root, other)));

function resolveOne(declared, context) {
  const lexical = resolve(declared);
  if (!statOf(lexical, { follow: false })) throw reject(`verifierInterpreter does not exist: ${declared}`, 'not-found');
  const status = statOf(lexical);
  if (!status) throw reject(`verifierInterpreter is a broken symlink: ${declared}`, 'not-found');
  let kind, root, location, interpreter;
  if (status.isDirectory()) {
    root = safeRealpath(lexical);
    interpreter = root && runnableIn(root);
    const venv = root && isFile(join(root, 'pyvenv.cfg'));
    if (venv && !interpreter) throw reject(`the virtualenv has no bin/python: ${declared}`, 'broken-venv');
    if (!interpreter)
      throw reject(`${declared} is neither a virtualenv (no pyvenv.cfg) nor an installation with bin/python`, 'not-an-interpreter');
    kind = venv ? 'venv' : 'prefix';
    location = root;
  } else {
    if (!status.isFile() || !PYTHON_NAME.test(basename(lexical)) || (status.mode & 0o111) === 0)
      throw reject(`${declared} is not an executable named python*; declare the interpreter or its virtualenv`, 'not-an-interpreter');
    if (startsWithShebang(lexical))
      throw reject(
        `${declared} is a script (a shim or wrapper), not an interpreter; declare the real interpreter or its virtualenv`,
        'script',
      );
    const binDirectory = safeRealpath(dirname(lexical));
    if (!binDirectory) throw reject(`verifierInterpreter does not exist: ${declared}`, 'not-found');
    interpreter = location = join(binDirectory, basename(lexical));
    const venvRoot = basename(binDirectory) === 'bin' ? dirname(binDirectory) : undefined;
    if (venvRoot && isFile(join(venvRoot, 'pyvenv.cfg'))) {
      kind = 'venv';
      root = venvRoot;
    } else kind = 'interpreter';
  }
  const real = safeRealpath(interpreter);
  if (!real) throw reject(`the interpreter cannot be resolved: ${declared}`, 'not-found');
  // The roots are the declared tree plus the installation the interpreter was
  // built from: a virtualenv is only a shim over its base prefix.
  const roots = [];
  if (root) roots.push(root);
  if (kind === 'interpreter') roots.push(prefixOf(location));
  if (kind === 'venv' && within(real, root)) {
    // A copied interpreter has no symlink to follow: pyvenv.cfg names its base.
    const named = pyvenvHome(root);
    const home = named && safeRealpath(named);
    if (home) roots.push(prefixOfDirectory(home));
  } else roots.push(prefixOf(real));
  const found = minimal(unique(roots));
  for (const candidate of found) assertGrantable(candidate, context);
  const allowed = (context.allowlist || []).map((entry) => safeRealpath(entry) ?? resolve(entry));
  if (allowed.length && !allowed.some((entry) => within(location, entry)))
    throw reject(`${declared} is not under a configured verifier.interpreterRoots entry`, 'not-allowlisted');
  return { declared, kind, interpreter, location, roots: found };
}

/**
 * Resolve declared interpreters/virtualenvs to the canonical directories the
 * verifier sandbox may read and execute, or throw a VerifierInterpreterError.
 * `context`: repoPath, writeScope and denyRead describe the job; allowlist is
 * the optional `verifier.interpreterRoots` server configuration.
 */
export function resolveVerifierInterpreters(declared, context = {}) {
  const normalized = normalizeInterpreterDeclaration(declared);
  const full = { home: homedir(), env: process.env, ...context };
  const grants = normalized.map((entry) => resolveOne(entry, full));
  const roots = minimal(unique(grants.flatMap((grant) => grant.roots)));
  if (roots.length > MAX_ROOTS) throw reject(`the declared interpreters resolve to more than ${MAX_ROOTS} directories`, 'too-many');
  return { declared: normalized, grants, roots };
}

/**
 * Re-check stored roots at the moment they are about to be granted. A root that
 * vanished, was swapped for something sensitive or no longer passes is dropped:
 * dropping can only reduce access, and the verifier then fails with an
 * actionable denial instead of a wider read.
 */
export function usableInterpreterRoots(roots, context = {}) {
  const full = { home: homedir(), env: process.env, ...context };
  const usable = [];
  for (const root of Array.isArray(roots) ? roots : []) {
    try {
      checkedPath(root);
      const real = (realpathSync.native || realpathSync)(root);
      if (!statSync(real).isDirectory()) continue;
      assertGrantable(real, full);
      usable.push(real);
    } catch {
      /* dropped */
    }
  }
  return minimal(unique(usable));
}

/** The runCommand option for a job's declared roots, or nothing when it declared none. */
export function interpreterPathsOption(job) {
  if (!Array.isArray(job?.verifierInterpreterRoots) || !job.verifierInterpreterRoots.length) return {};
  const interpreterPaths = usableInterpreterRoots(job.verifierInterpreterRoots, {
    repoPath: job.repoPath,
    writeScope: [...(job.ownedPaths || []), ...(job.extraWritable || [])],
    denyRead: job.denyRead || [],
  });
  return interpreterPaths.length ? { interpreterPaths } : {};
}

/** What offload_start/offload_job echo about a job's declaration. */
export function publicVerifierInterpreter(job) {
  if (!Array.isArray(job?.verifierInterpreter) || !job.verifierInterpreter.length) return {};
  return {
    verifierInterpreter: {
      accepted: true,
      declared: job.verifierInterpreter,
      ...(Array.isArray(job.verifierInterpreterRoots) ? { readExecRoots: job.verifierInterpreterRoots } : {}),
      appliesTo: 'verifier',
      sandboxed: job.sandboxMode === 'macos',
      writable: false,
    },
  };
}

/** Marker files that make a repository a Python project, in a fixed order. */
export function pythonProjectMarkers(repoPath) {
  const found = PYTHON_MARKERS.filter((name) => isFile(join(repoPath, name)));
  try {
    for (const entry of readdirSync(repoPath).sort()) if (REQUIREMENTS.test(entry) && isFile(join(repoPath, entry))) found.push(entry);
  } catch {
    /* an unreadable root has no markers */
  }
  return found.slice(0, 8);
}

/**
 * Whether a verifier of this repository can run its Python. Without a
 * declaration the sandbox cannot read any interpreter or virtualenv, so a
 * Python project is `missing` and the reason says what to pass; an interpreter
 * is `ok` only once a declaration has been probed (see probeVerifierInterpreter).
 */
export function verifierPythonStatus(repoPath, context = {}) {
  const markers = pythonProjectMarkers(repoPath);
  if (!markers.length) return { status: 'not-applicable', reason: 'not-a-python-project' };
  const candidates = [];
  const rejected = [];
  const looksLikeVenv = (path) => statOf(path)?.isDirectory() && isFile(join(path, 'pyvenv.cfg'));
  for (const path of unique([...['.venv', 'venv'].map((name) => join(repoPath, name)), ...(context.allowlist || [])])) {
    if (!looksLikeVenv(path)) continue;
    try {
      resolveVerifierInterpreters([path], { ...context, repoPath, writeScope: [] });
      candidates.push(path);
    } catch (error) {
      if (!(error instanceof VerifierInterpreterError)) throw error;
      rejected.push({ path, reason: error.reason });
    }
  }
  const base = { markers };
  if (candidates.length)
    return {
      status: 'missing',
      reason: 'interpreter-undeclared',
      interpreter: candidates[0],
      ...(candidates.length > 1 ? { candidates } : {}),
      ...base,
      note: `the verifier sandbox cannot read or run ${candidates[0]} unless offload_start declares verifierInterpreter: ["${candidates[0]}"] (read and exec only); call its python by absolute path in testCommand, since the private worktree has no copy of it`,
    };
  if (rejected.length)
    return {
      status: 'missing',
      reason: 'interpreter-rejected',
      interpreter: rejected[0].path,
      ...base,
      note: `${rejected[0].path} cannot be declared (${rejected[0].reason}); use an interpreter outside the writable scope and sensitive directories`,
    };
  return {
    status: 'missing',
    reason: 'no-interpreter-found',
    ...base,
    note: 'no .venv or venv in the repository; pass verifierInterpreter (a virtualenv root or interpreter path) for any testCommand that runs Python',
  };
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const PROBE_SCRIPT = '-c "import sys; print(sys.version)"';

/**
 * Run `<interpreter> -c "import sys; print(sys.version)"` inside the real
 * verifier sandbox with the declaration applied, so a primary learns before it
 * spends a job whether the declared interpreter works. Never throws for a
 * rejected or failing interpreter: that is the answer.
 */
export async function probeVerifierInterpreter(declared, { run = runCommand, timeoutSec = 10, ...context } = {}) {
  let resolved;
  try {
    resolved = resolveVerifierInterpreters(declared, context);
  } catch (error) {
    if (!(error instanceof VerifierInterpreterError)) throw error;
    return { status: 'missing', reason: 'interpreter-rejected', accepted: false, rejected: error.reason, note: clip(error.message) };
  }
  const interpreters = [];
  let scratch;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'offload-pyprobe-'));
    for (const grant of resolved.grants) {
      const entry = { declared: grant.declared, kind: grant.kind, interpreter: grant.interpreter };
      try {
        const result = await run(`${shellQuote(grant.interpreter)} ${PROBE_SCRIPT}`, {
          cwd: scratch,
          requireSandbox: true,
          timeoutSec,
          interpreterPaths: resolved.roots,
        });
        const version = clip(String(result?.stdout ?? '').split(/\r?\n/)[0], 120);
        if (result?.code === 0 && !result.timedOut && version) interpreters.push({ ...entry, status: 'ok', version });
        else
          interpreters.push({
            ...entry,
            status: 'failed',
            reason: result?.timedOut ? 'probe-timed-out' : 'probe-failed',
            ...(Number.isInteger(result?.code) ? { exitCode: result.code } : {}),
            detail: clip(
              String(result?.stderr ?? '')
                .split(/\r?\n/)
                .find((line) => line.trim()) ?? '',
            ),
          });
      } catch (error) {
        const sandboxless = /Required macOS sandbox is unavailable/.test(String(error?.message));
        interpreters.push({ ...entry, status: 'not-probed', reason: sandboxless ? 'sandbox-unavailable' : 'probe-failed' });
      }
    }
  } finally {
    if (scratch)
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {}
  }
  const failed = interpreters.find((entry) => entry.status !== 'ok');
  return {
    accepted: true,
    status: failed ? 'partial' : 'ok',
    reason: failed ? failed.reason : 'declared-interpreter-runs',
    interpreter: resolved.grants[0].interpreter,
    interpreters,
    readExecRoots: resolved.roots,
    note: failed
      ? 'the declaration was accepted but the interpreter did not run inside the verifier sandbox; a testCommand using it would fail the same way'
      : 'the declared interpreter runs inside the verifier sandbox (read and exec only, never write); call it by this absolute path in testCommand',
  };
}
