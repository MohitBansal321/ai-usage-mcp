import type { PricingTable } from '../types.js';
import { anthropicPricing } from './anthropic-2026-06-24.js';
import { openaiPricing } from './openai-2026-09-16.js';

export { anthropicPricing } from './anthropic-2026-06-24.js';
export { openaiPricing } from './openai-2026-09-16.js';

/**
 * Every provider table shipped with the package, in composition order.
 *
 * Each one keeps its own version string, provenance and capture date. They are
 * separate files rather than one growing table precisely so a stale provider
 * stays visibly stale instead of hiding behind another provider's fresh date.
 */
export const providerTables: PricingTable[] = [anthropicPricing, openaiPricing];

/**
 * The date the shipped tables were last composed. Bumped whenever a provider
 * table is added or its numbers change, so `ai-usage status` reports one
 * meaningful "as of", with each provider's own capture date in the provenance.
 */
export const BUILTIN_PRICING_VERSION = 'builtin-2026-09-16';

/**
 * Unions the provider tables into the single table the pricing engine consults.
 *
 * A model defined by two providers is a conflict, not a merge: whichever won
 * would price somebody's tokens at another vendor's rates, and the loser would
 * vanish without a word. It throws instead, which fails a test rather than a
 * user's invoice.
 *
 * The composed `cacheMultipliers` are the FIRST table's, used only by models
 * that carry no `cache` of their own. Any table whose defaults differ from that
 * one must therefore set `cache` per model -- `openai-2026-09-16` does exactly
 * this, because it has no 1-hour cache tier to inherit.
 */
export function composePricingTables(tables: PricingTable[], version: string): PricingTable {
  const base = tables[0];
  if (!base) throw new Error('composePricingTables requires at least one table.');

  const models: Record<string, import('../types.js').ModelPrice> = {};
  const definedBy = new Map<string, string>();

  for (const table of tables) {
    const defaults = table.cacheMultipliers;
    for (const [model, price] of Object.entries(table.models)) {
      const existing = definedBy.get(model);
      if (existing) {
        throw new Error(
          `Model "${model}" is priced by both ${existing} and ${table.version}. ` +
            `Built-in tables must not overlap: one of the two prices would be applied silently.`,
        );
      }
      definedBy.set(model, table.version);
      // A model inheriting its own table's defaults must keep them explicitly,
      // or composition would silently re-point it at the first table's.
      models[model] =
        price.cache || defaults === base.cacheMultipliers ? price : { ...price, cache: defaults };
    }
  }

  return {
    version,
    provenance: tables.map((t) => t.provenance).join('; '),
    currency: base.currency,
    unit: base.unit,
    cacheMultipliers: base.cacheMultipliers,
    models,
  };
}

/** The table in force when the user has supplied no override. */
export const builtinPricing: PricingTable = composePricingTables(
  providerTables,
  BUILTIN_PRICING_VERSION,
);
