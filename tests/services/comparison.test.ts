import { describe, expect, it } from 'vitest';
import type { AggregateRow } from '../../src/db/repositories/usage-repository.js';
import { emptyCostTotals, emptyTokenTotals } from '../../src/models/usage-record.js';
import {
  compareTotals,
  comparisonCaveats,
  delta,
  previousWindow,
} from '../../src/services/comparison.js';
import { percent, signed } from '../../src/services/formatter.js';

function totals(overrides: Partial<AggregateRow> = {}): AggregateRow {
  return {
    ...emptyTokenTotals(),
    records: 0,
    sessions: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cost: emptyCostTotals(),
    ...overrides,
  };
}

describe('delta', () => {
  it('reports the direction as well as the size', () => {
    expect(delta(150, 100)).toEqual({ absolute: 50, ratio: 0.5 });
    expect(delta(50, 100)).toEqual({ absolute: -50, ratio: -0.5 });
    expect(delta(100, 100)).toEqual({ absolute: 0, ratio: 0 });
  });

  it('omits the ratio entirely when the previous value was zero', () => {
    // There is no percentage change from zero. Reporting 100%, or Infinity,
    // would be inventing a figure: $0 -> $5 is a new thing happening, not a
    // rise of any particular size.
    expect(delta(5, 0)).toEqual({ absolute: 5 });
    expect(delta(5, 0).ratio).toBeUndefined();
    expect(delta(0, 0)).toEqual({ absolute: 0 });
  });
});

describe('compareTotals', () => {
  it('never merges the two cost bases into one figure', () => {
    const current = totals({
      cost: { ...emptyCostTotals(), reported: 10, estimated: 100 },
    });
    const previous = totals({
      cost: { ...emptyCostTotals(), reported: 4, estimated: 40 },
    });
    const d = compareTotals(current, previous);

    expect(d.reportedCost.absolute).toBe(6);
    expect(d.estimatedCost.absolute).toBe(60);
    // The combined figure must not exist anywhere in the result: a single
    // "spend is up $66" across two bases is the same lie the reports refuse.
    expect(Object.keys(d)).not.toContain('cost');
    expect(Object.values(d)).not.toContainEqual({ absolute: 66, ratio: 1.5 });
  });

  it('deltas every token class separately, as they are reported', () => {
    const d = compareTotals(
      totals({ inputTokens: 10, cacheReadTokens: 1000, totalTokens: 1010 }),
      totals({ inputTokens: 5, cacheReadTokens: 500, totalTokens: 505 }),
    );
    expect(d.inputTokens.absolute).toBe(5);
    expect(d.cacheReadTokens.absolute).toBe(500);
    expect(d.totalTokens.absolute).toBe(505);
  });
});

describe('previousWindow', () => {
  it('is the equal-length window immediately before this one', () => {
    const prev = previousWindow('2026-09-08T00:00:00.000Z', '2026-09-15T00:00:00.000Z');
    expect(prev.since).toBe('2026-09-01T00:00:00.000Z');
    expect(prev.until).toBe('2026-09-08T00:00:00.000Z');
    expect(prev.label).toContain('7 days');
  });

  it('abuts the current window exactly, with no gap and no overlap', () => {
    const since = '2026-09-08T06:30:00.000Z';
    const prev = previousWindow(since, '2026-09-09T06:30:00.000Z');
    expect(prev.until).toBe(since);
    expect(Date.parse(since) - Date.parse(prev.since)).toBe(24 * 3600 * 1000);
  });

  it('describes a sub-day window in hours rather than rounding it to a day', () => {
    const prev = previousWindow('2026-09-08T00:00:00.000Z', '2026-09-08T06:00:00.000Z');
    expect(prev.label).toContain('6 hours');
  });
});

describe('comparisonCaveats', () => {
  it('always says the two cost bases are compared separately', () => {
    const caveats = comparisonCaveats(
      { since: '2026-09-01T00:00:00.000Z', until: '2026-09-02T00:00:00.000Z' },
      totals({ records: 5 }),
    );
    expect(caveats.join(' ')).toContain('never summed');
  });

  it('warns that an open window is being compared against a finished one', () => {
    // The single easiest way to misread this feature: a part-finished today
    // against a whole previous day shows a fall that is the clock, not usage.
    const caveats = comparisonCaveats(
      { since: '2026-09-01T00:00:00.000Z' },
      totals({ records: 5 }),
    );
    expect(caveats.join(' ')).toContain('still open');
  });

  it('stays quiet about the clock when the window has already closed', () => {
    const caveats = comparisonCaveats(
      { since: '2020-01-01T00:00:00.000Z', until: '2020-01-02T00:00:00.000Z' },
      totals({ records: 5 }),
    );
    expect(caveats.join(' ')).not.toContain('still open');
  });

  it('says so when the previous window is empty, so a change from nothing is visible', () => {
    const caveats = comparisonCaveats(
      { since: '2020-01-01T00:00:00.000Z', until: '2020-01-02T00:00:00.000Z' },
      totals({ records: 0 }),
    );
    expect(caveats.join(' ')).toContain('change from nothing');
  });
});

describe('rendering a delta', () => {
  it('signs a change so it reads as a direction', () => {
    expect(signed(50)).toBe('+50');
    expect(signed(-50)).toBe('-50');
    // Neither +0 nor -0: no change is not a direction.
    expect(signed(0)).toBe('0');
  });

  it('never renders a percentage change from zero', () => {
    expect(percent(undefined)).toContain('n/a');
    expect(percent(undefined)).not.toContain('100');
    expect(percent(0.5)).toBe('+50.0%');
    expect(percent(-0.663)).toBe('-66.3%');
  });
});
