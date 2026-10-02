#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { posix, resolve, win32 } from 'node:path';
import { acquireArtifactLease } from './artifact-lease.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// These are generated, ignored directories. The shared lease prevents a
// standalone reporter from publishing while release cleanup removes outputs.
export async function cleanArtifacts({
  cwd = root,
  environment = process.env,
  platform = process.platform,
  acquireLease = acquireArtifactLease,
  remove = rm,
} = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  const lease = await acquireLease({ cwd, environment, platform });
  try {
    await Promise.all(['artifacts', 'coverage'].map((name) => remove(paths.join(cwd, name), { recursive: true, force: true })));
  } finally {
    await lease.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cleanArtifacts();
