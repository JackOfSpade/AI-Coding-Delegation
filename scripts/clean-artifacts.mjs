#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
// These are generated, ignored directories. Keeping cleanup here (rather than
// a shell command) makes the CI preflight portable and limits deletion to the
// exact project-local paths that artifact upload later reads.
await Promise.all(['artifacts', 'coverage'].map((name) => rm(join(root, name), { recursive: true, force: true })));
