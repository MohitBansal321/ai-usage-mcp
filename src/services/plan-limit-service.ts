import {
  PLAN_LIMIT_WINDOWS,
  WINDOW_MS,
  type PlanLimitWindow,
  type StatusLineInput,
} from '../collectors/claude-code/statusline.js';
import type {
  PlanLimitRepository,
  StoredPlanLimitReading,
} from '../db/repositories/plan-limit-repository.js';
import type {
  AggregateRow,
  UsageFilter,
  UsageRepository,
} from '../db/repositories/usage-repository.js';

/**
 * How much of a Pro or Max plan's 5-hour and weekly limits is used, as Claude
 * Code itself reported it.
 *
 * Until now this was the one figure the README said this tool could not see:
 * Claude Code writes it to no file. It does hand it to a configured status-line
 * command, so `ai-usage statusline` keeps each reading, and this service reports
 * the latest one per window -- the percentage verbatim, never re-derived from
 * tokens, because the limit is not published as a token count and any such
 * conversion would be a number made up.
 */

export const PLAN_WINDOW_LABEL: Record<PlanLimitWindow, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
};

/**
 * The shortest stretch of readings a pace is computed over. Two readings a
 * minute apart give a rate, but not one worth projecting a reset-sized horizon
 * from.
 */
const MIN_PACE_SPAN_MS: Record<PlanLimitWindow, number> = {
  five_hour: 10 * 60 * 1000,
  seven_day: 2 * 60 * 60 * 1000,
};

/**
 * Readings whose reset times differ by less than this belong to one window.
 * Nothing documents the reset instant as fixed for a window's life, so an exact
 * match would split one window in two over a second of jitter; a new window
 * moves it by hours, which no tolerance this size can blur.
 */
const SAME_WINDOW_TOLERANCE_MS = 5 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

export interface PlanPace {
  /** Average rise per hour, from the first reading in this window to the last. */
  percentPerHour: number;
  /** Distinct readings the pace is measured over. */
  readings: number;
  /** ISO: the first reading the pace is measured from. */
  from: string;
  /** ISO: the last time the latest value was seen. */
  to: string;
  /**
   * ISO: when the window reaches 100% at this pace. Absent when usage is not
   * rising, or is already at 100%.
   */
  reachesFullAt?: string;
  /** True when that comes before the reset -- the one case worth a warning. */
  fullBeforeReset: boolean;
}

export interface PlanWindowReport {
  window: PlanLimitWindow;
  label: string;
  /**
   * `current` -- the latest reading's window has not reset yet.
   * `reset`   -- it has, and no reading has arrived since: usage in the new
   *              window is unknown, NOT 0.
   * `none`    -- no reading has ever been stored for this window.
   */
  state: 'current' | 'reset' | 'none';
  latest?: StoredPlanLimitReading;
  /** ISO: the reset time minus the window's length. Present for `current`. */
  windowStart?: string;
  pace?: PlanPace;
  /** This machine's Claude Code turns since `windowStart`. Present for `current`. */
  local?: AggregateRow;
}

export interface PlanUsageReport {
  windows: PlanWindowReport[];
  /** True when nothing has ever been recorded, so the report is setup advice. */
  noReadings: boolean;
  /** Things that would make the figures misleading if unsaid. Never empty. */
  caveats: string[];
}

/** One status-line render: everything it shows, and nothing it does not. */
export interface StatusLineReport {
  /** Windows with a current reading only. A window that has reset is left out. */
  limits: Array<{
    window: PlanLimitWindow;
    usedPercent: number;
    resetsAt: string;
    /** Present only when the pace reaches 100% before the reset. */
    fullAt?: string;
  }>;
  /** Today's totals, local time, every client. */
  today: AggregateRow;
  /** The cache in the session Claude Code is rendering for, when it has turns stored. */
  session?: {
    hitRate?: number;
    breakCount: number;
    estimatedExtraCost?: number;
  };
}

export class PlanLimitService {
  constructor(
    private readonly limits: PlanLimitRepository,
    private readonly usage: UsageRepository,
  ) {}

  /** Stores what a status-line payload carried. Returns how many rows were new. */
  record(input: StatusLineInput, now = new Date()): number {
    let written = 0;
    for (const reading of input.readings) {
      if (this.limits.record('claude-code', reading, now.toISOString(), input.version)) written++;
    }
    return written;
  }

