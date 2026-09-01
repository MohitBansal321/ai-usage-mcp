/** Pricing is versioned *data*. These types describe its shape; the numbers live in ./tables. */

export interface ModelPrice {
  /** USD per 1,000,000 input tokens. */
  input: number;
  /** USD per 1,000,000 output tokens. */
  output: number;
  /** Optional premium rates (e.g. Claude Code "fast mode"), keyed by `usage.speed`. */
  fast?: { input: number; output: number };
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
  cacheMultipliers: CacheMultipliers;
  /**
   * Keyed by exact model id as the client records it.
   * A model absent from here yields `costBasis: 'unavailable'` -- never a guess.
   */
  models: Record<string, ModelPrice>;
}
