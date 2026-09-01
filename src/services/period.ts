export interface PeriodInput {
  /** Last N days, counted from local midnight N-1 days ago through now. */
  days?: number;
  /** Just today, in local time. */
  today?: boolean;
  /** Explicit ISO 8601 bounds; override `days`/`today`. */
  since?: string;
  until?: string;
}

export interface Period {
  since?: string;
  until?: string;
  /** Human-readable description, e.g. "last 7 days (local time)". */
  label: string;
}

function localMidnight(offsetDays = 0): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d;
}

/**
 * Resolves a period. Day boundaries are LOCAL, because "today" means the user's
 * today; the stored timestamps are UTC and converted here rather than at query time.
 */
export function resolvePeriod(input: PeriodInput = {}): Period {
  if (input.since || input.until) {
    const period: Period = {
      label: `${input.since ?? 'beginning'} to ${input.until ?? 'now'}`,
    };
    if (input.since) period.since = new Date(input.since).toISOString();
    if (input.until) period.until = new Date(input.until).toISOString();
    return period;
  }

  if (input.today) {
    return {
      since: localMidnight(0).toISOString(),
      label: 'today (local time)',
    };
  }

  if (typeof input.days === 'number' && input.days > 0) {
    return {
      since: localMidnight(input.days - 1).toISOString(),
      label: input.days === 1 ? 'today (local time)' : `last ${input.days} days (local time)`,
    };
  }

  return { label: 'all time' };
}
