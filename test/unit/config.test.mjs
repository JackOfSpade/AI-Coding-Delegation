import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  ConfigError,
  deepMerge,
  defaultConfigPath,
  loadConfig,
  parseJsonFile,
  validateConfig,
  validateRepoConfig,
} from '../../src/config.mjs';
import { cleanup, tempDir } from './helpers.mjs';

test('config merges nested defaults and validates profile references', () => {
  assert.equal(DEFAULT_CONFIG.default, 'pro');
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.profiles).sort(), ['flash', 'pro']);
  assert.equal(DEFAULT_CONFIG.providers.deepseek.keyRef, 'keychain:offload-deepseek');
  assert.equal(DEFAULT_CONFIG.providers.deepseek.attemptTimeoutMs, 300_000);
  assert.equal(DEFAULT_CONFIG.profiles.pro.model, 'deepseek-v4-pro');
  const merged = deepMerge(DEFAULT_CONFIG, {
    limits: { maxTurns: 4 },
    providers: { x: { type: 'openai-chat', baseUrl: 'https://x.example.test', keyRef: 'env:X' } },
    profiles: { p: { provider: 'x', model: 'm' } },
    default: 'p',
  });
  assert.equal(merged.limits.timeoutMinutes, 30);
  assert.equal(validateConfig(merged).profiles.p.model, 'm');
  assert.throws(() => validateConfig({ ...merged, default: 'missing' }), /does not exist/);
  assert.throws(() => validateConfig({ ...merged, limits: { maxTurns: 0, timeoutMinutes: 1, maxUsd: 1 } }), ConfigError);
  assert.throws(() => validateConfig({ ...merged, limits: { maxTurns: 1.5, timeoutMinutes: 1, maxUsd: 1 } }), ConfigError);
  assert.throws(() => validateConfig({ ...merged, default: null }), ConfigError);
  assert.throws(
    () => validateConfig({ ...merged, unknown: true }),
    (error) => error.code === 'E_CONFIG_KEY',
  );
  assert.throws(
    () => validateConfig({ ...merged, limits: { ...merged.limits, maxUSd: 1 } }),
    (error) => error.code === 'E_CONFIG_KEY',
  );
  assert.throws(
    () =>
      validateConfig({ ...merged, providers: { ...merged.providers, x: { ...merged.providers.x, baseURL: 'https://typo.example.test' } } }),
    (error) => error.code === 'E_CONFIG_KEY',
  );
  assert.throws(
    () => validateConfig({ ...merged, profiles: { ...merged.profiles, p: { ...merged.profiles.p, modelName: 'typo' } } }),
    (error) => error.code === 'E_CONFIG_KEY',
  );
  assert.throws(
    () =>
      validateConfig({
        ...merged,
        providers: { ...merged.providers, evil: { type: 'openai-chat', baseUrl: 'http://example.test', keyRef: 'env:X' } },
      }),
    (error) => error.code === 'E_CONFIG_PROVIDER',
  );
  assert.equal(
    validateConfig({
      ...merged,
      providers: { ...merged.providers, x: { ...merged.providers.x, attemptTimeoutMs: 45_000 } },
    }).providers.x.attemptTimeoutMs,
    45_000,
  );
  for (const attemptTimeoutMs of [29_999, 600_001, 30_000.5, '300000'])
    assert.throws(
      () => validateConfig({ ...merged, providers: { ...merged.providers, x: { ...merged.providers.x, attemptTimeoutMs } } }),
      ConfigError,
    );
  assert.throws(
    () =>
      validateConfig({
        ...merged,
        providers: {
          ...merged.providers,
          evil: { type: 'openai-chat', baseUrl: 'https://example.test', keyRef: 'keychain:service\tforged' },
        },
      }),
    (error) => error.code === 'E_CONFIG_PROVIDER',
  );
  assert.throws(
    () =>
      validateConfig({
        ...merged,
        providers: {
          ...merged.providers,
          evil: { type: 'openai-chat', baseUrl: 'https://example.test', keyRef: 'file:/private/key\tforged' },
        },
      }),
    (error) => error.code === 'E_CONFIG_PROVIDER',
  );
  const malicious = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(
    () => deepMerge(DEFAULT_CONFIG, malicious),
    (error) => error.code === 'E_CONFIG_KEY',
  );
});
test('missing config receives the documented DeepSeek profiles', () => {
  const dir = tempDir();
  try {
    const result = loadConfig({ configPath: join(dir, 'absent.json') });
    assert.equal(result.config.default, 'pro');
    assert.equal(result.config.profiles.flash.model, 'deepseek-flash');
  } finally {
    cleanup(dir);
  }
});
test('config parser rejects an oversized file before JSON parsing', () => {
  const dir = tempDir();
  const file = join(dir, 'large.json');
  try {
    writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
    assert.throws(
      () => loadConfig({ configPath: file }),
      (error) => error.code === 'E_CONFIG_SIZE',
    );
  } finally {
    cleanup(dir);
  }
});
test('config path honors XDG everywhere and APPDATA on Windows', () => {
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: '/portable/config' }, '/home/a', 'linux'), '/portable/config/offload/config.json');
  assert.equal(
    defaultConfigPath({ APPDATA: 'C:\\Users\\A\\AppData\\Roaming' }, 'C:\\Users\\A', 'win32'),
    'C:\\Users\\A\\AppData\\Roaming\\offload\\config.json',
  );
  assert.equal(defaultConfigPath({}, 'C:\\Users\\A', 'win32'), 'C:\\Users\\A\\AppData\\Roaming\\offload\\config.json');
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: 'D:\\portable' }, 'C:\\Users\\A', 'win32'), 'D:\\portable\\offload\\config.json');
});
test('loadConfig reads optional repo settings and honors disabled', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: { x: { type: 'openai-chat', baseUrl: 'https://x', keyRef: 'env:X' } },
        profiles: { p: { provider: 'x', model: 'x' } },
        default: 'p',
      }),
    );
    writeFileSync(join(dir, '.offload.json'), JSON.stringify({ disabled: true, denyRead: ['secrets/**'] }));
    const result = loadConfig({ configPath, repoPath: dir });
    assert.equal(result.disabled, true);
    assert.deepEqual(result.repoConfig.denyRead, ['secrets/**']);
  } finally {
    cleanup(dir);
  }
});
test('repo config is intentionally narrow', () => {
  assert.throws(() => validateRepoConfig({ providers: {} }), /Unknown/);
  assert.throws(() => validateRepoConfig({ extraWritable: ['build/**'] }), /Unknown repository config key: extraWritable/);
  assert.throws(() => validateRepoConfig({ disabled: 'yes' }), ConfigError);
});
test(
  'repository config cannot be a symlink to host policy',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  () => {
    const dir = tempDir(),
      outside = tempDir();
    try {
      writeFileSync(join(outside, 'policy.json'), JSON.stringify({ disabled: true }));
      symlinkSync(join(outside, 'policy.json'), join(dir, '.offload.json'));
      assert.throws(() => loadConfig({ configPath: join(dir, 'missing.json'), repoPath: dir }), /regular in-repository file/);
    } finally {
      cleanup(dir);
      cleanup(outside);
    }
  },
);
test(
  'repository policy read rejects a deterministic regular-file to symlink swap',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  () => {
    const dir = tempDir(),
      outside = tempDir(),
      file = join(dir, '.offload.json');
    try {
      writeFileSync(file, '{"disabled":false}');
      writeFileSync(join(outside, 'policy.json'), '{"disabled":true}');
      let swapped = false;
      const fs = {
        constants: nodeFs.constants,
        lstatSync: nodeFs.lstatSync,
        fstatSync: nodeFs.fstatSync,
        readSync: nodeFs.readSync,
        closeSync: nodeFs.closeSync,
        openSync(path, flags) {
          if (!swapped) {
            swapped = true;
            nodeFs.rmSync(path);
            nodeFs.symlinkSync(join(outside, 'policy.json'), path);
          }
          return nodeFs.openSync(path, flags);
        },
      };
      // Simulate Windows' identity-check fallback even on a POSIX test host;
      // it must reject the opened symlink target without O_NOFOLLOW.
      assert.throws(
        () => parseJsonFile(file, 'repository config', { rejectSymlink: true, platform: 'win32', fs }),
        (error) => error.code === 'E_CONFIG_FILE',
      );
    } finally {
      cleanup(dir);
      cleanup(outside);
    }
  },
);
test('config parser rejects a same-inode same-size rewrite detected only by nanosecond metadata', () => {
  const content = '{"disabled":false}';
  const metadata = (overrides) => ({
    dev: 1n,
    ino: 2n,
    mode: 0o100600n,
    size: BigInt(Buffer.byteLength(content)),
    mtimeNs: 4_000_000_001n,
    ctimeNs: 4_000_000_001n,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  });
  const before = metadata();
  const after = metadata({ mtimeNs: before.mtimeNs + 1n, ctimeNs: before.ctimeNs + 1n });
  let fstats = 0;
  const fs = {
    constants: nodeFs.constants,
    lstatSync: () => before,
    openSync: () => 7,
    fstatSync: () => (++fstats === 1 ? before : after),
    readSync: (_fd, bytes, offset, length) => {
      Buffer.from(content).copy(bytes, offset, 0, length);
      return length;
    },
    closeSync: () => {},
  };
  assert.throws(
    () => parseJsonFile('/private/offload-config-race.json', 'repository config', { rejectSymlink: true, fs }),
    (error) => error.code === 'E_CONFIG_FILE',
  );
});
test(
  'an explicitly selected user config may remain a symlink',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  () => {
    const dir = tempDir(),
      outside = tempDir();
    try {
      const target = join(outside, 'config.json'),
        link = join(dir, 'config.json');
      writeFileSync(target, '{"limits":{"maxTurns":3}}');
      symlinkSync(target, link);
      assert.equal(loadConfig({ configPath: link }).config.limits.maxTurns, 3);
    } finally {
      cleanup(dir);
      cleanup(outside);
    }
  },
);
