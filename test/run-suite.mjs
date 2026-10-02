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
    ['macOS sandbox denies readable host configuration subtrees after toolchain allowances', ''],
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
  const args = ['--test'];
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
