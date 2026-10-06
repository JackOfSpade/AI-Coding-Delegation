#!/usr/bin/env node
/** Idempotent, reversible client-routing installer. It never overwrites unmanaged content. */
import { access, lstat, link, mkdir, open, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { stdin, stderr } from 'node:process';
import { loadConfig } from './src/config.mjs';
import { parseKeyRef, resolveKeyRef, storeKeychainSecret } from './src/secrets.mjs';
import { doctor, doctorLive } from './src/doctor.mjs';
import { resolveClientPaths } from './src/client-paths.mjs';
import { runtimeIdentityFor } from './src/identity.mjs';

const BEGIN = '<!-- BEGIN offload';
const END = '<!-- END offload -->';
const here = dirname(fileURLToPath(import.meta.url));
const MAX_ARTIFACT_BYTES = 1_048_576;
const BIGINT_STAT_OPTIONS = Object.freeze({ bigint: true });
export function sameModulePath(left, right, platform = process.platform) {
  return platform === 'win32' ? left.replaceAll('\\', '/').toLowerCase() === right.replaceAll('\\', '/').toLowerCase() : left === right;
}
/** Determine whether this module was the script Node was asked to execute.
 * Canonical paths make invocation through a symlink work; the lexical fallback
 * preserves direct execution if an entry has disappeared during startup. */
export function isMainModule({
  entry = process.argv[1],
  moduleUrl = import.meta.url,
  platform = process.platform,
  realpath = realpathSync,
} = {}) {
  if (typeof entry !== 'string' || !entry) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    // Preserve the supplied spelling for realpath. On Windows, resolving it
    // first can turn a testable/real 8.3 or symlink spelling into a different
    // drive-qualified lexical path before the resolver has a chance to
    // canonicalize it.
    return sameModulePath(realpath(entry), realpath(modulePath), platform);
  } catch {
    return sameModulePath(resolve(entry), resolve(modulePath), platform);
  }
}
/** Parse the intentionally small installer CLI before any filesystem or keychain work. */
export function parseInstallerArgs(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) throw new TypeError('installer arguments must be strings');
  const parsed = { uninstall: false, skipKey: false, replaceKey: false, clients: 'detected', doctorHook: false };
  const seen = new Set();
  const once = (flag) => {
    if (seen.has(flag)) throw new Error(`duplicate installer option: ${flag}`);
    seen.add(flag);
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--uninstall') {
      once(value);
      parsed.uninstall = true;
      continue;
    }
    if (value === '--skip-key') {
      once(value);
      parsed.skipKey = true;
      continue;
    }
    if (value === '--replace-key') {
      once(value);
      parsed.replaceKey = true;
      continue;
    }
    if (value === '--doctor-hook') {
      once(value);
      parsed.doctorHook = true;
      continue;
    }
    if (value === '--clients' || value.startsWith('--clients=')) {
      once('--clients');
      const clients = value === '--clients' ? argv[++index] : value.slice('--clients='.length);
      if (!clients || clients.startsWith('-')) throw new Error('--clients requires claude,codex,cursor or a subset');
      parsed.clients = clients;
      continue;
    }
    if (value.startsWith('-')) throw new Error(`unknown installer option: ${value}`);
    throw new Error(`unexpected installer argument: ${value}`);
  }
  if (parsed.doctorHook) {
    if (argv.length !== 1) throw new Error('--doctor-hook cannot be combined with installer options');
    return parsed;
  }
  if (parsed.uninstall && parsed.replaceKey) throw new Error('--replace-key cannot be used with --uninstall');
  if (parsed.uninstall && parsed.skipKey) throw new Error('--skip-key cannot be used with --uninstall');
  return parsed;
}
const exists = async (p) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );
async function read(p, { withMetadata = false } = {}) {
  // Client state is user data, but never follow a substituted final symlink
  // while inspecting it or creating a backup. The descriptor identity check
  // also catches a same-name replacement between lstat and read.
  let before, after, handle, bytes;
  try {
    before = await lstat(p, BIGINT_STAT_OPTIONS);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('unsafe');
    handle = await open(p, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat(BIGINT_STAT_OPTIONS);
    if (!opened.isFile() || !sameArtifactMetadata(before, opened)) throw new Error('unsafe');
    bytes = await handle.readFile();
    after = await handle.stat(BIGINT_STAT_OPTIONS);
    if (!sameArtifactMetadata(opened, after)) throw new Error('unsafe');
  } catch (error) {
    if (error?.code === 'ENOENT') return withMetadata ? undefined : '';
    throw new Error(`refusing unsafe installer file: ${p}`);
  } finally {
    await handle?.close().catch(() => {});
  }
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return withMetadata ? { content, metadata: after } : content;
  } catch {
    throw new Error(`refusing non-text installer file: ${p}`);
  }
}
async function requiredArtifact(path) {
  let before, handle, bytes;
  try {
    before = await lstat(path, BIGINT_STAT_OPTIONS);
    if (!before.isFile() || before.isSymbolicLink() || !safeArtifactSize(before.size)) throw new Error('invalid');
    // A package root may be selected through an environment/client hook. Read
    // its static routing artifacts through the checked descriptor rather than
    // following a final-component replacement into an unrelated host file.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat(BIGINT_STAT_OPTIONS);
    if (!opened.isFile() || !sameArtifactMetadata(before, opened)) throw new Error('invalid');
    bytes = await handle.readFile();
    const after = await handle.stat(BIGINT_STAT_OPTIONS);
    if (!sameArtifactMetadata(opened, after) || !safeArtifactSize(BigInt(bytes.length))) throw new Error('invalid');
  } catch {
    throw new Error(`required installer artifact is missing, unsafe, or unreadable: ${path}`);
  } finally {
    await handle?.close().catch(() => {});
  }
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`required installer artifact is unreadable: ${path}`);
  }
  if (!Buffer.from(content, 'utf8').equals(bytes) || !content.trim())
    throw new Error(`required installer artifact is empty or non-canonical text: ${path}`);
  return content;
}
function safeArtifactSize(size) {
  return typeof size === 'bigint' && size > 0n && size <= BigInt(MAX_ARTIFACT_BYTES);
}
function sameArtifactMetadata(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => typeof left?.[key] === 'bigint' && left[key] === right?.[key]);
}
async function atomic(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.offload-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
/** Write a recovery copy only when the destination did not already exist.
 * A hard-link publication is exclusive on every supported host, unlike
 * rename(), which may replace an existing backup on POSIX. */
async function atomicIfMissing(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.offload-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
    await link(tmp, path);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function removeExactSessionHook(entries, hook, matcher) {
  let removed = false;
  const next = entries.flatMap((entry) => {
    if (matcher !== undefined && entry?.matcher !== matcher) return [entry];
    if (!Array.isArray(entry?.hooks)) return [entry];
    const hooks = entry.hooks.filter((value) => !equal(value, hook));
    if (hooks.length === entry.hooks.length) return [entry];
    removed = true;
    return hooks.length ? [{ ...entry, hooks }] : [];
  });
  return { next, removed };
}
// Doctor hooks are commands rather than a structured Claude setting, so only
// recognize the exact quoting grammar emitted by shellQuote().  In
// particular, do not try to interpret arbitrary shell text while migrating
// stale installer roots.
function parseDoctorHookCommand(command, platform) {
  if (typeof command !== 'string' || /[\0\r\n]/.test(command)) return undefined;
  if (platform === 'win32') {
    const matched = /^"([^"\r\n]+)" "([^"\r\n]+)" --doctor-hook$/.exec(command);
    if (!matched) return undefined;
    return { executable: matched[1], installer: matched[2] };
  }
  // POSIX shellQuote() encloses every argument in single quotes and encodes a
  // literal apostrophe as '"'"'. Accept only that representation, rather than
  // a general shell grammar with expansions, separators, or substitutions.
  const quoted = "'(?:[^'\\r\\n]|'\"'\"')*'";
  const matched = new RegExp(`^(${quoted}) (${quoted}) --doctor-hook$`).exec(command);
  if (!matched) return undefined;
  const unquote = (value) => value.slice(1, -1).replace(/'"'"'/g, "'");
  return { executable: unquote(matched[1]), installer: unquote(matched[2]) };
}
function isOffloadDoctorHook(command, root, platform) {
  const parsed = parseDoctorHookCommand(command, platform);
  if (!parsed || /[\0\r\n]/.test(parsed.executable) || /[\0\r\n]/.test(parsed.installer)) return false;
  const executable = parsed.executable.split(/[\\/]/).at(-1);
  if (!/^node(?:\.exe)?$/i.test(executable)) return false;
  const normalize = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const installer = normalize(parsed.installer);
  if (installer === normalize(join(root, 'install.mjs'))) return true;
  const flags = platform === 'win32' ? 'i' : '';
  // These are the two previous locations emitted by supported installers. A
  // package path has a stable npm ownership boundary; the source checkout
  // name is deliberately specific so an arbitrary user's install.mjs is not
  // mistaken for ours.
  return (
    new RegExp('^[A-Za-z]:[\\\\/]|^\\\\\\\\|^/', flags).test(parsed.installer) &&
    (new RegExp('[\\\\/]node_modules[\\\\/]offload[\\\\/]install\\.mjs$', flags).test(parsed.installer) ||
      new RegExp('[\\\\/]AI-Coding-Delegation[\\\\/]install\\.mjs$', flags).test(parsed.installer))
  );
}
const record = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const safeRecord = (value) =>
  record(value) && Object.keys(value).every((key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
const shellQuote = (value, platform) => {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error('hook path contains control characters');
  // Claude executes hooks through cmd.exe on Windows.  Its percent and delayed
  // expansion rules differ between interactive commands and batch files, so
  // escaping `%`/delayed `!` expansion is not reliably round-trippable.
  // Refuse those and active shell separators rather than risk executing a
  // different command. Parentheses are literal inside a double-quoted command
  // argument, which keeps normal `Program Files (x86)` installations working.
  if (platform === 'win32') {
    if (/[%^&|<>!"]/.test(text)) throw new Error('Windows hook path contains unsupported command metacharacters');
    return `"${text}"`;
  }
  return `'${text.replace(/'/g, `'"'"'`)}'`;
};
async function readManifest(path) {
  const raw = await read(path);
  if (!raw) return { version: 1, registrations: {}, files: {}, plugins: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`refusing invalid offload installer manifest: ${path}`);
  }
  // The manifest is state, not a source of authority.  In particular, an
  // array or null used to satisfy `typeof value === 'object'` and then failed
  // later, after routing files could already have been updated. Reject such
  // state before making any client-visible changes.
  if (
    !safeRecord(parsed) ||
    parsed.version !== 1 ||
    !safeRecord(parsed.registrations) ||
    !safeRecord(parsed.files) ||
    (parsed.plugins !== undefined && !safeRecord(parsed.plugins)) ||
    (parsed.runtime !== undefined &&
      (!safeRecord(parsed.runtime) ||
        typeof parsed.runtime.version !== 'string' ||
        !/^[\x20-\x7e]{1,128}$/.test(parsed.runtime.version) ||
        typeof parsed.runtime.buildHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(parsed.runtime.buildHash) ||
        typeof parsed.runtime.skillHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(parsed.runtime.skillHash) ||
        !Number.isSafeInteger(parsed.runtime.schemaRevision) ||
        parsed.runtime.schemaRevision < 1 ||
        parsed.runtime.schemaRevision > 1_000))
  )
    throw new Error(`refusing invalid offload installer manifest: ${path}`);
  parsed.plugins ||= {};
  return parsed;
}
function parseClientJson(raw, path, client) {
  if (!raw) return undefined;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`refusing invalid ${client} JSON: ${path}`);
  }
  if (!record(value) || (value.mcpServers !== undefined && !record(value.mcpServers)))
    throw new Error(`refusing invalid ${client} JSON: ${path}`);
  return value;
}
function parseClaudeSettings(raw, path) {
  if (!raw) return undefined;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`refusing invalid Claude settings JSON: ${path}`);
  }
  if (
    !record(value) ||
    (value.permissions !== undefined && !record(value.permissions)) ||
    (value.permissions?.allow !== undefined && !Array.isArray(value.permissions.allow)) ||
    (value.hooks !== undefined && !record(value.hooks)) ||
    (value.hooks?.SessionStart !== undefined && !Array.isArray(value.hooks.SessionStart))
  )
    throw new Error(`refusing invalid Claude settings JSON: ${path}`);
  return value;
}
export async function selectedClients(home, clients, { env = process.env, platform = process.platform, commandExists = exists } = {}) {
  const known = new Set(['claude', 'codex', 'cursor']);
  if (clients != null && clients !== 'detected') {
    const values = Array.isArray(clients) ? clients : String(clients).split(',');
    if (
      !values.length ||
      values.some((value) => typeof value !== 'string' || !value || !known.has(value)) ||
      new Set(values).size !== values.length
    )
      throw new Error('clients must be a non-empty subset of claude,codex,cursor without duplicates');
    return new Set(values);
  }
  const selected = new Set();
  const paths = resolveClientPaths({ home, env, platform });
  if ((await exists(paths.claudeDir)) || (await exists(paths.claudeState))) selected.add('claude');
  if (await exists(paths.codexDir)) selected.add('codex');
  if (await exists(join(home, '.cursor'))) selected.add('cursor');
  const delimiter = platform === 'win32' ? ';' : ':';
  const executableNames = platform === 'win32' ? (value) => [value, `${value}.cmd`, `${value}.exe`] : (value) => [value];
  // Windows treats environment names case-insensitively, but callers can
  // supply a plain object (and Windows commonly displays this variable as
  // `Path`). Honor both spellings instead of relying on Node's live-env shim.
  const pathValue = platform === 'win32' ? (env.PATH ?? env.Path ?? '') : env.PATH || '';
  for (const client of known)
    for (const directory of String(pathValue).split(delimiter).filter(Boolean)) {
      if ((await Promise.all(executableNames(client).map((name) => commandExists(join(directory, name))))).some(Boolean))
        selected.add(client);
    }
  return selected;
}
export function replaceManaged(content, block, uninstall = false) {
  const begins = [...content.matchAll(new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  const ends = [...content.matchAll(new RegExp(END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  if (begins.length !== ends.length || begins.length > 1 || (begins.length && begins[0].index > ends[0].index))
    throw new Error('refusing malformed or duplicate offload managed block');
  // The delimiter belongs to the surrounding document, not the template. On
  // Windows a checked-out template can be CRLF, while on POSIX it is LF; use
  // the existing document when it has an established convention and otherwise
  // inherit the template's final newline. This avoids mixed EOLs and repeated
  // installs adding blank lines at the retained suffix boundary.
  const eol = content.includes('\r\n') || (!content.includes('\n') && block.includes('\r\n')) ? '\r\n' : '\n';
  const normalizedBlock = !uninstall ? block.replace(/\r\n?|\n/g, eol) : block;
  const managedBlock = !uninstall && normalizedBlock.endsWith(eol) ? normalizedBlock.slice(0, -eol.length) : normalizedBlock;
  if (begins.length)
    return `${content.slice(0, begins[0].index)}${uninstall ? '' : managedBlock}${content.slice(ends[0].index + END.length)}`;
  return uninstall ? content : `${content}${content && !content.endsWith('\n') ? eol : ''}${managedBlock}${eol}`;
}
async function updateManaged(path, block, uninstall, backups) {
  const original = await read(path);
  const next = replaceManaged(original, block, uninstall);
  if (next === original) return false;
  if (original && !uninstall) {
    const backup = `${path}.offload.bak`;
    if (!(await exists(backup))) {
      await atomic(backup, original);
      backups.push(backup);
    }
  }
  await atomic(path, next);
  return true;
}
const legacySkillBackupPath = (skillPath) => `${skillPath}.offload.bak`;
const skillBackupPath = (backupDirectory, skillPath) => join(backupDirectory, basename(legacySkillBackupPath(skillPath)));
function insideClientRoot(root, path) {
  const portion = relative(resolve(root), resolve(path));
  return portion === '' || (!portion.startsWith(`..${sep}`) && portion !== '..' && !portion.includes(`..${sep}`));
}
/** Recovery copies must never traverse a user-controlled link below the
 * selected client root. We intentionally stop at a missing component: a
 * normal first install may not have created the skill tree yet, while every
 * existing ancestor is checked before it can be read, removed, or used as a
 * backup destination. */
async function assertNoSymlinkAncestry(clientRoot, path) {
  const root = resolve(clientRoot);
  const target = resolve(path);
  if (!insideClientRoot(root, target)) throw new Error('refusing backup path outside the selected client root');
  let rootInfo;
  try {
    rootInfo = await lstat(root, BIGINT_STAT_OPTIONS);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('refusing unsafe client backup root');
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('refusing unsafe client backup root');
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    let details;
    try {
      details = await lstat(current, BIGINT_STAT_OPTIONS);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new Error('refusing unsafe client backup path');
    }
    if (details.isSymbolicLink()) throw new Error('refusing symlinked client backup path');
    if (current !== target && !details.isDirectory()) throw new Error('refusing non-directory client backup ancestor');
  }
}
/** Create a backup directory one verified component at a time. `mkdir -p`
 * alone can follow a substituted ancestor outside the client configuration. */
async function ensureSafeBackupDirectory(clientRoot, backupDirectory) {
  const root = resolve(clientRoot);
  const target = resolve(backupDirectory);
  if (!insideClientRoot(root, target)) throw new Error('refusing backup path outside the selected client root');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertNoSymlinkAncestry(root, root);
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const details = await lstat(current, BIGINT_STAT_OPTIONS);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('refusing symlinked client backup path');
  }
}
async function reserveBackupPath(preferred) {
  for (let index = 0; index < 10_000; index++) {
    const candidate = index ? `${preferred}.legacy-${index}` : preferred;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`refusing to create an unbounded number of offload backups: ${preferred}`);
}
async function preserveSkillBackup(skillPath, backupDirectory, content, backups, clientRoot) {
  await assertNoSymlinkAncestry(clientRoot, skillPath);
  await ensureSafeBackupDirectory(clientRoot, backupDirectory);
  const backup = skillBackupPath(backupDirectory, skillPath);
  if (await atomicIfMissing(backup, content)) backups.push(backup);
}
/**
 * Older installers put recovery material directly next to SKILL.md, inside a
 * discoverable skill directory. Move a regular legacy copy out of that tree.
 * Never replace an existing recovery file; collisions receive a stable,
 * separate legacy name. If the source changes while being copied, keep it.
 */
async function migrateLegacySkillBackup(skillPath, backupDirectory, backups, clientRoot) {
  const legacyPath = legacySkillBackupPath(skillPath);
  await assertNoSymlinkAncestry(clientRoot, legacyPath);
  // Validate an already-present destination spelling without creating it.
  // This preserves fail-closed handling of a substituted backup directory
  // while a fresh no-op install/uninstall remains side-effect free.
  await assertNoSymlinkAncestry(clientRoot, backupDirectory);
  let legacy;
  try {
    legacy = await read(legacyPath, { withMetadata: true });
  } catch {
    // A symlink or non-text file is user data we cannot safely migrate.
    return false;
  }
  if (!legacy) return false;
  // Inspect the legacy source first. A no-op uninstall/selection on a fresh
  // home must not manufacture client or recovery directories merely to learn
  // that there is nothing to migrate.
  await ensureSafeBackupDirectory(clientRoot, backupDirectory);
  const preferred = skillBackupPath(backupDirectory, skillPath);
  let destination;
  for (;;) {
    destination = await reserveBackupPath(preferred);
    if (await atomicIfMissing(destination, legacy.content)) break;
  }
  backups.push(destination);
  try {
    const current = await lstat(legacyPath, BIGINT_STAT_OPTIONS);
    if (current.isFile() && !current.isSymbolicLink() && sameArtifactMetadata(legacy.metadata, current))
      await rm(legacyPath, { force: true });
  } catch {
    // The completed copy is retained. Do not remove a path that changed after
    // the descriptor-checked read.
  }
  return true;
}
async function installOwnedFile(path, content, uninstall, backups, manifest, backupDirectory, clientRoot) {
  // Native skill state is user-visible but its parent directories are not an
  // authority grant. Refuse an ancestor link before reading, publishing, or
  // removing an installer-owned skill outside the selected client root.
  await assertNoSymlinkAncestry(clientRoot, path);
  const prior = await read(path);
  if (uninstall) {
    // The manifest lets newer installers update their own previous output,
    // while protecting a file edited by the user after installation.
    if (manifest.files[path] === digest(prior)) {
      await assertNoSymlinkAncestry(clientRoot, path);
      await rm(path, { force: true });
      delete manifest.files[path];
      return true;
    }
    return false;
  }
  if (!prior && !(await exists(path))) {
    await assertNoSymlinkAncestry(clientRoot, path);
    await atomic(path, content);
    manifest.files[path] = digest(content);
    return true;
  }
  // Identical content is not evidence of ownership: users can install the
  // canonical skill themselves. Only a prior manifest grant lets us manage it.
  if (prior === content) return false;
  if (manifest.files[path] === digest(prior)) {
    await preserveSkillBackup(path, backupDirectory, prior, backups, clientRoot);
    await assertNoSymlinkAncestry(clientRoot, path);
    await atomic(path, content);
    manifest.files[path] = digest(content);
    return true;
  }
  await preserveSkillBackup(path, backupDirectory, prior, backups, clientRoot);
  // An existing user-owned (or manually edited) skill/command is deliberately left alone.
  return false;
}
const pluginName = 'offload';
const pluginFiles = ['plugin.json', '.codex-plugin/plugin.json', 'skills/offload/SKILL.md'];
const pluginEntry = () => ({
  name: pluginName,
  source: { source: 'local', path: './plugins/offload' },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
  category: 'Productivity',
});
function validPluginCatalog(reference, home) {
  return (
    safeRecord(reference) &&
    reference.path === join(home, '.agents', 'plugins', 'marketplace.json') &&
    typeof reference.name === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(reference.name) &&
    equal(reference.entry, pluginEntry())
  );
}
function validPluginState(state, home) {
  if (state === undefined) return true;
  if (!safeRecord(state)) return false;
  const source = join(home, 'plugins', pluginName);
  if (state.source !== source || !safeRecord(state.files)) return false;
  const allowed = new Set(pluginFiles.map((path) => join(source, path)));
  if (Object.entries(state.files).some(([path, hash]) => !allowed.has(path) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)))
    return false;
  if (state.marketplace !== undefined && !validPluginCatalog(state.marketplace, home)) return false;
  if (state.catalog !== undefined && !validPluginCatalog(state.catalog, home)) return false;
  // An identical marketplace entry may predate this installer. We can own a
  // later `plugin add` without adopting that entry, so enablement validates its
  // marketplace name independently rather than requiring marketplace ownership.
  if (
    state.enabled !== undefined &&
    (!safeRecord(state.enabled) ||
      typeof state.enabled.executable !== 'string' ||
      typeof state.enabled.marketplace !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(state.enabled.marketplace) ||
      !(state.marketplace || state.catalog) ||
      state.enabled.marketplace !== (state.marketplace || state.catalog).name)
  )
    return false;
  return (
    state.version === undefined ||
    (typeof state.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(state.version))
  );
}
function pluginExecutable(env, platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathValue = platform === 'win32' ? (env.PATH ?? env.Path ?? '') : env.PATH || '';
  // Prefer the native executable: `.cmd` needs cmd.exe's parser and therefore
  // has a narrower, explicitly quoted fallback below.
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
  return String(pathValue)
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => join(directory, name)));
}
function claudeExecutable(env, platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathValue = platform === 'win32' ? (env.PATH ?? env.Path ?? '') : env.PATH || '';
  // Prefer a native executable.  A .cmd launcher is safe only through the
  // deliberately narrow cmd.exe wrapper below.
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  return String(pathValue)
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => join(directory, name)));
}
function pluginCommandEnv(env, home, platform) {
  // The CLI needs its state and executable search path, not a worker/provider
  // credential inherited from the installer process.
  const minimal = {};
  for (const key of platform === 'win32' ? ['PATH', 'Path', 'SystemRoot', 'ComSpec'] : ['PATH']) if (env[key]) minimal[key] = env[key];
  minimal.HOME = home;
  minimal.USERPROFILE = home;
  if (env.CODEX_HOME) minimal.CODEX_HOME = env.CODEX_HOME;
  return minimal;
}
function claudeCommandEnv(env, home, platform) {
  // Claude's CLI needs only its user home/configuration location and a
  // bounded executable search path.  In particular, never pass provider or
  // unrelated application secrets inherited by the installer process.
  const minimal = {};
  for (const key of platform === 'win32' ? ['PATH', 'Path', 'SystemRoot', 'ComSpec'] : ['PATH'])
    if (typeof env[key] === 'string' && env[key]) minimal[key] = env[key];
  minimal.HOME = home;
  minimal.USERPROFILE = home;
  // Do not synthesize this variable for the default layout: Claude uses a
  // different user-state location when it is explicitly set.  Preserve an
  // explicit caller choice so the CLI and resolveClientPaths agree.
  if (typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR) minimal.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  return minimal;
}
function keychainCommandEnv(env, platform) {
  // Keychain helpers need a user session and executable lookup, never a
  // provider credential. Keep enough desktop-session state for secret-tool on
  // Linux and Credential Locker on Windows without inheriting arbitrary keys.
  const minimal = {};
  const keys =
    platform === 'win32'
      ? ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'USERPROFILE', 'HOME']
      : ['PATH', 'HOME', 'USER', 'LOGNAME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY'];
  for (const key of keys) if (typeof env[key] === 'string' && env[key]) minimal[key] = env[key];
  return minimal;
}
function packagedPluginVersion(artifacts) {
  let portable, codex;
  try {
    portable = JSON.parse(artifacts['plugin.json']);
    codex = JSON.parse(artifacts['.codex-plugin/plugin.json']);
  } catch {
    throw new Error('invalid packaged plugin manifest');
  }
  const normalized = pluginFiles
    .slice()
    .sort()
    .map((path) => {
      const content = artifacts[path];
      if (typeof content !== 'string') throw new Error(`missing packaged plugin artifact: ${path}`);
      // The cache version identifies semantic plugin content, not the checkout
      // platform. Git attributes keep the shipped artifacts LF-normalized, and
      // this defensive normalization also keeps an existing CRLF checkout from
      // rejecting its own otherwise canonical manifests before it can refresh.
      const canonicalContent = content.replace(/\r\n?/g, '\n');
      if (path === 'plugin.json' || path === '.codex-plugin/plugin.json') {
        const next = canonicalContent.replace(/("version"\s*:\s*)"(?:[^"\\]|\\.)*"/, '$1"<cache-version>"');
        if (next === canonicalContent) throw new Error('packaged plugin manifest lacks a normalizable version');
        return `${path}\0${next}\0`;
      }
      return `${path}\0${canonicalContent}\0`;
    })
    .join('');
  const expected = `+codex.${digest(normalized).slice(0, 16)}`;
  if (
    !record(portable) ||
    !record(codex) ||
    portable.name !== pluginName ||
    codex.name !== pluginName ||
    typeof portable.version !== 'string' ||
    portable.version !== codex.version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+codex\.[0-9a-f]{16}$/.test(portable.version) ||
    !portable.version.endsWith(expected)
  )
    throw new Error('packaged plugin manifests must use the canonical plugin content version');
  return portable.version;
}
function commandOk(result) {
  return !!result && result.status === 0;
}
function windowsCmdQuote(value) {
  const text = String(value);
  if (!text || /[\0\r\n"%^&|<>!]/.test(text)) throw new Error('unsafe Windows Codex plugin command argument');
  return `"${text}"`;
}
function runCodexPlugin(runCommand, executable, args, options, env, platform) {
  if (platform === 'win32' && /\.cmd$/i.test(executable)) {
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    return runCommand(comspec, ['/d', '/s', '/c', [executable, ...args].map(windowsCmdQuote).join(' ')], options);
  }
  return runCommand(executable, args, options);
}
function legacyPluginIdentityMatches(current, marketplace) {
  if (!record(current)) return false;
  return (
    current.name === pluginName &&
    (current.marketplace === marketplace || current.marketplaceName === marketplace || current.source?.marketplace === marketplace)
  );
}
function pluginIdentityState(current, marketplace) {
  if (!record(current)) return 'other';
  // Recent Codex clients identify an installed plugin with `pluginId`, while
  // older clients provide its two components.  A present, non-matching ID is
  // authoritative: do not let a contradictory display name activate a
  // plugin.  This keeps the fallback compatible without broadening it to a
  // similarly named plugin from another marketplace.
  const expectedId = `${pluginName}@${marketplace}`;
  if (Object.hasOwn(current, 'pluginId'))
    return typeof current.pluginId === 'string' && current.pluginId === expectedId
      ? 'match'
      : legacyPluginIdentityMatches(current, marketplace)
        ? 'ambiguous'
        : 'other';
  return legacyPluginIdentityMatches(current, marketplace) ? 'match' : 'other';
}
function matchesPluginIdentity(current, marketplace) {
  return pluginIdentityState(current, marketplace) === 'match';
}
function containsAmbiguousPluginIdentity(current, marketplace) {
  if (Array.isArray(current)) return current.some((item) => containsAmbiguousPluginIdentity(item, marketplace));
  if (!record(current)) return false;
  if (pluginIdentityState(current, marketplace) === 'ambiguous') return true;
  return Object.values(current).some((item) => containsAmbiguousPluginIdentity(item, marketplace));
}
function listedPlugin(result, marketplace) {
  if (!commandOk(result)) return false;
  let value;
  try {
    value = JSON.parse(String(result.stdout || ''));
  } catch {
    return false;
  }
  const visit = (current, installedCollection = false) => {
    if (Array.isArray(current)) return current.some((item) => visit(item, installedCollection));
    if (!record(current)) return false;
    const matches = matchesPluginIdentity(current, marketplace);
    if (matches && (current.enabled === false || current.status === 'disabled')) return false;
    if (matches && (installedCollection || current.installed === true || current.enabled === true || current.status === 'installed'))
      return true;
    if (Array.isArray(current.installed) && visit(current.installed, true)) return true;
    return Object.entries(current).some(([key, child]) => key !== 'installed' && key !== 'available' && visit(child, installedCollection));
  };
  return visit(value);
}
function pluginListState(result, marketplace) {
  if (!commandOk(result)) return 'unknown';
  let value;
  try {
    value = JSON.parse(String(result.stdout || ''));
  } catch {
    return 'unknown';
  }
  // A matching display identity paired with a malformed or contradictory
  // canonical ID could be an active plugin from another marketplace. Keep
  // the activation state ambiguous instead of issuing a duplicate add.
  if (containsAmbiguousPluginIdentity(value, marketplace)) return 'unknown';
  const disabled = (current) =>
    Array.isArray(current)
      ? current.some(disabled)
      : record(current)
        ? (matchesPluginIdentity(current, marketplace) && (current.enabled === false || current.status === 'disabled')) ||
          Object.values(current).some(disabled)
        : false;
  if (disabled(value)) return 'disabled';
  if (Array.isArray(value)) return listedPlugin(result, marketplace) ? 'active' : 'inactive';
  if (!record(value)) return 'unknown';
  if (Array.isArray(value.installed) || Array.isArray(value.plugins)) return listedPlugin(result, marketplace) ? 'active' : 'inactive';
  if (
    Array.isArray(value.available) &&
    value.available.some((item) => record(item) && matchesPluginIdentity(item, marketplace) && item.installed === false)
  )
    return 'inactive';
  return 'unknown';
}
/**
 * A Codex build which has no `plugin` command cannot have installed this
 * local plugin through the CLI.  That is a safe condition for the native
 * skill fallback.  A build which does advertise plugins but whose list output
 * cannot be understood is different: installing a second copy would be an
 * unsafe guess, so callers keep the state ambiguous instead.
 *
 * This deliberately runs only after `plugin list --json` was indeterminate.
 * Current clients need no extra probe on their normal machine-readable path,
 * while older clients get a capability check before we decide on a fallback.
 */
function pluginCommandCapability(runCommand, executable, options, env, platform) {
  const result = runCodexPlugin(runCommand, executable, ['plugin', '--help'], options, env, platform);
  if (!commandOk(result)) return 'unknown';
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const commands = /\bCommands:\s*[\s\S]*/i.exec(text)?.[0] || '';
  return /\badd\b/i.test(commands) && /\blist\b/i.test(commands) && /\bremove\b/i.test(commands) ? 'supported' : 'unsupported';
}
async function findPluginExecutable(env, platform, commandExists) {
  for (const path of pluginExecutable(env, platform)) {
    if (platform === 'win32' && /\.cmd$/i.test(path)) {
      try {
        windowsCmdQuote(path);
      } catch {
        continue;
      }
    }
    if (await commandExists(path)) return path;
  }
  return undefined;
}
async function findClaudeExecutable(env, platform, commandExists) {
  for (const path of claudeExecutable(env, platform)) {
    if (platform === 'win32' && /\.cmd$/i.test(path)) {
      try {
        windowsCmdQuote(path);
      } catch {
        continue;
      }
    }
    if (await commandExists(path)) return path;
  }
  return undefined;
}
function runClaudeMcp(runCommand, executable, args, options, env, platform) {
  if (platform === 'win32' && /\.cmd$/i.test(executable)) {
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    return runCommand(comspec, ['/d', '/s', '/c', [executable, ...args].map(windowsCmdQuote).join(' ')], options);
  }
  return runCommand(executable, args, options);
}
function commandOutput(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}`;
}
function claudeDuplicate(result) {
  return (
    !commandOk(result) &&
    /\b(offload\b[\s\S]{0,120}\b(already exists|already configured|already registered|duplicate)|\b(already exists|already configured|already registered|duplicate)\b[\s\S]{0,120}\boffload\b)/i.test(
      commandOutput(result),
    )
  );
}
function claudeAbsent(result) {
  return (
    !commandOk(result) &&
    /\b(offload\b[\s\S]{0,120}\b(not found|does not exist|unknown)|\b(not found|does not exist|unknown)\b[\s\S]{0,120}\boffload\b)/i.test(
      commandOutput(result),
    )
  );
}
function claudeMcpStatus(status, action) {
  return { status, action };
}
async function inspectClaudeMcp(path) {
  try {
    const raw = await read(path);
    const parsed = parseClientJson(raw, path, 'Claude');
    return { registration: parsed?.mcpServers?.offload };
  } catch {
    return { ambiguous: true };
  }
}
async function manageClaudeMcp({ root, home, uninstall, env, platform, commandExists, runCommand, manifest, statePath }) {
  const desired = { type: 'stdio', command: process.execPath, args: [join(root, 'bin', 'offload.mjs'), 'mcp'], env: {} };
  const executable = await findClaudeExecutable(env, platform, commandExists);
  if (!executable)
    return claudeMcpStatus(
      'unavailable',
      'Claude Code CLI was not found on PATH; install or expose `claude`, then rerun the installer to register Offload MCP.',
    );
  const options = {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    env: claudeCommandEnv(env, home, platform),
  };
  const invoke = (args) => {
    try {
      return runClaudeMcp(runCommand, executable, args, options, env, platform);
    } catch {
      return { status: undefined };
    }
  };
  const add = () => invoke(['mcp', 'add', '--scope', 'user', 'offload', '--', process.execPath, join(root, 'bin', 'offload.mjs'), 'mcp']);
  const remove = () => invoke(['mcp', 'remove', '--scope', 'user', 'offload']);
  const confirmAdded = async (status, action) => {
    const observed = await inspectClaudeMcp(statePath);
    if (observed.ambiguous || !equal(observed.registration, desired))
      return claudeMcpStatus(
        'add-unconfirmed',
        'Claude Code CLI reported registration success, but Offload could not confirm the expected MCP entry. Offload left Claude state untouched; rerun the installer after checking Claude Code.',
      );
    manifest.registrations.claude = desired;
    return claudeMcpStatus(status, action);
  };
  const prior = manifest.registrations.claude;
  const current = await inspectClaudeMcp(statePath);
  if (current?.ambiguous)
    return claudeMcpStatus(
      'state-unreadable',
      'Claude MCP state could not be safely inspected for ownership, so Offload left it untouched. Resolve the Claude configuration issue and rerun the installer.',
    );
  const currentRegistration = current?.registration;
  if (uninstall) {
    // The manifest, not a user config file, is the ownership boundary.  Never
    // ask Claude to remove a registration Offload did not successfully add.
    if (!prior) return claudeMcpStatus('not-managed', 'No manifest-owned Claude MCP registration to remove.');
    if (currentRegistration && !equal(currentRegistration, prior))
      return claudeMcpStatus(
        'user-owned',
        'Claude has a non-manifest Offload MCP registration; leaving that user-owned registration unchanged.',
      );
    const removed = remove();
    if (commandOk(removed) || claudeAbsent(removed)) {
      delete manifest.registrations.claude;
      return claudeMcpStatus('removed', 'Removed manifest-owned Offload MCP registration through the Claude Code CLI.');
    }
    return claudeMcpStatus(
      'remove-failed',
      'Claude Code CLI could not remove the manifest-owned Offload MCP registration; rerun uninstall after fixing Claude Code.',
    );
  }
  if (!prior && currentRegistration)
    return claudeMcpStatus('user-owned', 'Claude already has an Offload MCP registration; leaving that user-owned registration unchanged.');
  if (prior && currentRegistration && !equal(currentRegistration, prior))
    return claudeMcpStatus(
      'user-owned',
      'Claude has a non-manifest Offload MCP registration; leaving that user-owned registration unchanged.',
    );
  if (prior && !currentRegistration) {
    const added = add();
    if (commandOk(added))
      return confirmAdded('restored', 'Restored the missing manifest-owned Offload MCP registration through the Claude Code CLI.');
    return claudeMcpStatus(
      'restore-failed',
      'Claude Code CLI could not restore the missing manifest-owned Offload MCP registration; rerun the installer after fixing Claude Code.',
    );
  }
  if (prior && equal(prior, desired)) return claudeMcpStatus('managed', 'Manifest-owned Offload MCP registration is current.');
  if (prior) {
    const removed = remove();
    if (!commandOk(removed) && !claudeAbsent(removed))
      return claudeMcpStatus(
        'refresh-remove-failed',
        'Claude Code CLI could not refresh the manifest-owned Offload MCP registration; rerun the installer after fixing Claude Code.',
      );
    const added = add();
    if (commandOk(added))
      return confirmAdded('refreshed', 'Refreshed the manifest-owned Offload MCP registration through the Claude Code CLI.');
    return claudeMcpStatus(
      'refresh-add-failed',
      'Claude Code CLI could not refresh Offload MCP after removing the manifest-owned registration; rerun the installer after fixing Claude Code.',
    );
  }
  const added = add();
  if (commandOk(added)) return confirmAdded(prior ? 'refreshed' : 'added', 'Registered Offload MCP through the Claude Code CLI.');
  if (!prior && claudeDuplicate(added))
    return claudeMcpStatus('user-owned', 'Claude already has an Offload MCP registration; leaving that user-owned registration unchanged.');
  return claudeMcpStatus(
    prior ? 'refresh-add-failed' : 'add-failed',
    'Claude Code CLI could not register Offload MCP; rerun the installer after fixing Claude Code. Existing Claude authentication was not modified by Offload.',
  );
}
async function safeOwnedPluginFile(path, source) {
  const expected = new Set(pluginFiles.map((file) => join(source, file)));
  if (!expected.has(path)) return false;
  try {
    const parent = await lstat(dirname(source));
    if (!parent.isDirectory() || parent.isSymbolicLink()) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') return false;
  }
  const parts = relative(source, path).split(sep).filter(Boolean);
  let current = source;
  for (let index = 0; index < parts.length; index++) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      return false;
    }
    if (metadata.isSymbolicLink() || (index < parts.length && !metadata.isDirectory())) return false;
    current = join(current, parts[index]);
  }
  try {
    const file = await lstat(path);
    return file.isFile() && !file.isSymbolicLink();
  } catch {
    return false;
  }
}
async function safePluginDestination(path, source) {
  const expected = new Set(pluginFiles.map((file) => join(source, file)));
  if (!expected.has(path)) return false;
  try {
    const parent = await lstat(dirname(source));
    if (!parent.isDirectory() || parent.isSymbolicLink()) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') return false;
  }
  const parts = relative(source, dirname(path)).split(sep).filter(Boolean);
  let current = source;
  for (let index = 0; index <= parts.length; index++) {
    const metadata = await lstat(current).catch((error) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));
    if (!metadata) return true;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    if (index < parts.length) current = join(current, parts[index]);
  }
  return true;
}
async function removePluginSource(state) {
  let changed = false;
  for (const path of Object.keys(state.files || {})) {
    if (!(await safeOwnedPluginFile(path, state.source))) {
      // A vanished owned file has nothing left to preserve; only keep state
      // when the destination ancestry is unsafe (for example a symlink swap).
      if (!(await exists(path)) && (await safePluginDestination(path, state.source))) {
        delete state.files[path];
        changed = true;
      }
      continue;
    }
    const current = await read(path);
    if (current && digest(current) === state.files[path]) {
      await rm(path, { force: true });
      delete state.files[path];
      changed = true;
    }
  }
  if (!Object.keys(state.files || {}).length && state.source) {
    for (const directory of [
      join(state.source, 'skills', 'offload'),
      join(state.source, 'skills'),
      join(state.source, '.codex-plugin'),
      state.source,
    ]) {
      try {
        if (!(await readdir(directory)).length) await rmdir(directory);
      } catch {}
    }
  }
  return changed;
}
/** Install the desktop plugin without taking ownership of pre-existing content. */
async function manageCodexPlugin({
  root,
  home,
  uninstall,
  env,
  platform,
  commandExists,
  runCommand,
  manifest,
  backups,
  changed,
  skillBackupDirectory,
  nativeSkillBlocksPlugin = false,
}) {
  const state = manifest.plugins.codex;
  // The manifest is evidence, never authority over paths. Derive the sole
  // plugin source we may inspect from the selected home before migrating an
  // old adjacent skill backup.
  const source = join(home, 'plugins', pluginName);
  if (state && state.source !== source) throw new Error('refusing invalid offload Codex plugin installer state');
  if (state) await migrateLegacySkillBackup(join(source, 'skills', 'offload', 'SKILL.md'), skillBackupDirectory, backups, home);
  const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
  if (uninstall) {
    if (!state) return { active: false, retained: false };
    const executable = await findPluginExecutable(env, platform, commandExists);
    if (state.enabled && !executable)
      return { active: true, retained: true, reason: 'Codex CLI unavailable; retained installer-owned plugin state' };
    if (state.enabled) {
      const marketplaceName = state.marketplace?.name || state.catalog?.name;
      if (!marketplaceName)
        return { active: true, retained: true, reason: 'installer state lacks a plugin marketplace; retained plugin state' };
      const result = runCodexPlugin(
        runCommand,
        executable,
        ['plugin', 'remove', `${pluginName}@${marketplaceName}`, '--json'],
        { env: pluginCommandEnv(env, home, platform), timeout: 10_000, maxBuffer: 1_000_000, windowsHide: true },
        env,
        platform,
      );
      if (!commandOk(result))
        return { active: true, retained: true, reason: 'Codex plugin removal failed; retained installer-owned plugin state' };
      const removedState = pluginListState(
        runCodexPlugin(
          runCommand,
          executable,
          ['plugin', 'list', '--json'],
          { env: pluginCommandEnv(env, home, platform), timeout: 10_000, maxBuffer: 1_000_000, windowsHide: true },
          env,
          platform,
        ),
        marketplaceName,
      );
      if (!['inactive', 'disabled'].includes(removedState))
        return { active: true, retained: true, reason: 'Codex plugin removal was not confirmed; retained plugin state' };
      delete state.enabled;
    }
    const raw = await read(marketplacePath);
    if (state.marketplace && raw) {
      let marketplace;
      try {
        marketplace = JSON.parse(raw);
      } catch {
        marketplace = undefined;
      }
      const index = marketplace?.plugins?.findIndex((entry) => equal(entry, state.marketplace.entry));
      if (index >= 0) {
        const backup = `${marketplacePath}.offload.bak`;
        if (!(await exists(backup))) {
          await atomic(backup, raw);
          backups.push(backup);
        }
        marketplace.plugins.splice(index, 1);
        await atomic(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
        changed.push(marketplacePath);
      }
      // Missing or edited entries are now user state; preserve them but do not
      // keep stale ownership that would make later uninstalls permanently fail.
      delete state.marketplace;
    } else if (state.marketplace && !raw) delete state.marketplace;
    if (await removePluginSource(state)) changed.push(state.source);
    if (!state.enabled) delete state.catalog;
    if (!state.enabled && !state.marketplace && !Object.keys(state.files || {}).length) delete manifest.plugins.codex;
    return { active: false, retained: false };
  }
  if (nativeSkillBlocksPlugin) {
    if (!state?.enabled)
      return { active: false, nativePreferred: true, reason: 'user-owned native Codex offload skill is already installed' };
    const executable = await findPluginExecutable(env, platform, commandExists);
    if (!executable)
      return {
        active: false,
        blockNative: true,
        retained: true,
        reason: 'cannot remove installer-owned plugin while preserving user native skill',
      };
    const removed = runCodexPlugin(
      runCommand,
      executable,
      ['plugin', 'remove', `${pluginName}@${state.enabled.marketplace}`, '--json'],
      { env: pluginCommandEnv(env, home, platform), timeout: 10_000, maxBuffer: 1_000_000, windowsHide: true },
      env,
      platform,
    );
    const status = commandOk(removed)
      ? pluginListState(
          runCodexPlugin(
            runCommand,
            executable,
            ['plugin', 'list', '--json'],
            { env: pluginCommandEnv(env, home, platform), timeout: 10_000, maxBuffer: 1_000_000, windowsHide: true },
            env,
            platform,
          ),
          state.enabled.marketplace,
        )
      : 'unknown';
    if (!['inactive', 'disabled'].includes(status))
      return { active: false, blockNative: true, retained: true, reason: 'installer-owned plugin removal was not confirmed' };
    delete state.enabled;
    return { active: false, nativePreferred: true, reason: 'user-owned native Codex offload skill is already installed' };
  }
  let desiredVersion;
  try {
    desiredVersion = packagedPluginVersion(
      Object.fromEntries(
        await Promise.all(pluginFiles.map(async (path) => [path, await requiredArtifact(join(root, 'plugins', pluginName, path))])),
      ),
    );
  } catch (error) {
    return { active: false, reason: error.message };
  }
  const expected = pluginEntry();
  const sourceState = state || { source, files: {} };
  let sourceConflict = false;
  const sourceParent = await lstat(dirname(source)).catch(() => undefined);
  const sourceMetadata = await lstat(source).catch(() => undefined);
  if (sourceParent?.isSymbolicLink() || (sourceParent && !sourceParent.isDirectory()) || sourceMetadata?.isSymbolicLink())
    sourceConflict = true;
  for (const relativePath of pluginFiles) {
    const target = join(source, relativePath),
      desired = await requiredArtifact(join(root, 'plugins', pluginName, relativePath));
    const current = await read(target);
    if (!(await safePluginDestination(target, source))) sourceConflict = true;
    if (current && current !== desired && sourceState.files[target] !== digest(current)) sourceConflict = true;
  }
  const invalidMarketplace = async () => {
    if (!sourceState.enabled)
      return { active: false, blockNative: true, reason: 'invalid personal marketplace leaves plugin state ambiguous' };
    const executable = await findPluginExecutable(env, platform, commandExists);
    if (!executable)
      return {
        active: false,
        blockNative: true,
        retained: true,
        reason: 'invalid marketplace and unavailable Codex CLI leave plugin state ambiguous',
      };
    const status = pluginListState(
      runCodexPlugin(
        runCommand,
        executable,
        ['plugin', 'list', '--json'],
        { env: pluginCommandEnv(env, home, platform), timeout: 10_000, maxBuffer: 1_000_000, windowsHide: true },
        env,
        platform,
      ),
      sourceState.enabled.marketplace,
    );
    if (status === 'active') return { active: true, retained: true, reason: 'active plugin retained despite invalid marketplace' };
    if (status === 'unknown')
      return { active: false, blockNative: true, retained: true, reason: 'invalid marketplace plugin state cannot be confirmed' };
    delete sourceState.enabled;
    delete sourceState.version;
    return { active: false, reason: 'invalid marketplace with inactive plugin' };
  };
  const raw = await read(marketplacePath);
  let marketplace;
  let entry;
  if (raw) {
    try {
      marketplace = JSON.parse(raw);
    } catch {
      return invalidMarketplace();
    }
  } else marketplace = { name: 'personal', interface: { displayName: 'Personal' }, plugins: [] };
  if (
    !safeRecord(marketplace) ||
    typeof marketplace.name !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(marketplace.name) ||
    !Array.isArray(marketplace.plugins) ||
    !marketplace.plugins.every(safeRecord)
  )
    return invalidMarketplace();
  const matchingEntries = marketplace.plugins.filter((value) => record(value) && value.name === pluginName);
  entry = matchingEntries[0];
  const preexistingEntry = !!entry;
  if (matchingEntries.length > 1 || sourceConflict || (entry && !equal(entry, expected))) {
    // A user-owned source/catalog entry can already be active in the desktop
    // app. Do not create a second native skill unless the CLI positively says
    // it is not installed; an unavailable CLI leaves the ambiguity intact.
    const executable = await findPluginExecutable(env, platform, commandExists);
    if (!executable)
      return { active: false, blockNative: true, reason: 'conflicting plugin ownership cannot be resolved without the Codex CLI' };
    const listed = runCodexPlugin(
      runCommand,
      executable,
      ['plugin', 'list', '--json'],
      { env: pluginCommandEnv(env, home, platform), timeout: 10_000, maxBuffer: 1_000_000, windowsHide: true },
      env,
      platform,
    );
    const state = pluginListState(listed, marketplace.name);
    if (state === 'unknown')
      return { active: false, blockNative: true, reason: 'Codex plugin state cannot be confirmed after a source conflict' };
    if (state === 'active') return { active: true, preexisting: true, reason: 'conflicting user-owned plugin is active' };
    delete sourceState.enabled;
    delete sourceState.version;
    return { active: false, reason: 'conflicting user-owned plugin source or marketplace entry' };
  }
  for (const relativePath of pluginFiles) {
    const target = join(source, relativePath),
      desired = await requiredArtifact(join(root, 'plugins', pluginName, relativePath));
    const current = await read(target);
    if (!current && !(await exists(target))) {
      await atomic(target, desired);
      sourceState.files[target] = digest(desired);
      changed.push(target);
    } else if (sourceState.files[target] === digest(current) && current !== desired) {
      if (relativePath === 'skills/offload/SKILL.md') await preserveSkillBackup(target, skillBackupDirectory, current, backups, home);
      else {
        const backup = `${target}.offload.bak`;
        if (!(await exists(backup))) {
          await atomic(backup, current);
          backups.push(backup);
        }
      }
      await atomic(target, desired);
      sourceState.files[target] = digest(desired);
      changed.push(target);
    }
  }
  sourceState.source = source;
  sourceState.catalog = { path: marketplacePath, name: marketplace.name, entry: expected };
  manifest.plugins.codex = sourceState;
  if (!entry) {
    if (raw) {
      const backup = `${marketplacePath}.offload.bak`;
      if (!(await exists(backup))) {
        await atomic(backup, raw);
        backups.push(backup);
      }
    }
    marketplace.plugins.push(expected);
    await atomic(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
    changed.push(marketplacePath);
    sourceState.marketplace = { path: marketplacePath, name: marketplace.name, entry: expected };
  }
  const executable = await findPluginExecutable(env, platform, commandExists);
  if (!executable)
    return sourceState.enabled || preexistingEntry
      ? { active: false, blockNative: true, retained: true, reason: 'Codex CLI unavailable; retained ambiguous plugin activation' }
      : { active: false, reason: 'Codex CLI unavailable' };
  const options = { env: pluginCommandEnv(env, home, platform), timeout: 10_000, maxBuffer: 1_000_000, windowsHide: true };
  const list = runCodexPlugin(runCommand, executable, ['plugin', 'list', '--json'], options, env, platform);
  const listState = pluginListState(list, marketplace.name);
  if (listState === 'disabled') return { active: false, reason: 'Codex plugin is explicitly disabled' };
  if (listState === 'unknown') {
    const capability = pluginCommandCapability(runCommand, executable, options, env, platform);
    // An older CLI cannot have installed a plugin through its absent command,
    // so the native skill is the compatible route.  Do not infer that from a
    // generic list failure: a plugin-aware client with an unreadable list may
    // already have an active copy.
    if (capability === 'unsupported')
      return { active: false, reason: 'Codex CLI does not support plugin commands; using native skill fallback' };
    return {
      active: false,
      blockNative: true,
      retained: true,
      reason: capability === 'supported' ? 'Codex plugin state cannot be confirmed' : 'Codex plugin capability cannot be confirmed',
    };
  }
  if (listState === 'active') {
    // Only an enablement recorded by us may be refreshed. A discovered
    // user-owned plugin can be active, but must never be removed/adopted.
    if (!sourceState.enabled || sourceState.version === desiredVersion) return { active: true, preexisting: !sourceState.enabled };
    const removed = runCodexPlugin(
      runCommand,
      executable,
      ['plugin', 'remove', `${pluginName}@${marketplace.name}`, '--json'],
      options,
      env,
      platform,
    );
    if (!commandOk(removed)) return { active: true, retained: true, reason: 'Codex plugin refresh removal failed' };
    const afterRemoval = pluginListState(
      runCodexPlugin(runCommand, executable, ['plugin', 'list', '--json'], options, env, platform),
      marketplace.name,
    );
    if (!['inactive', 'disabled'].includes(afterRemoval))
      return { active: true, retained: true, reason: 'Codex plugin refresh removal was not confirmed' };
    const refreshed = runCodexPlugin(
      runCommand,
      executable,
      ['plugin', 'add', `${pluginName}@${marketplace.name}`, '--json'],
      options,
      env,
      platform,
    );
    if (!commandOk(refreshed)) {
      delete sourceState.enabled;
      return { active: false, reason: 'Codex plugin refresh failed; using native skill fallback' };
    }
    const confirmed = pluginListState(
      runCodexPlugin(runCommand, executable, ['plugin', 'list', '--json'], options, env, platform),
      marketplace.name,
    );
    if (confirmed !== 'active') {
      if (confirmed === 'unknown') {
        sourceState.enabled = { executable, marketplace: marketplace.name };
        sourceState.version = desiredVersion;
      } else delete sourceState.enabled;
      return { active: false, blockNative: confirmed === 'unknown', reason: 'Codex plugin refresh was not confirmed' };
    }
    sourceState.enabled = { executable, marketplace: marketplace.name };
    sourceState.version = desiredVersion;
    return { active: true, refreshed: true };
  }
  const added = runCodexPlugin(
    runCommand,
    executable,
    ['plugin', 'add', `${pluginName}@${marketplace.name}`, '--json'],
    options,
    env,
    platform,
  );
  if (!commandOk(added)) return { active: false, reason: 'Codex CLI does not support or failed to add the plugin' };
  const confirmed = pluginListState(
    runCodexPlugin(runCommand, executable, ['plugin', 'list', '--json'], options, env, platform),
    marketplace.name,
  );
  if (confirmed !== 'active') {
    if (confirmed === 'unknown') {
      sourceState.enabled = { executable, marketplace: marketplace.name };
      sourceState.version = desiredVersion;
    }
    return { active: false, blockNative: confirmed === 'unknown', reason: 'Codex plugin add was not confirmed' };
  }
  sourceState.enabled = { executable, marketplace: marketplace.name };
  sourceState.version = desiredVersion;
  return { active: true };
}
function mcpToml(root, eol = '\n') {
  return [
    '# offload managed MCP',
    '[mcp_servers.offload]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(join(root, 'bin', 'offload.mjs'))}, "mcp"]`,
    'startup_timeout_sec = 15',
    'tool_timeout_sec = 60',
    'default_tools_approval_mode = "writes"',
  ].join(eol);
}
const horizontal = (character) => character === ' ' || character === '\t';
function parseTomlKeySegment(line, start) {
  let index = start;
  while (horizontal(line[index])) index++;
  if (line[index] === '"') {
    let value = '';
    index++;
    for (; index < line.length; index++) {
      const character = line[index];
      if (character === '"') return { value, index: index + 1 };
      if (character === '\\') {
        const escape = line[++index];
        const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (Object.hasOwn(simple, escape)) {
          value += simple[escape];
          continue;
        }
        const width = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
        const hex = line.slice(index + 1, index + 1 + width);
        if (!width || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
        value += String.fromCodePoint(codePoint);
        index += width;
        continue;
      }
      if (character < ' ') return undefined;
      value += character;
    }
    return undefined;
  }
  if (line[index] === "'") {
    const end = line.indexOf("'", index + 1);
    if (end < 0 || /[\r\n]/.test(line.slice(index + 1, end))) return undefined;
    return { value: line.slice(index + 1, end), index: end + 1 };
  }
  const match = /^[A-Za-z0-9_-]+/.exec(line.slice(index));
  return match ? { value: match[0], index: index + match[0].length } : undefined;
}
function parseTomlHeader(line) {
  let index = 0;
  while (horizontal(line[index])) index++;
  if (line[index] !== '[') return undefined;
  const array = line[index + 1] === '[';
  index += array ? 2 : 1;
  const segments = [];
  for (;;) {
    const segment = parseTomlKeySegment(line, index);
    if (!segment) return { ambiguous: /mcp_servers|offload/i.test(line) };
    segments.push(segment.value);
    index = segment.index;
    while (horizontal(line[index])) index++;
    if (line[index] === '.') {
      index++;
      continue;
    }
    if (line[index] !== ']') return { ambiguous: /mcp_servers|offload/i.test(line) };
    index++;
    if (array) {
      if (line[index] !== ']') return { ambiguous: /mcp_servers|offload/i.test(line) };
      index++;
    }
    while (horizontal(line[index])) index++;
    if (index < line.length && line[index] !== '#') return { ambiguous: /mcp_servers|offload/i.test(line) };
    return { segments, array, canonical: line === '[mcp_servers.offload]' };
  }
}
/** Find exactly one offload table without reformatting unrelated TOML. */
export function scanCodexOffloadToml(text) {
  const headers = [],
    lines = /^.*(?:\r?\n|$)/gm;
  for (let match; (match = lines.exec(text));) {
    if (!match[0]) break;
    const raw = match[0];
    const line = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    const parsed = parseTomlHeader(line);
    if (parsed?.ambiguous) {
      headers.ambiguous = true;
      continue;
    }
    if (parsed?.segments) headers.push({ start: match.index, next: match.index + raw.length, ...parsed });
  }
  const tables = [];
  tables.ambiguous = headers.ambiguous === true;
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index];
    if (header.segments.length !== 2 || header.segments[0] !== 'mcp_servers' || header.segments[1] !== 'offload') continue;
    if (header.array) {
      tables.ambiguous = true;
      continue;
    }
    const tableStart = header.start;
    const before = text.slice(0, tableStart);
    const marker = '# offload managed MCP';
    const markerStart = before.lastIndexOf(marker);
    const markerEnd = markerStart < 0 ? -1 : markerStart + marker.length;
    const managed =
      markerEnd === before.length - 1 || markerEnd === before.length - 2
        ? (markerStart === 0 || before[markerStart - 1] === '\n') && header.canonical
        : false;
    const start = managed ? markerStart : tableStart;
    const boundary = headers[index + 1]?.start;
    // Keep the line separator outside the owned block. That makes the exact
    // manifest block identical whether it is followed by another table or EOF.
    const rawEnd = boundary ?? text.length;
    // A plugin command can append its own table after ours with one or more
    // blank separator lines. Keep only blank-line whitespace outside the owned
    // MCP block, so equality with the manifest survives without consuming a
    // user comment or value between tables.
    const suffix = /(?:\r?\n[ \t]*)+$/.exec(text.slice(start, rawEnd));
    const end = suffix ? rawEnd - suffix[0].length : rawEnd;
    tables.push({ start, end, removeEnd: rawEnd, trailing: text.slice(end, rawEnd), block: text.slice(start, end), managed });
  }
  return tables;
}
function cursorJson(root) {
  return (
    JSON.stringify({ mcpServers: { offload: { command: process.execPath, args: [join(root, 'bin', 'offload.mjs'), 'mcp'] } } }, null, 2) +
    '\n'
  );
}
export async function storeKeychainKey({
  service = 'offload-deepseek',
  prompt,
  execFile = (cmd, args, options) => spawnSync(cmd, args, options),
  platform = process.platform,
  env = process.env,
  macosInteractive = false,
} = {}) {
  const guardedExecFile = (command, args, options = {}) => execFile(command, args, { ...options, env: keychainCommandEnv(env, platform) });
  if (platform === 'darwin') {
    if (!macosInteractive)
      return { stored: false, reason: 'macOS keychain setup requires an interactive terminal; rerun install in a terminal' };
    return storeKeychainSecret(service, undefined, { platform, execFile: guardedExecFile, interactive: true });
  }
  if (typeof prompt !== 'function') return { stored: false, reason: 'no prompt' };
  const key = await prompt({ echo: false, label: `API key for ${service}` });
  if (typeof key !== 'string' || !key.trim()) return { stored: false, reason: 'empty key' };
  if (!['darwin', 'linux', 'win32'].includes(platform)) return { stored: false, reason: 'system keychain unsupported' };
  return storeKeychainSecret(service, key, { platform, execFile: guardedExecFile });
}
export async function promptNoEcho({ input = stdin, output = stderr } = {}) {
  if (!input.isTTY) return '';
  output.write('Offload worker API key (stored in system keychain; input hidden): ');
  return new Promise((resolve, reject) => {
    let value = '',
      finished = false,
      raw = false;
    const cleanup = () => {
      input.removeListener('data', onData);
      input.removeListener('end', end);
      input.removeListener('error', end);
      if (raw)
        try {
          input.setRawMode(false);
        } catch {}
      try {
        input.pause();
      } catch {}
    };
    const done = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        output.write('\n');
      } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const end = () => {
      value = '';
      done();
    };
    const onData = (chunk) => {
      try {
        for (const char of String(chunk)) {
          if (char === '\r' || char === '\n') return done();
          if (char === '\u0003') {
            value = '';
            return done();
          }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else if (value.length < 4096) value += char;
          else {
            value = '';
            return done();
          }
        }
      } catch (error) {
        done(error);
      }
    };
    try {
      input.setRawMode(true);
      raw = true;
      input.resume();
      input.on('data', onData);
      input.once('end', end);
      input.once('error', end);
    } catch (error) {
      done(error);
    }
  });
}
export async function install({
  root = here,
  home,
  uninstall = false,
  configHome,
  keyPrompt,
  keychain = storeKeychainKey,
  platform = process.platform,
  env = process.env,
  commandExists = exists,
  runCommand = (command, args, options) => spawnSync(command, args, options),
  clients = 'detected',
  replaceKey = false,
} = {}) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required');
  const clientPaths = resolveClientPaths({ home, env, platform });
  home = clientPaths.home;
  configHome ||= env.XDG_CONFIG_HOME || (platform === 'win32' ? env.APPDATA || join(home, 'AppData', 'Roaming') : join(home, '.config'));
  root = resolve(root);
  // A normal packaged install has every runtime artifact and can record an
  // exact identity for the next update. Keep the public API tolerant of the
  // deliberately partial fixture roots used by embedders and migration tests;
  // those roots could not run the MCP server in the first place.
  let installedRuntime;
  if (!uninstall) {
    try {
      installedRuntime = runtimeIdentityFor(root);
    } catch {}
  }
  const selected = await selectedClients(home, clients, { env, platform, commandExists });
  // Reject unsafe hook command paths before probing a deliberately malformed root.
  if (selected.has('claude')) {
    shellQuote(process.execPath, platform);
    shellQuote(join(root, 'install.mjs'), platform);
  }
  // Install validates every source artifact before mutating client files. An
  // uninstall uses only recorded state/current config, so it remains safe from
  // a partial or moved package checkout.
  const artifacts = uninstall ? [] : [join(root, 'bin', 'offload.mjs'), join(root, 'install.mjs'), join(root, 'config.example.json')];
  if (!uninstall && (selected.has('codex') || selected.has('claude')))
    artifacts.push(join(root, 'plugins', 'offload', 'skills', 'offload', 'SKILL.md'));
  if (!uninstall && selected.has('codex'))
    artifacts.push(join(root, 'plugins', 'offload', 'plugin.json'), join(root, 'plugins', 'offload', '.codex-plugin', 'plugin.json'));
  if (!uninstall && selected.has('claude')) artifacts.push(join(root, 'templates', 'CLAUDE.md.block.md'));
  if (!uninstall && selected.has('codex')) artifacts.push(join(root, 'templates', 'AGENTS.md.block.md'));
  const artifactContents = new Map(await Promise.all(artifacts.map(async (path) => [path, await requiredArtifact(path)])));
  if (!uninstall && selected.has('codex'))
    packagedPluginVersion(
      Object.fromEntries(pluginFiles.map((path) => [path, artifactContents.get(join(root, 'plugins', 'offload', path))])),
    );
  const manifestPath = join(configHome, 'offload', 'installer-state.json');
  const manifest = await readManifest(manifestPath);
  const previousRuntime = manifest.runtime;
  const hadManagedInstallation =
    Object.keys(manifest.registrations).length > 0 ||
    Object.keys(manifest.files).length > 0 ||
    Object.keys(manifest.plugins).length > 0 ||
    !!manifest.claudeSettings;
  if (!validPluginState(manifest.plugins.codex, home)) throw new Error('refusing invalid offload Codex plugin installer state');
  const template = (name) => artifactContents.get(join(root, 'templates', name));
  const claudeBlock = !uninstall && selected.has('claude') ? template('CLAUDE.md.block.md') : '';
  const codexBlock = !uninstall && selected.has('codex') ? template('AGENTS.md.block.md') : '';
  if (![claudeBlock, codexBlock].filter(Boolean).every((block) => block.includes(BEGIN)))
    throw new Error('routing template missing managed markers');
  // Fully validate every selected client configuration before altering routing
  // documents. A JSON array or a malformed/unmanaged MCP registration must
  // fail closed rather than leave a partial installation behind.
  const codexConfig = clientPaths.codexConfig;
  const currentToml = selected.has('codex') ? await read(codexConfig) : '';
  const codexTables = selected.has('codex') ? scanCodexOffloadToml(currentToml) : [];
  if (selected.has('codex') && codexTables.ambiguous) throw new Error('refusing ambiguous Codex offload MCP header');
  if (selected.has('codex') && codexTables.length > 1) throw new Error('refusing duplicate Codex offload MCP tables');
  if (selected.has('codex') && !uninstall && codexTables[0] && !codexTables[0].managed)
    throw new Error('refusing to overwrite unmanaged Codex offload MCP table');
  const cursorConfig = clientPaths.cursorConfig;
  const currentCursor = selected.has('cursor') ? await read(cursorConfig) : '';
  const cursorState = selected.has('cursor') ? parseClientJson(currentCursor, cursorConfig, 'Cursor MCP') : undefined;
  const claudeSettings = clientPaths.claudeSettings;
  const existingSettings = selected.has('claude') ? await read(claudeSettings) : '';
  const claudeSettingsState = selected.has('claude') ? parseClaudeSettings(existingSettings, claudeSettings) : undefined;
  const backups = [],
    changed = [];
  // Cursor has no supported global rule directory. Remove only an old managed
  // block during migration; its MCP registration remains below.
  const docs = [
    [clientPaths.claudeMemory, claudeBlock, 'claude'],
    [clientPaths.codexMemory, codexBlock, 'codex'],
  ];
  for (const [path, text, client] of docs)
    if (selected.has(client) && (await updateManaged(path, text, uninstall, backups))) changed.push(path);
  if (selected.has('cursor') && (await exists(clientPaths.cursorRule))) {
    const migrated = await updateManaged(clientPaths.cursorRule, '', true, backups);
    if (migrated) {
      if (!(await read(clientPaths.cursorRule)).trim()) await rm(clientPaths.cursorRule, { force: true });
      changed.push(clientPaths.cursorRule);
    }
  }
  // MCP registrations are entirely owned blocks; do not reformat unrelated TOML.
  if (selected.has('codex')) {
    const eol = currentToml.includes('\r\n') ? '\r\n' : '\n';
    const current = codexTables[0];
    const desired = mcpToml(root, eol);
    if (!uninstall && !current) {
      const separator = currentToml && !currentToml.endsWith('\n') ? eol : '';
      await atomic(codexConfig, `${currentToml}${separator}${desired}${eol}`);
      manifest.registrations.codex = desired;
      changed.push(codexConfig);
    } else if (!uninstall && current.block === desired && manifest.registrations.codex === current.block)
      manifest.registrations.codex = desired;
    else if (!uninstall && current.managed && manifest.registrations.codex === current.block) {
      await atomic(
        codexConfig,
        `${currentToml.slice(0, current.start)}${desired}${current.trailing}${currentToml.slice(current.removeEnd)}`,
      );
      manifest.registrations.codex = desired;
      changed.push(codexConfig);
    } else if (uninstall && current && current.managed && manifest.registrations.codex === current.block) {
      await atomic(codexConfig, `${currentToml.slice(0, current.start)}${currentToml.slice(current.removeEnd)}`);
      delete manifest.registrations.codex;
      changed.push(codexConfig);
    }
  }
  if (selected.has('cursor') && !uninstall) {
    try {
      const parsed = cursorState || {};
      parsed.mcpServers ||= {};
      const desired = JSON.parse(cursorJson(root)).mcpServers.offload;
      const current = parsed.mcpServers.offload;
      const previous = manifest.registrations.cursor;
      if (!current) {
        parsed.mcpServers.offload = desired;
        manifest.registrations.cursor = desired;
        if (currentCursor) {
          const backup = `${cursorConfig}.offload.bak`;
          if (!(await exists(backup))) {
            await atomic(backup, currentCursor);
            backups.push(backup);
          }
        }
        await atomic(cursorConfig, JSON.stringify(parsed, null, 2) + '\n');
        changed.push(cursorConfig);
      } else if (equal(current, desired) && previous && equal(current, previous)) manifest.registrations.cursor = desired;
      else if (previous && equal(current, previous)) {
        parsed.mcpServers.offload = desired;
        manifest.registrations.cursor = desired;
        await atomic(cursorConfig, JSON.stringify(parsed, null, 2) + '\n');
        changed.push(cursorConfig);
      }
      // Any other entry is user-owned. Leave it byte-for-byte semantically intact.
    } catch {
      throw new Error(`refusing invalid Cursor MCP JSON: ${cursorConfig}`);
    }
  } else if (selected.has('cursor') && currentCursor) {
    try {
      const parsed = cursorState;
      if (manifest.registrations.cursor && equal(parsed.mcpServers?.offload, manifest.registrations.cursor)) {
        delete parsed.mcpServers.offload;
        delete manifest.registrations.cursor;
        await atomic(cursorConfig, JSON.stringify(parsed, null, 2) + '\n');
        changed.push(cursorConfig);
      }
    } catch {
      throw new Error(`refusing invalid Cursor MCP JSON: ${cursorConfig}`);
    }
  }
  const nativeSkill =
    selected.has('codex') &&
    !uninstall &&
    (await exists(clientPaths.codexSkill)) &&
    manifest.files[clientPaths.codexSkill] !== digest(await read(clientPaths.codexSkill));
  const plugin = selected.has('codex')
    ? await manageCodexPlugin({
        root,
        home,
        uninstall,
        env,
        platform,
        commandExists,
        runCommand,
        manifest,
        backups,
        changed,
        skillBackupDirectory: clientPaths.codexSkillBackupDir,
        nativeSkillBlocksPlugin: nativeSkill,
      })
    : { active: false };
  const skill = !uninstall ? artifactContents.get(join(root, 'plugins', 'offload', 'skills', 'offload', 'SKILL.md')) : '';
  // The canonical skill works for both native coding clients. Legacy Claude
  // commands lose to same-named skills, so migration removes only our exact file.
  if (selected.has('claude'))
    await migrateLegacySkillBackup(clientPaths.claudeSkill, clientPaths.claudeSkillBackupDir, backups, clientPaths.claudeDir);
  if (selected.has('codex'))
    await migrateLegacySkillBackup(clientPaths.codexSkill, clientPaths.codexSkillBackupDir, backups, clientPaths.codexDir);
  if (
    selected.has('claude') &&
    (await installOwnedFile(
      clientPaths.claudeSkill,
      skill,
      uninstall,
      backups,
      manifest,
      clientPaths.claudeSkillBackupDir,
      clientPaths.claudeDir,
    ))
  )
    changed.push(clientPaths.claudeSkill);
  // A successfully active desktop plugin supplies the same skill. Remove only
  // a prior installer-owned native duplicate; user-owned native skills stay.
  if (
    selected.has('codex') &&
    !plugin.blockNative &&
    (await installOwnedFile(
      clientPaths.codexSkill,
      skill,
      uninstall || plugin.active,
      backups,
      manifest,
      clientPaths.codexSkillBackupDir,
      clientPaths.codexDir,
    ))
  )
    changed.push(clientPaths.codexSkill);
  if (selected.has('claude')) {
    const legacy = await read(clientPaths.claudeLegacyCommand);
    if (legacy && manifest.files[clientPaths.claudeLegacyCommand] === digest(legacy)) {
      await rm(clientPaths.claudeLegacyCommand, { force: true });
      delete manifest.files[clientPaths.claudeLegacyCommand];
      changed.push(clientPaths.claudeLegacyCommand);
    }
  }
  const claudeMcp = selected.has('claude')
    ? await manageClaudeMcp({
        root,
        home,
        uninstall,
        env,
        platform,
        commandExists,
        runCommand,
        manifest,
        statePath: clientPaths.claudeState,
      })
    : claudeMcpStatus('not-selected', 'Claude was not selected for this installer run.');
  // Claude permissions are least-privilege: reverting a patch remains an
  // interactive decision. These literal entries are idempotent and unrelated
  // settings are retained verbatim by JSON parse/stringify semantics.
  if (selected.has('claude') && !uninstall) {
    try {
      const settings = claudeSettingsState || {};
      settings.permissions ||= {};
      settings.permissions.allow ||= [];
      settings.hooks ||= {};
      settings.hooks.SessionStart ||= [];
      const rules = ['mcp__offload__offload_wait', 'mcp__offload__offload_job'];
      const oldMutatingRules = new Set([
        'mcp__offload__offload_start',
        'mcp__offload__offload_repair',
        'mcp__offload__offload_cancel',
        'mcp__offload__offload_revert',
      ]);
      const formerlyOwned = new Set(manifest.claudeSettings?.rules || []);
      const staleOwned = [...oldMutatingRules].filter((rule) => formerlyOwned.has(rule));
      if (staleOwned.length) settings.permissions.allow = settings.permissions.allow.filter((rule) => !staleOwned.includes(rule));
      const missing = rules.filter((rule) => !settings.permissions.allow.includes(rule));
      const hookCommand = `${shellQuote(process.execPath, platform)} ${shellQuote(join(root, 'install.mjs'), platform)} --doctor-hook`;
      // Check at session creation, durable resume, and fork.  Deliberately
      // exclude clear/compact: those happen during normal conversation and
      // would make a diagnostic hook unnecessarily noisy.
      const hookMatcher = 'startup|resume|fork';
      const managedHook = { type: 'command', command: hookCommand };
      // v1 used an empty matcher; the first optimized release used startup.
      // Migrate only exact manifest-owned hooks, retaining other handlers a
      // user added to those same event entries.  New manifests record the
      // matcher so routine reinstalls do not remove and recreate their hook.
      const recordedHookCommand = manifest.claudeSettings?.hookCommand;
      const recordedHookIsSafe = isOffloadDoctorHook(recordedHookCommand, root, platform);
      const oldHookOwned =
        (manifest.claudeSettings?.hookOwned === true && recordedHookIsSafe) ||
        (manifest.claudeSettings?.hookOwned === undefined && (recordedHookCommand === hookCommand || recordedHookIsSafe));
      const recordedMatcher = typeof manifest.claudeSettings?.hookMatcher === 'string' ? manifest.claudeSettings.hookMatcher : undefined;
      let migration = { next: settings.hooks.SessionStart, removed: false };
      // The manifest is the ownership boundary. A recognized path merely
      // validates its recorded command; it never authorizes us to remove a
      // separately-added lookalike hook during a later reinstall.
      if (oldHookOwned && (recordedHookCommand !== hookCommand || recordedMatcher !== hookMatcher))
        for (const matcher of recordedMatcher ? [recordedMatcher] : ['', 'startup']) {
          const next = removeExactSessionHook(migration.next, { type: 'command', command: recordedHookCommand }, matcher);
          migration = { next: next.next, removed: migration.removed || next.removed };
        }
      if (migration.removed) settings.hooks.SessionStart = migration.next;
      const hasHook = settings.hooks.SessionStart.some(
        (entry) => entry?.matcher === hookMatcher && entry?.hooks?.some((hook) => equal(hook, managedHook)),
      );
      const createdHook = !hasHook;
      const needsOwnershipMigration =
        manifest.claudeSettings &&
        (!Object.hasOwn(manifest.claudeSettings, 'hookOwned') || !Object.hasOwn(manifest.claudeSettings, 'hookMatcher'));
      if (missing.length || staleOwned.length || migration.removed || createdHook) {
        settings.permissions.allow.push(...missing);
        if (createdHook) settings.hooks.SessionStart.push({ matcher: hookMatcher, hooks: [managedHook] });
        await atomic(claudeSettings, JSON.stringify(settings, null, 2) + '\n');
        changed.push(claudeSettings);
      }
      if (missing.length || staleOwned.length || migration.removed || createdHook || needsOwnershipMigration) {
        // A canonical hook already in the target entry can be user-owned.
        // Migrating a different recorded legacy command must not transfer that
        // ownership merely because the desired command was already present.
        const ownsCurrent = createdHook || (oldHookOwned && recordedHookCommand === hookCommand && recordedMatcher === hookMatcher);
        manifest.claudeSettings = {
          hookCommand,
          hookMatcher,
          hookOwned: ownsCurrent,
          rules: [...new Set([...(manifest.claudeSettings?.rules || []).filter((rule) => !oldMutatingRules.has(rule)), ...missing])],
        };
      }
    } catch {
      throw new Error(`refusing invalid Claude settings JSON: ${claudeSettings}`);
    }
  } else if (selected.has('claude') && existingSettings) {
    try {
      const settings = claudeSettingsState;
      const rules = new Set(manifest.claudeSettings?.rules || []);
      const hookCommand =
        manifest.claudeSettings?.hookCommand ||
        `${shellQuote(process.execPath, platform)} ${shellQuote(join(root, 'install.mjs'), platform)} --doctor-hook`;
      let dirty = false;
      const managedHook = { type: 'command', command: hookCommand };
      if (Array.isArray(settings.permissions?.allow)) {
        const next = settings.permissions.allow.filter((rule) => !rules.has(rule));
        dirty ||= next.length !== settings.permissions.allow.length;
        settings.permissions.allow = next;
      }
      const hookOwned =
        manifest.claudeSettings?.hookOwned === true ||
        (manifest.claudeSettings?.hookOwned === undefined && manifest.claudeSettings?.hookCommand === hookCommand);
      if (hookOwned && Array.isArray(settings.hooks?.SessionStart)) {
        const recordedMatcher = typeof manifest.claudeSettings?.hookMatcher === 'string' ? manifest.claudeSettings.hookMatcher : undefined;
        let removal = { next: settings.hooks.SessionStart, removed: false };
        for (const matcher of recordedMatcher ? [recordedMatcher] : ['', 'startup']) {
          const next = removeExactSessionHook(removal.next, managedHook, matcher);
          removal = { next: next.next, removed: removal.removed || next.removed };
        }
        dirty ||= removal.removed;
        settings.hooks.SessionStart = removal.next;
      }
      // Permissions and the hook have separate lifecycles: a user can remove
      // the hook without thereby claiming installer-added approvals.
      delete manifest.claudeSettings;
      if (dirty) {
        await atomic(claudeSettings, JSON.stringify(settings, null, 2) + '\n');
        changed.push(claudeSettings);
      }
    } catch {
      throw new Error(`refusing invalid Claude settings JSON: ${claudeSettings}`);
    }
  }
  const configPath = join(configHome, 'offload', 'config.json');
  if (!uninstall && !(await exists(configPath))) {
    await atomic(configPath, artifactContents.get(join(root, 'config.example.json')));
    changed.push(configPath);
  }
  let key = { stored: false };
  if (!uninstall && keyPrompt) {
    let keyRef;
    try {
      const loaded = loadConfig({ configPath, repoPath: undefined });
      const profile = loaded.config.profiles[loaded.config.default];
      keyRef = loaded.config.providers[profile.provider].keyRef;
    } catch {}
    let parsedRef;
    try {
      parsedRef = parseKeyRef(keyRef);
    } catch {}
    let present = false;
    try {
      present = !!parsedRef && !!resolveKeyRef(keyRef, { env });
    } catch {}
    if (!parsedRef) key = { stored: false, reason: 'configured key reference is unavailable' };
    else if (parsedRef.kind !== 'keychain') key = { stored: false, reason: `configure ${parsedRef.kind}: key reference manually` };
    else
      key =
        present && !replaceKey
          ? { stored: false, reason: 'already configured' }
          : await keychain({
              service: parsedRef.value,
              prompt: keyPrompt,
              platform,
              macosInteractive: platform === 'darwin' && keyPrompt === promptNoEcho && stdin.isTTY,
            });
  }
  if (
    uninstall &&
    !Object.keys(manifest.registrations).length &&
    !Object.keys(manifest.files).length &&
    !manifest.claudeSettings &&
    !Object.keys(manifest.plugins).length
  )
    await rm(manifestPath, { force: true });
  else {
    if (uninstall) delete manifest.runtime;
    else if (installedRuntime)
      manifest.runtime = {
        version: installedRuntime.version,
        buildHash: installedRuntime.buildHash,
        skillHash: installedRuntime.skillHash,
        schemaRevision: installedRuntime.schemaRevision,
      };
    await atomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  const runtimeChanged =
    !!installedRuntime &&
    ((!!previousRuntime &&
      (previousRuntime.buildHash !== installedRuntime.buildHash || previousRuntime.skillHash !== installedRuntime.skillHash)) ||
      (!previousRuntime && hadManagedInstallation));
  const restart = runtimeChanged
    ? {
        required: true,
        reason: 'offload runtime artifacts changed',
        action:
          'Restart Claude Code or the MCP client to load the updated Offload server and skill. The installer does not kill live processes.',
      }
    : { required: false };
  return {
    changed,
    backups,
    skippedCursorConfig: !!currentCursor && currentCursor !== cursorJson(root),
    configPath,
    key,
    plugin,
    claudeMcp,
    ...(installedRuntime ? { runtime: installedRuntime } : {}),
    restart,
  };
}
export { doctor, doctorLive };
if (isMainModule()) {
  const args = parseInstallerArgs(process.argv.slice(2));
  if (args.doctorHook) {
    const result = doctor({ root: here });
    console.log(
      `offload: node ${result.nodeOk ? 'ok' : 'bad'} · git ${result.git ? 'ok' : 'missing'} · key ${result.key.ok ? 'ok' : 'missing'} · sandbox ${result.sandboxReason} · runtime ${result.server.version} ${result.server.buildHash.slice(0, 19)} schema ${result.server.schemaRevision} · report/inputFiles ${result.server.capabilities.reportMode && result.server.capabilities.inputFiles ? 'yes' : 'no'} · restart the MCP client after updates`,
    );
    process.exitCode = result.nodeOk && result.git ? 0 : 2;
  } else {
    const result = await install({
      uninstall: args.uninstall,
      keyPrompt: args.skipKey ? undefined : promptNoEcho,
      clients: args.clients,
      replaceKey: args.replaceKey,
    });
    const checked = doctor({ root: here });
    console.log(JSON.stringify({ ...result, doctor: checked }, null, 2));
    if (result.restart.required) console.error(`offload: ${result.restart.action}`);
    if (!checked.nodeOk || !checked.git) process.exitCode = 2;
  }
}
