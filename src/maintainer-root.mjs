/**
 * Which Offload checkout a maintainer prompt should name. The server runs from its package root, which after
 * the documented update (`npm pack` + `npm install -g <tgz>`) is a packed copy with no `.git` and no tests:
 * naming it would send the maintainer to a path that cannot be changed or tested. The installer therefore
 * records the source checkout it was run from in SOURCE_RECORD inside the installed package, and the server
 * resolves the root at retrospective time, naming nothing when no git checkout qualifies.
 */
import * as nodeFs from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const SOURCE_RECORD = '.offload-source.json';
const MAX_RECORD_BYTES = 4096;
const MAX_ROOT_CHARS = 400;

const plainRoot = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ROOT_CHARS && isAbsolute(value) && !/[\0-\x1f\x7f]/.test(value);

/** True when `dir` is an Offload source checkout: absolute, a git work tree root, with install.mjs and package.json name "offload". */
export function isOffloadSourceCheckout(dir, { fs = nodeFs } = {}) {
  if (!plainRoot(dir)) return false;
  try {
    if (!fs.existsSync(join(dir, '.git'))) return false;
    if (!fs.statSync(join(dir, 'install.mjs')).isFile()) return false;
    const pkg = join(dir, 'package.json');
    if (fs.statSync(pkg).size > 1_048_576) return false;
    return JSON.parse(fs.readFileSync(pkg, 'utf8'))?.name === 'offload';
  } catch {
    return false;
  }
}

/** The recorded source checkout of an installed package, or undefined when absent, malformed or oversized. */
export function readSourceRecord(packageRoot, { fs = nodeFs } = {}) {
  if (!plainRoot(packageRoot)) return undefined;
  try {
    const path = join(packageRoot, SOURCE_RECORD);
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return undefined;
    const value = JSON.parse(fs.readFileSync(path, 'utf8'))?.sourceRoot;
    return plainRoot(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The checkout to name: an explicit `config.maintainerRoot`; else the package root when it is itself a git
 * checkout; else the recorded source when it still is one; else undefined (the prompt then names none).
 */
export function resolveMaintainerRoot({ configured, packageRoot, fs = nodeFs } = {}) {
  if (plainRoot(configured)) return configured;
  if (plainRoot(packageRoot) && fs.existsSync(join(packageRoot, '.git'))) return packageRoot;
  const recorded = readSourceRecord(packageRoot, { fs });
  return recorded && isOffloadSourceCheckout(recorded, { fs }) ? recorded : undefined;
}

/**
 * Installer side: record where this packed install came from. An explicit `sourceRoot` must qualify (it
 * throws otherwise); without one, `cwd` is used only when it qualifies. Nothing is written when the package
 * root is itself a git checkout (the server names it directly) or when no candidate qualifies.
 * Returns `{ sourceRoot, path }` when recorded, otherwise `{ skipped: reason }`.
 */
export function recordSourceRoot({ packageRoot, sourceRoot, cwd, now = () => new Date(), fs = nodeFs } = {}) {
  if (!plainRoot(packageRoot)) return { skipped: 'package-root-invalid' };
  if (fs.existsSync(join(packageRoot, '.git'))) return { skipped: 'package-root-is-checkout' };
  let candidate;
  if (sourceRoot !== undefined) {
    candidate = plainRoot(sourceRoot) ? resolve(sourceRoot) : undefined;
    if (!candidate || !isOffloadSourceCheckout(candidate, { fs }))
      throw new Error('--source-root must be an absolute path to an Offload git checkout (.git, install.mjs, package.json name "offload")');
  } else {
    const fromCwd = plainRoot(cwd) ? resolve(cwd) : undefined;
    if (!fromCwd || !isOffloadSourceCheckout(fromCwd, { fs })) return { skipped: 'no-source-checkout' };
    candidate = fromCwd;
  }
  if (resolve(candidate) === resolve(packageRoot)) return { skipped: 'package-root-is-checkout' };
  const path = join(packageRoot, SOURCE_RECORD);
  // Replace, never write through: a pre-existing symlink at the record path must not redirect the write.
  fs.rmSync(path, { force: true });
  fs.writeFileSync(path, `${JSON.stringify({ sourceRoot: candidate, recordedAt: now().toISOString() }, null, 2)}\n`, {
    mode: 0o644,
    flag: 'wx',
  });
  return { sourceRoot: candidate, path };
}
