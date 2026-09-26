import type {
  AggregateRow,
  GroupedRow,
  Page,
  PageRequest,
  SessionRow,
  TurnRow,
  UsageFilter,
  UsageRepository,
} from '../db/repositories/usage-repository.js';
import type { ClientId } from '../models/usage-record.js';
import type { CrossTabRow, GroupAxis, TimeGrain } from '../db/repositories/usage-repository.js';
import { zeroFill, type TimeBucket } from './time-buckets.js';
import { compareTotals, comparisonCaveats, type Comparison } from './comparison.js';

/**
 * What a list-shaped report says about the rows it did NOT return.
 *
 * Carried beside the rows rather than replacing them: existing consumers keep
 * reading `models`/`projects`/`clients` as an array, and a caller that wants to
 * page has something to page with.
 */
export interface PageInfo {
  total: number;
  offset: number;
  limit?: number;
  hasMore: boolean;
  nextOffset?: number;
  sort: string;
  rowsWithoutSortValue: number;
}

function pageInfo<T>(page: Page<T>): PageInfo {
  const info: PageInfo = {
    total: page.total,
    offset: page.offset,
    hasMore: page.hasMore,
    sort: page.sort,
    rowsWithoutSortValue: page.rowsWithoutSortValue,
  };
  if (page.limit !== undefined) info.limit = page.limit;
  if (page.nextOffset !== undefined) info.nextOffset = page.nextOffset;
  return info;
}

export interface SummaryReport {
  period: { since?: string; until?: string; label: string };
  includeSubagents: boolean;
  overall: AggregateRow;
  byClient: GroupedRow[];
  turnKinds: { main: number; subagent: number };
  /** Scope values the caller asked for that match no record at all. */
  unmatchedScope?: UnmatchedScope;
  /** Present when the caller asked to compare against another window. */
  comparison?: Comparison;
}

/**
 * Scope values that exist nowhere in the database.
 *
 * Without this, `--model does-not-exist` answers "No usage records for this
 * period" and exits 0 -- indistinguishable from a genuinely quiet period, which
 * invites reading a typo as a fact about the data.
 */
export interface UnmatchedScope {
  models?: string[];
  projectPaths?: string[];
  clients?: string[];
}

export interface ModelReport {
  period: { since?: string; until?: string; label: string };
  includeSubagents: boolean;
  models: GroupedRow[];
  page: PageInfo;
  overall: AggregateRow;
  unmatchedScope?: UnmatchedScope;
}

export interface ClientReport {
  period: { since?: string; until?: string; label: string };
  includeSubagents: boolean;
  clients: GroupedRow[];
  page: PageInfo;
  overall: AggregateRow;
  unmatchedScope?: UnmatchedScope;
}

export interface ProjectReport {
  period: { since?: string; until?: string; label: string };
  includeSubagents: boolean;
  /** Keyed by project path. Records with no project resolve to `(unknown)`. */
  projects: GroupedRow[];
  page: PageInfo;
  overall: AggregateRow;
  unmatchedScope?: UnmatchedScope;
}

export interface DailyReport {
  period: { since?: string; until?: string; label: string };
  includeSubagents: boolean;
  /**
   * Newest bucket first. Key shape depends on `grain`: `YYYY-MM-DD` for a day,
   * `YYYY-MM-DDTHH:00` for an hour, `HH` for hour-of-day.
   *
   * Buckets with no activity are INCLUDED, carrying `zeroFilled: true`. Omitting
   * them made a trend unreadable: the gaps were invisible, so an ordinary day
   * rendered beside one three weeks earlier and looked like a spike next to it.
   */
  days: TimeBucket[];
  grain: TimeGrain;
  /** Set when the range was too large to zero-fill, saying so rather than hiding it. */
  zeroFillNote?: string;
  overall: AggregateRow;
  unmatchedScope?: UnmatchedScope;
}

export interface BreakdownReport {
  period: { since?: string; until?: string; label: string };
  includeSubagents: boolean;
  /** The dimensions crossed, in the order requested. */
  axes: GroupAxis[];
  /** One row per combination present. Combinations with no activity are absent. */
  rows: CrossTabRow[];
  page: PageInfo;
  overall: AggregateRow;
  unmatchedScope?: UnmatchedScope;
}

export interface SessionDetail {
  session: SessionRow;
  models: GroupedRow[];
  /** Subagent totals, broken out so a session's own turns stay distinguishable. */
  main: AggregateRow;
  subagent: AggregateRow;
}

