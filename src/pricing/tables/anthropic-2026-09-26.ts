import type { PricingTable } from '../types.js';

/**
 * Anthropic first-party API list prices.
 *
 * Captured 2026-09-26 (first captured 2026-06-24; every earlier rate re-checked
 * and unchanged). These are API list rates, used only to produce an
 * "API-equivalent estimated cost" for Claude Code, which records no cost of its
 * own. A Claude Pro/Max subscriber's marginal cost per request is $0 -- see the
 * cost policy in README.md.
 *
 * Cache multipliers: reads bill at 0.1x the input rate; writes at 1.25x (5-minute
 * TTL) or 2x (1-hour TTL). Both TTLs occur heavily in real transcripts, so they
 * are priced separately rather than averaged. The newest models discount cache
 * reads further and carry their own `cache` below.
 *
 * Partner platforms (Bedrock, Vertex) have separate pricing and are not modelled.
 */
export const anthropicPricing: PricingTable = {
  version: 'anthropic-2026-09-26',
  provenance: 'Anthropic first-party API list pricing, captured 2026-09-26',
  currency: 'USD',
  unit: 'per_million_tokens',
  cacheMultipliers: {
    read: 0.1,
    write5m: 1.25,
    write1h: 2.0,
  },
  models: {
    // Cache reads at $0.25/MTok -- 0.025x, a quarter of Fable 5's. Inheriting the
    // 0.1x default would overstate them fourfold, and on a Claude Code session
    // cache reads are most of the tokens.
    'claude-fable-5-1': {
      input: 10,
      output: 50,
      cache: { read: 0.025, write5m: 1.25, write1h: 2.0 },
    },
    'claude-mythos-5-1': {
      input: 10,
      output: 50,
      cache: { read: 0.025, write5m: 1.25, write1h: 2.0 },
    },
    'claude-fable-5': { input: 10, output: 50 },
    'claude-mythos-5': { input: 10, output: 50 },
    // Cheaper than Opus 5 at every rate, and cache reads at $0.20/MTok (0.05x).
    'claude-opus-5-5': {
      input: 4,
      output: 20,
      fast: { input: 8, output: 40 },
      cache: { read: 0.05, write5m: 1.25, write1h: 2.0 },
    },
    // Fast mode is a research preview on Opus 5.5 / Opus 5 / Opus 4.8 only, billed at a premium.
    'claude-opus-5': { input: 5, output: 25, fast: { input: 10, output: 50 } },
    'claude-opus-4-8': { input: 5, output: 25, fast: { input: 10, output: 50 } },
    'claude-opus-4-7': { input: 5, output: 25 },
    'claude-opus-4-6': { input: 5, output: 25 },
    'claude-sonnet-5': { input: 2, output: 10 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 1, output: 5 },
  },
};
