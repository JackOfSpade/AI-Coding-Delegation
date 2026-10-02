function clockIsPeak(table, now) {
  const peak = table.peak;
  if (!peak || !Array.isArray(peak.utc_windows)) return false;
  const weekdaysOnly = Array.isArray(peak.days)
    ? peak.days.includes('Mon-Fri')
    : typeof peak.days === 'string' && peak.days.includes('Mon-Fri');
  const day = now.getUTCDay();
  if (weekdaysOnly && (day === 0 || day === 6)) return false;
  const time = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  return peak.utc_windows.some(([start, end]) => time >= start && time < end);
}
const RATE_KINDS = ['input_cache_hit', 'input_cache_miss', 'output'];
const RATE_TIERS = ['off_peak', 'peak'];
export function validatePricingTable(table) {
  if (
    !table ||
    typeof table !== 'object' ||
    Array.isArray(table) ||
    !table.models ||
    typeof table.models !== 'object' ||
    Array.isArray(table.models)
  )
    throw new TypeError('pricing table must contain models');
  if (table.fetched_at !== undefined && (typeof table.fetched_at !== 'string' || Number.isNaN(Date.parse(table.fetched_at))))
    throw new TypeError('pricing fetched_at must be a date string');
  if (table.peak !== undefined) {
    if (!table.peak || typeof table.peak !== 'object' || Array.isArray(table.peak) || !Array.isArray(table.peak.utc_windows))
      throw new TypeError('pricing peak windows are invalid');
    for (const window of table.peak.utc_windows)
      if (
        !Array.isArray(window) ||
        window.length !== 2 ||
        !window.every((value) => typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) && value >= '00:00' && value <= '23:59') ||
        window[0] >= window[1]
      )
        throw new TypeError('pricing peak window is invalid');
    // Provider pages have used both a human-readable weekday note and the
    // compact array in our shipped table. Undefined means every UTC day; no
    // other day notation is implemented by the clock, so reject it instead
    // of accepting a table that will later misprice or throw.
    const days = table.peak.days;
    const supportedDescription = typeof days === 'string' && days.includes('Mon-Fri');
    const supportedArray = Array.isArray(days) && days.length === 1 && days[0] === 'Mon-Fri';
    if (days !== undefined && !supportedDescription && !supportedArray) throw new TypeError('pricing peak days are invalid');
  }
  for (const [model, spec] of Object.entries(table.models)) {
    if (!model || !spec || typeof spec !== 'object' || !spec.usd_per_1m || typeof spec.usd_per_1m !== 'object')
      throw new TypeError(`pricing model ${model || '(unnamed)'} is invalid`);
    for (const kind of RATE_KINDS)
      for (const tier of RATE_TIERS) {
        const rate = spec.usd_per_1m[kind]?.[tier];
        if (!Number.isFinite(rate) || rate < 0)
          throw new TypeError(`pricing rate ${model}.${kind}.${tier} must be finite and non-negative`);
      }
  }
  return table;
}
export function resolveModel(table, model) {
  if (!table || typeof table !== 'object' || !table.models || typeof table.models !== 'object' || typeof model !== 'string')
    return undefined;
  if (Object.hasOwn(table.models, model)) return table.models[model];
  // Fixture aliases can be explanatory prose rather than a canonical model
  // identifier. Only honor aliases that resolve to an actual table entry.
  const aliases = table.legacy_aliases;
  const alias = aliases && typeof aliases === 'object' && Object.hasOwn(aliases, model) ? aliases[model] : undefined;
  return typeof alias === 'string' && Object.hasOwn(table.models, alias) ? table.models[alias] : undefined;
}
/** True only when two identifiers resolve to the exact same priced entry.
 * This permits declared aliases without treating merely similar rate tables as
 * interchangeable budget authority. */
