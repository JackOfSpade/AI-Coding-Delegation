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

// Claude cache writes use the default five-minute TTL (1.25x base input).
// Cache reads, writes and ordinary input are metered separately.
const ANTHROPIC_SONNET_2026_10_12 = deepFreeze({
  fetched_at: '2026-10-12T00:00Z',
  sources: ['https://platform.claude.com/docs/models/overview'],
  models: {
    'claude-sonnet-5-5': {
      usd_per_1m: {
        input_cache_hit: { off_peak: 0.2, peak: 0.2 },
        input_cache_miss: { off_peak: 2, peak: 2 },
        input_cache_write: { off_peak: 2.5, peak: 2.5 },
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
        input_cache_write: { off_peak: 2.5, peak: 2.5 },
        output: { off_peak: 10, peak: 10 },
      },
    },
    'claude-opus-5-5': {
      usd_per_1m: {
        input_cache_hit: { off_peak: 0.2, peak: 0.2 },
        input_cache_miss: { off_peak: 4, peak: 4 },
        input_cache_write: { off_peak: 5, peak: 5 },
        output: { off_peak: 20, peak: 20 },
      },
    },
  },
});

const OPENAI_2026_10_26 = deepFreeze({
  fetched_at: '2026-10-26T00:00Z',
  sources: ['https://developers.openai.com/api/docs/pricing'],
  models: {
    'gpt-6.1-sol': {
      usd_per_1m: {
        input_cache_hit: { off_peak: 0.1, peak: 0.1 },
        input_cache_miss: { off_peak: 2, peak: 2 },
        input_cache_write: { off_peak: 2.5, peak: 2.5 },
        output: { off_peak: 10, peak: 10 },
      },
    },
    'gpt-6.1-terra': {
      usd_per_1m: {
        input_cache_hit: { off_peak: 0.05, peak: 0.05 },
        input_cache_miss: { off_peak: 1, peak: 1 },
        input_cache_write: { off_peak: 1.25, peak: 1.25 },
        output: { off_peak: 5, peak: 5 },
      },
    },
  },
});

const TABLES = Object.freeze({
  'openai-2026-10-26': OPENAI_2026_10_26,
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
