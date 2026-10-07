#!/usr/bin/env node
/** Cross-platform test discovery; cmd.exe does not expand *.test.mjs globs. */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOOPBACK_SKIP_MARKER = 'loopback networking is unavailable in this sandbox';
// Platform/capability skips are pinned by both test name and reason. This is
// deliberately data, rather than a broad reason regexp, so a new t.skip()
// fails strict CI until its portability rationale is reviewed here.
export const STRICT_SKIP_ALLOWLIST = Object.freeze(
  [
    [
      'detached worker remains alive across automatic repair and publishes the repaired result',
      'automatic repair requires an actual macOS verifier sandbox',
    ],
    ['macOS sandbox blocks out-of-scope and git writes', ''],
    ['macOS sandbox broad writable scope cannot overwrite protected secrets or future policy', ''],
    ['macOS sandbox cannot rewrite a linked-worktree .git pointer through broad writable scope', ''],
    ['macOS sandbox denies configured secret reads, symlink escapes, and exposes a disposable HOME', ''],
    [
      'macOS sandbox gives Node a physical disposable temp root and read-only private-worktree parent traversal',
      'requires an available macOS sandbox',
    ],
    ['macOS sandbox denies exact host configuration roots after toolchain allowances', 'requires an available macOS sandbox'],
    ['macOS sandbox lets a worktree command read linked dependencies but never write through them', 'requires an available macOS sandbox'],
    [
      'macOS profile protects linked-worktree Git metadata from broad temp and writable allowances',
      'macOS Seatbelt profile paths use POSIX semantics',
    ],
    ['macOS Seatbelt applies the complete generated profile when the host permits a basic profile', 'requires an available macOS sandbox'],
    [
      'macOS sandbox permits shell startup and stdout/stderr null redirection with data-only literals',
      'requires an available macOS sandbox',
    ],
    [
      'macOS verifier temp contract: only the per-run TMPDIR is writable and it is cleaned afterwards',
      'requires an available macOS sandbox',
    ],
    [
      'macOS verifier can run git in its temp directory because the tool environment fixes the xcode-select shim',
      'requires an available macOS sandbox',
    ],
    ['the real verifier temp probe finds the per-run TMPDIR writable and /tmp denied', 'requires an available macOS sandbox'],
    [
      'real sandbox: the command sees the applied diff, cannot write the primary, and can use its temp dir',
      'requires an available macOS sandbox',
    ],
    ['end to end with the real sandboxed runner: node:test output flows through the streaming parser', 'requires a Homebrew Node on macOS'],
    [
      'end to end with the real sandboxed runner: node:test output flows through the streaming parser',
      'requires an available macOS sandbox',
    ],
    ...[
      'MCP e2e: preflight health reports the capabilities, verifier temp probe, dirty working tree and an empty session list',
      'MCP e2e: a new server session lists only its own jobs, all:true reaches the old ones, and spend is cumulative',
      'MCP e2e: the turn cap is sized from file size, a line range reaches the worker as an offset, and the worker sees the dirty snapshot',
      'MCP e2e: a looping worker FAILS with its last failing call, the log is bounded by tail and limit, and offload_continue resumes it',
      'MCP e2e: a job that FAILED the finish protocol after correct work is applied through offload_apply (dry run first) and reverted by offload_revert',
      'MCP e2e: a stalled provider request raises one advisory, polls collapse to unchanged, and the terminal report splits the wall clock',
      'MCP e2e: a turn-cap BUDGET stop names the cap, keeps the work, and offload_continue raises only that cap',
      'MCP e2e: the retrospective names a failed finish protocol and the hand apply, leaves a clean job alone, stays redacted and bounded, and feeds the local history',
    ].map((name) => [name, 'the POSIX stdio end-to-end suite does not run on Windows']),
    ...[
      'MCP e2e: a suite with a hard-coded /tmp test ends VERIFY_ENV_FAILED, and baseline-diff verifies it against the real per-run TMPDIR',
      'MCP e2e: offload_apply with applyThenVerify reverts on a failing check and keeps the diff on a passing one',
      "MCP e2e: a worker's own run_command gets the per-run TMPDIR, so its test runs match the verifier, and still never /tmp",
    ].flatMap((name) => [
      [name, 'requires a Homebrew Node on macOS'],
      [name, 'requires an available macOS sandbox'],
    ]),
    // Declared Python interpreters/virtualenvs for the verifier sandbox (verifierInterpreter).
    ...[
      'a virtualenv with a copied interpreter resolves to the venv and the base installation pyvenv.cfg names',
      'a standalone interpreter resolves to its installation prefix',
      'only an interpreter or virtualenv can be declared',
      'credential, home and server-state areas can never be granted',
      'a declaration cannot reach into the job writable scope or its denied reads',
      'an allowlist confines what may be declared, judged by where the venv is, not by where its python points',
      'stored roots are re-checked and unsafe or vanished ones are dropped, never widened',
      'a job contributes interpreter paths only when it declared roots',
      'Python readiness: not-applicable, missing with an actionable reason, and never ok without a declaration',
      'probing a declaration runs python -c inside the sandbox and reports each outcome',
      'a declared interpreter is resolved at start, echoed, stored as server-derived roots, and reaches the verifier',
      'a refused declaration creates no job, and report jobs cannot declare one',
      'a Python project start echoes interpreter readiness instead of a JavaScript not-applicable',
      'health reports verifierPython for a Python project, mirrors it into verifierDeps, and probes a declared interpreter',
      'the declared roots reach both the job verifier and applyThenVerify, and nothing else',
    ].map((name) => [name, 'POSIX interpreter layouts are not applicable on Windows']),
    ...[
      'a symlinked venv interpreter pulls in the installation it points at',
      'a symlinked skill copy is unreadable, never trusted as current',
    ].map((name) => [name, 'Windows symlink creation requires Developer Mode or elevation']),
    ...[
      'requires an available macOS sandbox',
      'requires a python3 that can create a virtualenv',
      'POSIX interpreter layouts are not applicable on Windows',
    ].map((reason) => [
      'macOS sandbox lets a verifier read and run a declared virtualenv but never write it, and undeclared interpreters stay denied',
      reason,
    ]),
    ['macOS Homebrew Node runs a dependency-free npm test inside the sandbox', 'requires a Homebrew Node on macOS'],
    ['macOS Homebrew Node runs a dependency-free npm test inside the sandbox', 'requires an available macOS sandbox'],
    ['macOS sandbox denies protected files through case-folded and Unicode-normalized root aliases', 'requires an available macOS sandbox'],
    ['macOS sandbox denies exact host configuration roots after toolchain allowances', 'requires an available macOS sandbox'],
    ['no protected host configuration subtree exists on this host', 'no protected host configuration subtree exists on this host'],
    [
      'Windows PowerShell can construct a SID-scoped Global mutex with a current-user-only ACL',
      'requires Windows PowerShell and a Windows SID',
    ],
    [
      'explicit integrity state rejects symlinked and insecure parent directories',
      'POSIX ownership/mode checks are not applicable on Windows',
    ],
    [
      'timeout terminates a background descendant process group',
      'POSIX process-group semantics are tested separately from Windows taskkill tree termination',
    ],
    ['snapshot patch carries binary blobs, executable modes and symlinks when supported', ''],
    ['worktree materialization neither runs repository filters nor inherits provider credentials', ''],
    ['literal Git pathspecs preserve a POSIX backslash filename', 'backslash is a Windows separator, not a portable filename byte'],
    [
      'NUL name-status preserves literal unusual filenames without diff-header parsing',
      'Windows cannot create newline-containing filenames',
    ],
    ['secret files require owner-only permissions', 'file: key references intentionally fail closed on Windows ACL semantics'],
    [
      'POSIX secret files require current-user ownership before and after open',
      'file: key references intentionally fail closed on Windows ACL semantics',
    ],
    [
      'secret file metadata races fail closed before secret text is returned',
      'file: key references intentionally fail closed on Windows ACL semantics',
    ],
    [
      'secret file same-size in-place rewrites are caught by nanosecond mtime and ctime after reading',
      'file: key references intentionally fail closed on Windows ACL semantics',
    ],
    [
      'secret files reject oversized, binary, and control-containing values',
      'file: key references intentionally fail closed on Windows ACL semantics',
    ],
    ['POSIX integrity root is owner-private, non-symlinked, and malformed roots fail closed', 'POSIX root checks require POSIX metadata'],
    [
      'POSIX integrity root rejects a same-inode same-size rewrite detected only by nanosecond metadata',
      'POSIX root checks require POSIX metadata',
    ],
    ['a missing integrity root is never recreated over a corrupt orphan job entry', 'Windows stores integrity roots in Credential Locker'],
    [
      'path policy rejects broken symlink and lexical escapes before a write can follow them',
      'Windows symlink creation requires Developer Mode or elevation',
    ],
    [
      'path policy blocks symlink escapes and scope bypasses through internal symlinks',
      'Windows symlink creation requires Developer Mode or elevation',
    ],
    ['repository config cannot be a symlink to host policy', 'Windows symlink creation requires Developer Mode or elevation'],
    [
      'repository policy read rejects a deterministic regular-file to symlink swap',
      'Windows symlink creation requires Developer Mode or elevation',
    ],
    ['an explicitly selected user config may remain a symlink', 'Windows symlink creation requires Developer Mode or elevation'],
    [
      'lease storage refuses offload and locks symlinks before creating or reclaiming locks',
      'Windows symlink creation requires Developer Mode or elevation',
    ],
    ['lease reader rejects a deterministic final-component symlink swap', 'Windows symlink creation requires Developer Mode or elevation'],
    ['POSIX lease storage rejects a non-sticky writable git ancestry', 'POSIX ownership/mode checks are not applicable on Windows'],
    [
      'PathPolicy blocks canonical scope bypasses and hides nested sensitive paths',
      'Windows symlink creation requires Developer Mode or elevation',
    ],
    ['writes are same-directory atomic replacements that preserve existing mode', 'POSIX mode bits are not portable to Windows ACLs'],
    [
      'write_file never creates a directory through an intermediate symlink substituted after policy approval',
      'Windows symlink creation requires Developer Mode or elevation',
    ],
    ['job storage refuses symlinked managed directories and artifacts', 'Windows symlink creation requires Developer Mode or elevation'],
    [
      'transcript append refuses a final-component symlink swap and remove initializes a fresh store',
      'Windows symlink creation requires Developer Mode or elevation',
    ],
    [
      'POSIX store rejects a non-sticky writable git ancestry and hardens managed directories by descriptor',
      'POSIX ownership/mode checks are not applicable on Windows',
    ],
    [
      'POSIX store rejects managed directories owned by another user before chmod/write',
      'POSIX ownership/mode checks are not applicable on Windows',
    ],
    [
      'checked store reads reject a deterministic final-component symlink swap',
      'Windows symlink creation requires Developer Mode or elevation',
    ],
    [
      'secret references reject relative paths and symlinks without leaking values',
      'Windows symlink creation requires Developer Mode or elevation',
    ],
    [
      'installer refuses a symlinked package artifact before altering a client',
      'Windows symlink creation requires Developer Mode or elevation',
    ],
    [
      'installer refuses a symlinked client config without reading, backing up, or replacing its target',
      'Windows symlink creation requires Developer Mode or elevation',
    ],
  ].map(([name, reason]) => Object.freeze({ name, reason })),
);

