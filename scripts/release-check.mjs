#!/usr/bin/env node
/** Hold generated artifacts stable across every release-gate phase. */
import { spawn } from 'node:child_process';
import { posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_LEASE_ENV, acquireArtifactLease } from './artifact-lease.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const phases = Object.freeze(['artifacts:clean', 'static', 'lint', 'format:check', 'test:ci', 'coverage', 'package:check']);

function processExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

export function npmInvocation({ phase, environment = process.env, platform = process.platform, node = process.execPath } = {}) {
  if (!phases.includes(phase)) throw new TypeError('release phase is invalid');
  const paths = platform === 'win32' ? win32 : posix;
  const npmCli = environment.npm_execpath;
  if (typeof npmCli === 'string' && npmCli.endsWith('npm-cli.js')) return { command: node, args: [npmCli, 'run', phase] };
  if (platform !== 'win32') return { command: 'npm', args: ['run', phase] };
  return { command: node, args: [paths.join(paths.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'run', phase] };
}

export async function runReleaseCheck({
  cwd = root,
  environment = process.env,
  platform = process.platform,
  node = process.execPath,
  acquireLease = acquireArtifactLease,
  spawnProcess = spawn,
} = {}) {
  // A stale inherited marker must never let an independently launched release
  // skip acquisition. Only the coverage child receives the marker we create.
  const lease = await acquireLease({ cwd, environment, platform, allowInherited: false });
  try {
    const childEnvironment = { ...environment, [ARTIFACT_LEASE_ENV]: lease.markerValue };
    for (const phase of phases) {
      const invocation = npmInvocation({ phase, environment: childEnvironment, platform, node });
      const child = spawnProcess(invocation.command, invocation.args, {
        cwd,
        env: childEnvironment,
        stdio: 'inherit',
        windowsHide: true,
      });
      const exitCode = await processExit(child);
      if (exitCode !== 0) return exitCode;
    }
    return 0;
  } finally {
    lease.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runReleaseCheck();
