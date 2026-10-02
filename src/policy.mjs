import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { matchesAny, normalizePath } from './glob.mjs';

export const DEFAULT_DENY_READ = Object.freeze([
  '.env*',
  '**/.env*',
  '*.pem',
  '**/*.pem',
  '*.key',
  '**/*.key',
  'id_rsa*',
  '**/id_rsa*',
  'id_ecdsa*',
  '**/id_ecdsa*',
  'id_ed25519*',
  '**/id_ed25519*',
  'id_dsa*',
  '**/id_dsa*',
  'id_xmss*',
  '**/id_xmss*',
  '.npmrc',
  '**/.npmrc',
  '.netrc',
  '**/.netrc',
  '.pypirc',
  '**/.pypirc',
  '.git-credentials',
  '**/.git-credentials',
  // Database clients and deployment tools conventionally put long-lived
  // credentials in these exact filenames or key-store containers.  Keep the
  // matches narrow: names such as `credential.ts` remain ordinary source.
  '.pgpass',
  '**/.pgpass',
  '.credentials',
  '.credentials/**',
  '**/.credentials',
  '**/.credentials/**',
  'credentials',
  'credentials/**',
  '**/credentials',
  '**/credentials/**',
  'credential.json',
  '**/credential.json',
  'credentials.json',
  '**/credentials.json',
  'credentials.yaml',
  '**/credentials.yaml',
  'credentials.yml',
  '**/credentials.yml',
  '*.p12',
  '**/*.p12',
  '*.pfx',
  '**/*.pfx',
  '*.jks',
  '**/*.jks',
  '*.keystore',
  '**/*.keystore',
  '*.tfstate',
  '**/*.tfstate',
  '*.tfstate.backup',
  '**/*.tfstate.backup',
  '.aws',
  '.aws/**',
  '**/.aws',
  '**/.aws/**',
  '.ssh',
  '.ssh/**',
  '**/.ssh',
  '**/.ssh/**',
  '.azure',
  '.azure/**',
  '**/.azure',
  '**/.azure/**',
  '.kube',
  '.kube/**',
  '**/.kube',
  '**/.kube/**',
  '.config/gcloud',
  '.config/gcloud/**',
  '**/.config/gcloud',
  '**/.config/gcloud/**',
  '.docker/config.json',
  '**/.docker/config.json',
  '.git',
  '.git/**',
  '**/.git',
  '**/.git/**',
]);
// Repository-local Offload policy is read at the next job boundary. It is
// intentionally not a writable worker artifact: otherwise a broad `**`
// delegation could plant future execution policy for a later user-approved
// job. Reading it remains allowed so the worker can understand project setup.
// Exported so the command sandbox can enforce the same non-negotiable write
// boundary as file tools when an owned glob is broad (for example `**`).
export const DEFAULT_DENY_WRITE = Object.freeze([...DEFAULT_DENY_READ, '.offload.json', '**/.offload.json']);

