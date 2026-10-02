#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { acquireArtifactLease } from './artifact-lease.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// These are generated, ignored directories. The shared lease prevents a
// standalone reporter from publishing while release cleanup removes outputs.
export async function cleanArtifacts({ cwd = root, environment = process.env, acquireLease = acquireArtifactLease, remove = rm } = {}) {
  const lease = await acquireLease({ cwd, environment });
  try {
    await Promise.all(['artifacts', 'coverage'].map((name) => remove(join(cwd, name), { recursive: true, force: true })));
  } finally {
    await lease.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cleanArtifacts();
