import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { matchesAny } from './glob.mjs';

const MAX_SCAN_CHARS = 64 * 1024;
const MAX_DETAIL = 200;

// A bare Node specifier that could not be resolved. Relative/absolute paths,
// file:/node: URLs, `#imports` and `@/`/`~/` aliases are the worker's own files
// or project aliases and are deliberately not matched.
const MISSING_PACKAGE = /Cannot find (?:package|module) '((?![./#~]|@\/|file:|node:)[^'\s]{1,214})'/;
const COMMAND_NOT_FOUND = /(?:^|\n)[^\n]*?(?:sh|bash|zsh|dash): (?:line \d+: )?([^\s:'"]{1,100}): (?:command )?not found\b/i;
const NO_EXECUTABLE = /could not determine executable to run/i;
const ASSERTION_FAILURE = /\bAssertionError\b|\bERR_ASSERTION\b/;
// The two places a hard-coded temp path lands on macOS and Linux. The verifier
// grants only its per-run TMPDIR, so a command that spells one of these out (or
// spawns a child that dropped TMPDIR) is denied by design.
const SYSTEM_TEMP = /^(?:\/private)?\/(?:tmp|var\/folders)(?:\/|$)/;
// The verifier's own per-run TMPDIR lives under the system temp root; a denial
// on a file a test made inside it is not a hard-coded system-temp path.
const OWN_TEMP = /\/offload-sandbox-[A-Za-z0-9]+(?:\/|$)/;
const PERMISSION = /(?:\bEACCES\b|\bEPERM\b|permission denied|operation not permitted)[^\n]*/i;
// Test tools write throwaway caches next to the code (pytest's `.pytest_cache`,
// bytecode, type-checker caches). The worktree outside ownedPaths is read-only,
// so the write is denied, and the tool warns and carries on: that line says
// nothing about why a run failed and must not turn a failing suite into an
// environment failure that no repair round could address.
const TOOL_CACHE =
  /PytestCacheWarning|[/\\](?:\.pytest_cache|__pycache__|\.mypy_cache|\.ruff_cache|\.hypothesis)(?:[/\\]|\b)|pytest-cache-files-[\w-]+/;
// A Python interpreter or virtualenv outside the worktree is unreadable to the
// verifier unless the caller declares it (verifierInterpreter). Its denial reads
// as a plain "Operation not permitted" on the interpreter, its prefix or a
// site-packages file, or as CPython dying before it can import `encodings`.
const INTERPRETER_PATH =
  /(?:\/bin\/(?:python|pypy)[\d.]*[a-z]?\/?$|\/site-packages\b|\/lib\/python\d|pyvenv\.cfg$|\/Python\d*\.framework\b|\/(?:\.?venv|virtualenvs?|\.pyenv|\.?conda|miniconda\d*|anaconda\d*|mambaforge)(?:\/|$))/;
const PYTHON_COMMAND = /(?:^|[\s/;&|(])(?:python[\d.]*|pypy[\d.]*|pytest|py\.test|tox|pip[\d.]*|poetry|uv|pipenv)(?:\s|$)/;
const INTERPRETER_STARTUP = /Fatal Python error:[^\n]*|No module named 'encodings'|Could not find platform independent libraries/;

const clip = (value, max = MAX_DETAIL) =>
  String(value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, max);
// Actionable, and honest about the grant: read and exec of the declared roots,
// never a write. The action leads so a long path cannot truncate it away.
const interpreterDetail = (path) =>
  `an interpreter or virtualenv outside the worktree must be declared with verifierInterpreter (read and exec only) and called by absolute path; denied: ${path ? clip(path, 90) : 'interpreter startup'}`;

// The first absolute path named on a permission-error line, quoted or bare.
function permissionPath(line) {
  const quoted = line.match(/['"`](\/[^'"`\n]+)['"`]/);
  if (quoted) return quoted[1];
  const bare = line.match(/(?:^|[\s:(])(\/[^\s'"`:,)]+)/);
  return bare ? bare[1] : undefined;
}

// Error text may spell the worktree through either its symlinked or canonical
// form (macOS temp roots are symlinks).
function workspaceRoots(workspacePath) {
  if (typeof workspacePath !== 'string' || !isAbsolute(workspacePath)) return [];
  const roots = [resolve(workspacePath)];
  try {
    roots.push(realpathSync(workspacePath));
  } catch {
    /* worktree already gone */
  }
  return [...new Set(roots)];
}

// The same file, spelled as printed and as the filesystem names it.
function spellings(path) {
  const found = [path];
  let probe = path,
    tail = '';
  while (probe !== dirname(probe)) {
    try {
      found.push(join(realpathSync(probe), tail));
      break;
    } catch {
      tail = tail ? join(basename(probe), tail) : basename(probe);
      probe = dirname(probe);
    }
  }
  return [...new Set(found)];
}

/**
 * Decide whether a failed verifier run failed because of its *environment*
 * (a dependency, executable, or path the worker could not have supplied)
 * rather than because of the worker's code.
 *
 * A match never proves the worker is innocent (it may have imported a package
 * that does not exist), so the result is a diagnosis for the primary, not a
 * verdict on the diff. The point is only that a repair round cannot fix it:
 * the worker has no network, cannot install, and cannot write outside its
 * scope.
 *
 * Returns `{ kind, detail, specifier? }` or `null`.
 */
export function classifyVerifierEnvironment(verify, { workspacePath, writeScope = [] } = {}) {
  const result = verify?.result;
  if (!result || verify.verdict !== 'FAIL' || result.timedOut || result.cancelled) return null;
  const text = `${result.stderr || ''}\n${result.stdout || ''}`.slice(-MAX_SCAN_CHARS);
  const testCommand = String(verify.command ?? '');

  // Output that also carries an ordinary assertion failure is a code failure
  // that merely mentions a module or path (an optional require inside a test, a
  // logged EACCES): the text signals below must not mask it. An exit-127 or
  // "could not determine executable" run has no tests to have failed.
  const assertionFailure = ASSERTION_FAILURE.test(text);
  const missing = assertionFailure ? null : text.match(MISSING_PACKAGE);
  if (missing)
    return { kind: 'missing-package', specifier: clip(missing[1]), detail: `package '${clip(missing[1])}' could not be resolved` };

  const command = assertionFailure ? null : text.match(COMMAND_NOT_FOUND);
  if (command) return { kind: 'command-not-found', detail: `command '${clip(command[1])}' not found` };
  if (NO_EXECUTABLE.test(text))
    return { kind: 'command-not-found', detail: 'executable could not be determined (npx/npm without network)' };
  if (result.code === 127) return { kind: 'command-not-found', detail: 'verifier exited 127 (command not found)' };

  // Every permission line is read: the actionable temp-dir denial must not be
  // lost to whichever other denial happens to print first.
  let denied;
  for (const line of assertionFailure ? [] : text.split(/\r?\n/)) {
    if (!PERMISSION.test(line) || TOOL_CACHE.test(line)) continue;
    const path = permissionPath(line);
    if (!path) continue;
    let ownedByWorker = false;
    let insideWorkspace = false;
    search: for (const candidate of spellings(path)) {
      for (const root of workspaceRoots(workspacePath)) {
        const rel = relative(root, candidate);
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
        insideWorkspace = true;
        try {
          ownedByWorker = matchesAny(rel.split(sep).join('/'), writeScope);
        } catch {
          ownedByWorker = false;
        }
        break search;
      }
    }
    // A denial on a path the worker was allowed to write is a code/test
    // problem; a denial anywhere else is the sandbox doing its job against a
    // command that wants more than the package may grant.
    // The private worktree itself lives under the OS temp root, so a denial
    // inside it is never a system-temp denial.
    if (!ownedByWorker && !insideWorkspace && SYSTEM_TEMP.test(path) && !OWN_TEMP.test(path))
      return {
        kind: 'temp-dir-denied',
        detail: `a command used the system temp directory ${clip(path)}; the verifier grants only its per-run TMPDIR (use os.tmpdir() and pass process.env to child processes)`,
      };
    // A bare `.../bin/` (CPython's realpath of its own directory) only counts as
    // an interpreter denial for a Python command.
    if (!ownedByWorker && !insideWorkspace && (INTERPRETER_PATH.test(path) || (/\/bin\/?$/.test(path) && PYTHON_COMMAND.test(testCommand))))
      denied ??= { kind: 'permission-denied', detail: interpreterDetail(path) };
    else if (!ownedByWorker)
      denied ??= { kind: 'permission-denied', detail: `permission denied outside the job's write scope: ${clip(path)}` };
  }
  // An interpreter that dies at startup names no path: its standard library was
  // unreadable, which is the same undeclared-interpreter denial.
  if (!denied && !assertionFailure && INTERPRETER_STARTUP.test(text) && PYTHON_COMMAND.test(testCommand))
    return { kind: 'permission-denied', detail: interpreterDetail() };
  return denied ?? null;
}
