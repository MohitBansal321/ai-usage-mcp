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
export const ESTIMATED_CLIENTS: readonly ClientId[] = ['claude-code', 'codex'];

/**
 * Where each client puts reasoning tokens relative to `outputTokens`.
 *
 * This is a pricing concern, not a cosmetic one. Claude Code's thinking tokens
 * are a *detail of* `output_tokens`, so they are already paid for by pricing
 * output. OpenCode's `reasoning` is a *sibling* of `output` (verified:
 * `tokens.total === input + output + reasoning + cache.read`), so pricing only
 * `output` would bill nothing for them. Codex follows OpenAI's convention:
 * `reasoning_output_tokens` is part of `output_tokens` (verified: `total_tokens
 * === input_tokens + output_tokens` on every counted request).
 *
 * Collection-time estimates never hit this, because only the clients whose
 * reasoning is inside output are estimated -- OpenCode reports its own cost.
 * Anything that RE-prices a stored row does hit it, for every client. See
 * docs/DATA_SOURCES.md.
 */
export const REASONING_PLACEMENT: Record<ClientId, 'inside-output' | 'sibling-of-output'> = {
  'claude-code': 'inside-output',
  opencode: 'sibling-of-output',
  codex: 'inside-output',
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
  /**
   * The whole prompt of the ONE request being priced -- see {@link promptTokensOf}.
   * It picks a model's long-context rate card, so a model that has one cannot be
   * priced without it: summed tokens from many requests would land every group
   * in the long tier.
   */
  promptTokens?: number;
}

/**
 * A request's prompt length as Anthropic bills it: every input token, cache
 * reads and cache writes included.
 */
export function promptTokensOf(t: {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  return t.inputTokens + (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0);
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
 *  3. Reasoning/thinking tokens are NOT priced separately for Claude Code or
 *     Codex: they are already inside `output_tokens`. Adding them would
 *     double-charge.
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

  /**
   * Every prompt length at which some model changes rate card, ascending. A
   * caller pricing aggregates splits its groups at these, so that no group
   * straddles a tier and each can be priced at its own longest prompt.
   */
  longContextThresholds(): number[] {
    const above = Object.values(this.loaded.table.models)
      .map((p) => p.longContext?.aboveTokens)
      .filter((n): n is number => n !== undefined);
    return [...new Set(above)].sort((a, b) => a - b);
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

    const fast = input.speed === 'fast' ? price.fast : undefined;
    let rates = fast ?? { input: price.input, output: price.output };
    // Fast mode is one rate across the whole context window, so a long-context
    // card only ever replaces the standard rates.
    const long = fast ? undefined : price.longContext;
    let longPrompt = false;
    if (long) {
      if (input.promptTokens === undefined) {
        return {
          costBasis: 'unavailable',
          note:
            `Model "${input.model}" is priced by prompt length (a higher rate above ` +
            `${long.aboveTokens.toLocaleString('en-US')} tokens), and this figure does not ` +
            `say how long each request's prompt was. Cost reported as unavailable rather ` +
            `than estimated.`,
        };
      }
      if (input.promptTokens > long.aboveTokens) {
        rates = { input: long.input, output: long.output };
        longPrompt = true;
      }
    }

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
    if (fast) notes.push('Priced at fast-mode premium rates.');
    if (longPrompt && long) {
      notes.push(
        `Priced at long-context rates: the prompt was over ` +
          `${long.aboveTokens.toLocaleString('en-US')} tokens.`,
      );
    }

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