/** Parse TAP test-point skips; diagnostics and prose cannot match this grammar. */
export function parseTapSkips(tap) {
  if (typeof tap !== 'string') throw new TypeError('TAP output must be a string');
  const skips = [];
  for (const line of tap.split(/\r?\n/)) {
    // Node indents nested subtests, hence leading horizontal whitespace.
    const match = /^[ \t]*ok\s+(\d+)\s+-\s+(.+?)\s+#\s*SKIP(?:\s+(.*?))?[ \t]*$/i.exec(line);
    if (match) skips.push({ number: Number(match[1]), name: match[2], reason: match[3] || '' });
  }
  return skips;
}

export function analyzeStrictSkips(tap) {
  const skips = parseTapSkips(tap);
  const loopbackSkips = skips.filter((skip) => skip.reason === LOOPBACK_SKIP_MARKER);
  const allowed = (skip) => STRICT_SKIP_ALLOWLIST.some((entry) => entry.name === skip.name && entry.reason === skip.reason);
  return { skips, loopbackSkips, unapprovedSkips: skips.filter((skip) => skip.reason !== LOOPBACK_SKIP_MARKER && !allowed(skip)) };
}

export async function discoverTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) =>
        entry.isDirectory()
          ? discoverTests(resolve(directory, entry.name))
          : entry.isFile() && entry.name.endsWith('.test.mjs')
            ? [resolve(directory, entry.name)]
            : [],
      ),
    )
  ).flat();
}

