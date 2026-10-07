import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, ConfigError, loadConfig, validateConfig } from '../../src/config.mjs';
import { OpenAIChatProvider } from '../../src/provider/openai-chat.mjs';
import { loadPricing } from '../../src/pricing-registry.mjs';
import { OFFLOAD_DEEPSEEK_MODEL, assertModelAllowed, isProModel, modelPolicyViolation } from '../../src/model-policy.mjs';
import { cleanup, tempDir, write } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const PRO_SPELLINGS = [
  'deepseek-v4-pro',
  'DeepSeek-V4-Pro',
  'DEEPSEEK-V4-PRO-0813',
  'deepseek_v4_pro',
  'deepseek.v4.pro',
  'deepseekv4pro',
  'deepseek-pro',
  'pro',
];

test('every spelling of a Pro model id is recognized, unrelated names are not', () => {
  for (const model of PRO_SPELLINGS) assert.equal(isProModel(model), true, model);
  for (const model of ['deepseek-flash', 'mock-model', 'test-model', 'professional-model', 'probe', 'deepseek-v4-flash'])
    assert.equal(isProModel(model), false, model);
  assert.equal(isProModel(undefined), false);
});

test('a DeepSeek endpoint accepts exactly deepseek-flash and nothing else', () => {
  for (const baseUrl of [
    'https://api.deepseek.com',
    'https://api.deepseek.com/v1',
    'https://API.DeepSeek.com:8443',
    'https://x.deepseek.com',
  ])
    assert.equal(modelPolicyViolation({ baseUrl, model: OFFLOAD_DEEPSEEK_MODEL }), undefined, baseUrl);
  for (const model of [...PRO_SPELLINGS, 'deepseek-reasoner', 'deepseek-chat', 'deepseek-v4-flash', 'unrecognized-model', ''])
    assert.ok(modelPolicyViolation({ baseUrl: 'https://api.deepseek.com', model }), model || '(empty)');
  assert.ok(modelPolicyViolation({ baseUrl: 'not a url', model: 'anything' }), 'an unparseable endpoint is treated as restricted');
});

test('other endpoints keep arbitrary model names but can never request a Pro model', () => {
  for (const baseUrl of ['http://127.0.0.1:9', 'https://proxy.example.test/v1', 'https://notdeepseek.com'])
    assert.equal(modelPolicyViolation({ baseUrl, model: 'mock-model' }), undefined, baseUrl);
  for (const model of PRO_SPELLINGS) assert.ok(modelPolicyViolation({ baseUrl: 'https://proxy.example.test/v1', model }), model);
  assert.throws(() => assertModelAllowed({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }), { code: 'E_MODEL_POLICY' });
});

test('shipped defaults and the example config expose only flash', () => {
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.profiles), ['flash']);
  assert.equal(DEFAULT_CONFIG.default, 'flash');
  const example = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8'));
  assert.deepEqual(Object.keys(example.profiles), ['flash']);
  assert.equal(example.default, 'flash');
  assert.doesNotThrow(() => validateConfig(structuredClone(example)));
});

test('configuration can never define a Pro profile, under any name or provider', () => {
  const withProfile = (profile, baseUrl = 'https://api.deepseek.com') => ({
    providers: { deepseek: { ...DEFAULT_CONFIG.providers.deepseek, baseUrl } },
    profiles: { renamed: profile },
    default: 'renamed',
    limits: DEFAULT_CONFIG.limits,
  });
  for (const model of PRO_SPELLINGS) {
    for (const baseUrl of ['https://api.deepseek.com', 'https://proxy.example.test/v1']) {
      assert.throws(
        () => validateConfig(withProfile({ provider: 'deepseek', model }, baseUrl)),
        (error) => error instanceof ConfigError && error.code === 'E_CONFIG_MODEL_POLICY',
        `${model} @ ${baseUrl}`,
      );
    }
  }
});

test('a user config that adds or restores a pro profile fails closed at load time', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    write(configPath, JSON.stringify({ profiles: { pro: { provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' } } }));
    assert.throws(() => loadConfig({ configPath }), { code: 'E_CONFIG_MODEL_POLICY' });
    write(configPath, JSON.stringify({ profiles: { flash: { provider: 'deepseek', model: 'deepseek-v4-pro' } } }));
    assert.throws(() => loadConfig({ configPath }), { code: 'E_CONFIG_MODEL_POLICY' }, 'overriding flash with Pro is the same violation');
  } finally {
    cleanup(dir);
  }
});

test('the provider refuses a Pro model at construction and as a per-request override, before any network call', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('data: [DONE]\n\n', { status: 200 });
  };
  for (const model of PRO_SPELLINGS) {
    assert.throws(() => new OpenAIChatProvider({ baseUrl: 'https://api.deepseek.com', model, fetchImpl }), { code: 'E_MODEL_POLICY' });
    assert.throws(() => new OpenAIChatProvider({ baseUrl: 'https://proxy.example.test', model, fetchImpl }), { code: 'E_MODEL_POLICY' });
  }
  const provider = new OpenAIChatProvider({ baseUrl: 'https://api.deepseek.com', model: OFFLOAD_DEEPSEEK_MODEL, retries: 0, fetchImpl });
  for (const model of ['deepseek-v4-pro', 'DeepSeek-V4-Pro', 'deepseek-reasoner'])
    await assert.rejects(
      async () => {
        for await (const _ of provider.chat({ messages: [], tools: [], model })) {
        }
      },
      /Offload model policy/,
      model,
    );
  assert.equal(calls, 0, 'a refused model must never reach fetch');
});

test('the shipped pricing table has no Pro entry, so a Pro response is unpriced and unauthorized', () => {
  const models = Object.keys(loadPricing('deepseek-2026-10-01').models);
  assert.deepEqual(models, ['deepseek-flash']);
});

test('no shipped source, skill, template, or config names a Pro model id', () => {
  const skip = new Set(['node_modules', '.git', 'coverage', 'artifacts']);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  for (const dir of ['src', 'plugins', 'templates']) walk(join(root, dir));
  files.push(join(root, 'config.example.json'));
  // The policy module documents the spellings it blocks; everything else must not mention one.
  const offenders = files
    .filter((file) => relative(root, file) !== join('src', 'model-policy.mjs'))
    .filter((file) => /deepseek[-_.]?v?\d*[-_.]?pro\b/i.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file));
  assert.deepEqual(offenders, []);
});
