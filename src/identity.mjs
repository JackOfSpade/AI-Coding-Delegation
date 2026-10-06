/** Stable, non-secret runtime identity for health and MCP discovery. */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegularFileSync } from './regular-file.mjs';

export const IDENTITY_SCHEMA_REVISION = 1;
export const RUNTIME_CAPABILITIES = Object.freeze({ reportMode: true, inputFiles: true });

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(moduleDirectory);
const MAX_RUNTIME_FILE_BYTES = 1_048_576;
const MAX_RUNTIME_TOTAL_BYTES = 16 * 1_048_576;
const MAX_RUNTIME_FILES = 512;
const hash = (parts) => {
  const digest = createHash('sha256');
  for (const [name, bytes] of parts) {
    digest.update(name);
    digest.update('\0');
    digest.update(bytes);
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
};
const sameDirectory = (left, right) => left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs;
const checkedDirectory = (path) => {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`offload runtime directory is unsafe: ${path}`);
  return { path, stat };
};
const checkDirectories = (directories) => {
  for (const directory of directories) {
    const current = checkedDirectory(directory.path).stat;
    if (!sameDirectory(directory.stat, current)) throw new Error(`offload runtime directory changed: ${directory.path}`);
  }
};
const canonicalUtf8 = (bytes, label) => {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`offload ${label} is not UTF-8`);
  }
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`offload ${label} is not canonical UTF-8`);
  return text;
};
const boundedRead = (path, label, directories, total) => {
  checkDirectories(directories);
  const bytes = readRegularFileSync(path, MAX_RUNTIME_FILE_BYTES);
  total.value += bytes.length;
  if (total.value > MAX_RUNTIME_TOTAL_BYTES) throw new Error('offload runtime artifacts exceed their total size limit');
  checkDirectories(directories);
  return bytes;
};
const packageMetadata = (root, directories, total) => {
  const bytes = boundedRead(join(root, 'package.json'), 'package.json', directories, total);
  let parsed;
  try {
    parsed = JSON.parse(canonicalUtf8(bytes, 'package.json'));
  } catch {
    throw new Error('offload package.json is invalid');
  }
  if (typeof parsed.version !== 'string' || !parsed.version) throw new Error('offload package.json lacks a version');
  return { version: parsed.version, bytes };
};
const sourceFiles = (directory, directories, found) => {
  const current = checkedDirectory(directory);
  const nextDirectories = [...directories, current];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    throw new Error(`offload runtime directory is unreadable: ${directory}`);
  }
  checkDirectories(nextDirectories);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(path, nextDirectories, found);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      found.push({ path, directories: nextDirectories });
      if (found.length > MAX_RUNTIME_FILES) throw new Error('offload runtime has too many source files');
    } else if (entry.isSymbolicLink()) throw new Error(`offload runtime source is a symlink: ${path}`);
  }
};

/**
 * Hash the shipped execution surface, not a checkout timestamp or path. The
 * resulting value is reproducible for byte-identical packed artifacts and is
 * useful when a long-lived stdio host may still be running old code.
 */
export function runtimeIdentityFor(root = packageRoot) {
  root = resolve(root);
  const rootDirectory = checkedDirectory(root);
  const directories = [rootDirectory];
  const total = { value: 0 };
  const metadata = packageMetadata(root, directories, total);
  const skillDirectory = checkedDirectory(join(root, 'plugins'));
  const offloadDirectory = checkedDirectory(join(root, 'plugins', 'offload'));
  const skillsDirectory = checkedDirectory(join(root, 'plugins', 'offload', 'skills'));
  const skillRoot = checkedDirectory(join(root, 'plugins', 'offload', 'skills', 'offload'));
  const skillDirectories = [...directories, skillDirectory, offloadDirectory, skillsDirectory, skillRoot];
  const skill = boundedRead(join(skillRoot.path, 'SKILL.md'), 'skill', skillDirectories, total);
  const source = [];
  sourceFiles(join(root, 'src'), directories, source);
  const binDirectory = checkedDirectory(join(root, 'bin'));
  const bin = boundedRead(join(binDirectory.path, 'offload.mjs'), 'entrypoint', [...directories, binDirectory], total);
  const buildParts = [
    ['package.json', metadata.bytes],
    ['bin/offload.mjs', bin],
    ...source.map((file) => [relative(root, file.path).replaceAll('\\', '/'), boundedRead(file.path, 'source', file.directories, total)]),
    ['plugins/offload/skills/offload/SKILL.md', skill],
  ];
  checkDirectories(directories);
  checkDirectories(skillDirectories);
  checkDirectories([...directories, binDirectory]);
  return Object.freeze({
    name: 'offload',
    version: metadata.version,
    buildHash: hash(buildParts),
    skillHash: hash([['plugins/offload/skills/offload/SKILL.md', skill]]),
    schemaRevision: IDENTITY_SCHEMA_REVISION,
    capabilities: RUNTIME_CAPABILITIES,
  });
}

const runtime = runtimeIdentityFor();

/** The identity of the loaded process, as opposed to a later on-disk update. */
export const runtimeIdentity = () => runtime;

/** Pure stale-runtime decision helper, exported for health and focused tests. */
export function compareRuntimeIdentity(loaded, current) {
  if (!current)
    return {
      ...loaded,
      stale: true,
      staleReason: 'runtime-artifacts-unreadable',
      restartRequired: true,
      restartAction: 'Restart the MCP client; its installed Offload runtime changed or is incomplete.',
    };
  if (current.buildHash === loaded.buildHash && current.skillHash === loaded.skillHash)
    return { ...loaded, stale: false, restartRequired: false };
  return {
    ...loaded,
    installedBuildHash: current.buildHash,
    installedSkillHash: current.skillHash,
    stale: true,
    staleReason: 'runtime-artifacts-changed',
    restartRequired: true,
    restartAction: 'Restart the MCP client to load the updated Offload server and skill.',
  };
}

/**
 * Detect an in-place package replacement without reaching into client process
 * tables. We never kill a host process: callers get a precise, actionable
 * instruction and decide when to restart their MCP client.
 */
export function healthIdentity() {
  try {
    return compareRuntimeIdentity(runtime, runtimeIdentityFor());
  } catch {
    return compareRuntimeIdentity(runtime);
  }
}
