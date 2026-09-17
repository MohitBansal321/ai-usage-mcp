import type { GroupedRow, TimeGrain } from '../db/repositories/usage-repository.js';
import { emptyCostTotals } from '../models/usage-record.js';

/**
 * Filling in the buckets that had no activity.
 *
 * `daily --days 30` returned only the days that HAD data -- ten rows for a
 * thirty-day window, with nothing to say the other twenty existed. Reading a
 * trend off that is not merely harder, it is actively misleading: the gaps are
 * invisible, so an ordinary day renders immediately beside one three weeks
 * earlier and looks like a spike next to it.
 *
 * A zero row is not a fabricated number. It asserts that no usage was recorded
 * in that bucket, which is exactly what the absence of rows meant -- it just
 * says it where a reader can see it. Every filled row carries `zeroFilled: true`
 * so a consumer can tell an observed zero from a constructed one.
 */

/** A bucket that was constructed rather than observed. */
export interface TimeBucket extends GroupedRow {
  zeroFilled?: boolean;
}

/**
 * Zero-filling an hourly range over all time would generate tens of thousands
 * of rows nobody asked for, so it is bounded and the caller is told when the
 * bound bit, rather than quietly returning a partial series.
 */
export const MAX_ZERO_FILLED_BUCKETS = 5000;

export interface ZeroFillResult {
  rows: TimeBucket[];
  /** Set when the range was too large to fill, explaining why it was not. */
  note?: string;
}

function emptyRow(key: string): TimeBucket {
  return {
    key,
    zeroFilled: true,
    records: 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: emptyCostTotals(),
  };
}

/** `YYYY-MM-DD` for a local date, without going through UTC. */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localHourKey(d: Date): string {
  return `${localDayKey(d)}T${String(d.getHours()).padStart(2, '0')}:00`;
}

/**
 * Every bucket key between two instants, in local time, newest first.
 *
 * Stepping with `setDate`/`setHours` rather than adding fixed millisecond
 * offsets is deliberate: across a DST boundary a "day" is 23 or 25 hours, and
 * adding 86,400,000ms would drift onto the wrong local date and eventually
 * duplicate or skip one.
 */
function keysBetween(grain: 'hour' | 'day', from: Date, to: Date, cap: number): string[] | null {
  const keys: string[] = [];
  const cursor = new Date(from);
  if (grain === 'day') cursor.setHours(0, 0, 0, 0);
  else cursor.setMinutes(0, 0, 0);

  while (cursor.getTime() <= to.getTime()) {
    keys.push(grain === 'day' ? localDayKey(cursor) : localHourKey(cursor));
    if (keys.length > cap) return null;
    if (grain === 'day') cursor.setDate(cursor.getDate() + 1);
    else cursor.setHours(cursor.getHours() + 1);
  }
  return keys.reverse();
}

/**
 * Returns the observed rows with every empty bucket in range filled in.
 *
 * @param bounds The window to fill. When the caller gave no explicit period,
 *   pass the first and last activity instead -- filling from the epoch would
 *   invent thousands of rows describing time before the data existed.
 */
export function zeroFill(
  rows: GroupedRow[],
  grain: TimeGrain,
  bounds: { since?: string; until?: string },
): ZeroFillResult {
  if (grain === 'hour-of-day') {
    // A fixed 24-slot clock: every hour exists whether or not it was used, and
    // a missing 03 is exactly the finding ("nothing happens overnight").
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return {
      rows: Array.from({ length: 24 }, (_, h) => {
        const key = String(h).padStart(2, '0');
        return byKey.get(key) ?? emptyRow(key);
      }),
    };
  }

  if (rows.length === 0 && !bounds.since) return { rows: [] };

  const from = bounds.since ? new Date(bounds.since) : new Date(oldestObservedInstant(rows, grain));
  const to = bounds.until ? new Date(Date.parse(bounds.until) - 1) : new Date();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return { rows: [...rows] };
  }

  const keys = keysBetween(grain, from, to, MAX_ZERO_FILLED_BUCKETS);
  if (keys === null) {
    return {
      rows: [...rows],
      note:
        `Empty ${grain} buckets were NOT filled in: the range exceeds ` +
        `${MAX_ZERO_FILLED_BUCKETS} buckets. Only ${grain}s with activity are listed, so ` +
        `gaps between them are not visible. Narrow the period to see a gap-free series.`,
    };
  }

  const byKey = new Map(rows.map((r) => [r.key, r]));
  return { rows: keys.map((key) => byKey.get(key) ?? emptyRow(key)) };
}

/**
 * The oldest observed bucket as a local instant, used when the caller gave no
 * lower bound. Filling from the epoch instead would invent thousands of rows
 * describing time before any data existed.
 */
function oldestObservedInstant(rows: GroupedRow[], grain: TimeGrain): string {
  const oldest = rows[rows.length - 1]?.key ?? '';
  return grain === 'day' ? `${oldest}T00:00:00` : `${oldest}:00`;
}
