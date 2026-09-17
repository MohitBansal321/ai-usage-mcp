import type { PricingTable } from '../types.js';

/**
 * OpenAI first-party API list prices.
 *
 * Captured 2026-09-16 from https://platform.openai.com/docs/pricing, "Flagship
 * models" and "Cyber models", **Standard** service tier, **short context**
 * column. Every number below is transcribed from that page; none is derived.
 *
 * Three things that table publishes and this one deliberately does not model,
 * because guessing which applies to a given stored turn would invent a figure:
 *
 *  - **Long context.** OpenAI charges a second, higher set of rates once a
 *    request crosses its long-context threshold (roughly 2x input, 1.5x output).
 *    Nothing in a `usage_record` says which side of that line a request fell on,
 *    so these are the short-context rates and a long-context turn is *under*
 *    stated. Said plainly here rather than silently split the difference.
 *  - **Batch and Flex tiers**, which are cheaper, and **Fast mode**, which is a
 *    premium. Only Claude Code records a `speed`, so there is nothing to key
 *    them off for an OpenAI turn.
 *  - **The 10% regional-processing uplift** for data-residency endpoints.
 *
 * Cache rates are per-model rather than inherited, and that is not a formality:
 * OpenAI publishes ONE cache-write price with no 1-hour tier, so `write1h` is
 * set equal to `write5m` (1.25x). Inheriting the table default would price an
 * OpenAI cache write at Anthropic's 2x 1-hour rate -- 60% too high. The cached-
 * input price is 0.1x input for every model here, which matches the default
 * read multiplier, but it is stated explicitly so a future divergence in either
 * table cannot silently move these numbers.
 */
export const openaiPricing: PricingTable = {
  version: 'openai-2026-09-16',
  provenance:
    'OpenAI first-party API list pricing (Standard tier, short context), captured 2026-09-16',
  currency: 'USD',
  unit: 'per_million_tokens',
  cacheMultipliers: {
    read: 0.1,
    write5m: 1.25,
    write1h: 1.25,
  },
  models: {
    // input / cached input / cache writes / output, per 1M tokens:
    // gpt-6-astra    $10.00 / $1.00  / $12.50   / $50.00
    'gpt-6-astra': {
      input: 10,
      output: 50,
      cache: { read: 0.1, write5m: 1.25, write1h: 1.25 },
    },
    // gpt-5.6-sol    $4.00  / $0.40  / $5.00    / $20.00
    'gpt-5.6-sol': {
      input: 4,
      output: 20,
      cache: { read: 0.1, write5m: 1.25, write1h: 1.25 },
    },
    // gpt-5.6-terra  $2.00  / $0.20  / $2.50    / $12.00
    'gpt-5.6-terra': {
      input: 2,
      output: 12,
      cache: { read: 0.1, write5m: 1.25, write1h: 1.25 },
    },
    // gpt-5.6-luna   $0.20  / $0.02  / $0.25    / $1.20
    'gpt-5.6-luna': {
      input: 0.2,
      output: 1.2,
      cache: { read: 0.1, write5m: 1.25, write1h: 1.25 },
    },
    // gpt-5.6-cyber  $12.50 / $1.25  / $15.625  / $75.00
    'gpt-5.6-cyber': {
      input: 12.5,
      output: 75,
      cache: { read: 0.1, write5m: 1.25, write1h: 1.25 },
    },
  },
};
