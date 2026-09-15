import type {
  AggregateRow,
  GroupedRow,
  SessionRow,
  UsageFilter,
  UsageRepository,
} from '../db/repositories/usage-repository.js';
import type { ClientId } from '../models/usage-record.js';
import { emptyCostTotals, emptyTokenTotals } from '../models/usage-record.js';

/**
 * A day the period covers but nothing was spent on. Every figure is a real zero,
 * not an unavailable one: the period genuinely contains this day and it genuinely
 * had no usage, which is a fact about the data rather than a gap in it.
 */
function emptyDay(key: string): GroupedRow {
  return {
    key,
    ...emptyTokenTotals(),
    records: 0,
    sessions: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cost: emptyCostTotals(),
  };
}

/** Local calendar day, matching SQLite's `date(timestamp,'localtime')` grouping. */
function localDayKey(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * A period longer than this is not zero-filled. Ten years of daily rows is not a
 * report anyone reads, and an absurd `--since` should not be able to make the
 * process allocate its way out of memory.
 */
const MAX_FILLED_DAYS = 3700;

/**
 * Inserts the days a period covers that have no usage.
 *
 * `byDay` returns only days that have rows, so a 30-day window could come back as
 * 10 -- and the gaps were invisible. That makes a trend actively misleading:
 * consecutive rendered rows look adjacent, so an ordinary day reads as a spike
 * purely because it is the only one drawn near it.
 *
 * The filled span is deliberately bounded by what was asked for. An explicit
 * `since` extends the range even where no data reaches, because "I used nothing
 * that week" is the answer to the question. With no explicit bound the range is
 * the data's own first and last day, so "all time" cannot grow without limit.
 */
function zeroFillDays(days: GroupedRow[], filter: UsageFilter): GroupedRow[] {
  const present = new Map(days.map((d) => [d.key, d]));
  // byDay orders newest first, so the last row is the earliest day.
  const earliest = days.at(-1)?.key;
  const latest = days[0]?.key;

  const startKey = filter.since ? localDayKey(new Date(filter.since)) : earliest;
  const endKey = filter.until
    ? // `until` is exclusive, so the last day it covers is the millisecond before.
      localDayKey(new Date(new Date(filter.until).getTime() - 1))
    : filter.since
      ? localDayKey(new Date())
      : latest;

  if (!startKey || !endKey || startKey > endKey) return days;

  const out: GroupedRow[] = [];
  const cursor = new Date(`${startKey}T00:00:00`);
  const end = new Date(`${endKey}T00:00:00`);
  for (let guard = 0; cursor <= end; guard++) {
    if (guard >= MAX_FILLED_DAYS) return days;
    const key = localDayKey(cursor);
    out.push(present.get(key) ?? emptyDay(key));
    cursor.setDate(cursor.getDate() + 1);
  }
  // Newest first, matching what `byDay` returns.
  return out.reverse();
}

export interface SummaryReport {
  period: { since?: string; until?: string; label: string };
  includeSubagents: boolean;
  overall: AggregateRow;
  byClient: GroupedRow[];
  turnKinds: { main: number; subagent: number };
}

export interface ModelReport {
  period: { since?: string; until?: string; label: string };
  includeSubagents: boolean;
  models: GroupedRow[];
  overall: AggregateRow;
}

export interface ClientReport {
  period: { since?: string; until?: string; label: string };
  includeSubagents: boolean;
  clients: GroupedRow[];
  overall: AggregateRow;
}

export interface ProjectReport {
  period: { since?: string; until?: string; label: string };
  includeSubagents: boolean;
  /** Keyed by project path. Records with no project resolve to `(unknown)`. */
  projects: GroupedRow[];
  overall: AggregateRow;
}

export interface DailyReport {
  period: { since?: string; until?: string; label: string };
  includeSubagents: boolean;
  /** Newest day first. Keyed by local calendar date, `YYYY-MM-DD`. */
  days: GroupedRow[];
  overall: AggregateRow;
}

export interface SessionDetail {
  session: SessionRow;
  models: GroupedRow[];
  /** Subagent totals, broken out so a session's own turns stay distinguishable. */
  main: AggregateRow;
  subagent: AggregateRow;
}

/**
 * Pure read-side aggregation over the local database.
 *
 * Every method here takes the same `UsageFilter`, so the CLI and the MCP tools
 * cannot drift apart: identical filters in, identical numbers out.
 */
export class AggregationService {
  constructor(private readonly repo: UsageRepository) {}

  summary(filter: UsageFilter, label: string): SummaryReport {
    return {
      period: {
        ...(filter.since ? { since: filter.since } : {}),
        ...(filter.until ? { until: filter.until } : {}),
        label,
      },
      includeSubagents: filter.includeSubagents !== false,
      overall: this.repo.totals(filter),
      byClient: this.repo.byClient(filter),
      turnKinds: this.repo.turnKindCounts(filter),
    };
  }

  models(filter: UsageFilter, label: string, limit?: number): ModelReport {
    return {
      period: {
        ...(filter.since ? { since: filter.since } : {}),
        ...(filter.until ? { until: filter.until } : {}),
        label,
      },
      includeSubagents: filter.includeSubagents !== false,
      models: this.repo.byModel(filter, limit),
      overall: this.repo.totals(filter),
    };
  }

  clients(filter: UsageFilter, label: string): ClientReport {
    return {
      period: {
        ...(filter.since ? { since: filter.since } : {}),
        ...(filter.until ? { until: filter.until } : {}),
        label,
      },
      includeSubagents: filter.includeSubagents !== false,
      clients: this.repo.byClient(filter),
      overall: this.repo.totals(filter),
    };
  }

  projects(filter: UsageFilter, label: string, limit?: number): ProjectReport {
    return {
      period: {
        ...(filter.since ? { since: filter.since } : {}),
        ...(filter.until ? { until: filter.until } : {}),
        label,
      },
      includeSubagents: filter.includeSubagents !== false,
      projects: this.repo.byProject(filter, limit),
      overall: this.repo.totals(filter),
    };
  }

  recentSessions(filter: UsageFilter, limit: number): SessionRow[] {
    return this.repo.sessions(filter, limit);
  }

  byDay(filter: UsageFilter): GroupedRow[] {
    return this.repo.byDay(filter);
  }

  daily(filter: UsageFilter, label: string): DailyReport {
    return {
      period: {
        ...(filter.since ? { since: filter.since } : {}),
        ...(filter.until ? { until: filter.until } : {}),
        label,
      },
      includeSubagents: filter.includeSubagents !== false,
      days: zeroFillDays(this.repo.byDay(filter), filter),
      overall: this.repo.totals(filter),
    };
  }

  /** Resolves an exact or partial session id, then assembles its detail view. */
  session(
    sessionId: string,
    includeSubagents = true,
  ): SessionDetail | { ambiguous: string[] } | undefined {
    const matches = this.repo.findSessionIds(sessionId);
    if (matches.length === 0) return undefined;
    const exact = matches.includes(sessionId)
      ? sessionId
      : matches.length === 1
        ? matches[0]
        : undefined;
    if (!exact) return { ambiguous: matches };

    const base: UsageFilter = { sessionId: exact, includeSubagents };
    const rows = this.repo.sessions(base, 1);
    const session = rows[0];
    if (!session) return undefined;

    return {
      session,
      models: this.repo.byModel(base),
      main: this.repo.totals({ sessionId: exact, includeSubagents: false }),
      subagent: subtract(
        this.repo.totals({ sessionId: exact }),
        this.repo.totals({ sessionId: exact, includeSubagents: false }),
      ),
    };
  }

  clientsPresent(): { client: ClientId; records: number; lastTimestamp: string | null }[] {
    return this.repo.countsByClient();
  }
}

function subtract(all: AggregateRow, main: AggregateRow): AggregateRow {
  return {
    records: all.records - main.records,
    sessions: all.sessions,
    inputTokens: all.inputTokens - main.inputTokens,
    outputTokens: all.outputTokens - main.outputTokens,
    cacheReadTokens: all.cacheReadTokens - main.cacheReadTokens,
    cacheWriteTokens: all.cacheWriteTokens - main.cacheWriteTokens,
    cacheWrite5mTokens: all.cacheWrite5mTokens - main.cacheWrite5mTokens,
    cacheWrite1hTokens: all.cacheWrite1hTokens - main.cacheWrite1hTokens,
    reasoningTokens: all.reasoningTokens - main.reasoningTokens,
    totalTokens: all.totalTokens - main.totalTokens,
    cost: {
      reported: all.cost.reported - main.cost.reported,
      reportedRecords: all.cost.reportedRecords - main.cost.reportedRecords,
      estimated: all.cost.estimated - main.cost.estimated,
      estimatedRecords: all.cost.estimatedRecords - main.cost.estimatedRecords,
      unavailableRecords: all.cost.unavailableRecords - main.cost.unavailableRecords,
      currency: 'USD',
    },
  };
}
