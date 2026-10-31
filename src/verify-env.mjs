import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { matchesAny } from './glob.mjs';
import { TSX_LOADER_FIX } from './verifier-command.mjs';
import { redactText, stripTerminalControls } from './redact.mjs';

const MAX_SCAN_CHARS = 64 * 1024;
const MAX_DETAIL = 200;
const ENVIRONMENT_KINDS = new Set([
  'missing-package',
  'command-not-found',
  'permission-denied',
  'temp-dir-denied',
  'git-config-denied',
  'native-module-crash',
  // Set by the baseline-diff verifier, never by the classifier below: the same
  // failures in both runs were the sandbox refusing the suite's fixtures.
  'sandbox-dominated',
]);
export const isVerifierEnvironmentKind = (kind) => ENVIRONMENT_KINDS.has(kind);

// A bare Node specifier that could not be resolved. Relative/absolute paths,
// file:/node: URLs, `#imports` and `@/`/`~/` aliases are the worker's own files
// or project aliases and are deliberately not matched.
const MISSING_PACKAGE = /Cannot find (?:package|module) '((?![./#~]|@\/|file:|node:)[^'\s]{1,214})'/;
const COMMAND_NOT_FOUND = /(?:^|\n)[^\n]*?(?:sh|bash|zsh|dash): (?:line \d+: )?([^\s:'"]{1,100}): (?:command )?not found\b/i;
const NO_EXECUTABLE = /could not determine executable to run/i;
const ASSERTION_FAILURE = /\bAssertionError\b|\bERR_ASSERTION\b/;
// Git fixture helpers commonly shell out to the system Git binary. The
// verifier intentionally denies the host system configuration, so an older
// Git that still reaches it cannot initialize the disposable fixture. This is
// an execution-environment limit, not evidence about the worker's patch.
const GIT_SYSTEM_CONFIG_DENIED =
  /(?:fatal:\s+unable to access ['"]\/etc\/gitconfig['"]|xcode-select: error: unable to read data link at ['"]\/var\/select\/developer_dir['"])[\s\S]{0,160}?(?:operation not permitted|permission denied)/i;
// The two places a hard-coded temp path lands on macOS and Linux. The verifier
// grants only its per-run TMPDIR, so a command that spells one of these out (or
// spawns a child that dropped TMPDIR) is denied by design.
export const SYSTEM_TEMP_PATH = /^(?:\/private)?\/(?:tmp|var\/folders)(?:\/|$)/;
// The verifier's own per-run TMPDIR lives under the system temp root; a denial
// on a file a test made inside it is not a hard-coded system-temp path.
const OWN_TEMP = /\/offload-sandbox-[A-Za-z0-9]+(?:\/|$)/;
const PERMISSION = /(?:\bEACCES\b|\bEPERM\b|permission denied|operation not permitted)[^\n]*/i;
// Test tools write throwaway caches next to the code (pytest's `.pytest_cache`,
// bytecode, type-checker caches). The worktree outside ownedPaths is read-only,
// so the write is denied, and the tool warns and carries on: that line says
// nothing about why a run failed and must not turn a failing suite into an
// environment failure that no repair round could address.
export const TOOL_CACHE =
  /PytestCacheWarning|[/\\](?:\.pytest_cache|__pycache__|\.mypy_cache|\.ruff_cache|\.hypothesis)(?:[/\\]|\b)|pytest-cache-files-[\w-]+/;
// A Python interpreter or virtualenv outside the worktree is unreadable to the
// verifier unless the caller declares it (verifierInterpreter). Its denial reads
// as a plain "Operation not permitted" on the interpreter, its prefix or a
// site-packages file, or as CPython dying before it can import `encodings`.
const INTERPRETER_PATH =
  /(?:\/bin\/(?:python|pypy)[\d.]*[a-z]?\/?$|\/site-packages\b|\/lib\/python\d|pyvenv\.cfg$|\/Python\d*\.framework\b|\/(?:\.?venv|virtualenvs?|\.pyenv|\.?conda|miniconda\d*|anaconda\d*|mambaforge)(?:\/|$))/;
const PYTHON_COMMAND = /(?:^|[\s/;&|(])(?:python[\d.]*|pypy[\d.]*|pytest|py\.test|tox|pip[\d.]*|poetry|uv|pipenv)(?:\s|$)/;
const INTERPRETER_STARTUP = /Fatal Python error:[^\n]*|No module named 'encodings'|Could not find platform independent libraries/;
// Some native Python extensions crash while their module initializer is
// running when Seatbelt denies an OS service.  That is neither a missing
// interpreter nor a repairable test failure.  Be deliberately strict: an
// ordinary SIGSEGV is not enough; faulthandler must also have printed a native
// frame and named the library being initialized.
const NATIVE_SEGFAULT = /(?:\bSIGSEGV\b|Fatal Python error:\s*Segmentation fault)/i;
const FAULTHANDLER_NATIVE_FRAME =
  /(?:^|\n)\s*(?:C\s+\[[^\n]*(?:\.dylib|\.so(?:\.\d+)?)|[^\n]*(?:\.dylib|\.so(?:\.\d+)?)[^\n]*\binitModule\b)/im;
const NATIVE_LIBRARY = /(?:^|[\s\[/(])((?:lib)?[A-Za-z0-9_.-]+\.(?:dylib|so(?:\.\d+)*))(?:[\s\]+):]|$)/im;

/** Also used when rendering a legacy job's stored generic permission denial. */
export function tsxIpcEnvironment(verify) {
  const result = verify?.result;
  if (verify?.verdict !== 'FAIL' || !result || result.timedOut || result.cancelled) return null;
  const text = `${result.stderr || ''}\n${result.stdout || ''}`.slice(-MAX_SCAN_CHARS);
  if (
    ASSERTION_FAILURE.test(text) ||
    !/\blisten\s+(?:EPERM|EACCES)\b[^\n]*\/offload-sandbox-[A-Za-z0-9]+\/tsx-\d+\/[^\s'"`]+\.pipe\b/i.test(text)
  )
    return null;
  return { kind: 'permission-denied', detail: `tsx CLI Unix-socket IPC was denied in TMPDIR; ${TSX_LOADER_FIX}` };
}

function nativeCrashModule(text) {
  const frame = text.match(FAULTHANDLER_NATIVE_FRAME)?.[0];
  const library = frame?.match(NATIVE_LIBRARY)?.[1];
  const torchLibrary = frame?.match(/\blibtorch_python\.(?:dylib|so(?:\.\d+)*)\b/i)?.[0];
  // PyTorch's extension is loaded as torch._C, but its initializer lives in
  // libtorch_python.  Name both the Python module and the native library so a
  // report is actionable without claiming every native crash is Torch.
  if (torchLibrary || /\btorch\._C\b/i.test(text)) return { module: 'torch', nativeModule: torchLibrary || library || 'libtorch_python' };
  return library ? { module: library.replace(/^lib/i, '').replace(/\.(?:dylib|so(?:\.\d+)?)$/i, ''), nativeModule: library } : null;
}

const clip = (value, max = MAX_DETAIL) =>
  redactText(stripTerminalControls(String(value)))
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, max);
// Actionable, and honest about the grant: read and exec of the declared roots,
// never a write. The action leads so a long path cannot truncate it away.
const interpreterDetail = (path) =>
  `an interpreter or virtualenv outside the worktree must be declared with verifierInterpreter (read and exec only) and called by absolute path; denied: ${path ? clip(path, 90) : 'interpreter startup'}`;

// Shell diagnostics put the target immediately before the denial reason,
// while Python/Node errors usually put it after. Prefer those positions over
// an earlier absolute shell/script name, and preserve spaces inside the path.
function permissionPath(line) {
  const reason = /permission denied|operation not permitted/i.exec(line);
  if (reason) {
    const after = line.slice(reason.index + reason[0].length);
    const following = diagnosticPath(after);
    if (following) return following;
    const before = line.slice(0, reason.index).replace(/:\s*$/, '').trim();
    const target = before.split(/:\s+/).at(-1);
    return diagnosticPath(target);
  }
  return diagnosticPath(line);
}

function diagnosticPath(text) {
  const quoted = text.match(/(['"\x60])((?:[A-Za-z]:[/\\]|\\\\|\/)[^\r\n]*?)\1/);
  const bare = quoted ? undefined : text.match(/(?:^|[\s:(])((?:[A-Za-z]:[/\\]|\\\\|\/)[^'"\x60\r\n,]+)/);
  const found = (quoted?.[2] ?? bare?.[1])?.trim();
  // Some shell diagnostics print escaped whitespace rather than quoting it.
  // Windows backslashes are separators and must retain their original bytes.
  return found && !/^(?:[A-Za-z]:[/\\]|\\\\)/.test(found) ? found.replace(/\\([ \t'"\x60\\()])/g, '$1') : found;
}

// A diagnostic can name either platform's absolute path, regardless of the
// host running the verifier. Do not turn a Windows drive or UNC prefix into a
// relative POSIX filename, or treat slash-prefixed POSIX paths as drive-local.
const pathApi = (path) => (/^(?:[A-Za-z]:[/\\]|\\\\)/.test(path) ? win32 : posix);

// Error text may spell the worktree through either its symlinked or canonical
// form (macOS temp roots are symlinks).
function workspaceRoots(workspacePath) {
  if (typeof workspacePath !== 'string' || !pathApi(workspacePath).isAbsolute(workspacePath)) return [];
  const roots = [pathApi(workspacePath).resolve(workspacePath)];
  try {
    roots.push(realpathSync(workspacePath));
  } catch {
    /* worktree already gone */
  }
  return [...new Set(roots)];
}

// The same file, spelled as printed and as the filesystem names it.
function spellings(path) {
  const { basename, dirname, join } = pathApi(path);
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

  const native =
    !ASSERTION_FAILURE.test(text) &&
    (result.code === 139 || result.signal === 'SIGSEGV') &&
    NATIVE_SEGFAULT.test(text) &&
    FAULTHANDLER_NATIVE_FRAME.test(text)
      ? nativeCrashModule(text)
      : null;
  if (native)
    return {
      kind: 'native-module-crash',
      module: native.module,
      nativeModule: native.nativeModule,
      detail: `native module '${native.module}' (${native.nativeModule}) crashed during interpreter initialization (SIGSEGV / exit 139)`,
    };

  // Output that also carries an ordinary assertion failure is a code failure
  // that merely mentions a module or path (an optional require inside a test, a
  // logged EACCES): the text signals below must not mask it. An exit-127 or
  // "could not determine executable" run has no tests to have failed.
  const assertionFailure = ASSERTION_FAILURE.test(text);
  // Wrappers (npm test) and older jobs can still reach this startup failure.
  const tsxEnvironment = tsxIpcEnvironment(verify);
  if (tsxEnvironment) return tsxEnvironment;
  if (!assertionFailure && GIT_SYSTEM_CONFIG_DENIED.test(text))
    return {
      kind: 'git-config-denied',
      detail: 'Git fixture setup could not read host system configuration in the verifier sandbox',
    };
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
  const roots = workspaceRoots(workspacePath);
  for (const line of assertionFailure ? [] : text.split(/\r?\n/)) {
    if (!PERMISSION.test(line) || TOOL_CACHE.test(line)) continue;
    const path = permissionPath(line);
    if (!path) continue;
    let ownedByWorker = false;
    let insideWorkspace = false;
    search: for (const candidate of spellings(path)) {
      for (const root of roots) {
        const paths = pathApi(root);
        if (pathApi(candidate) !== paths) continue;
        const rel = paths.relative(root, candidate);
        if (rel === '' || rel.startsWith('..') || paths.isAbsolute(rel)) continue;
        insideWorkspace = true;
        try {
          ownedByWorker = matchesAny(rel.split(paths.sep).join('/'), writeScope, { platform: paths === win32 ? 'win32' : 'linux' });
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
    if (!ownedByWorker && !insideWorkspace && SYSTEM_TEMP_PATH.test(path) && !OWN_TEMP.test(path))
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
