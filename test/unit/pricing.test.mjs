import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Meter, priceUsage, resolveModel, samePricedModel, validatePricingTable } from '../../src/pricing.mjs';
import { loadPricing } from '../../src/pricing-registry.mjs';

const table = JSON.parse(await readFile(new URL('../fixtures/deepseek-pricing-2026-10-01.json', import.meta.url)));
test('pricing accounts for cache hit, miss and output at UTC peak', () => {
  const p = priceUsage(
    table,
    'deepseek-v4-pro',
    { inputTokens: 100, cacheHitTokens: 20, cacheMissTokens: 80, outputTokens: 10 },
    new Date('2026-10-05T02:00:00Z'),
  );
  assert.equal(p.peak, true);
  assert.equal(p.usd, (20 * 0.044 + 80 * 1.32 + 10 * 3.96) / 1e6);
  assert.equal(priceUsage(table, 'deepseek-v4-pro', { inputTokens: 1 }, new Date('2026-10-04T02:00:00Z')).peak, false);
});
test('meter accumulates normalized provider usage', () => {
  const meter = new Meter({ table, model: 'deepseek-flash', now: () => new Date('2026-10-05T02:00:00Z') });
  meter.add({ inputTokens: 11, outputTokens: 2, cacheHitTokens: 4, cacheMissTokens: 7 });
  meter.add({ inputTokens: 1, outputTokens: 3, cacheHitTokens: 1, cacheMissTokens: 0 });
  assert.deepEqual(meter.usage, { inputTokens: 12, outputTokens: 5, cacheHitTokens: 5, cacheMissTokens: 7 });
  assert.ok(meter.usd > 0);
});
test('meter rejects cumulative usage that would lose integer precision', () => {
  const meter = new Meter({ model: 'unpriced' });
  meter.add({ inputTokens: Number.MAX_SAFE_INTEGER - 1, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: Number.MAX_SAFE_INTEGER - 1 });
  assert.throws(() => meter.add({ inputTokens: 2, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 2 }), /cumulative usage/);
});
test('prose legacy aliases are not silently treated as priced models', () => {
  const price = priceUsage(table, 'deepseek-v4-flash', { inputTokens: 1 });
  assert.equal(price.known, false);
  assert.equal(price.unknown, true);
  const meter = new Meter({ table, model: 'unknown-model' });
  meter.add({ inputTokens: 1 });
  assert.equal(meter.unknownPricing, true);
});

test('meter rejects malformed or inconsistent token accounting', () => {
  const meter = new Meter({ table, model: 'deepseek-flash' });
  assert.throws(() => meter.add({ inputTokens: 2, cacheHitTokens: 1, cacheMissTokens: 0 }), /equal inputTokens/);
  assert.throws(() => meter.add({ inputTokens: 1, outputTokens: -1 }), /non-negative/);
});
test('pricing tables reject missing, non-finite, and negative rates', () => {
  assert.doesNotThrow(() => validatePricingTable(table));
  const broken = structuredClone(table);
  delete broken.models['deepseek-flash'].usd_per_1m.output.peak;
  assert.throws(() => validatePricingTable(broken), /rate/);
  const negative = structuredClone(table);
  negative.models['deepseek-flash'].usd_per_1m.output.peak = -1;
  assert.throws(() => new Meter({ table: negative, model: 'deepseek-flash' }), /non-negative/);
});
test('accepted peak-day schedules are safe to meter and unsupported shapes fail early', () => {
  for (const days of [undefined, 'Mon-Fri (UTC date of the window)', ['Mon-Fri']]) {
    const accepted = structuredClone(table);
    if (days === undefined) delete accepted.peak.days;
    else accepted.peak.days = days;
    assert.doesNotThrow(() => validatePricingTable(accepted));
    assert.doesNotThrow(() => priceUsage(accepted, 'deepseek-v4-pro', { inputTokens: 1 }, new Date('2026-10-05T02:00:00Z')));
  }
  for (const days of [5, {}, [], ['Tue'], ['Mon-Fri', 'Tue']]) {
    const broken = structuredClone(table);
    broken.peak.days = days;
    assert.throws(() => validatePricingTable(broken), /peak days/);
  }
});
test('model and alias lookup never resolves inherited object properties', () => {
  const spec = {
    usd_per_1m: { input_cache_hit: { off_peak: 0, peak: 0 }, input_cache_miss: { off_peak: 0, peak: 0 }, output: { off_peak: 0, peak: 0 } },
  };
  const table = { models: {}, legacy_aliases: {} };
  assert.equal(resolveModel(table, 'toString'), undefined);
  assert.equal(resolveModel(table, '__proto__'), undefined);
  Object.setPrototypeOf(table.models, { inherited: spec });
  Object.setPrototypeOf(table.legacy_aliases, { inheritedAlias: 'inherited' });
  assert.equal(resolveModel(table, 'inherited'), undefined);
  assert.equal(resolveModel(table, 'inheritedAlias'), undefined);
  table.models.owned = spec;
  table.legacy_aliases.ownedAlias = 'owned';
  assert.equal(resolveModel(table, 'ownedAlias'), spec);
});
test('budget model authorization uses canonical names, not mutable object identity', () => {
  const spec = {
    usd_per_1m: { input_cache_hit: { off_peak: 0, peak: 0 }, input_cache_miss: { off_peak: 1, peak: 1 }, output: { off_peak: 1, peak: 1 } },
  };
  const aliases = { models: { canonical: spec }, legacy_aliases: { legacy: 'canonical' } };
  assert.equal(samePricedModel(aliases, 'legacy', 'canonical'), true);
  assert.equal(samePricedModel({ models: { requested: spec, substituted: spec } }, 'requested', 'substituted'), false);
});
test('pricing rejects invalid clocks and finite rates that overflow arithmetic', () => {
  assert.throws(() => priceUsage(table, 'deepseek-flash', { inputTokens: 1 }, new Date('invalid')), /valid Date/);
  const enormous = structuredClone(table);
  enormous.models['deepseek-flash'].usd_per_1m.output.off_peak = Number.MAX_VALUE;
  assert.throws(
    () =>
      priceUsage(enormous, 'deepseek-flash', { inputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER }, new Date('2026-10-04T02:00:00Z')),
    /not finite/,
  );
});
test('shipped pricing tables cannot be mutated through the registry', () => {
  const shipped = loadPricing('deepseek-2026-10-01');
  assert.throws(() => {
    shipped.models['deepseek-flash'].usd_per_1m.output.off_peak = 999;
  }, TypeError);
  assert.equal(loadPricing('deepseek-2026-10-01').models['deepseek-flash'].usd_per_1m.output.off_peak, 0.6);
});