export interface HandoffPacket {
  sessionId: string;
  phaseName?: string;
  generatedAt: string;
  whatChanged: {
    filesModified: string[];
    keyDecisions: string[];
    configChanges: string[];
  };
  whatFailed: {
    errors: string[];
    testFailures: string[];
    blockers: string[];
  };
  whatNext: {
    nextSteps: string[];
    openQuestions: string[];
    contextNeeded: string[];
  };
  metadata: {
    totalTurns: number;
    mainTurns: number;
    subagentTurns: number;
    modelsUsed: string[];
    timeSpan: { start: string; end: string };
    totalTokens: number;
  };
}

/**
 * Pure read-side aggregation over the local database.
 *
 * Every method here takes the same `UsageFilter`, so the CLI and the MCP tools
 * cannot drift apart: identical filters in, identical numbers out.
 */
export class AggregationService {
  constructor(private readonly repo: UsageRepository) {}

  private periodOf(filter: UsageFilter, label: string) {
    return {
      ...(filter.since ? { since: filter.since } : {}),
      ...(filter.until ? { until: filter.until } : {}),
      label,
    };
  }

  /**
   * Scope values matching no record anywhere in the database.
   *
   * Checked against the whole table rather than the period, so the answer
   * separates "you typed a name that does not exist" from "that project was
   * quiet this week" -- two very different things that both rendered as an empty
   * report.
   */
  private unmatched(filter: UsageFilter): UnmatchedScope | undefined {
    const out: UnmatchedScope = {};
    if (filter.models?.length) {
      const missing = this.repo.absentValues('model', filter.models);
      if (missing.length) out.models = missing;
    }
    if (filter.projectPaths?.length) {
      const missing = this.repo.absentValues('project_path', filter.projectPaths);
      if (missing.length) out.projectPaths = missing;
    }
    if (filter.clients?.length) {
      const missing = this.repo.absentValues('client', filter.clients);
      if (missing.length) out.clients = missing;
    }
    return Object.keys(out).length ? out : undefined;
  }

  private withScope<T extends object>(report: T, filter: UsageFilter): T {
    const unmatchedScope = this.unmatched(filter);
    return unmatchedScope ? { ...report, unmatchedScope } : report;
  }

  summary(
    filter: UsageFilter,
    label: string,
    previous?: { since: string; until: string; label: string },
  ): SummaryReport {
    const comparison = previous ? this.comparison(filter, previous) : undefined;
    return this.withScope(
      {
        period: this.periodOf(filter, label),
        includeSubagents: filter.includeSubagents !== false,
        overall: this.repo.totals(filter),
        byClient: this.repo.byClient(filter).rows,
        turnKinds: this.repo.turnKindCounts(filter),
        ...(comparison ? { comparison } : {}),
      },
      filter,
    );
  }

  models(filter: UsageFilter, label: string, page: PageRequest = {}): ModelReport {
    const result = this.repo.byModel(filter, page);
    return this.withScope(
      {
        period: this.periodOf(filter, label),
        includeSubagents: filter.includeSubagents !== false,
        models: result.rows,
        page: pageInfo(result),
        overall: this.repo.totals(filter),
      },
      filter,
    );
  }

  clients(filter: UsageFilter, label: string, page: PageRequest = {}): ClientReport {
    const result = this.repo.byClient(filter, page);
    return this.withScope(
      {
        period: this.periodOf(filter, label),
        includeSubagents: filter.includeSubagents !== false,
        clients: result.rows,
        page: pageInfo(result),
        overall: this.repo.totals(filter),
      },
      filter,
    );
  }

  projects(filter: UsageFilter, label: string, page: PageRequest = {}): ProjectReport {
    const result = this.repo.byProject(filter, page);
    return this.withScope(
      {
        period: this.periodOf(filter, label),
        includeSubagents: filter.includeSubagents !== false,
        projects: result.rows,
        page: pageInfo(result),
        overall: this.repo.totals(filter),
      },
      filter,
    );
  }

  breakdown(
    axes: GroupAxis[],
    filter: UsageFilter,
    label: string,
    page: PageRequest = {},
  ): BreakdownReport {
    const result = this.repo.crossTab(axes, filter, page);
    return this.withScope(
      {
        period: this.periodOf(filter, label),
        includeSubagents: filter.includeSubagents !== false,
        axes,
        rows: result.rows,
        page: pageInfo(result),
        overall: this.repo.totals(filter),
      },
      filter,
    );
  }

