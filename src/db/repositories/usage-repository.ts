import type { Database, Statement } from 'better-sqlite3';
import type {
  ClientId,
  CostTotals,
  TokenTotals,
  TurnKind,
  UsageRecord,
} from '../../models/usage-record.js';

export interface UsageFilter {
  /** Inclusive lower bound, ISO 8601. */
  since?: string;
  /** Exclusive upper bound, ISO 8601. */
  until?: string;
  client?: ClientId;
  model?: string;
  sessionId?: string;
  projectPath?: string;
  /**
   * Include subagent/sidechain turns. Defaults to true: they are real spend.
   * The same default is used by the CLI and the MCP tools -- see README.
   */
  includeSubagents?: boolean;
}

export interface AggregateRow extends TokenTotals {
  records: number;
  sessions: number;
  /**
   * Cache writes split by TTL. Kept alongside the combined `cacheWriteTokens`
   * because the two are priced differently (1.25x vs 2x of the input rate), so
   * anything re-pricing a period needs them separately.
   */
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cost: CostTotals;
  firstTimestamp?: string;
  lastTimestamp?: string;
}

/**
 * One stored turn. The first non-aggregate shape in this repository: every other
 * read collapses rows, which makes per-turn questions -- how context grew, what a
 * single turn cost -- unanswerable.
 */
export interface TurnRow {
  id: string;
  client: ClientId;
  provider: string;
  model: string;
  sessionId: string;
  projectPath?: string;
  timestamp: string;
  turnKind: TurnKind;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost?: number;
  estimatedCost?: number;
  costBasis: string;
}

/** Sessions reach thousands of turns, so a row read is always bounded. */
export const TURNS_DEFAULT_LIMIT = 200;
export const TURNS_MAX_LIMIT = 5000;

export interface GroupedRow extends AggregateRow {
  key: string;
}

export interface SessionRow extends AggregateRow {
  sessionId: string;
  client: ClientId;
  projectPath?: string;
  models: string[];
  startedAt: string;
  endedAt: string;
  /** Wall-clock span between the first and last priced turn, in seconds. */
  durationSeconds: number;
  mainRecords: number;
  subagentRecords: number;
}

interface RawAgg {
  records: number;
  sessions: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  reported: number | null;
  reported_records: number | null;
  estimated: number | null;
  estimated_records: number | null;
  unavailable_records: number | null;
  first_ts: string | null;
  last_ts: string | null;
}

const AGG_SELECT = `
  COUNT(*)                          AS records,
  COUNT(DISTINCT session_id)        AS sessions,
  SUM(input_tokens)                 AS input_tokens,
  SUM(output_tokens)                AS output_tokens,
  SUM(COALESCE(cache_read_tokens,0))  AS cache_read_tokens,
  SUM(COALESCE(cache_write_tokens,0)) AS cache_write_tokens,
  SUM(COALESCE(cache_write_5m_tokens,0)) AS cache_write_5m_tokens,
  SUM(COALESCE(cache_write_1h_tokens,0)) AS cache_write_1h_tokens,
  SUM(COALESCE(reasoning_tokens,0))   AS reasoning_tokens,
  SUM(total_tokens)                 AS total_tokens,
  SUM(CASE WHEN cost_basis='reported'  THEN COALESCE(cost,0)           ELSE 0 END) AS reported,
  SUM(CASE WHEN cost_basis='reported'  THEN 1 ELSE 0 END)                          AS reported_records,
  SUM(CASE WHEN cost_basis='estimated' THEN COALESCE(estimated_cost,0) ELSE 0 END) AS estimated,
  SUM(CASE WHEN cost_basis='estimated' THEN 1 ELSE 0 END)                          AS estimated_records,
  SUM(CASE WHEN cost_basis='unavailable' THEN 1 ELSE 0 END)                        AS unavailable_records,
  MIN(timestamp)                    AS first_ts,
  MAX(timestamp)                    AS last_ts
`;