export async function runSuite({
  suite = process.argv[2],
  strictLoopback = process.env.OFFLOAD_REQUIRE_LOOPBACK === '1',
  summaryFile = process.env.OFFLOAD_TEST_SUMMARY_FILE,
} = {}) {
  if (!['unit', 'integration', 'all'].includes(suite)) throw new Error('usage: node test/run-suite.mjs <unit|integration|all>');
  const roots = suite === 'all' ? ['unit', 'integration'] : [suite];
  const files = (await Promise.all(roots.map((root) => discoverTests(resolve('test', root))))).flat().sort();
  if (!files.length) throw new Error(`no ${suite} tests found`);
  // Worktree integration tests invoke real Git processes and secure durable
  // storage. A small fan-out avoids test-runner oversubscription turning
  // lifecycle timing into a host-load-dependent result.
  const args = ['--test', '--test-concurrency=4'];
  if (strictLoopback) args.push('--test-reporter=tap');
  args.push(...files);
  const child = spawn(process.execPath, args, { stdio: strictLoopback ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true });
  let tapOutput = '';
  if (strictLoopback) {
    child.stdout.on('data', (chunk) => {
      tapOutput += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  }
  const childExitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (value) => resolveExit(value ?? 1));
  });
  const strict = strictLoopback ? analyzeStrictSkips(tapOutput) : { skips: [], loopbackSkips: [], unapprovedSkips: [] };
  const exitCode = childExitCode || (strictLoopback && (strict.loopbackSkips.length || strict.unapprovedSkips.length) ? 1 : 0);
  if (summaryFile) {
    await mkdir(dirname(resolve(summaryFile)), { recursive: true });
    await writeFile(
      resolve(summaryFile),
      `${JSON.stringify({ suite, strictLoopback, skips: strict.skips, loopbackSkips: strict.loopbackSkips.length, unapprovedSkips: strict.unapprovedSkips, childExitCode, exitCode })}\n`,
      { mode: 0o600 },
    );
  }
  if (strictLoopback && strict.loopbackSkips.length)
    process.stderr.write(`offload: ${strict.loopbackSkips.length} loopback-backed test(s) skipped while OFFLOAD_REQUIRE_LOOPBACK=1\n`);
  if (strictLoopback && strict.unapprovedSkips.length)
    process.stderr.write(
      `offload: unapproved TAP skip(s): ${strict.unapprovedSkips.map((skip) => JSON.stringify(`${skip.name}: ${skip.reason || '(no reason)'}`)).join(', ')}\n`,
    );
  return { exitCode, ...strict, childExitCode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runSuite();
  process.exitCode = result.exitCode;
}
