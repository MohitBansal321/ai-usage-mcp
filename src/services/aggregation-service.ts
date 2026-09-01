import type {
  AggregateRow,
  GroupedRow,
  SessionRow,
  UsageFilter,
  UsageRepository,
} from '../db/repositories/usage-repository.js';
import type { ClientId } from '../models/usage-record.js';

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
