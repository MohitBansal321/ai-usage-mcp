import type { CostBasis } from '../models/usage-record.js';
import { loadPricing, type LoadedPricing, type PricingTable } from '../pricing/index.js';

export interface EstimateInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /** Total cache-write tokens; authoritative even if the TTL split is incomplete. */
  cacheWriteTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  /** `usage.speed` from the transcript: 'fast' bills at premium rates. */
  speed?: string;
}

export interface Estimate {
  costBasis: CostBasis;
  estimatedCost?: number;
  /** Explanation shown to the user when they ask how a number was produced. */
  note?: string;
}

/**
 * Turns token counts into an *API-equivalent* cost.
 *
 * Three rules this class exists to enforce:
 *  1. A model that is not in the pricing table yields `unavailable`, never a guess.
 *  2. Cache reads and cache writes are priced from their own multipliers, and the
 *     two cache-write TTLs are priced separately (1.25x vs 2x input). Averaging
 *     them would have understated this machine's real usage, where 55.1M of the
 *     82.6M cache-write tokens used the 1-hour TTL.
 *  3. Reasoning/thinking tokens are NOT priced separately for Claude: they are
 *     already inside `output_tokens`. Adding them would double-charge.
 */
export class CostService {
  private readonly loaded: LoadedPricing;

  constructor(loaded?: LoadedPricing) {
    this.loaded = loaded ?? loadPricing();
  }

  get table(): PricingTable {
    return this.loaded.table;
  }

  get pricingVersion(): string {
    return this.loaded.table.version;
  }

  get overridePath(): string | undefined {
    return this.loaded.overridePath;
  }

  knowsModel(model: string): boolean {
    return Boolean(this.loaded.table.models[model]);
  }

  estimate(input: EstimateInput): Estimate {
    const table = this.loaded.table;
    const price = table.models[input.model];
    if (!price) {
      return {
        costBasis: 'unavailable',
        note:
          `No price for model "${input.model}" in pricing table ${table.version}. ` +
          `Cost reported as unavailable rather than estimated.`,
      };
    }

    const rates =
      input.speed === 'fast' && price.fast ? price.fast : { input: price.input, output: price.output };

    const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
    const { read, write5m, write1h } = table.cacheMultipliers;

    const cacheRead = input.cacheReadTokens ?? 0;
    const total5m = input.cacheWrite5mTokens ?? 0;
    const total1h = input.cacheWrite1hTokens ?? 0;
    const declaredWrite = input.cacheWriteTokens ?? 0;
    // If the TTL split does not account for every cache-write token, price the
    // remainder at the cheaper 5-minute rate and say so, rather than dropping it.
    const unsplit = Math.max(0, declaredWrite - total5m - total1h);

    let cost = 0;
    cost += perMillion(input.inputTokens, rates.input);
    cost += perMillion(input.outputTokens, rates.output);
    cost += perMillion(cacheRead, rates.input * read);
    cost += perMillion(total5m, rates.input * write5m);
    cost += perMillion(total1h, rates.input * write1h);
    cost += perMillion(unsplit, rates.input * write5m);

    const notes: string[] = [];
    if (unsplit > 0) {
      notes.push(
        `${unsplit} cache-write token(s) had no TTL breakdown; priced at the 5-minute rate.`,
      );
    }
    if (input.speed === 'fast' && price.fast) notes.push('Priced at fast-mode premium rates.');

    const estimate: Estimate = { costBasis: 'estimated', estimatedCost: cost };
    if (notes.length) estimate.note = notes.join(' ');
    return estimate;
  }

  /** The label that must accompany every estimated figure shown to a user. */
  estimatedCostLabel(): string {
    return (
      `API-equivalent estimated cost (pricing table ${this.loaded.table.version}). ` +
      `This is what the tokens would cost at API list prices; on a Claude Pro/Max ` +
      `subscription the marginal cost per request is $0.`
    );
  }
}
