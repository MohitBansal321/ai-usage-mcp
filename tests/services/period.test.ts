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
