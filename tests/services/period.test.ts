import { describe, expect, it } from 'vitest';
import { resolvePeriod } from '../../src/services/period.js';

describe('resolvePeriod', () => {
  it('defaults to all time with no bounds', () => {
    const period = resolvePeriod({});
    expect(period.since).toBeUndefined();
    expect(period.until).toBeUndefined();
    expect(period.label).toBe('all time');
  });

  it('resolves today to local midnight', () => {
    const period = resolvePeriod({ today: true });
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(period.since).toBe(midnight.toISOString());
    expect(period.label).toContain('today');
  });

  it('counts --days N inclusively from local midnight', () => {
    const period = resolvePeriod({ days: 7 });
    const expected = new Date();
    expected.setHours(0, 0, 0, 0);
    expected.setDate(expected.getDate() - 6);
    expect(period.since).toBe(expected.toISOString());
    expect(period.label).toBe('last 7 days (local time)');
  });

  it('treats --days 1 as today', () => {
    expect(resolvePeriod({ days: 1 }).since).toBe(resolvePeriod({ today: true }).since);
  });

  it('lets explicit bounds win', () => {
    const period = resolvePeriod({
      days: 7,
      since: '2026-01-01T00:00:00Z',
      until: '2026-02-01T00:00:00Z',
    });
    expect(period.since).toBe('2026-01-01T00:00:00.000Z');
    expect(period.until).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('invalid explicit bounds', () => {
  it('names the offending bound instead of throwing Invalid time value', () => {
    expect(() => resolvePeriod({ since: 'not-a-date' })).toThrow(
      /since is not a valid ISO 8601 date: "not-a-date"/,
    );
    expect(() => resolvePeriod({ until: 'garbage' })).toThrow(
      /until is not a valid ISO 8601 date: "garbage"/,
    );
  });

  it('still accepts the forms a user would actually type', () => {
    expect(resolvePeriod({ since: '2026-09-01' }).since).toBe('2026-09-01T00:00:00.000Z');
    expect(resolvePeriod({ since: '2026-09-01T12:30:00Z' }).since).toBe('2026-09-01T12:30:00.000Z');
  });
});

/**
 * The previous window is resolved HERE rather than derived later from
 * since/until, so it aligns to the same local midnights the period uses and is
 * a pure function of the request. Deriving it from an open window's elapsed
 * length gives "the 156 hours before" for `--days 7`, and a different answer
 * every time the clock is read.
 */
describe('resolvePeriod: the comparable previous window', () => {
  it('compares today against yesterday, on local midnights', () => {
    const period = resolvePeriod({ today: true });
    expect(period.previous?.until).toBe(period.since);
    expect(period.previous?.label).toContain('yesterday');
    expect(Date.parse(period.since!) - Date.parse(period.previous!.since)).toBe(86_400_000);
  });

  it('compares N days against the N whole days before', () => {
    const period = resolvePeriod({ days: 7 });
    expect(period.previous?.until).toBe(period.since);
    expect(period.previous?.label).toContain('7 days');
    // Seven local days, abutting exactly: no gap, no overlap.
    expect(Date.parse(period.since!) - Date.parse(period.previous!.since)).toBe(7 * 86_400_000);
  });

  it('is stable across calls, so two processes describe the same window', () => {
    expect(resolvePeriod({ days: 7 }).previous).toEqual(resolvePeriod({ days: 7 }).previous);
  });

  it('uses the exact length of an explicit range', () => {
    const period = resolvePeriod({
      since: '2026-09-08T00:00:00.000Z',
      until: '2026-09-15T00:00:00.000Z',
    });
    expect(period.previous).toEqual({
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-08T00:00:00.000Z',
      label: 'the equally long window before that',
    });
  });

  it('offers no previous window for all time, and none for an open-ended range', () => {
    // All time has nothing before it; an open range has no stable length, so
    // any window offered would move between two runs of the same command.
    expect(resolvePeriod({}).previous).toBeUndefined();
    expect(resolvePeriod({ since: '2026-09-08T00:00:00.000Z' }).previous).toBeUndefined();
  });
});
