#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const summaryFile = resolve(process.env.OFFLOAD_TEST_SUMMARY_FILE || 'artifacts/test-summary.json');
await mkdir(dirname(summaryFile), { recursive: true });
const child = spawn(process.execPath, ['test/run-suite.mjs', 'all'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    OFFLOAD_REQUIRE_LOOPBACK: '1',
    OFFLOAD_TEST_SUMMARY_FILE: summaryFile,
  },
  stdio: 'inherit',
  windowsHide: true,
});
const code = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (value) => resolveExit(value ?? 1));
});
process.exitCode = code;
