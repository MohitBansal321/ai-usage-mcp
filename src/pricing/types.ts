/** Pricing is versioned *data*. These types describe its shape; the numbers live in ./tables. */

export interface ModelPrice {
  /** USD per 1,000,000 input tokens. */
  input: number;
  /** USD per 1,000,000 output tokens. */
  output: number;
  /** Optional premium rates (e.g. Claude Code "fast mode"), keyed by `usage.speed`. */
  fast?: { input: number; output: number };
  /**
   * Cache rates for this model, when they differ from the table default.
   *
   * Not a theoretical knob: OpenAI publishes a single cache-write price with no
   * 1-hour tier, so pricing its cache writes at Anthropic's 2x 1-hour multiplier
   * would overcharge them by 60%. Providers also disagree on the cache-read
   * discount -- DeepSeek's cache-hit rate is 0.02x its input rate, not 0.1x.
   * Without this, a provider could be added to the table only by being priced
   * wrongly.
   */
  cache?: CacheMultipliers;
}

export interface CacheMultipliers {
  /** Cache reads cost this multiple of the input price. */
  read: number;
  /** Cache writes with a 5-minute TTL. */
  write5m: number;
  /** Cache writes with a 1-hour TTL. */
  write1h: number;
}

export interface PricingTable {
  /** Table version -- appears in every estimated-cost explanation. */
  version: string;
  /** Where these numbers came from, and when they were captured. */
  provenance: string;
  currency: 'USD';
  unit: 'per_million_tokens';
  /** Applied to any model that does not carry its own {@link ModelPrice.cache}. */
  cacheMultipliers: CacheMultipliers;
  /**
   * Keyed by exact model id as the client records it.
   * A model absent from here yields `costBasis: 'unavailable'` -- never a guess.
   */
  models: Record<string, ModelPrice>;
}

/**
 * A user-supplied pricing file.
 *
 * Overlaid onto the built-in table by default, keyed by model id, so adding one
 * model does not silently discard every built-in price. Set `replace` when
 * starting from nothing is genuinely what you want -- previously that was the
 * only available behaviour, and it was not the one anybody wanted.
 */
export interface PricingOverride {
  /** Required. Names *your* table; it is what reports will cite. */
  version: string;
  provenance?: string;
  currency?: 'USD';
  unit?: 'per_million_tokens';
  /**
   * Discard the built-in table instead of overlaying onto it. Requires a
   * complete `cacheMultipliers`, since there is then no base to inherit from.
   */
  replace?: boolean;
  /** Overrides the built-in defaults for models that carry no `cache` of their own. */
  cacheMultipliers?: CacheMultipliers;
  models: Record<string, ModelPrice>;
}

/** How the table in force was assembled, for honest reporting in `ai-usage status`. */
export type PricingMode = 'builtin' | 'overlay' | 'replace';