  recentSessions(filter: UsageFilter, page: PageRequest = {}): Page<SessionRow> {
    return this.repo.sessions(filter, page);
  }

  byDay(filter: UsageFilter): GroupedRow[] {
    return this.repo.byDay(filter);
  }

  daily(filter: UsageFilter, label: string, grain: TimeGrain = 'day'): DailyReport {
    const observed = this.repo.byTime(filter, grain);
    // With no explicit period, fill only across the span that actually has data:
    // filling from the epoch would invent thousands of rows describing time
    // before any of it existed.
    const bounds =
      filter.since || filter.until
        ? {
            ...(filter.since ? { since: filter.since } : {}),
            ...(filter.until ? { until: filter.until } : {}),
          }
        : {};
    const filled = zeroFill(observed, grain, bounds);

    return this.withScope(
      {
        period: this.periodOf(filter, label),
        includeSubagents: filter.includeSubagents !== false,
        days: filled.rows,
        grain,
        ...(filled.note ? { zeroFillNote: filled.note } : {}),
        overall: this.repo.totals(filter),
      },
      filter,
    );
  }

  /**
   * Totals for the window of equal length immediately before this one.
   *
   * Requires a bounded current window. "All time" has no previous window, and
   * inventing one would be answering a question nobody asked.
   */
  comparison(
    filter: UsageFilter,
    previous?: { since: string; until: string; label: string },
  ): Comparison | undefined {
    const since = filter.since;
    if (!since || !previous) return undefined;

    const previousFilter: UsageFilter = { ...filter, since: previous.since, until: previous.until };
    const previousTotals = this.repo.totals(previousFilter);

    return {
      previous,
      previousTotals,
      delta: compareTotals(this.repo.totals(filter), previousTotals),
      caveats: comparisonCaveats(
        { since, ...(filter.until ? { until: filter.until } : {}) },
        previousTotals,
      ),
    };
  }

  /** Resolves an exact or partial session id, then assembles its detail view. */
  session(
    sessionId: string,
    includeSubagents = true,
    pricedModels?: string[],
  ): SessionDetail | { ambiguous: string[] } | undefined {
    const matches = this.repo.findSessionIds(sessionId);
    if (matches.length === 0) return undefined;
    const exact = matches.includes(sessionId)
      ? sessionId
      : matches.length === 1
        ? matches[0]
        : undefined;
    if (!exact) return { ambiguous: matches };

    const priced = pricedModels ? { pricedModels } : {};
    const base: UsageFilter = { sessionId: exact, includeSubagents, ...priced };
    const session = this.repo.sessions(base, { limit: 1 }).rows[0];
    if (!session) return undefined;

    return {
      session,
      models: this.repo.byModel(base).rows,
      main: this.repo.totals({ sessionId: exact, includeSubagents: false, ...priced }),
      subagent: subtract(
        this.repo.totals({ sessionId: exact, ...priced }),
        this.repo.totals({ sessionId: exact, includeSubagents: false, ...priced }),
      ),
    };
  }

  clientsPresent(): { client: ClientId; records: number; lastTimestamp: string | null }[] {
    return this.repo.countsByClient();
  }