  report(baseFilter: UsageFilter, now = new Date()): PlanUsageReport {
    const windows = PLAN_LIMIT_WINDOWS.map((w) => this.window(w, baseFilter, now));
    const noReadings = windows.every((w) => w.state === 'none');
    return { windows, noReadings, caveats: this.caveats(windows, noReadings) };
  }

  window(window: PlanLimitWindow, baseFilter: UsageFilter, now = new Date()): PlanWindowReport {
    const label = PLAN_WINDOW_LABEL[window];
    const latest = this.limits.latest('claude-code', window);
    if (!latest) return { window, label, state: 'none' };

    const resetsAt = new Date(latest.resetsAt).getTime();
    if (resetsAt <= now.getTime()) return { window, label, state: 'reset', latest };

    const windowStart = new Date(resetsAt - WINDOW_MS[window]).toISOString();
    const report: PlanWindowReport = { window, label, state: 'current', latest, windowStart };

    const pace = this.pace(window, latest, windowStart);
    if (pace) report.pace = pace;

    report.local = this.usage.totals({
      ...baseFilter,
      clients: ['claude-code'],
      since: windowStart,
    });
    return report;
  }

  private pace(
    window: PlanLimitWindow,
    latest: StoredPlanLimitReading,
    windowStart: string,
  ): PlanPace | undefined {
    const resetsAt = new Date(latest.resetsAt).getTime();
    const readings = this.limits
      .since('claude-code', window, windowStart)
      .filter(
        (r) => Math.abs(new Date(r.resetsAt).getTime() - resetsAt) < SAME_WINDOW_TOLERANCE_MS,
      );
    const first = readings[0];
    if (!first || readings.length < 2) return undefined;

    const fromMs = new Date(first.observedAt).getTime();
    const toMs = new Date(latest.lastSeenAt).getTime();
    if (toMs - fromMs < MIN_PACE_SPAN_MS[window]) return undefined;

    // Never negative: a reading that went DOWN inside one window is not a
    // credit to project from, it is noise in someone else's rounding.
    const rise = Math.max(0, latest.usedPercent - first.usedPercent);
    const percentPerHour = rise / ((toMs - fromMs) / HOUR_MS);
    const pace: PlanPace = {
      percentPerHour,
      readings: readings.length,
      from: first.observedAt,
      to: latest.lastSeenAt,
      fullBeforeReset: false,
    };
    if (percentPerHour > 0 && latest.usedPercent < 100) {
      const fullMs = toMs + ((100 - latest.usedPercent) / percentPerHour) * HOUR_MS;
      pace.reachesFullAt = new Date(fullMs).toISOString();
      pace.fullBeforeReset = fullMs < resetsAt;
    }
    return pace;
  }

  private caveats(windows: PlanWindowReport[], noReadings: boolean): string[] {
    if (noReadings) {
      return [
        'No plan-limit reading has been recorded, so usage against your limits is UNAVAILABLE ' +
          '-- not 0%. Claude Code reports these percentages only to a status-line command. ' +
          'Set `ai-usage statusline` as yours (see `ai-usage help` or the README) and each ' +
          'reading is kept from then on. They exist only on a Claude Pro or Max plan; an API ' +
          'key has no such limits.',
      ];
    }
    const caveats = [
      "These percentages are Claude Code's own figures, passed to its status line and kept " +
        'by `ai-usage statusline` -- as fresh as the last time it ran, never re-derived from ' +
        'tokens. The limits are not published as token counts, so no token figure here can ' +
        'be turned into one.',
      'The limits are shared by everything on your account -- claude.ai, the desktop app, and ' +
        "Claude Code on other machines. The token figures cover only this machine's Claude " +
        'Code turns since the window started (taken as the reset time minus its length).',
    ];
    if (windows.some((w) => w.pace)) {
      caveats.push(
        'Pace is the average rise from the first reading in the window to the last, and the ' +
          '100% time is where that pace would land: a projection, not a fact. A burst of work ' +
          'after a quiet hour makes it look slower than it is now.',
      );
    }
    return caveats;
  }
}