export class PolicyError extends Error {
  constructor(message, code = 'E_PATH_POLICY') {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

/**
 * Resolve worker paths without allowing lexical traversal or symlink escapes.
 * All public methods return an absolute, canonical-enough filesystem path.
 */
export class PathPolicy {
  constructor({ repoPath, ownedPaths, extraWritable = [], denyRead = [], platform = process.platform } = {}) {
    if (!repoPath) throw new PolicyError('repoPath is required', 'E_PATH_REPO');
    this.platform = platform;
    this.repoPath = realpathSync(resolve(repoPath));
    this.ownedPaths = validatePatterns(ownedPaths, 'ownedPaths', platform);
    this.extraWritable = validatePatterns(extraWritable, 'extraWritable', platform);
    this.denyRead = [...DEFAULT_DENY_READ, ...validatePatterns(denyRead, 'denyRead', platform)];
    // Scope is an allowance, never permission to mutate Git metadata or likely secrets.
    this.denyWrite = [...DEFAULT_DENY_WRITE];
  }

  /** Resolve an input path and verify it remains inside the repository after symlinks. */
  resolve(path) {
    return this.#resolve(path);
  }
  assertReadable(path) {
    const target = this.#resolve(path);
    const rel = repoRelative(this.repoPath, target, this.platform);
    const logical = logicalRelative(this.repoPath, path, this.platform);
    if (matchesDeny(logical, this.denyRead, this.platform) || matchesDeny(rel, this.denyRead, this.platform))
      throw new PolicyError('Reading this path is denied', 'E_READ_DENIED');
    return target;
  }
  assertWritable(path) {
    const target = this.#resolve(path);
    const rel = repoRelative(this.repoPath, target, this.platform);
    const logical = logicalRelative(this.repoPath, path, this.platform);
    if (matchesDeny(logical, this.denyWrite, this.platform) || matchesDeny(rel, this.denyWrite, this.platform))
      throw new PolicyError('Writing protected Git metadata or secret paths is denied', 'E_WRITE_DENIED');
    if (
      !matchesAny(logical, [...this.ownedPaths, ...this.extraWritable], this) ||
      !matchesAny(rel, [...this.ownedPaths, ...this.extraWritable], this)
    ) {
      throw new PolicyError('Writing outside owned paths is denied', 'E_WRITE_SCOPE');
    }
    return target;
  }
  isOwned(path) {
    try {
      const target = this.#resolve(path);
      return (
        matchesAny(logicalRelative(this.repoPath, path, this.platform), this.ownedPaths, this) &&
        matchesAny(repoRelative(this.repoPath, target, this.platform), this.ownedPaths, this)
      );
    } catch {
      return false;
    }
  }
  #resolve(path) {
    const lexical = logicalRelative(this.repoPath, path, this.platform);
    const absolute = resolve(this.repoPath, lexical);
    const canonical = canonicalTarget(absolute);
    if (!isInside(this.repoPath, canonical, this.platform)) throw new PolicyError('Path resolves outside repository', 'E_PATH_ESCAPE');
    return canonical;
  }
}

function validatePatterns(value, name, platform) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new PolicyError(`${name} must be an array of relative globs`, 'E_PATH_PATTERNS');
  try {
    return value.map((item) => normalizePath(item, { platform }));
  } catch {
    throw new PolicyError(`${name} contains an invalid path pattern`, 'E_PATH_PATTERNS');
  }
}
function matchesDeny(path, patterns, platform) {
  return matchesAny(path, patterns, { platform, caseInsensitive: true });
}
function logicalRelative(repo, path, platform) {
  if (typeof path !== 'string' || path.includes('\0')) throw new PolicyError('Invalid path', 'E_PATH_INVALID');
  if (!isAbsolute(path) && path.replaceAll('\\', '/').split('/').includes('..'))
    throw new PolicyError('Lexical path traversal is denied', 'E_PATH_ESCAPE');
  const target = isAbsolute(path) ? resolve(path) : resolve(repo, path);
  if (!isInside(repo, target, platform)) throw new PolicyError('Path is outside repository', 'E_PATH_ESCAPE');
  const rel = relative(repo, target);
  if (!rel || rel === '.') throw new PolicyError('Repository root is not a file path', 'E_PATH_INVALID');
  try {
    return normalizePath(rel, { platform });
  } catch {
    throw new PolicyError('Invalid path', 'E_PATH_INVALID');
  }
}
function canonicalTarget(absolute) {
  return followSymlinks(absolute, new Set());
}
function followSymlinks(absolute, seen) {
  const parsed = resolve(absolute);
  // `sep` alone is not a filesystem root on Windows: starting at it turns
  // C:\\repo into the current drive's root.  Keep the parsed drive/UNC root and
  // walk only the remaining segments on every platform.
  const root = parse(parsed).root;
  const parts = parsed.slice(root.length).split(sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    const candidate = resolve(cursor, parts[index]);
    let details;
    try {
      details = lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') return resolve(cursor, ...parts.slice(index));
      throw new PolicyError('Path cannot be inspected', 'E_PATH_INVALID');
    }
    if (details.isSymbolicLink()) {
      if (seen.has(candidate)) throw new PolicyError('Symlink loop is denied', 'E_PATH_ESCAPE');
      seen.add(candidate);
      let link;
      try {
        link = readlinkSync(candidate);
      } catch {
        throw new PolicyError('Symlink cannot be inspected', 'E_PATH_INVALID');
      }
      return followSymlinks(resolve(dirname(candidate), link, ...parts.slice(index + 1)), seen);
    }
    cursor = candidate;
  }
  try {
    return realpathSync(cursor);
  } catch {
    return cursor;
  }
}
function repoRelative(repo, target, platform) {
  return normalizePath(relative(repo, target), { platform });
}
function isInside(root, target, platform = process.platform) {
  if (platform === 'win32') {
    root = root.toLowerCase();
    target = target.toLowerCase();
  }
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
