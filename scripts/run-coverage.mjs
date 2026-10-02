#!/usr/bin/env node
/** Run c8 in a private directory so concurrent release gates cannot mix V8 data. */
import { access, copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const c8Program = fileURLToPath(new URL('../node_modules/c8/bin/c8.js', import.meta.url));

export function coverageInvocation({
  c8 = c8Program,
  cwd = root,
  temporaryDirectory,
  platform = process.platform,
  node = process.execPath,
} = {}) {
  if (typeof temporaryDirectory !== 'string' || !temporaryDirectory) throw new TypeError('temporaryDirectory is required');
  const paths = platform === 'win32' ? win32 : posix;
  return {
    command: node,
    args: [
      c8,
      '--all',
      '--include=src/**/*.mjs',
      '--reporter=text',
      '--reporter=json-summary',
      `--reports-dir=${paths.join(temporaryDirectory, 'reports')}`,
      `--temp-directory=${paths.join(temporaryDirectory, 'v8')}`,
      '--check-coverage',
      '--lines=90',
      '--functions=90',
      '--branches=72',
      node,
      paths.join(cwd, 'scripts', 'test-ci.mjs'),
    ],
  };
}

function processExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

async function publishFile(source, destination, { makeDirectory, copy, move, remove, unique, paths, pid }) {
  await makeDirectory(paths.dirname(destination), { recursive: true });
  const staged = paths.join(paths.dirname(destination), `.${paths.basename(destination)}.${pid}.${unique()}.tmp`);
  try {
    await copy(source, staged);
    // A same-directory rename replaces the whole report atomically. Concurrent
    // callers may publish in either order, but never leave a partial JSON file.
    await move(staged, destination);
  } finally {
    await remove(staged, { force: true });
  }
}

/**
 * Preserve the public CI artifact paths, but do not expose a run's generated
 * data until c8 has completed and its threshold checks have passed.
 */
export async function runCoverage({
  cwd = root,
  environment = process.env,
  platform = process.platform,
  node = process.execPath,
  c8 = c8Program,
  temporaryRoot = tmpdir(),
  createTemporaryDirectory = mkdtemp,
  spawnProcess = spawn,
  makeDirectory = mkdir,
  checkAccess = access,
  copy = copyFile,
  move = rename,
  remove = rm,
  unique = randomUUID,
  pid = process.pid,
} = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  const temporaryDirectory = await createTemporaryDirectory(paths.join(temporaryRoot, 'offload-coverage-'));
  const reportsDirectory = paths.join(temporaryDirectory, 'reports');
  const testSummary = paths.join(temporaryDirectory, 'test-summary.json');
  try {
    const invocation = coverageInvocation({ c8, cwd, temporaryDirectory, platform, node });
    const child = spawnProcess(invocation.command, invocation.args, {
      cwd,
      env: { ...environment, OFFLOAD_TEST_SUMMARY_FILE: testSummary },
      stdio: 'inherit',
      windowsHide: true,
    });
    const exitCode = await processExit(child);
    if (exitCode !== 0) return exitCode;

    const coverageSummary = paths.join(reportsDirectory, 'coverage-summary.json');
    // Check both generated inputs before replacing either public artifact.
    await Promise.all([checkAccess(coverageSummary), checkAccess(testSummary)]);
    await publishFile(coverageSummary, paths.join(cwd, 'coverage', 'coverage-summary.json'), {
      makeDirectory,
      copy,
      move,
      remove,
      unique,
      paths,
      pid,
    });
    await publishFile(testSummary, paths.join(cwd, 'artifacts', 'test-summary.json'), {
      makeDirectory,
      copy,
      move,
      remove,
      unique,
      paths,
      pid,
    });
    return 0;
  } finally {
    await remove(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCoverage();
