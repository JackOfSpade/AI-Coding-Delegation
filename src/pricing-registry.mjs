/**
 * Shipped price tables keyed by the provider config's `pricing` identifier.
 * Values are a dated transcription of the cited provider pricing page; callers
 * should surface the table date rather than assuming it is current forever.
 */
const DEEPSEEK_2026_10_01 = deepFreeze({
  fetched_at: '2026-10-01T09:42Z',
  sources: ['https://api-docs.deepseek.com/quick_start/pricing'],
  peak: {
    utc_windows: [
      ['01:00', '04:00'],
      ['06:00', '10:00'],
    ],
    days: ['Mon-Fri'],
  },
  models: {
    'deepseek-flash': {
      usd_per_1m: {
        input_cache_hit: { off_peak: 0.003, peak: 0.006 },
        input_cache_miss: { off_peak: 0.15, peak: 0.3 },
        output: { off_peak: 0.6, peak: 1.2 },
      },
    },
  },
  legacy_aliases: {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  },
});

const TABLES = Object.freeze({ 'deepseek-2026-10-01': DEEPSEEK_2026_10_01 });

export function loadPricing(name) {
  return typeof name === 'string' ? TABLES[name] : undefined;
}

export const pricingNames = () => Object.keys(TABLES);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
