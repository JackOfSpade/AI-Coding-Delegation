import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  providers: {
    deepseek: {
      type: 'openai-chat',
      baseUrl: 'https://api.deepseek.com',
      keyRef: 'keychain:offload-deepseek',
      pricing: 'deepseek-2026-10-01',
    },
  },
  profiles: {
    pro: { provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' },
    flash: { provider: 'deepseek', model: 'deepseek-flash' },
  },
  default: 'pro',
  limits: { maxTurns: 80, timeoutMinutes: 30, maxUsd: 2 },
});
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_PROVIDERS = 64;
const MAX_PROFILES = 128;
const MAX_NAME = 128;
const MAX_PATH_TEXT = 4096;
const BIGINT_STAT_OPTIONS = Object.freeze({ bigint: true });

export class ConfigError extends Error {
  constructor(message, code = 'E_CONFIG') {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

/**
 * Select the native per-user configuration location.  XDG_CONFIG_HOME wins on
 * every host so CI and portable setups remain predictable.  Windows otherwise
 * follows APPDATA rather than creating a Unix-style .config directory.
 * `platform` is injectable to make the host-specific contract testable.
 */
export function defaultConfigPath(env = process.env, home = homedir(), platform = process.platform) {
  if (platform === 'win32') {
    const path = win32;
    if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'offload', 'config.json');
    const base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'offload', 'config.json');
  }
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'offload', 'config.json');
  return join(home, '.config', 'offload', 'config.json');
}

export function deepMerge(base, override) {
  if (override === undefined) return structuredClone(base);
  if (!isPlainObject(base) || !isPlainObject(override)) return structuredClone(override);
  assertSafeKeys(override);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? deepMerge(result[key], value) : structuredClone(value);
  }
  return result;
}

/**
 * Read JSON through one checked descriptor. `rejectSymlink` is used for the
 * repository policy, which must never be redirected outside the checkout.
 * User-selected global config may remain a symlink, but still gets the same
 * descriptor/size race protection.
 */
export function parseJsonFile(filePath, label = 'config', { rejectSymlink = false, platform = process.platform, fs = defaultFs } = {}) {
  let fd;
  try {
    // Bigint Stats preserve nanosecond mtime/ctime.  A same-inode,
    // same-length in-place rewrite can otherwise evade the usual dev/ino/size
    // comparison on filesystems whose millisecond timestamps are rounded.
    const before = fs.lstatSync(filePath, BIGINT_STAT_OPTIONS);
    if ((!before.isFile() && !before.isSymbolicLink()) || (rejectSymlink && before.isSymbolicLink()))
      throw new ConfigError(`${label} must be a regular file`, 'E_CONFIG_FILE');
    // O_NOFOLLOW closes the final-component swap on POSIX. Windows has no
    // portable equivalent, so its fallback compares lstat/fstat identity.
    const noFollow = rejectSymlink && platform !== 'win32' ? fs.constants.O_NOFOLLOW || 0 : 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd, BIGINT_STAT_OPTIONS);
    const size = checkedConfigSize(opened.size);
    if (!opened.isFile() || size === undefined || size > MAX_CONFIG_BYTES || (rejectSymlink && !sameConfigMetadata(before, opened))) {
      throw new ConfigError(
        size !== undefined && size > MAX_CONFIG_BYTES
          ? `${label} exceeds ${MAX_CONFIG_BYTES} byte limit`
          : `${label} changed while opening`,
        size !== undefined && size > MAX_CONFIG_BYTES ? 'E_CONFIG_SIZE' : 'E_CONFIG_FILE',
      );
    }
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new ConfigError(`${label} changed while reading`, 'E_CONFIG_FILE');
      offset += count;
    }
    const after = fs.fstatSync(fd, BIGINT_STAT_OPTIONS);
    if (!after.isFile() || !sameConfigMetadata(opened, after)) throw new ConfigError(`${label} changed while reading`, 'E_CONFIG_FILE');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ConfigError(`Invalid UTF-8 in ${label}: ${filePath}`, 'E_CONFIG_JSON');
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ConfigError(`Invalid JSON in ${label}: ${filePath}`, 'E_CONFIG_JSON');
    if (rejectSymlink && ['ELOOP', 'EMLINK'].includes(error?.code))
      throw new ConfigError(`${label} must be a regular file`, 'E_CONFIG_FILE');
    throw error;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
}

