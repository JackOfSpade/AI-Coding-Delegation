#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { doctor } from '../src/doctor.mjs';

const requested = process.argv.find((arg) => arg.startsWith('--clients='))?.slice('--clients='.length) || process.env.OFFLOAD_CLIENTS || '';
if (!requested || !/^(?:claude|codex|cursor)(?:,(?:claude|codex|cursor))*$/.test(requested)) {
  throw new Error('usage: node scripts/client-smoke.mjs --clients=claude,codex,cursor');
}
const clients = requested.split(',');
if (new Set(clients).size !== clients.length) throw new Error('requested clients must be unique');
const commands = { claude: 'claude', codex: 'codex', cursor: 'cursor' };
const root = fileURLToPath(new URL('..', import.meta.url));

const home = await mkdtemp(join(tmpdir(), 'offload-client-smoke-'));
const cleanEnv = {
  PATH: process.env.PATH || process.env.Path || '',
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  CODEX_HOME: join(home, '.codex'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
};
for (const name of ['ComSpec', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[name]) cleanEnv[name] = process.env[name];
// A client --version probe is quick. The installer runs several client
// commands of its own, each allowed 10 s, and on Windows each one starts
// cmd.exe and Node, so its whole run needs more than any single step.
const PROBE_TIMEOUT_MS = 10_000;
const INSTALLER_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024;
function run(command, args, label, timeout = PROBE_TIMEOUT_MS) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: cleanEnv,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout,
    // Only the fixed client --version probes need Windows batch lookup.
    // Invoke Node directly so spaces in its path never enter cmd.exe parsing.
    shell: process.platform === 'win32' && command !== process.execPath,
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') throw new Error(`${label} is unavailable on this self-hosted runner`);
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`${label} timed out after ${timeout}ms`);
  if (result.error?.code === 'ENOBUFS') throw new Error(`${label} produced more than ${MAX_BUFFER} bytes of output`);
  if (result.error) throw new Error(`${label} could not start: ${result.error.code || result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status ?? 'unknown'}`);
  return result;
}
function assertRegistrations(expected, installerResult) {
  const registration = doctor({ root, home, repoPath: root, env: cleanEnv }).registration;
  const mismatched = clients.filter((client) => registration[client] !== expected);
  if (mismatched.length) {
    let claudeStatus = 'unknown';
    try {
      const status = JSON.parse(installerResult.stdout).claudeMcp?.status;
      if (typeof status === 'string' && /^[a-z-]{1,32}$/.test(status)) claudeStatus = status;
    } catch {}
    throw new Error(`client registration state is invalid for ${mismatched.join(', ')} (Claude installer status: ${claudeStatus})`);
  }
}
try {
  for (const client of clients) run(commands[client], ['--version'], `${client} --version`);
  const installed = run(
    process.execPath,
    ['install.mjs', '--skip-key', `--clients=${requested}`],
    'disposable-home install',
    INSTALLER_TIMEOUT_MS,
  );
  assertRegistrations(true, installed);
  const uninstalled = run(
    process.execPath,
    ['install.mjs', '--uninstall', `--clients=${requested}`],
    'disposable-home uninstall',
    INSTALLER_TIMEOUT_MS,
  );
  assertRegistrations(false, uninstalled);
  process.stdout.write(`client smoke passed install, registration, and uninstall for ${clients.join(', ')} using a disposable home\n`);
} finally {
  await rm(home, { recursive: true, force: true });
}
