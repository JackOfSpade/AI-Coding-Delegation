#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

// These hooks can execute while a consumer installs this package or while it is packed/published.
// Keep the published artifact declarative: this project has an explicit installer instead.
export const FORBIDDEN_LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'prepublishOnly',
  'prepack',
  'postpack',
  'preversion',
  'version',
  'postversion',
  'preuninstall',
  'uninstall',
  'postuninstall',
  'predependencies',
  'dependencies',
  'postdependencies',
]);

export function forbiddenLifecycleScripts(manifest) {
  return Object.keys(manifest.scripts || {})
    .filter((name) => FORBIDDEN_LIFECYCLE_SCRIPTS.has(name))
    .sort();
}

// Match the runtime read-deny conventions, but only for paths that would be
// dangerous to distribute. The narrow credential extension match deliberately
// permits ordinary source names such as `src/credentials.ts`.
export const FORBIDDEN_PACKAGE_PATH =
  /(?:^|\/)(?:\.env[^/]*(?:$)|\.npmrc$|\.netrc$|\.pypirc$|\.git-credentials$|\.pgpass$|\.credentials(?:\/|$)|credentials(?:\/|$)|credentials?\.(?:json|ya?ml)$|id_(?:rsa|ecdsa|ed25519|dsa|xmss)[^/]*(?:$)|[^/]*\.(?:key|pem|p12|pfx|der|jks|keystore)$|[^/]*\.tfstate(?:\.backup)?$|\.(?:aws|ssh|azure|kube)(?:\/|$)|\.config\/gcloud(?:\/|$)|\.docker\/config\.json$|\.git(?:\/|$))/i;

export function isForbiddenPackagePath(path) {
  return typeof path === 'string' && FORBIDDEN_PACKAGE_PATH.test(path.replaceAll('\\', '/'));
}