function buildWhere(filter: UsageFilter): { sql: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.since) {
    clauses.push('timestamp >= :since');
    params.since = filter.since;
  }
  if (filter.until) {
    clauses.push('timestamp < :until');
    params.until = filter.until;
  }
  if (filter.client) {
    clauses.push('client = :client');
    params.client = filter.client;
  }
  if (filter.model) {
    clauses.push('model = :model');
    params.model = filter.model;
  }
  if (filter.sessionId) {
    clauses.push('session_id = :sessionId');
    params.sessionId = filter.sessionId;
  }
  if (filter.projectPath) {
    clauses.push('project_path = :projectPath');
    params.projectPath = filter.projectPath;
  }
  if (filter.includeSubagents === false) {
    clauses.push("turn_kind = 'main'");
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function toAggregate(raw: RawAgg | undefined): AggregateRow {
  const r = raw ?? ({} as RawAgg);
  const row: AggregateRow = {
    records: r.records ?? 0,
    sessions: r.sessions ?? 0,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    cacheReadTokens: r.cache_read_tokens ?? 0,
    cacheWriteTokens: r.cache_write_tokens ?? 0,
    cacheWrite5mTokens: r.cache_write_5m_tokens ?? 0,
    cacheWrite1hTokens: r.cache_write_1h_tokens ?? 0,
    reasoningTokens: r.reasoning_tokens ?? 0,
    totalTokens: r.total_tokens ?? 0,
    cost: {
      reported: r.reported ?? 0,
      reportedRecords: r.reported_records ?? 0,
      estimated: r.estimated ?? 0,
      estimatedRecords: r.estimated_records ?? 0,
      unavailableRecords: r.unavailable_records ?? 0,
      currency: 'USD',
    },
  };
  if (r.first_ts) row.firstTimestamp = r.first_ts;
  if (r.last_ts) row.lastTimestamp = r.last_ts;
  return row;
}

export class UsageRepository {
  private readonly upsertStmt: Statement;

  constructor(private readonly db: Database) {
    this.upsertStmt = db.prepare(`
      INSERT INTO usage_records (
        id, client, provider, model, session_id, project_path, timestamp,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens, reasoning_tokens, total_tokens,
        cost, estimated_cost, cost_basis, currency, turn_kind, source, source_version, created_at
      ) VALUES (
        @id, @client, @provider, @model, @sessionId, @projectPath, @timestamp,
        @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
        @cacheWrite5mTokens, @cacheWrite1hTokens, @reasoningTokens, @totalTokens,
        @cost, @estimatedCost, @costBasis, @currency, @turnKind, @source, @sourceVersion, @createdAt
      )
      ON CONFLICT(id) DO UPDATE SET
        client=excluded.client, provider=excluded.provider, model=excluded.model,
        session_id=excluded.session_id, project_path=excluded.project_path,
        timestamp=excluded.timestamp,
        input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
        cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
        cache_write_5m_tokens=excluded.cache_write_5m_tokens,
        cache_write_1h_tokens=excluded.cache_write_1h_tokens,
        reasoning_tokens=excluded.reasoning_tokens, total_tokens=excluded.total_tokens,
        cost=excluded.cost, estimated_cost=excluded.estimated_cost,
        cost_basis=excluded.cost_basis, currency=excluded.currency,
        turn_kind=excluded.turn_kind, source=excluded.source,
        source_version=excluded.source_version
    `);
  }

  /** Idempotent by design: re-syncing the same source data must not change totals. */
  upsertMany(records: UsageRecord[]): number {
    if (records.length === 0) return 0;
    const createdAt = new Date().toISOString();
    const run = this.db.transaction((batch: UsageRecord[]) => {
      for (const r of batch) {
        this.upsertStmt.run({
          id: r.id,
          client: r.client,
          provider: r.provider,
          model: r.model,
          sessionId: r.sessionId,
          projectPath: r.projectPath ?? null,
          timestamp: r.timestamp,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens ?? null,
          cacheWriteTokens: r.cacheWriteTokens ?? null,
          cacheWrite5mTokens: r.cacheWrite5mTokens ?? null,
          cacheWrite1hTokens: r.cacheWrite1hTokens ?? null,
          reasoningTokens: r.reasoningTokens ?? null,
          totalTokens: r.totalTokens,
          cost: r.cost ?? null,
          estimatedCost: r.estimatedCost ?? null,
          costBasis: r.costBasis,
          currency: r.currency,
          turnKind: r.turnKind,
          source: r.source,
          sourceVersion: r.sourceVersion ?? null,
          createdAt,
        });
      }
    });
    run(records);
    return records.length;
  }

  totals(filter: UsageFilter = {}): AggregateRow {
    const { sql, params } = buildWhere(filter);
    const raw = this.db.prepare(`SELECT ${AGG_SELECT} FROM usage_records ${sql}`).get(params) as
      RawAgg | undefined;
    return toAggregate(raw);
  }

  private grouped(column: string, filter: UsageFilter, limit?: number): GroupedRow[] {
    const { sql, params } = buildWhere(filter);
    const limitSql = limit ? 'LIMIT :limit' : '';
    if (limit) params.limit = limit;
    const rows = this.db
      .prepare(
        `SELECT ${column} AS key, ${AGG_SELECT} FROM usage_records ${sql}
         GROUP BY ${column} ORDER BY total_tokens DESC ${limitSql}`,
      )
      .all(params) as (RawAgg & { key: string })[];
    return rows.map((r) => ({ key: r.key, ...toAggregate(r) }));
  }

  byClient(filter: UsageFilter = {}): GroupedRow[] {
    return this.grouped('client', filter);
  }

  byModel(filter: UsageFilter = {}, limit?: number): GroupedRow[] {
    return this.grouped('model', filter, limit);
  }

  byProvider(filter: UsageFilter = {}): GroupedRow[] {
    return this.grouped('provider', filter);
  }

  byProject(filter: UsageFilter = {}, limit?: number): GroupedRow[] {
    return this.grouped("COALESCE(project_path,'(unknown)')", filter, limit);
  }

  /**
   * Per-day totals bucketed in LOCAL time, matching how `resolvePeriod` derives
   * its bounds from local midnight. Bucketing on `substr(timestamp,1,10)` would
   * be UTC, which puts a turn made late in the evening into the wrong day for
   * every user east of Greenwich -- and silently disagrees with the very period
   * filter that selected the rows. `localtime` reads the OS timezone database,
   * so it stays correct across DST changes where a fixed offset would not.
   */
  byDay(filter: UsageFilter = {}): GroupedRow[] {
    const { sql, params } = buildWhere(filter);
    const rows = this.db
      .prepare(
        `SELECT date(timestamp,'localtime') AS key, ${AGG_SELECT} FROM usage_records ${sql}
         GROUP BY key ORDER BY key DESC`,
      )
      .all(params) as (RawAgg & { key: string })[];
    return rows.map((r) => ({ key: r.key, ...toAggregate(r) }));
  }

  /**
   * Individual turns, oldest first so a caller can read a session as a series.
   * Always bounded: `limit` defaults to {@link TURNS_DEFAULT_LIMIT} and is capped
   * at {@link TURNS_MAX_LIMIT}, because a single session can exceed 2,000 turns.
   */
  turns(filter: UsageFilter = {}, options: { limit?: number; offset?: number } = {}): TurnRow[] {
    const { sql, params } = buildWhere(filter);
    params.limit = Math.min(Math.max(1, options.limit ?? TURNS_DEFAULT_LIMIT), TURNS_MAX_LIMIT);
    params.offset = Math.max(0, options.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT id, client, provider, model, session_id, project_path, timestamp, turn_kind,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                cache_write_5m_tokens, cache_write_1h_tokens, reasoning_tokens, total_tokens,
                cost, estimated_cost, cost_basis
         FROM usage_records ${sql}
         ORDER BY timestamp ASC, id ASC
         LIMIT :limit OFFSET :offset`,
      )
      .all(params) as Record<string, unknown>[];
    return rows.map((r) => {
      const turn: TurnRow = {
        id: r.id as string,
        client: r.client as ClientId,
        provider: r.provider as string,
        model: r.model as string,
        sessionId: r.session_id as string,
        timestamp: r.timestamp as string,
        turnKind: r.turn_kind as TurnKind,
        inputTokens: (r.input_tokens as number) ?? 0,
        outputTokens: (r.output_tokens as number) ?? 0,
        cacheReadTokens: (r.cache_read_tokens as number) ?? 0,
        cacheWriteTokens: (r.cache_write_tokens as number) ?? 0,
        cacheWrite5mTokens: (r.cache_write_5m_tokens as number) ?? 0,
        cacheWrite1hTokens: (r.cache_write_1h_tokens as number) ?? 0,
        reasoningTokens: (r.reasoning_tokens as number) ?? 0,
        totalTokens: (r.total_tokens as number) ?? 0,
        costBasis: r.cost_basis as string,
      };
      if (r.project_path != null) turn.projectPath = r.project_path as string;
      if (r.cost != null) turn.cost = r.cost as number;
      if (r.estimated_cost != null) turn.estimatedCost = r.estimated_cost as number;
      return turn;
    });
  }

  /** Total turns matching a filter, so a caller can page without guessing. */
  countTurns(filter: UsageFilter = {}): number {
    const { sql, params } = buildWhere(filter);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM usage_records ${sql}`).get(params) as {
      n: number;
    };
    return row.n;
  }

  /** Recent sessions, newest activity first. */
  sessions(filter: UsageFilter = {}, limit = 20): SessionRow[] {
    const { sql, params } = buildWhere(filter);
    params.limit = limit;
    const rows = this.db
      .prepare(
        `SELECT session_id, client, MAX(project_path) AS project_path,
                GROUP_CONCAT(DISTINCT model) AS models,
                SUM(CASE WHEN turn_kind='main' THEN 1 ELSE 0 END)     AS main_records,
                SUM(CASE WHEN turn_kind='subagent' THEN 1 ELSE 0 END) AS subagent_records,
                ${AGG_SELECT}
         FROM usage_records ${sql}
         GROUP BY session_id, client
         ORDER BY last_ts DESC
         LIMIT :limit`,
      )
      .all(params) as (RawAgg & {
      session_id: string;
      client: ClientId;
      project_path: string | null;
      models: string | null;
      main_records: number;
      subagent_records: number;
    })[];

    return rows.map((r) => {
      const agg = toAggregate(r);
      const startedAt = r.first_ts ?? '';
      const endedAt = r.last_ts ?? '';
      const durationSeconds =
        startedAt && endedAt
          ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
          : 0;
      const row: SessionRow = {
        ...agg,
        sessionId: r.session_id,
        client: r.client,
        models: (r.models ?? '').split(',').filter(Boolean).sort(),
        startedAt,
        endedAt,
        durationSeconds,
        mainRecords: r.main_records ?? 0,
        subagentRecords: r.subagent_records ?? 0,
      };
      if (r.project_path) row.projectPath = r.project_path;
      return row;
    });
  }

  /** Resolves a full or unambiguous partial session id. */
  findSessionIds(partial: string, limit = 5): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT session_id FROM usage_records
         WHERE session_id = :exact OR session_id LIKE :like
         ORDER BY (session_id = :exact) DESC, session_id LIMIT :limit`,
      )
      .all({ exact: partial, like: `%${partial}%`, limit }) as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  modelsForSession(sessionId: string): GroupedRow[] {
    return this.grouped('model', { sessionId });
  }

  recordCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM usage_records').get() as { n: number };
    return row.n;
  }

  countsByClient(): { client: ClientId; records: number; lastTimestamp: string | null }[] {
    return this.db
      .prepare(
        `SELECT client, COUNT(*) AS records, MAX(timestamp) AS lastTimestamp
         FROM usage_records GROUP BY client ORDER BY client`,
      )
      .all() as { client: ClientId; records: number; lastTimestamp: string | null }[];
  }

  /** Distinct token-bearing turn kinds present, for honest "includes subagents" labelling. */
  turnKindCounts(filter: UsageFilter = {}): Record<TurnKind, number> {
    const { sql, params } = buildWhere({ ...filter, includeSubagents: true });
    const rows = this.db
      .prepare(`SELECT turn_kind, COUNT(*) AS n FROM usage_records ${sql} GROUP BY turn_kind`)
      .all(params) as { turn_kind: TurnKind; n: number }[];
    const out: Record<TurnKind, number> = { main: 0, subagent: 0 };
    for (const r of rows) out[r.turn_kind] = r.n;
    return out;
  }

  deleteByClient(client: ClientId): number {
    const info = this.db.prepare('DELETE FROM usage_records WHERE client = ?').run(client);
    return info.changes;
  }
}
