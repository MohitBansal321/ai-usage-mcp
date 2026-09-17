import { describe, expect, it } from 'vitest';
import type { GroupedRow } from '../../src/db/repositories/usage-repository.js';
import { emptyCostTotals } from '../../src/models/usage-record.js';
import { MAX_ZERO_FILLED_BUCKETS, zeroFill } from '../../src/services/time-buckets.js';

function row(key: string, records = 1): GroupedRow {
  return {
    key,
    records,
    sessions: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    totalTokens: 10,
    cost: emptyCostTotals(),
  };
}

/** A local-midnight ISO string N days ago, matching how periods are resolved. */
function localMidnight(daysAgo: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

/**
 * An instant built from LOCAL calendar components.
 *
 * Bounds written as `2026-03-01T00:00:00.000Z` are UTC, and buckets are local,
 * so such a test asserts a different number of buckets in every timezone --
 * which is the very confusion this module exists to prevent. Build the bound the
 * same way the period resolver does, from local components.
 */
function localIso(year: number, month: number, day: number, hour = 0): string {
  return new Date(year, month - 1, day, hour, 0, 0, 0).toISOString();
}

function dayKey(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * `daily --days 30` returned only the days that HAD data -- ten rows for a
 * thirty-day window, with nothing to say the other twenty existed. The gaps
 * being invisible is what makes reading a trend off it actively misleading.
 */
describe('zeroFill: day', () => {
  it('fills every day in an explicit window, newest first', () => {
    const rows = zeroFill([row(dayKey(0)), row(dayKey(3))], 'day', {
      since: localMidnight(4),
    }).rows;

    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.key)).toEqual([dayKey(0), dayKey(1), dayKey(2), dayKey(3), dayKey(4)]);
  });

  it('marks a constructed bucket, so an observed zero stays distinguishable', () => {
    const rows = zeroFill([row(dayKey(0))], 'day', { since: localMidnight(2) }).rows;
    expect(rows[0]?.zeroFilled).toBeUndefined();
    expect(rows[1]?.zeroFilled).toBe(true);
    expect(rows[1]?.records).toBe(0);
    expect(rows[1]?.totalTokens).toBe(0);
  });

  it('does not invent history before the data when no period was given', () => {
    // Filling from the epoch would generate thousands of rows describing time
    // before any of it existed.
    const rows = zeroFill([row(dayKey(0)), row(dayKey(2))], 'day', {}).rows;
    expect(rows.map((r) => r.key)).toEqual([dayKey(0), dayKey(1), dayKey(2)]);
  });

  it('returns nothing for an empty, unbounded range rather than a year of zeroes', () => {
    expect(zeroFill([], 'day', {}).rows).toEqual([]);
  });

  it('fills a window that has no data at all, when the window is explicit', () => {
    const rows = zeroFill([], 'day', { since: localMidnight(2) }).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.zeroFilled)).toBe(true);
  });

  it('treats `until` as exclusive, matching the period filter', () => {
    const rows = zeroFill([], 'day', {
      since: localIso(2026, 3, 1),
      until: localIso(2026, 3, 4),
    }).rows;
    // 1st, 2nd, 3rd -- not the 4th.
    expect(rows.map((r) => r.key)).toEqual(['2026-03-03', '2026-03-02', '2026-03-01']);
  });
});

describe('zeroFill: hour', () => {
  it('fills each hour of an explicit window', () => {
    const rows = zeroFill([], 'hour', {
      since: localIso(2026, 3, 1, 0),
      until: localIso(2026, 3, 1, 4),
    }).rows;
    // 00, 01, 02, 03 -- `until` is exclusive, as everywhere else.
    expect(rows.map((r) => r.key)).toEqual([
      '2026-03-01T03:00',
      '2026-03-01T02:00',
      '2026-03-01T01:00',
      '2026-03-01T00:00',
    ]);
    expect(rows.every((r) => r.zeroFilled)).toBe(true);
  });

  it('refuses to fill an unbounded range, and says so instead of silently not filling', () => {
    const result = zeroFill([row('2020-01-01T00:00')], 'hour', {
      since: localIso(2020, 1, 1),
      until: localIso(2026, 1, 1),
    });
    expect(result.rows).toHaveLength(1);
    expect(result.note).toContain(String(MAX_ZERO_FILLED_BUCKETS));
    expect(result.note).toContain('NOT filled in');
  });
});

describe('zeroFill: hour-of-day', () => {
  it('always returns all 24 slots, in clock order', () => {
    const rows = zeroFill([row('12'), row('15')], 'hour-of-day', {}).rows;
    expect(rows).toHaveLength(24);
    expect(rows[0]?.key).toBe('00');
    expect(rows[23]?.key).toBe('23');
  });

  it('keeps the observed hours and marks only the rest', () => {
    // A missing 03 is the finding, not a gap to apologise for: "nothing happens
    // overnight" is exactly what the question asks.
    const rows = zeroFill([row('12', 5)], 'hour-of-day', {}).rows;
    expect(rows[12]).toMatchObject({ key: '12', records: 5 });
    expect(rows[12]?.zeroFilled).toBeUndefined();
    expect(rows[3]).toMatchObject({ key: '03', records: 0, zeroFilled: true });
  });

  it('ignores the period bounds, since every day collapses onto one clock', () => {
    const bounded = zeroFill([row('12')], 'hour-of-day', {
      since: localIso(2026, 3, 1),
      until: localIso(2026, 3, 2),
    }).rows;
    expect(bounded).toHaveLength(24);
  });
});
