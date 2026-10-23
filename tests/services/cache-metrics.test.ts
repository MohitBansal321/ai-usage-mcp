import { describe, expect, it } from 'vitest';
import { emptyTokenTotals, type TokenTotals } from '../../src/models/usage-record.js';
import {
  breakEvenReadsPerWrite,
  cacheMetrics,
  overallCacheMetrics,
} from '../../src/services/cache-metrics.js';

function tokens(overrides: Partial<TokenTotals> = {}): TokenTotals {
  return { ...emptyTokenTotals(), ...overrides };
}

/**
 * Cache tokens are where the money is -- 94.7% of all tokens in the database
 * this was written against -- and every report printed them as raw counts and
 * stopped, so a user could see that cache dominates without being able to tell
 * whether their cache was paying for itself.
 */
describe('cacheMetrics', () => {
  it('computes the hit rate as reads over all cache traffic', () => {
    // The issue's own figure: 620,076,310 / (620,076,310 + 23,363,277) = 96.4%.
    const metrics = cacheMetrics(
      tokens({ cacheReadTokens: 620_076_310, cacheWriteTokens: 23_363_277 }),
    );
    expect(metrics.hitRate).toBeCloseTo(0.9637, 4);
  });

  it('computes reads per write', () => {
    // claude-code in the issue: 319,410,712 reads to 28,763 writes.
    const metrics = cacheMetrics(
      tokens({ cacheReadTokens: 319_410_712, cacheWriteTokens: 28_763 }),
    );
    expect(metrics.readsPerWrite).toBeCloseTo(11_104.92, 2);

    // A simple case, checkable in the head.
    expect(cacheMetrics(tokens({ cacheReadTokens: 100, cacheWriteTokens: 4 })).readsPerWrite).toBe(
      25,
    );
  });

  it('reports no hit rate at all when there was no cache traffic', () => {
    // 0% and "no cache was used" are different statements, and reporting the
    // second as the first would be inventing a measurement.
    const metrics = cacheMetrics(tokens({ inputTokens: 100 }));
    expect(metrics.hitRate).toBeUndefined();
    expect(metrics.readsPerWrite).toBeUndefined();
  });

  it('reports a real 0% hit rate when there were writes but no reads', () => {
    // Writing to a cache nothing ever read IS a 0% hit rate, and the worst case
    // for the write premium: it must not be hidden as "unavailable".
    const metrics = cacheMetrics(tokens({ cacheWriteTokens: 1000 }));
    expect(metrics.hitRate).toBe(0);
    expect(metrics.readsPerWrite).toBe(0);
  });

  it('reports no ratio when nothing was written, rather than Infinity', () => {
    const metrics = cacheMetrics(tokens({ cacheReadTokens: 1000 }));
    expect(metrics.hitRate).toBe(1);
    expect(metrics.readsPerWrite).toBeUndefined();
  });
});

describe('breakEvenReadsPerWrite', () => {
  it('derives the break-even from the table multipliers', () => {
    // A 5-minute write costs 1.25x input, so 0.25x extra; each read saves 0.9x.
    // 0.25 / 0.9 = 0.28 reads per write. The 1-hour tier: 1.0 / 0.9 = 1.11.
    const breakEven = breakEvenReadsPerWrite({ read: 0.1, write5m: 1.25, write1h: 2 });
    expect(breakEven?.write5m).toBeCloseTo(0.2778, 4);
    expect(breakEven?.write1h).toBeCloseTo(1.1111, 4);
  });

  it('follows a provider whose cache discount differs', () => {
    // DeepSeek's cache-hit rate is ~0.02x input, so each read saves far more and
    // the write premium pays back sooner.
    const breakEven = breakEvenReadsPerWrite({ read: 0.02, write5m: 1.25, write1h: 1.25 });
    expect(breakEven?.write5m).toBeCloseTo(0.2551, 4);
  });

  it('says there is no break-even when a read costs as much as fresh input', () => {
    // No amount of reuse pays for a write premium if reading saves nothing.
    expect(breakEvenReadsPerWrite({ read: 1, write5m: 1.25, write1h: 2 })).toBeUndefined();
    expect(breakEvenReadsPerWrite({ read: 1.5, write5m: 1.25, write1h: 2 })).toBeUndefined();
  });
});

/**
 * OpenAI caches prompts by itself and bills no cache write, so Codex records none,
 * and read / (read + write) printed 100% for every Codex row on the development
 * machine. These are that machine's Codex totals.
 */
describe('a client with no cache-write step', () => {
  const codex = tokens({ inputTokens: 12_767, cacheReadTokens: 52_992, cacheWriteTokens: 0 });

  it('reports the cached share of prompt input instead of a hit rate', () => {
    const metrics = cacheMetrics(codex, 'codex');
    expect(metrics.hitRate).toBeUndefined();
    expect(metrics.readsPerWrite).toBeUndefined();
    expect(metrics.cachedInputShare).toBeCloseTo(52_992 / 65_759, 10);
  });

  it('keeps the hit rate for a client that does write to cache', () => {
    const claude = tokens({ cacheReadTokens: 900, cacheWriteTokens: 100 });
    expect(cacheMetrics(claude, 'claude-code').hitRate).toBe(0.9);
    expect(cacheMetrics(claude, 'claude-code').cachedInputShare).toBeUndefined();
  });

  it('is left out of the overall hit rate, and named as left out', () => {
    const claude = tokens({ cacheReadTokens: 900, cacheWriteTokens: 100 });
    const overall = tokens({
      inputTokens: codex.inputTokens,
      cacheReadTokens: 900 + codex.cacheReadTokens,
      cacheWriteTokens: 100,
    });
    const metrics = overallCacheMetrics(overall, [
      { key: 'claude-code', ...claude },
      { key: 'codex', ...codex },
    ]);
    expect(metrics.hitRate).toBe(0.9);
    expect(metrics.readsPerWrite).toBe(9);
    expect(metrics.excludedClients).toEqual(['codex']);
    // The raw counts still cover every client.
    expect(metrics.cacheReadTokens).toBe(overall.cacheReadTokens);
  });

  it('changes nothing overall when no such client is present', () => {
    const claude = tokens({ cacheReadTokens: 900, cacheWriteTokens: 100 });
    expect(overallCacheMetrics(claude, [{ key: 'claude-code', ...claude }])).toEqual(
      cacheMetrics(claude),
    );
  });
});
