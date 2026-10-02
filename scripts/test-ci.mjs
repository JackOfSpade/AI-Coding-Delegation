#!/usr/bin/env node
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireArtifactLease, publishArtifactFile } from './artifact-lease.mjs';

export async function runCiTests({
  cwd = process.cwd(),
  environment = process.env,
  platform = process.platform,
  makeDirectory = mkdir,
  createTemporaryDirectory = mkdtemp,
  checkAccess = access,
  remove = rm,
  acquireLease = acquireArtifactLease,
  publishFile = publishArtifactFile,
  spawnProcess = spawn,
} = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  const explicitSummary = typeof environment.OFFLOAD_TEST_SUMMARY_FILE === 'string' && environment.OFFLOAD_TEST_SUMMARY_FILE.length > 0;
  const temporaryDirectory = explicitSummary ? undefined : await createTemporaryDirectory(paths.join(tmpdir(), 'offload-test-summary-'));
  const summaryFile = paths.resolve(
    explicitSummary ? environment.OFFLOAD_TEST_SUMMARY_FILE : paths.join(temporaryDirectory, 'test-summary.json'),
  );
  await makeDirectory(paths.dirname(summaryFile), { recursive: true });
  const child = spawnProcess(process.execPath, ['test/run-suite.mjs', 'all'], {
    cwd,
    env: {
      ...environment,
      OFFLOAD_REQUIRE_LOOPBACK: '1',
      OFFLOAD_TEST_SUMMARY_FILE: summaryFile,
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  let exitCode;
  try {
    exitCode = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (value) => resolveExit(value ?? 1));
    });
    if (explicitSummary) return exitCode;
    await checkAccess(summaryFile);
    const lease = await acquireLease({ cwd, environment, platform });
    try {
      await publishFile({ source: summaryFile, destination: paths.join(cwd, 'artifacts', 'test-summary.json'), platform });
    } finally {
      await lease.release();
    }
  } catch (error) {
    // A strict test failure still gets its diagnostic summary when available;
    // a publication failure must not replace that useful test exit status.
    if (exitCode === undefined || exitCode === 0) throw error;
  } finally {
    if (!explicitSummary) await remove(temporaryDirectory, { recursive: true, force: true });
  }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCiTests();
