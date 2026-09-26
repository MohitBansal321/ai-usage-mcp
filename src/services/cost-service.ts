import type { ClientId, CostBasis } from '../models/usage-record.js';
import {
  loadPricing,
  type CommunityPricingState,
  type LoadedPricing,
  type PricingMode,
  type PricingTable,
} from '../pricing/index.js';

/**
 * Clients that record no cost of their own, so their collector estimates one
 * from the pricing table at collection time.
 *
 * A stored row from one of these that was `unavailable` -- its model was not
 * in the table when it was collected -- is what a later table can still price.
 * Rows from any other client carry the cost the client itself reported, which
 * no pricing table may overwrite.
 */
export const ESTIMATED_CLIENTS: readonly ClientId[] = ['claude-code'];

/**
 * Where each client puts reasoning tokens relative to `outputTokens`.
 *
 * This is a pricing concern, not a cosmetic one. Claude Code's thinking tokens
 * are a *detail of* `output_tokens`, so they are already paid for by pricing
 * output. OpenCode's `reasoning` is a *sibling* of `output` (verified:
 * `tokens.total === input + output + reasoning + cache.read`), so pricing only
 * `output` would bill nothing for them.
 *
 * Collection-time estimates never hit this, because only Claude Code is
 * estimated -- OpenCode reports its own cost. Anything that RE-prices a stored
 * row does hit it, for every client. See docs/DATA_SOURCES.md.
 */
export const REASONING_PLACEMENT: Record<ClientId, 'inside-output' | 'sibling-of-output'> = {
  'claude-code': 'inside-output',
  opencode: 'sibling-of-output',
};

/**
 * The output-token count to price for a client, given what it stored.
 *
 * Use this instead of passing `outputTokens` straight through whenever you are
 * re-pricing stored rows; a new client whose reasoning is a sibling will
 * otherwise be under-billed with nothing to show it.
 */
export function billableOutputTokens(
  client: ClientId,
  outputTokens: number,
  reasoningTokens = 0,
): number {
  return REASONING_PLACEMENT[client] === 'sibling-of-output'
    ? outputTokens + reasoningTokens
    : outputTokens;
}

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
  private loaded: LoadedPricing;
  /** False when a caller handed the table over, which there is then no disk copy to re-read. */
  private readonly fromDisk: boolean;

  /**
   * `mode` is metadata about how the table was assembled, not an input to any
   * number, so a caller handing over a table directly may omit it.
   */
  constructor(loaded?: Omit<LoadedPricing, 'mode'> & { mode?: PricingMode }) {
    this.fromDisk = !loaded;
    this.loaded = loaded ? { ...loaded, mode: loaded.mode ?? 'builtin' } : loadPricing();
  }

  /**
   * Re-reads the pricing in force from disk -- built-in tables, community
   * prices and override -- and returns whether any price changed.
   *
   * A long-running MCP server needs this: the community list it downloads in
   * the background would otherwise only take effect on the next restart. The
   * table is replaced whole, and only when it differs, so a caller holding the
   * old one keeps a consistent table rather than a half-updated one. Throws if
   * the override on disk has become malformed, leaving the current table in
   * force.
   */
  reload(): boolean {
    if (!this.fromDisk) return false;
    const next = loadPricing();
    const changed = JSON.stringify(next.table) !== JSON.stringify(this.loaded.table);
    if (changed) this.loaded = next;
    else this.loaded = { ...next, table: this.loaded.table };
    return changed;
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

  /** How the table in force was assembled: built-in, an overlay, or a full replacement. */
  get pricingMode(): PricingMode {
    return this.loaded.mode;
  }

  /** The built-in version an overlay sits on. Absent unless `pricingMode` is 'overlay'. */
  get baseVersion(): string | undefined {
    return this.loaded.baseVersion;
  }

  /** What the community price list contributed. Absent when the table was handed over. */
  get community(): CommunityPricingState | undefined {
    return this.loaded.community;
  }

  knowsModel(model: string): boolean {
    return Boolean(this.loaded.table.models[model]);
  }

  /** Every model the table can price, so a caller need not hardcode a list. */
  pricedModels(): string[] {
    return Object.keys(this.loaded.table.models).sort();
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
      input.speed === 'fast' && price.fast
        ? price.fast
        : { input: price.input, output: price.output };

    const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
    // A model may carry its own cache rates; the table default applies only to
    // models that do not. Providers genuinely disagree here -- OpenAI has no
    // 1-hour cache tier at all, so inheriting Anthropic's 2x would overcharge it.
    const { read, write5m, write1h } = price.cache ?? table.cacheMultipliers;

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