export function validateConfig(config) {
  if (!isPlainObject(config)) throw new ConfigError('Config must be a JSON object');
  assertSafeKeys(config);
  assertAllowedKeys(config, ['providers', 'profiles', 'default', 'limits'], 'Config');
  for (const key of ['providers', 'profiles']) if (!isPlainObject(config[key])) throw new ConfigError(`Config.${key} must be an object`);
  assertSafeKeys(config.providers);
  assertSafeKeys(config.profiles);
  if (Object.keys(config.providers).length > MAX_PROVIDERS || Object.keys(config.profiles).length > MAX_PROFILES)
    throw new ConfigError('Config has too many providers or profiles', 'E_CONFIG_LIMIT');
  if (!boundedText(config.default, MAX_NAME)) throw new ConfigError('Config.default must be a non-empty profile name');
  if (!config.profiles[config.default]) throw new ConfigError(`Default profile does not exist: ${config.default}`);
  if (!isPlainObject(config.limits)) throw new ConfigError('Config.limits must be an object');
  assertSafeKeys(config.limits);
  assertAllowedKeys(config.limits, ['maxTurns', 'timeoutMinutes', 'maxUsd'], 'Config.limits');
  numeric(config.limits.maxTurns, 'limits.maxTurns', 1, 1000, true);
  numeric(config.limits.timeoutMinutes, 'limits.timeoutMinutes', 1, 1440);
  numeric(config.limits.maxUsd, 'limits.maxUsd', 0, 10000);
  for (const [name, provider] of Object.entries(config.providers)) {
    if (
      !boundedText(name, MAX_NAME) ||
      !isPlainObject(provider) ||
      typeof provider.type !== 'string' ||
      typeof provider.baseUrl !== 'string' ||
      typeof provider.keyRef !== 'string'
    ) {
      throw new ConfigError(`Provider ${name} requires type, baseUrl, and keyRef`);
    }
    assertSafeKeys(provider);
    assertAllowedKeys(provider, ['type', 'baseUrl', 'keyRef', 'pricing', 'pricingFile'], `Provider ${name}`);
    if (provider.type !== 'openai-chat' || !safeProviderUrl(provider.baseUrl) || !safeKeyRef(provider.keyRef))
      throw new ConfigError(`Provider ${name} has invalid connection settings`, 'E_CONFIG_PROVIDER');
    if (provider.pricing !== undefined && !boundedText(provider.pricing, MAX_NAME))
      throw new ConfigError(`Provider ${name}.pricing must be a bounded string`, 'E_CONFIG_PROVIDER');
    if (provider.pricingFile !== undefined && !boundedText(provider.pricingFile, MAX_PATH_TEXT))
      throw new ConfigError(`Provider ${name}.pricingFile must be a bounded path string`, 'E_CONFIG_PROVIDER');
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (
      !boundedText(name, MAX_NAME) ||
      !isPlainObject(profile) ||
      !boundedText(profile.provider, MAX_NAME) ||
      !boundedText(profile.model, MAX_NAME)
    )
      throw new ConfigError(`Profile ${name} requires provider and model`);
    assertSafeKeys(profile);
    assertAllowedKeys(profile, ['provider', 'model', 'effort'], `Profile ${name}`);
    if (!config.providers[profile.provider]) throw new ConfigError(`Profile ${name} refers to unknown provider: ${profile.provider}`);
    if (profile.effort !== undefined && !['normal', 'high'].includes(profile.effort))
      throw new ConfigError(`Profile ${name}.effort must be normal or high`);
  }
  return config;
}

export function validateRepoConfig(config) {
  if (!isPlainObject(config)) throw new ConfigError('Repository config must be a JSON object', 'E_REPO_CONFIG');
  assertSafeKeys(config);
  const allowed = new Set(['testCommand', 'denyRead', 'disabled']);
  for (const key of Object.keys(config))
    if (!allowed.has(key)) throw new ConfigError(`Unknown repository config key: ${key}`, 'E_REPO_CONFIG');
  if (config.disabled !== undefined && typeof config.disabled !== 'boolean')
    throw new ConfigError('Repository config.disabled must be boolean', 'E_REPO_CONFIG');
  if (config.testCommand !== undefined && !boundedText(config.testCommand, 8192))
    throw new ConfigError('Repository config.testCommand must be a bounded string', 'E_REPO_CONFIG');
  if (
    config.denyRead !== undefined &&
    (!Array.isArray(config.denyRead) || config.denyRead.length > 128 || config.denyRead.some((x) => !boundedText(x, MAX_PATH_TEXT)))
  )
    throw new ConfigError('Repository config.denyRead must be a bounded array of strings', 'E_REPO_CONFIG');
  return config;
}

