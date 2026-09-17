import type { AggregateRow } from '../db/repositories/usage-repository.js';
import type { CostTotals } from '../models/usage-record.js';

/**
 * One window against another.
 *
 * Every report described a single window in absolutes, so "am I trending up?"
 * meant re-running with a second hand-computed date pair and diffing mentally.
 *
 * The one rule this module exists to keep: reported and estimated cost are
 * deltaed SEPARATELY and never summed, exactly as they are reported. A single
 * "spend is up $40" across two bases would be the same lie in motion.
 */

export interface Delta {
  /** current minus previous. Negative means the current window is lower. */
  absolute: number;
  /**
   * Change as a fraction of the previous value, or `undefined` when the previous
   * value is 0.
   *
   * There is no percentage change from zero. Reporting one as 100%, or as
   * Infinity, would be inventing a figure -- going from $0 to $5 is a new thing
   * happening, not a 100% rise.
   */
  ratio?: number;
}

export interface ComparisonTotals {
  records: Delta;
  sessions: Delta;
  inputTokens: Delta;
  outputTokens: Delta;
  cacheReadTokens: Delta;
  cacheWriteTokens: Delta;
  reasoningTokens: Delta;
  totalTokens: Delta;
  /** Kept apart, like every other cost figure in this codebase. */
  reportedCost: Delta;
  estimatedCost: Delta;
}

export interface Comparison {
  /** The window being compared against. */
  previous: { since: string; until: string; label: string };
  previousTotals: AggregateRow;
  delta: ComparisonTotals;
  /** Things that would make the comparison misleading if unsaid. Never empty. */
  caveats: string[];
}

export function delta(current: number, previous: number): Delta {
  const absolute = current - previous;
  return previous === 0 ? { absolute } : { absolute, ratio: absolute / previous };
}

function costDeltas(current: CostTotals, previous: CostTotals) {
  return {
    reportedCost: delta(current.reported, previous.reported),
    estimatedCost: delta(current.estimated, previous.estimated),
  };
}

export function compareTotals(current: AggregateRow, previous: AggregateRow): ComparisonTotals {
  return {
    records: delta(current.records, previous.records),
    sessions: delta(current.sessions, previous.sessions),
    inputTokens: delta(current.inputTokens, previous.inputTokens),
    outputTokens: delta(current.outputTokens, previous.outputTokens),
    cacheReadTokens: delta(current.cacheReadTokens, previous.cacheReadTokens),
    cacheWriteTokens: delta(current.cacheWriteTokens, previous.cacheWriteTokens),
    reasoningTokens: delta(current.reasoningTokens, previous.reasoningTokens),
    totalTokens: delta(current.totalTokens, previous.totalTokens),
    ...costDeltas(current.cost, previous.cost),
  };
}

/**
 * The window of equal length immediately before an explicit range.
 *
 * `resolvePeriod` is the normal source of a previous window, because it can
 * align to the same local midnights the period itself uses. This is the raw
 * arithmetic, for a caller that has only two instants.
 */
export function previousWindow(
  since: string,
  until: string,
): { since: string; until: string; label: string } {
  const start = Date.parse(since);
  const end = Date.parse(until);
  const length = end - start;
  const prevSince = new Date(start - length).toISOString();
  return {
    since: prevSince,
    until: since,
    label: `the ${describeLength(length)} before that`,
  };
}

function describeLength(ms: number): string {
  const days = ms / 86_400_000;
  if (days >= 1 && Number.isInteger(Math.round(days)) && Math.abs(days - Math.round(days)) < 0.01) {
    const n = Math.round(days);
    return n === 1 ? 'day' : `${n} days`;
  }
  const hours = Math.round(ms / 3_600_000);
  return hours === 1 ? 'hour' : `${hours} hours`;
}

/**
 * Caveats that travel with the numbers.
 *
 * The partial-window one matters most: comparing a part-finished today against a
 * whole previous day shows a fall that is an artefact of the clock, not of
 * behaviour, and it is the single easiest way to misread this feature.
 */
export function comparisonCaveats(
  current: { since: string; until?: string },
  previousTotals: AggregateRow,
): string[] {
  const caveats: string[] = [
    'Reported and estimated cost are compared separately and never summed, for the same ' +
      'reason they are reported separately: they are not the same kind of figure.',
  ];

  if (!current.until || Date.parse(current.until) > Date.now()) {
    caveats.push(
      'The current window is still open, so it is being compared against a window that has ' +
        'already finished. Part of any fall shown here is the clock, not a change in usage.',
    );
  }
  if (previousTotals.records === 0) {
    caveats.push(
      'The previous window has no records at all, so every change below is a change from ' +
        'nothing. Percentages are omitted rather than reported as 100%.',
    );
  }
  return caveats;
}
