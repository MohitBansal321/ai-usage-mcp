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
  /**
   * The comparable window immediately before this one, when one exists.
   *
   * Resolved HERE rather than derived later from `since`/`until`, for two
   * reasons. It is aligned to the same local midnights the period itself uses,
   * so `--days 7` compares against the seven whole days before -- not against
   * "the 156 hours before", which is what subtracting an open window's elapsed
   * length gives. And it is a pure function of the request, so two processes
   * answering the same question describe the same window rather than differing
   * by however many milliseconds apart they read the clock.
   *
   * Absent for "all time", which has no window before it.
   */
  previous?: { since: string; until: string; label: string };
}

/**
 * Asked to compare against a window that does not exist.
 *
 * Its own class so the CLI can report it as the usage error it is -- one line
 * and exit 2, like any other bad flag combination -- rather than as an
 * unexpected failure with a stack trace.
 */
export class ComparePeriodError extends RangeError {}

/**
 * Names the bound that was unreadable, instead of letting `toISOString()` throw.
 *
 * `new Date('nonsense')` yields an Invalid Date rather than throwing, so the
 * failure used to surface here as a bare `RangeError: Invalid time value` --
 * which says nothing about *which* bound was wrong, or what it was. The CLI
 * validates these at the flag boundary; this guards every other caller,
 * including the MCP tools, where the argument arrives straight from a client.
 */
function toIso(bound: 'since' | 'until', raw: string): string {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()))
    throw new RangeError(`${bound} is not a valid ISO 8601 date: "${raw}".`);
  return parsed.toISOString();
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
    if (input.since) period.since = toIso('since', input.since);
    if (input.until) period.until = toIso('until', input.until);
    // An inverted range can only ever match nothing. Reporting "no usage records
    // for this period" would be indistinguishable from a genuinely quiet period,
    // which invites reading a typo as a fact about the data.
    if (period.since && period.until && period.since >= period.until)
      throw new RangeError(
        `since (${period.since}) is not before until (${period.until}): the range is empty.`,
      );
    // An explicit range has an exact length, so the window before it is exact
    // too. An open-ended one does not: its length depends on when the clock is
    // read, so there is no stable window to compare against and none is offered.
    if (period.since && period.until) {
      const start = Date.parse(period.since);
      const length = Date.parse(period.until) - start;
      period.previous = {
        since: new Date(start - length).toISOString(),
        until: period.since,
        label: 'the equally long window before that',
      };
    }
    return period;
  }

  if (input.today) {
    return {
      since: localMidnight(0).toISOString(),
      label: 'today (local time)',
      previous: {
        since: localMidnight(1).toISOString(),
        until: localMidnight(0).toISOString(),
        label: 'yesterday (local time)',
      },
    };
  }

  if (typeof input.days === 'number' && input.days > 0) {
    const days = input.days;
    return {
      since: localMidnight(days - 1).toISOString(),
      label: days === 1 ? 'today (local time)' : `last ${days} days (local time)`,
      previous: {
        // The N whole days before this window, on the same local midnights.
        since: localMidnight(2 * days - 1).toISOString(),
        until: localMidnight(days - 1).toISOString(),
        label: days === 1 ? 'yesterday (local time)' : `the ${days} days before that`,
      },
    };
  }

  return { label: 'all time' };
}