/** Load global config and the optional, deliberately narrow repository override. */
export function loadConfig({ configPath, repoPath, requireConfig = false, env = process.env } = {}) {
  configPath ||= defaultConfigPath(env);
  let user = {};
  if (existsSync(configPath)) user = parseJsonFile(configPath, 'config');
  else if (requireConfig) throw new ConfigError(`Config file not found: ${configPath}`, 'E_CONFIG_MISSING');
  const config = validateConfig(deepMerge(DEFAULT_CONFIG, user));
  let repoConfig = {};
  if (repoPath) {
    const file = join(resolve(repoPath), '.offload.json');
    if (existsSync(file)) {
      // Repo policy affects command execution. Its read opens exactly the
      // lstat-checked file and fails closed on a final-component link swap.
      try {
        repoConfig = validateRepoConfig(parseJsonFile(file, 'repository config', { rejectSymlink: true }));
      } catch (error) {
        if (error?.code === 'E_CONFIG_FILE')
          throw new ConfigError(`Repository config must be a regular in-repository file: ${file}`, 'E_REPO_CONFIG');
        throw error;
      }
    }
  }
  return { config, repoConfig, disabled: repoConfig.disabled === true, configPath: resolve(configPath) };
}

export function resolveConfigRelativePath(value, configPath) {
  return isAbsolute(value) ? value : resolve(dirname(configPath), value);
}

function numeric(value, name, minimum, maximum, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value)))
    throw new ConfigError(`Config.${name} must be a finite ${integer ? 'integer' : 'number'} between ${minimum} and ${maximum}`);
}
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function boundedText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\0\r\n]/.test(value);
}
function assertSafeKeys(value) {
  for (const key of Object.keys(value))
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      throw new ConfigError(`Unsafe config key: ${key}`, 'E_CONFIG_KEY');
}
function assertAllowedKeys(value, keys, label) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new ConfigError(`${label} has unknown key: ${key}`, 'E_CONFIG_KEY');
}
function safeKeyRef(value) {
  if (!boundedText(value, MAX_PATH_TEXT)) return false;
  if (/^(?:env:[A-Za-z_][A-Za-z0-9_]*|keychain:[^\x00-\x1f\x7f]{1,256})$/.test(value)) return true;
  return value.startsWith('file:') && !/[\x00-\x1f\x7f]/.test(value.slice(5)) && isAbsolute(value.slice(5));
}
function safeProviderUrl(value) {
  if (!boundedText(value, 2048)) return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

function checkedConfigSize(value) {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(value);
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function sameConfigMetadata(first, second) {
  return (
    ['dev', 'ino', 'size', 'mode'].every((name) => sameStatValue(first?.[name], second?.[name])) &&
    sameTimestamp(first, second, 'mtime') &&
    sameTimestamp(first, second, 'ctime')
  );
}
function sameStatValue(first, second) {
  if (first === second) return true;
  if (typeof first === 'bigint' && Number.isSafeInteger(second)) return first === BigInt(second);
  if (typeof second === 'bigint' && Number.isSafeInteger(first)) return BigInt(first) === second;
  return false;
}
function sameTimestamp(first, second, name) {
  const left = statTimestamp(first, name),
    right = statTimestamp(second, name);
  return left !== undefined && right !== undefined && sameStatValue(left, right);
}
function statTimestamp(details, name) {
  const nanoseconds = details?.[`${name}Ns`];
  if (typeof nanoseconds === 'bigint') return nanoseconds;
  const milliseconds = details?.[`${name}Ms`];
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds)) return milliseconds;
  const date = details?.[name];
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : undefined;
}

const defaultFs = Object.freeze({ constants, lstatSync, openSync, fstatSync, readSync, closeSync });
