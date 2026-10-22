#!/usr/bin/env node
/** Rewrite the plugin manifests' `+codex.<hash>` content version after a plugin artifact changes. */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginContentVersionSuffix, pluginFiles } from '../install.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const MANIFESTS = Object.freeze(['plugin.json', '.codex-plugin/plugin.json']);
const VERSION = /("version"\s*:\s*"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\+codex\.[0-9a-f]{16}"/;

// `check` reports stale manifests without writing; only the hash suffix is
// rewritten, so the semantic version stays a deliberate, manual bump.
export async function syncPluginVersion({ cwd = root, check = false } = {}) {
  const directory = join(cwd, 'plugins', 'offload');
  const artifacts = Object.fromEntries(
    await Promise.all(pluginFiles.map(async (path) => [path, await readFile(join(directory, path), 'utf8')])),
  );
  const suffix = pluginContentVersionSuffix(artifacts);
  const stale = [];
  for (const path of MANIFESTS) {
    const content = artifacts[path];
    if (!VERSION.test(content)) throw new Error(`${path} lacks a <semver>+codex.<hash> version`);
    const next = content.replace(VERSION, `$1${suffix}"`);
    if (next === content) continue;
    stale.push(path);
    if (!check) await writeFile(join(directory, path), next);
  }
  return { suffix, stale };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const { suffix, stale } = await syncPluginVersion({ check });
  if (!stale.length) console.log(`plugin version is current (${suffix})`);
  else if (check) {
    console.error(`stale plugin version in ${stale.join(', ')}; run npm run plugin:version`);
    process.exitCode = 1;
  } else console.log(`updated ${stale.join(', ')} to ${suffix}`);
}
