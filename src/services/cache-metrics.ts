import type { TokenTotals } from '../models/usage-record.js';

/**
 * The figures that make cache tokens actionable.
 *
 * Cache tokens are where the money is -- in the database this was written
 * against, cache-read is 94.7% of all tokens, and for Claude Code it outweighs
 * input by roughly 33,000x. Every report printed `cacheRead` and `cacheWrite` as
 * raw counts and stopped there, so a user could see that cache dominates without
 * being able to tell whether their cache was paying for itself.
 *
 * Every figure here is a pure function of token counts already stored. Nothing
 * is collected or estimated to produce them.
 */

export interface CacheMetrics {
  /**
   * Cache reads as a fraction of all cache traffic: read / (read + write).
   *
   * `undefined` when there is no cache traffic at all. A hit rate of 0% and "no
   * cache was used" are different statements, and reporting the second as the
   * first would be inventing a measurement.
   */
  hitRate?: number;
  /**
   * Reads per write: how many times the average cached block was reused.
   *
   * The number that says whether the cache-write premium paid off. Below roughly
   * 2.5 reads per write it does not: a 5-minute write costs 1.25x input and each
   * read saves 0.9x, so a block read once is a small loss.
   *
   * `undefined` when nothing was written to cache -- there is no ratio to report,
   * and 0 or Infinity would both be claims nobody can support.
   */
  readsPerWrite?: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function cacheMetrics(tokens: TokenTotals): CacheMetrics {
  const read = tokens.cacheReadTokens;
  const write = tokens.cacheWriteTokens;
  const traffic = read + write;
  return {
    ...(traffic > 0 ? { hitRate: read / traffic } : {}),
    ...(write > 0 ? { readsPerWrite: read / write } : {}),
    cacheReadTokens: read,
    cacheWriteTokens: write,
  };
}

/**
 * Reads per write at which the cache-write premium breaks even.
 *
 * A 5-minute cache write costs `write5m` x the input rate; each subsequent read
 * costs `read` x input instead of 1x, saving `1 - read`. The write itself
 * replaces an ordinary input token, so the extra paid is `write5m - 1`.
 * Break-even is therefore (write5m - 1) / (1 - read) reads per write.
 *
 * With Anthropic's multipliers: (1.25 - 1) / (1 - 0.1) = 0.28 reads per write for
 * the 5-minute tier, and (2 - 1) / 0.9 = 1.11 for the 1-hour tier.
 */
export function breakEvenReadsPerWrite(multipliers: {
  read: number;
  write5m: number;
  write1h: number;
}): { write5m: number; write1h: number } | undefined {
  const saving = 1 - multipliers.read;
  // A cache read that costs as much as (or more than) fresh input can never pay
  // for a write premium, however often it is reused. No break-even exists.
  if (saving <= 0) return undefined;
  return {
    write5m: (multipliers.write5m - 1) / saving,
    write1h: (multipliers.write1h - 1) / saving,
  };
}