const productionFields = ['dependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];
const offloadPluginFiles = [
  'plugins/offload/plugin.json',
  'plugins/offload/.codex-plugin/plugin.json',
  'plugins/offload/skills/offload/SKILL.md',
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Validate the common identity fields of the marketplace and Codex manifests.
 * The manifests intentionally differ beyond these fields: each serves a
 * separate plugin schema. The skill frontmatter is JSON (not YAML) because it
 * is also consumed directly by the MCP catalog.
 */
export function validateOffloadPluginArtifacts(marketplace, codex, skill) {
  const errors = [];
  if (!isPlainObject(marketplace)) errors.push('marketplace plugin manifest must be a JSON object');
  if (!isPlainObject(codex)) errors.push('Codex plugin manifest must be a JSON object');
  if (isPlainObject(marketplace) && isPlainObject(codex)) {
    for (const field of ['name', 'version', 'description']) {
      if (typeof marketplace[field] !== 'string' || !marketplace[field]) errors.push(`marketplace plugin manifest has invalid ${field}`);
      if (typeof codex[field] !== 'string' || !codex[field]) errors.push(`Codex plugin manifest has invalid ${field}`);
      if (marketplace[field] !== codex[field]) errors.push(`plugin manifest ${field} differs`);
    }
    const validAuthor = (author) => isPlainObject(author) && typeof author.name === 'string' && author.name.length > 0;
    if (!validAuthor(marketplace.author) || !validAuthor(codex.author) || marketplace.author.name !== codex.author.name)
      errors.push('plugin manifest author must have the same non-empty name');
    const validKeywords = (keywords) =>
      Array.isArray(keywords) &&
      keywords.length > 0 &&
      keywords.length <= 16 &&
      keywords.every((keyword) => typeof keyword === 'string' && keyword.length > 0);
    if (
      !validKeywords(marketplace.keywords) ||
      !validKeywords(codex.keywords) ||
      JSON.stringify(marketplace.keywords) !== JSON.stringify(codex.keywords)
    )
      errors.push('plugin manifest keywords must be the same bounded non-empty string array');
    if (codex.skills !== './skills/') errors.push('Codex plugin manifest must declare ./skills/');
  }
  const frontmatter = typeof skill === 'string' && /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill);
  if (!frontmatter) errors.push('plugin SKILL.md must start with JSON frontmatter');
  else {
    try {
      const metadata = JSON.parse(frontmatter[1]);
      if (
        !isPlainObject(metadata) ||
        typeof metadata.name !== 'string' ||
        !metadata.name ||
        typeof metadata.description !== 'string' ||
        !metadata.description
      )
        errors.push('plugin SKILL.md frontmatter requires non-empty name and description');
      else if (isPlainObject(marketplace) && metadata.name !== marketplace.name)
        errors.push('plugin SKILL.md name differs from plugin manifest');
    } catch {
      errors.push('plugin SKILL.md frontmatter must be strict JSON');
    }
  }
  return errors;
}

export function npmPackEnvironment(baseEnv, isolatedHome, cache, platform = process.platform) {
  // `npm pack` is a subprocess over untrusted package metadata. Do not pass
  // registry credentials, user npm configuration, or provider credentials to
  // it. The package is packed locally and does not need network access.
  const env = {
    PATH: platform === 'win32' ? (baseEnv.PATH ?? baseEnv.Path ?? '') : baseEnv.PATH || '',
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    npm_config_cache: cache,
    npm_config_userconfig: join(isolatedHome, 'empty-npmrc'),
    npm_config_globalconfig: join(isolatedHome, 'empty-global-npmrc'),
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_offline: 'true',
    NO_UPDATE_NOTIFIER: '1',
  };
  if (platform === 'win32')
    for (const key of ['Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) if (baseEnv[key]) env[key] = baseEnv[key];
  return env;
}

function isSafePackageTarget(value, allowBarePaths) {
  if (typeof value !== 'string' || !value || value.includes('\\')) return false;
  if (value.startsWith('./'))
    return !value
      .slice(2)
      .split('/')
      .some((part) => !part || part === '.' || part === '..');
  return (
    allowBarePaths &&
    !value.startsWith('/') &&
    !value.startsWith('../') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

export function collectPackageTargets(value, { field, allowBarePaths = false, compound = false, allowNull = false } = {}) {
  const targets = [];
  const invalid = [];
  const visit = (candidate) => {
    if (candidate === null && allowNull) return;
    if (typeof candidate === 'string') {
      if (!isSafePackageTarget(candidate, allowBarePaths)) invalid.push(`${field}: ${candidate}`);
      else targets.push(candidate.startsWith('./') ? candidate.slice(2) : candidate);
      return;
    }
    if (compound && Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (compound && candidate && typeof candidate === 'object') {
      Object.values(candidate).forEach(visit);
      return;
    }
    invalid.push(`${field}: ${String(candidate)}`);
  };
  if (value !== undefined) visit(value);
  return { targets, invalid };
}

export async function packageGate(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const cache = await mkdtemp(join(tmpdir(), 'offload-npm-pack-cache-'));
  let result;
  try {
    result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      env: npmPackEnvironment(process.env, cache, cache),
      windowsHide: true,
    });
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack --dry-run failed with exit ${result.status ?? 'unknown'}`);

  let packed;
  try {
    packed = JSON.parse(result.stdout);
  } catch {
    throw new Error('npm pack --dry-run returned invalid JSON');
  }
  const entry = packed[0];
  if (!entry || !Array.isArray(entry.files)) throw new Error('npm pack --dry-run did not describe package files');
  const files = entry.files.map((file) => file.path).sort();
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const productionDependencies = productionFields.flatMap((field) => {
    const value = manifest[field];
    if (Array.isArray(value)) return value.map((name) => `${field}:${name}`);
    return value && typeof value === 'object' ? Object.keys(value).map((name) => `${field}:${name}`) : [];
  });
  const targetGroups = [
    collectPackageTargets(manifest.bin, { field: 'bin', allowBarePaths: true, compound: true }),
    collectPackageTargets(manifest.exports, { field: 'exports', compound: true, allowNull: true }),
    collectPackageTargets(manifest.main, { field: 'main', allowBarePaths: true }),
    collectPackageTargets(manifest.module, { field: 'module', allowBarePaths: true }),
    collectPackageTargets(manifest.types, { field: 'types', allowBarePaths: true }),
    collectPackageTargets(manifest.man, { field: 'man', allowBarePaths: true, compound: true }),
  ];
  const required = [
    'install.mjs',
    'package.json',
    ...targetGroups.flatMap((group) => group.targets),
    ...(manifest.name === 'offload' ? offloadPluginFiles : []),
  ];
  const invalidPackageTargets = targetGroups.flatMap((group) => group.invalid);
  const lifecycleScripts = forbiddenLifecycleScripts(manifest);
  const uniqueRequired = [...new Set(required)].sort();
  const missing = uniqueRequired.filter((file) => !files.includes(file));
  const unexpected = files.filter(isForbiddenPackagePath);
  let pluginArtifacts = [];
  if (manifest.name === 'offload' && !missing.some((file) => offloadPluginFiles.includes(file))) {
    try {
      const [marketplace, codex, skill] = await Promise.all([
        readFile(join(root, offloadPluginFiles[0]), 'utf8').then(JSON.parse),
        readFile(join(root, offloadPluginFiles[1]), 'utf8').then(JSON.parse),
        readFile(join(root, offloadPluginFiles[2]), 'utf8'),
      ]);
      pluginArtifacts = validateOffloadPluginArtifacts(marketplace, codex, skill);
    } catch {
      pluginArtifacts = ['plugin artifacts must contain valid JSON manifests'];
    }
  }
  const summary = {
    fileCount: files.length,
    files,
    missing,
    unexpected,
    productionDependencies,
    lifecycleScripts,
    invalidPackageTargets,
    pluginArtifacts,
  };
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(join(root, 'artifacts', 'package-contents.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  if (
    missing.length ||
    unexpected.length ||
    productionDependencies.length ||
    lifecycleScripts.length ||
    invalidPackageTargets.length ||
    pluginArtifacts.length
  ) {
    throw new Error(
      `package gate failed: ${[
        missing.length && `missing ${missing.join(', ')}`,
        unexpected.length && `forbidden ${unexpected.join(', ')}`,
        productionDependencies.length && `production dependencies ${productionDependencies.join(', ')}`,
        lifecycleScripts.length && `forbidden lifecycle scripts ${lifecycleScripts.join(', ')}`,
        invalidPackageTargets.length && `invalid package targets ${invalidPackageTargets.join(', ')}`,
        pluginArtifacts.length && `invalid plugin artifacts ${pluginArtifacts.join(', ')}`,
      ]
        .filter(Boolean)
        .join('; ')}`,
    );
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await packageGate();
