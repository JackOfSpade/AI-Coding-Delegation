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

// Current Claude Sonnet 5.5 public rates, transcribed on 2026-10-12. We do
// not send cache-control directives, so cache writes are never requested; any
// input that is not a cache read is conservatively billed at the base rate.
const ANTHROPIC_SONNET_2026_10_12 = deepFreeze({
  fetched_at: '2026-10-12T00:00Z',
  sources: ['https://platform.claude.com/docs/models/overview'],
  models: {
    'claude-sonnet-5-5': {
      usd_per_1m: {
        input_cache_hit: { off_peak: 0.2, peak: 0.2 },
        input_cache_miss: { off_peak: 2, peak: 2 },
        output: { off_peak: 10, peak: 10 },
      },
    },
  },
});

const ANTHROPIC_2026_10_19 = deepFreeze({
  fetched_at: '2026-10-19T00:00Z',
  sources: ['https://platform.claude.com/docs/en/about-claude/pricing'],
  models: {
    'claude-sonnet-5-5': {
      usd_per_1m: {
        input_cache_hit: { off_peak: 0.1, peak: 0.1 },
        input_cache_miss: { off_peak: 2, peak: 2 },
        output: { off_peak: 10, peak: 10 },
      },
    },
    'claude-opus-5-5': {
      usd_per_1m: {
        input_cache_hit: { off_peak: 0.2, peak: 0.2 },
        input_cache_miss: { off_peak: 4, peak: 4 },
        output: { off_peak: 20, peak: 20 },
      },
    },
  },
});

const TABLES = Object.freeze({
  'anthropic-2026-10-19': ANTHROPIC_2026_10_19,
  'deepseek-2026-10-01': DEEPSEEK_2026_10_01,
  'anthropic-sonnet-2026-10-12': ANTHROPIC_SONNET_2026_10_12,
});

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
