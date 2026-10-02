#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runCiTests({
  summaryFile = resolve(process.env.OFFLOAD_TEST_SUMMARY_FILE || 'artifacts/test-summary.json'),
  cwd = process.cwd(),
  environment = process.env,
  makeDirectory = mkdir,
  spawnProcess = spawn,
} = {}) {
  await makeDirectory(dirname(summaryFile), { recursive: true });
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
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (value) => resolveExit(value ?? 1));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCiTests();
