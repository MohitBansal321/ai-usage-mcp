import type {
  GroupedRow,
  UsageFilter,
  UsageRepository,
} from '../db/repositories/usage-repository.js';

/**
 * Spend against a target, and where it is heading.
 *
 * Nothing in the tool surface accepted a budget number, so extrapolating
 * month-end spend meant reading the active days out of `daily` and picking a
 * denominator -- calendar days? active days? -- by hand. That is a modelling
 * choice, and the two answers differ by a factor of two on a machine used on
 * weekdays only. This reports BOTH, labelled, and never blends them into one
 * "projected" figure.
 *
 * The prior question the issue raises -- which cost figure a Pro/Max subscriber
 * should budget from -- is answered the same way `--fail-over` answers it: the
 * caller names the basis. There is no default. Reported and estimated cost are
 * separate figures that are never summed, so a budget with no stated basis is a
 * budget against nothing in particular.
 */

export type BudgetBasis = 'reported' | 'estimated';

export const BUDGET_BASES: BudgetBasis[] = ['reported', 'estimated'];

/** A calendar period has an end to project towards; a rolling window does not. */
export type BudgetPeriod = 'month' | 'week';

export const BUDGET_PERIODS: BudgetPeriod[] = ['month', 'week'];

export interface Projection {
  /** Spend per day on this denominator. */
  ratePerDay: number;
  /** Where the period ends up at this rate. */
  projected: number;
  /** Positive when the projection exceeds the budget; absent when it does not. */
  overBy?: number;
  /** The denominator used, so the figure can be checked by hand. */
  days: number;
}

export interface BudgetReport {
  period: { since: string; until: string; label: string };
  basis: BudgetBasis;
  amount: number;
  /** Spend so far on the chosen basis only. Never a blend of the two. */
  spent: number;
  remaining: number;
  /** Spend as a fraction of the budget. May exceed 1. */
  fractionUsed: number;
  /** Whole and partial days elapsed, and the period's full length. */
  elapsed: { days: number; totalDays: number; fraction: number };
  /** Elapsed days with any recorded activity. The second denominator. */
  activeDays: number;
  /** Deliberately two, because the choice of denominator changes the answer. */
  projections: { perCalendarDay: Projection; perActiveDay: Projection };
  /** True when SPENT already exceeds the budget. A fact, not a forecast. */
  overBudget: boolean;
  /** Things that would make the figures misleading if unsaid. Never empty. */
  caveats: string[];
}

function startOfLocalMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
}

function startOfNextLocalMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
}

/** ISO weeks start on Monday; `getDay()` calls Sunday 0, hence the shift. */
function startOfLocalWeek(now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

export function budgetWindow(
  period: BudgetPeriod,
  now = new Date(),
): { since: Date; until: Date; label: string } {
  if (period === 'week') {
    const since = startOfLocalWeek(now);
    const until = new Date(since);
    until.setDate(until.getDate() + 7);
    return { since, until, label: 'this week (local, Monday start)' };
  }
  const since = startOfLocalMonth(now);
  const until = startOfNextLocalMonth(now);
  return {
    since,
    until,
    label: `${since.toLocaleString('en-US', { month: 'long' })} ${since.getFullYear()} (local)`,
  };
}

const DAY_MS = 86_400_000;

function projection(spent: number, days: number, totalDays: number, amount: number): Projection {
  // No elapsed days means no rate to project from. Reporting 0 would say "on
  // track for $0", which is a claim about the future made from no data.
  const ratePerDay = days > 0 ? spent / days : 0;
  const projected = ratePerDay * totalDays;
  const result: Projection = { ratePerDay, projected, days };
  if (projected > amount) result.overBy = projected - amount;
  return result;
}

export class BudgetService {
  constructor(private readonly repo: UsageRepository) {}

  budget(options: {
    amount: number;
    basis: BudgetBasis;
    period: BudgetPeriod;
    filter?: UsageFilter;
    now?: Date;
  }): BudgetReport {
    const now = options.now ?? new Date();
    const window = budgetWindow(options.period, now);
    const filter: UsageFilter = {
      ...options.filter,
      since: window.since.toISOString(),
      until: window.until.toISOString(),
    };

    const totals = this.repo.totals(filter);
    const spent = options.basis === 'reported' ? totals.cost.reported : totals.cost.estimated;
    const records =
      options.basis === 'reported' ? totals.cost.reportedRecords : totals.cost.estimatedRecords;

    const totalDays = Math.round((window.until.getTime() - window.since.getTime()) / DAY_MS);
    // Partial, not whole: a projection made at noon on the 17th that pretends
    // 16 days have passed over-states the rate by a sixteenth.
    const elapsedMs = Math.max(
      0,
      Math.min(now.getTime(), window.until.getTime()) - window.since.getTime(),
    );
    const elapsedDays = elapsedMs / DAY_MS;

    // A day with any recorded turn. The second denominator, and the one that
    // matters on a machine used on weekdays only.
    const activeDays = this.repo.byDay(filter).filter((day: GroupedRow) => day.records > 0).length;

    return {
      period: {
        since: window.since.toISOString(),
        until: window.until.toISOString(),
        label: window.label,
      },
      basis: options.basis,
      amount: options.amount,
      spent,
      remaining: options.amount - spent,
      fractionUsed: options.amount === 0 ? 0 : spent / options.amount,
      elapsed: {
        days: elapsedDays,
        totalDays,
        fraction: totalDays === 0 ? 0 : elapsedDays / totalDays,
      },
      activeDays,
      projections: {
        perCalendarDay: projection(spent, elapsedDays, totalDays, options.amount),
        perActiveDay: projection(spent, activeDays, totalDays, options.amount),
      },
      overBudget: spent > options.amount,
      caveats: this.caveats(options.basis, records, totals.cost.unpricedRecords),
    };
  }

  private caveats(basis: BudgetBasis, records: number, unpricedRecords?: number): string[] {
    const caveats: string[] = [
      'The two projections use different denominators on purpose. Calendar-day pace assumes ' +
        'the rest of the period looks like the period so far, weekends included; active-day ' +
        'pace assumes every remaining day is a working one. Neither is "the" answer, and the ' +
        'gap between them is the size of the assumption.',
    ];

    if (basis === 'estimated') {
      caveats.push(
        'Budgeting against the ESTIMATED basis. That is an API-equivalent list price: on a ' +
          'Claude Pro or Max subscription the marginal cost per request is $0, so this is a ' +
          'shadow price for comparing workloads, not money you will be billed. If you are on a ' +
          'subscription, the figure to watch is usage against your plan limits, which this ' +
          'tool cannot see.',
      );
    } else {
      caveats.push(
        'Budgeting against the REPORTED basis: only records whose client told us what it ' +
          'charged. Claude Code reports no cost at all, so its usage is NOT in this figure.',
      );
    }

    if (records === 0) {
      caveats.push(
        `No record in this period carries a ${basis} cost, so the spend is $0.00 because ` +
          'nothing was measured on this basis -- not because nothing was spent. Check the ' +
          'other basis before concluding you are under budget.',
      );
    }
    if (unpricedRecords !== undefined && unpricedRecords > 0) {
      caveats.push(
        `${unpricedRecords} record(s) in this period have no price in the pricing table, so ` +
          'no estimate was attempted for them. Whatever they cost is missing from every ' +
          'figure above.',
      );
    }
    return caveats;
  }
}