export function samePricedModel(table, left, right) {
  const leftName = canonicalModelName(table, left),
    rightName = canonicalModelName(table, right);
  return leftName !== undefined && leftName === rightName;
}
function canonicalModelName(table, model) {
  if (!table || typeof table !== 'object' || !table.models || typeof table.models !== 'object' || typeof model !== 'string')
    return undefined;
  if (Object.hasOwn(table.models, model)) return model;
  const aliases = table.legacy_aliases;
  const alias = aliases && typeof aliases === 'object' && Object.hasOwn(aliases, model) ? aliases[model] : undefined;
  return typeof alias === 'string' && Object.hasOwn(table.models, alias) ? alias : undefined;
}
export function priceUsage(table, model, usage, now = new Date()) {
  const spec = resolveModel(table, model);
  if (!spec) return { usd: 0, peak: false, known: false, unknown: true };
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('pricing time must be a valid Date');
  const rates = spec.usd_per_1m;
  const peak = clockIsPeak(table, now);
  const tier = peak ? 'peak' : 'off_peak';
  const hit = usage.cacheHitTokens ?? 0,
    miss = usage.cacheMissTokens ?? Math.max(0, (usage.inputTokens ?? 0) - hit),
    output = usage.outputTokens ?? 0;
  for (const [name, value] of Object.entries({ cacheHitTokens: hit, cacheMissTokens: miss, outputTokens: output }))
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`usage.${name} must be a non-negative safe integer`);
  if (
    usage.inputTokens !== undefined &&
    (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || hit + miss !== usage.inputTokens)
  )
    throw new TypeError('usage cache token counts must equal inputTokens');
  const inputCacheHitUsd = (hit * rates.input_cache_hit[tier]) / 1e6;
  const inputCacheMissUsd = (miss * rates.input_cache_miss[tier]) / 1e6;
  const outputUsd = (output * rates.output[tier]) / 1e6;
  const usd = inputCacheHitUsd + inputCacheMissUsd + outputUsd;
  if (![inputCacheHitUsd, inputCacheMissUsd, outputUsd, usd].every((value) => Number.isFinite(value) && value >= 0))
    throw new TypeError('priced usage is not finite');
  return { usd, peak, known: true, inputCacheHitUsd, inputCacheMissUsd, outputUsd };
}
export class Meter {
  constructor({ table, model, now = () => new Date() } = {}) {
    if (table) validatePricingTable(table);
    this.table = table;
    this.model = model;
    this.now = now;
    this.usage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
    this.usd = 0;
    this.unknownPricing = false;
    this.unknownPricingRecords = 0;
  }
  add(usage, model, at = this.now()) {
    if (!usage) return 0;
    const normalized = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheHitTokens: usage.cacheHitTokens ?? 0,
      cacheMissTokens: usage.cacheMissTokens ?? Math.max(0, (usage.inputTokens ?? 0) - (usage.cacheHitTokens ?? 0)),
    };
    for (const [key, value] of Object.entries(normalized))
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`usage.${key} must be a non-negative safe integer`);
    if (normalized.cacheHitTokens + normalized.cacheMissTokens !== normalized.inputTokens)
      throw new TypeError('usage cache token counts must equal inputTokens');
    // Usage is provider-controlled data. Do not allow individually valid
    // records to overflow the durable/accounting representation after they
    // are accumulated: an imprecise total could otherwise pass a later budget
    // comparison and authorize tool execution.
    const nextUsage = {};
    for (const key of Object.keys(this.usage)) {
      const value = this.usage[key] + normalized[key];
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('cumulative usage exceeds safe integer range');
      nextUsage[key] = value;
    }
    const p = this.table ? priceUsage(this.table, model ?? this.model, normalized, at) : { usd: 0, known: false, unknown: true };
    const nextUsd = this.usd + p.usd;
    if (!Number.isFinite(nextUsd) || nextUsd < 0) throw new TypeError('cumulative price is invalid');
    this.usage = nextUsage;
    this.usd = nextUsd;
    this.unknownPricingRecords += p.unknown ? 1 : 0;
    this.unknownPricing = this.unknownPricingRecords > 0;
    return p;
  }
  /** Reprice one already-counted usage record when model metadata arrived
   * after its aggregate usage chunk. Token totals do not change. */
  reprice(usage, previousModel, nextModel, at = this.now()) {
    if (!usage) throw new TypeError('usage is required');
    const previous = this.table ? priceUsage(this.table, previousModel ?? this.model, usage, at) : { usd: 0, known: false, unknown: true };
    const replacement = this.table ? priceUsage(this.table, nextModel ?? this.model, usage, at) : { usd: 0, known: false, unknown: true };
    let nextUsd = this.usd - previous.usd + replacement.usd;
    if (nextUsd < 0 && nextUsd > -Number.EPSILON) nextUsd = 0;
    if (!Number.isFinite(nextUsd) || nextUsd < 0) throw new TypeError('cumulative price is invalid');
    const nextUnknown = this.unknownPricingRecords - (previous.unknown ? 1 : 0) + (replacement.unknown ? 1 : 0);
    if (!Number.isSafeInteger(nextUnknown) || nextUnknown < 0) throw new TypeError('pricing record accounting is invalid');
    this.usd = nextUsd;
    this.unknownPricingRecords = nextUnknown;
    this.unknownPricing = nextUnknown > 0;
    return replacement;
  }
}