  /** Generates a handoff packet for a session -- compresses raw history into a structured summary. */
  generateHandoffPacket(
    sessionId: string,
    includeSubagents = true,
    pricedModels?: string[],
    phaseName?: string,
  ): HandoffPacket | { ambiguous: string[] } | undefined {
    const matches = this.repo.findSessionIds(sessionId);
    if (matches.length === 0) return undefined;
    const exact = matches.includes(sessionId)
      ? sessionId
      : matches.length === 1
        ? matches[0]
        : undefined;
    if (!exact) return { ambiguous: matches };

    const priced = pricedModels ? { pricedModels } : {};
    const base: UsageFilter = { sessionId: exact, includeSubagents, ...priced };

    const turns = this.repo.turns(base, { limit: 5000 });
    if (turns.length === 0) {
      return {
        sessionId: exact,
        phaseName,
        generatedAt: new Date().toISOString(),
        whatChanged: { filesModified: [], keyDecisions: [], configChanges: [] },
        whatFailed: { errors: [], testFailures: [], blockers: [] },
        whatNext: { nextSteps: [], openQuestions: [], contextNeeded: [] },
        metadata: {
          totalTurns: 0,
          mainTurns: 0,
          subagentTurns: 0,
          modelsUsed: [],
          timeSpan: { start: '', end: '' },
          totalTokens: 0,
        },
      };
    }

    const session = this.repo.sessions(base, { limit: 1 }).rows[0];
    const models = [...new Set(turns.map((t) => t.model).filter((m) => m !== '(unknown)'))];
    const mainTurns = turns.filter((t) => t.turnKind === 'main').length;
    const subagentTurns = turns.filter((t) => t.turnKind === 'subagent').length;
    const totalTokens = turns.reduce((sum, t) => sum + t.totalTokens, 0);

    // Extract signals from turns - look for tool use, errors, file modifications
    const filesModified = this.extractFilesModified(turns);
    const keyDecisions = this.extractKeyDecisions(turns);
    const configChanges = this.extractConfigChanges(turns);
    const errors = this.extractErrors(turns);
    const testFailures = this.extractTestFailures(turns);
    const blockers = this.extractBlockers(turns);
    const nextSteps = this.inferNextSteps(turns);
    const openQuestions = this.inferOpenQuestions(turns);
    const contextNeeded = this.inferContextNeeded(turns);

    return {
      sessionId: exact,
      phaseName,
      generatedAt: new Date().toISOString(),
      whatChanged: { filesModified, keyDecisions, configChanges },
      whatFailed: { errors, testFailures, blockers },
      whatNext: { nextSteps, openQuestions, contextNeeded },
      metadata: {
        totalTurns: turns.length,
        mainTurns,
        subagentTurns,
        modelsUsed: models,
        timeSpan: {
          start: session?.startedAt ?? turns[0]?.timestamp ?? '',
          end: session?.endedAt ?? turns[turns.length - 1]?.timestamp ?? '',
        },
        totalTokens,
      },
    };
  }

  private extractFilesModified(turns: TurnRow[]): string[] {
    const files = new Set<string>();
    // This is a heuristic - in real usage we'd need access to tool calls
    // For now, we infer from model switches and subagent spawns
    return Array.from(files);
  }

  private extractKeyDecisions(turns: TurnRow[]): string[] {
    const decisions: string[] = [];
    const modelSwitches = turns.filter((t, i) => i > 0 && t.model !== (turns[i - 1]?.model ?? ''));
    for (const t of modelSwitches) {
      decisions.push(`Model switched to ${t.model} at ${t.timestamp}`);
    }
    if (turns.some((t) => t.turnKind === 'subagent')) {
      decisions.push('Subagent(s) spawned for parallel work');
    }
    return decisions;
  }

  private extractConfigChanges(turns: TurnRow[]): string[] {
    const changes: string[] = [];
    // Heuristic: speed changes might indicate config changes
    const speedChanges = turns.filter((t, i) => i > 0 && t.speed !== turns[i - 1]?.speed);
    for (const t of speedChanges) {
      changes.push(`Speed mode changed to ${t.speed ?? 'standard'} at ${t.timestamp}`);
    }
    return changes;
  }

  private extractErrors(turns: TurnRow[]): string[] {
    // Would need access to turn content for real error extraction
    return [];
  }

  private extractTestFailures(turns: TurnRow[]): string[] {
    return [];
  }

  private extractBlockers(turns: TurnRow[]): string[] {
    return [];
  }

  private inferNextSteps(turns: TurnRow[]): string[] {
    const steps: string[] = [];
    const lastTurn = turns[turns.length - 1];
    if (lastTurn) {
      steps.push(`Continue from ${lastTurn.model} at turn ${turns.length}`);
    }
    return steps;
  }

  private inferOpenQuestions(turns: TurnRow[]): string[] {
    return [];
  }

  private inferContextNeeded(turns: TurnRow[]): string[] {
    const needed: string[] = [];
    const models = [...new Set(turns.map((t) => t.model))];
    if (models.length > 1) {
      needed.push(`Context spans ${models.length} models: ${models.join(', ')}`);
    }
    return needed;
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
      // Counts subtract; the model NAMES cannot. A set difference of two counts
      // says nothing about which models are left, and naming the wrong one is
      // worse than naming none, so the names stay absent on a derived row.
      ...(all.cost.unpricedRecords !== undefined && main.cost.unpricedRecords !== undefined
        ? { unpricedRecords: all.cost.unpricedRecords - main.cost.unpricedRecords }
        : {}),
      currency: 'USD',
    },
  };
}
