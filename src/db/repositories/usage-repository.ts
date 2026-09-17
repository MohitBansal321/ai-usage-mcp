import type { SqliteDatabase, SqliteStatement } from '../driver.js';
import type {
  ClientId,
  CostTotals,
  TokenTotals,
  TurnKind,
  UsageRecord,
} from '../../models/usage-record.js';
import { normaliseProjectPath } from '../../models/usage-record.js';

export interface UsageFilter {
  /** Inclusive lower bound, ISO 8601. */
  since?: string;
  /** Exclusive upper bound, ISO 8601. */
  until?: string;
  /**
   * Scope filters, each matching ANY of the values given.
   *
   * Lists rather than single values because one value could not answer "these
   * two projects" or "these three models" without N calls and a client-side
   * join. An EMPTY list means "none of them" and matches nothing -- it is not
   * treated as "no filter", which is how an empty `--model ""` used to answer a
   * narrowed question with the whole database.
   */
  clients?: ClientId[];
  models?: string[];
  projectPaths?: string[];
  sessionId?: string;
  /**
   * Include subagent/sidechain turns. Defaults to true: they are real spend.
   * The same default is used by the CLI and the MCP tools -- see README.
   */
  includeSubagents?: boolean;
  /**
   * Every model id the pricing table can price, so each aggregate can report how
   * many of its records no estimate was even attempted for.
   *
   * Deliberately a caller-supplied list rather than a lookup: the repository has
   * no business importing the pricing table, and a caller who does not supply one
   * gets `unpricedRecords: undefined` -- "not asked" -- instead of a 0 that would
   * claim every model is priced. An empty array is a real answer (nothing is
   * priced) and is not the same as omitting it.
   */
  pricedModels?: string[];
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
 * Totals for one (client, model, speed) combination -- the smallest grouping that
 * can be honestly re-priced at a different model's rates.
 */
export interface RepriceGroup extends AggregateRow {
  client: ClientId;
  model: string;
  /** Absent when the source never recorded a speed. Not the same as 'standard'. */
  speed?: string;
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
  /** As recorded by the source; 'fast' billed at premium rates. Absent if unsaid. */
  speed?: string;
}

/** Sessions reach thousands of turns, so a row read is always bounded. */
export const TURNS_DEFAULT_LIMIT = 200;
export const TURNS_MAX_LIMIT = 5000;

export interface GroupedRow extends AggregateRow {
  key: string;
}

/**
 * How a list of rows is ordered.
 *
 * There is deliberately no plain `cost`. Reported and estimated cost are
 * separate figures that must never be summed, so "order by cost" has no single
 * answer: ordering by one silently sorts every row priced on the other basis as
 * though it were $0. The caller has to say which, and the report says how many
 * rows that ordering could not speak for.
 */
export type SortKey =
  'tokens' | 'reported-cost' | 'estimated-cost' | 'records' | 'sessions' | 'recent';

export const SORT_KEYS: SortKey[] = [
  'tokens',
  'reported-cost',
  'estimated-cost',
  'records',
  'sessions',
  'recent',
];

/**
 * The ORDER BY behind each sort key. Every one is followed by a deterministic
 * tie-break, or paging would silently drop and repeat rows between pages when
 * two rows compare equal.
 */
const SORT_SQL: Record<SortKey, string> = {
  tokens: 'total_tokens DESC',
  'reported-cost': 'reported DESC',
  'estimated-cost': 'estimated DESC',
  records: 'records DESC',
  sessions: 'sessions DESC',
  recent: 'last_ts DESC',
};

/**
 * For the two cost sorts, the record count that must be non-zero for a row to
 * carry a figure on that basis. Non-cost sorts have no such notion.
 */
const COST_SORT_COLUMN: Partial<Record<SortKey, string>> = {
  'reported-cost': 'reported_records',
  'estimated-cost': 'estimated_records',
};

/**
 * Time buckets, all evaluated in local time.
 *
 * `hour-of-day` is not a finer timeline -- it collapses every day onto one
 * 24-slot clock, which is the only grain that answers "when during the day do I
 * burn tokens". The other two are ordinary timelines.
 */
export type TimeGrain = 'hour' | 'day' | 'hour-of-day';

export const TIME_GRAINS: TimeGrain[] = ['hour', 'day', 'hour-of-day'];

const TIME_GRAIN_SQL: Record<TimeGrain, string> = {
  hour: "strftime('%Y-%m-%dT%H:00', timestamp, 'localtime')",
  day: "date(timestamp,'localtime')",
  'hour-of-day': "strftime('%H', timestamp, 'localtime')",
};

export interface PageRequest {
  limit?: number;
  offset?: number;
  sort?: SortKey;
}

/**
 * A page of rows that knows what it is a page OF.
 *
 * `--limit` alone tells a caller nothing about what it did not see, so walking a
 * list or reporting "the top 5" was guesswork. `total` counts the groups the
 * filter matches, ignoring limit and offset.
 */
export interface Page<T> {
  rows: T[];
  /** Groups matching the filter, before `limit`/`offset`. */
  total: number;
  offset: number;
  /** Absent when the caller set no limit, i.e. every row was returned. */
  limit?: number;
  hasMore: boolean;
  /** The offset that fetches the next page, or undefined when there is none. */
  nextOffset?: number;
  sort: SortKey;
  /**
   * Rows carrying no figure on the sorted basis, which therefore sort as $0.
   *
   * They are not cheap; they are priced on the other basis, or not at all. Only
   * meaningful for the two cost sorts, where it is 0 otherwise.
   */
  rowsWithoutSortValue: number;
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
  unpriced_records: number | null;
  unpriced_models: string | null;
  first_ts: string | null;
  last_ts: string | null;
}

/**
 * The aggregate projection.
 *
 * Takes the priced-model placeholders because "how many records could not be
 * priced" has to be counted in the same pass as everything else -- computing it
 * from a second query would let the two disagree whenever rows change between
 * them. With no list supplied both unpriced columns are NULL, which maps to
 * `undefined`: the question was not asked.
 */
function aggSelect(pricedPlaceholders: string[] | undefined): string {
  const unpriced =
    pricedPlaceholders === undefined
      ? `  NULL AS unpriced_records,
  NULL AS unpriced_models`
      : // An empty list means nothing is priced, so every record is unpriced.
        // `NOT IN ()` is not valid SQL, hence the constant-false placeholder.
        `  SUM(CASE WHEN ${pricedNotIn(pricedPlaceholders)} THEN 1 ELSE 0 END) AS unpriced_records,
  GROUP_CONCAT(DISTINCT CASE WHEN ${pricedNotIn(pricedPlaceholders)} THEN model END) AS unpriced_models`;

  return `
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
${unpriced},
  MIN(timestamp)                    AS first_ts,
  MAX(timestamp)                    AS last_ts
`;
}

function pricedNotIn(placeholders: string[]): string {
  return placeholders.length === 0 ? '1=1' : `model NOT IN (${placeholders.join(',')})`;
}

/**
 * Binds the priced-model list, returning the placeholders `aggSelect` needs.
 * Bound as parameters rather than interpolated: model ids come from the pricing
 * table, but building SQL out of map keys is a habit worth not having.
 */
function bindPricedModels(
  filter: UsageFilter,
  params: Record<string, unknown>,
): string[] | undefined {
  if (!filter.pricedModels) return undefined;
  return filter.pricedModels.map((model, i) => {
    params[`pm${i}`] = model;
    return `:pm${i}`;
  });
}

/**
 * `column IN (...)`, bound as parameters.
 *
 * An empty list yields a clause that matches nothing, deliberately. Falling back
 * to "no filter" is precisely how an empty scope value used to answer a narrowed
 * question with the whole database -- a wrong number that looks like a right one.
 */
function anyOf(
  column: string,
  prefix: string,
  values: readonly string[],
  params: Record<string, unknown>,
): string {
  if (values.length === 0) return '1=0';
  const placeholders = values.map((value, i) => {
    params[`${prefix}${i}`] = value;
    return `:${prefix}${i}`;
  });
  return `${column} IN (${placeholders.join(',')})`;
}

/** The only columns `absentValues` may interpolate. */
const SCOPE_COLUMNS = ['model', 'project_path', 'client'] as const;

function toPage<T>(
  rows: T[],
  meta: { total: number; without: number; offset: number; limit?: number; sort: SortKey },
): Page<T> {
  const seen = meta.offset + rows.length;
  const hasMore = seen < meta.total;
  const page: Page<T> = {
    rows,
    total: meta.total,
    offset: meta.offset,
    hasMore,
    sort: meta.sort,
    rowsWithoutSortValue: meta.without,
  };
  if (meta.limit !== undefined) page.limit = meta.limit;
  if (hasMore) page.nextOffset = seen;
  return page;
}

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
  if (filter.clients) clauses.push(anyOf('client', 'cl', filter.clients, params));
  if (filter.models) clauses.push(anyOf('model', 'md', filter.models, params));
  if (filter.sessionId) {
    clauses.push('session_id = :sessionId');
    params.sessionId = filter.sessionId;
  }
  if (filter.projectPaths) {
    // Normalised on the way in as well as on the way to storage, so a caller who
    // types `d:\repo` still matches rows stored as `D:\repo`.
    clauses.push(
      anyOf('project_path', 'pp', filter.projectPaths.map(normaliseProjectPath), params),
    );
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
  // NULL here means no priced-model list was supplied, which is "not asked" and
  // must stay undefined. A real 0 -- every model priced -- is reported as 0.
  if (r.unpriced_records != null) {
    row.cost.unpricedRecords = r.unpriced_records;
    row.cost.unpricedModels = (r.unpriced_models ?? '').split(',').filter(Boolean).sort();
  }
  if (r.first_ts) row.firstTimestamp = r.first_ts;
  if (r.last_ts) row.lastTimestamp = r.last_ts;
  return row;
}

export class UsageRepository {
  private readonly upsertStmt: SqliteStatement;

  constructor(private readonly db: SqliteDatabase) {
    this.upsertStmt = db.prepare(`
      INSERT INTO usage_records (
        id, client, provider, model, session_id, project_path, timestamp,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens, reasoning_tokens, total_tokens,
        cost, estimated_cost, cost_basis, currency, turn_kind, speed, source, source_version, created_at
      ) VALUES (
        @id, @client, @provider, @model, @sessionId, @projectPath, @timestamp,
        @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
        @cacheWrite5mTokens, @cacheWrite1hTokens, @reasoningTokens, @totalTokens,
        @cost, @estimatedCost, @costBasis, @currency, @turnKind, @speed, @source, @sourceVersion, @createdAt
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
        turn_kind=excluded.turn_kind, speed=excluded.speed, source=excluded.source,
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
          speed: r.speed ?? null,
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
    const priced = bindPricedModels(filter, params);
    const raw = this.db
      .prepare(`SELECT ${aggSelect(priced)} FROM usage_records ${sql}`)
      .get(params) as RawAgg | undefined;
    return toAggregate(raw);
  }

  /**
   * One page of grouped rows, plus what it is a page of.
   *
   * The group count is a second query over the same WHERE clause rather than a
   * window function, because `node:sqlite` and `better-sqlite3` must agree and
   * the driver contract here is deliberately small.
   */
  private groupedPage(column: string, filter: UsageFilter, page: PageRequest): Page<GroupedRow> {
    const { sql, params } = buildWhere(filter);
    const priced = bindPricedModels(filter, params);
    const sort = page.sort ?? 'tokens';
    const offset = Math.max(0, page.offset ?? 0);
    const limit = page.limit !== undefined ? Math.max(1, page.limit) : undefined;

    params.offset = offset;
    if (limit !== undefined) params.limit = limit;
    const window = limit !== undefined ? 'LIMIT :limit OFFSET :offset' : 'LIMIT -1 OFFSET :offset';

    const rows = this.db
      .prepare(
        `SELECT ${column} AS key, ${aggSelect(priced)} FROM usage_records ${sql}
         GROUP BY ${column} ORDER BY ${SORT_SQL[sort]}, key ASC ${window}`,
      )
      .all(params) as (RawAgg & { key: string })[];

    const { total, without } = this.groupStats(column, filter, sort);
    return toPage(
      rows.map((r) => ({ key: r.key, ...toAggregate(r) })),
      { total, without, offset, limit, sort },
    );
  }

  /**
   * Total groups, and how many of them carry nothing on the sorted basis.
   *
   * The second number is what stops "sorted by estimated cost" from quietly
   * presenting every reported-cost row as a $0 at the bottom of the list.
   */
  private groupStats(
    column: string,
    filter: UsageFilter,
    sort: SortKey,
  ): { total: number; without: number } {
    // A FRESH binding, not the caller's: that one also carries the paging and
    // priced-model placeholders, and `node:sqlite` rejects a named parameter the
    // statement does not mention. better-sqlite3 tolerates it, so reusing the
    // object failed on one driver only -- exactly the split the driver contract
    // exists to prevent.
    const { sql: where, params } = buildWhere(filter);
    const havingless = COST_SORT_COLUMN[sort];
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN ${havingless ? `${havingless} = 0` : '0'} THEN 1 ELSE 0 END) AS without
           FROM (SELECT ${column} AS key,
                        SUM(CASE WHEN cost_basis='reported'  THEN 1 ELSE 0 END) AS reported_records,
                        SUM(CASE WHEN cost_basis='estimated' THEN 1 ELSE 0 END) AS estimated_records
                   FROM usage_records ${where} GROUP BY ${column})`,
      )
      .get(params) as { total: number; without: number | null };
    return { total: row.total, without: row.without ?? 0 };
  }

  byClient(filter: UsageFilter = {}, page: PageRequest = {}): Page<GroupedRow> {
    return this.groupedPage('client', filter, page);
  }

  byModel(filter: UsageFilter = {}, page: PageRequest = {}): Page<GroupedRow> {
    return this.groupedPage('model', filter, page);
  }

  byProvider(filter: UsageFilter = {}, page: PageRequest = {}): Page<GroupedRow> {
    return this.groupedPage('provider', filter, page);
  }

  /**
   * Token totals grouped by every dimension that changes what they would cost:
   * `client`, `model` and `speed`.
   *
   * `byModel` is not enough to re-price a period. `client` decides whether
   * reasoning tokens are already inside `output_tokens` (Claude Code) or a
   * sibling of them (OpenCode), and `speed` decides whether the premium fast-mode
   * rates applied. Collapsing either one and then re-pricing would quietly get
   * the arithmetic wrong -- see docs/DATA_SOURCES.md.
   */
  repriceGroups(filter: UsageFilter = {}): RepriceGroup[] {
    const { sql, params } = buildWhere(filter);
    const priced = bindPricedModels(filter, params);
    const rows = this.db
      .prepare(
        `SELECT client AS group_client, model AS group_model, speed AS group_speed, ${aggSelect(priced)}
         FROM usage_records ${sql}
         GROUP BY client, model, speed
         ORDER BY total_tokens DESC`,
      )
      .all(params) as (RawAgg & {
      group_client: ClientId;
      group_model: string;
      group_speed: string | null;
    })[];
    return rows.map((r) => {
      const group: RepriceGroup = {
        client: r.group_client,
        model: r.group_model,
        ...toAggregate(r),
      };
      if (r.group_speed != null) group.speed = r.group_speed;
      return group;
    });
  }

  byProject(filter: UsageFilter = {}, page: PageRequest = {}): Page<GroupedRow> {
    return this.groupedPage("COALESCE(project_path,'(unknown)')", filter, page);
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
    return this.byTime(filter, 'day');
  }

  /**
   * Totals bucketed on the time axis at the requested grain, newest first.
   *
   * Every grain is evaluated in LOCAL time with `localtime`, matching how
   * `resolvePeriod` derives its bounds from local midnight. Bucketing on
   * `substr(timestamp,...)` would be UTC, which puts a turn made late in the
   * evening in the wrong bucket for every user east of Greenwich -- and silently
   * disagrees with the very period filter that selected the rows. `localtime`
   * reads the OS timezone database, so it stays correct across DST changes where
   * a fixed offset would not.
   */
  byTime(filter: UsageFilter = {}, grain: TimeGrain = 'day'): GroupedRow[] {
    const { sql, params } = buildWhere(filter);
    const priced = bindPricedModels(filter, params);
    const rows = this.db
      .prepare(
        `SELECT ${TIME_GRAIN_SQL[grain]} AS key, ${aggSelect(priced)} FROM usage_records ${sql}
         GROUP BY key ORDER BY key DESC`,
      )
      .all(params) as (RawAgg & { key: string })[];
    return rows.map((r) => ({ key: r.key, ...toAggregate(r) }));
  }

  /** The first and last activity matching a filter, for deciding zero-fill bounds. */
  timeBounds(filter: UsageFilter = {}): { first?: string; last?: string } {
    const { sql, params } = buildWhere(filter);
    const row = this.db
      .prepare(`SELECT MIN(timestamp) AS first, MAX(timestamp) AS last FROM usage_records ${sql}`)
      .get(params) as { first: string | null; last: string | null };
    return {
      ...(row.first ? { first: row.first } : {}),
      ...(row.last ? { last: row.last } : {}),
    };
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
                cost, estimated_cost, cost_basis, speed
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
      if (r.speed != null) turn.speed = r.speed as string;
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

  /**
   * A page of sessions.
   *
   * Recency is still the default, but it is now a choice rather than the only
   * option: `--limit` on a recency-ordered list actively HIDES the most
   * expensive session unless it also happens to be recent.
   */
  sessions(filter: UsageFilter = {}, page: PageRequest = {}): Page<SessionRow> {
    const { sql, params } = buildWhere(filter);
    const priced = bindPricedModels(filter, params);
    const sort = page.sort ?? 'recent';
    const offset = Math.max(0, page.offset ?? 0);
    const limit = page.limit !== undefined ? Math.max(1, page.limit) : 20;
    params.limit = limit;
    params.offset = offset;
    const rows = this.db
      .prepare(
        `SELECT session_id, client, MAX(project_path) AS project_path,
                GROUP_CONCAT(DISTINCT model) AS models,
                SUM(CASE WHEN turn_kind='main' THEN 1 ELSE 0 END)     AS main_records,
                SUM(CASE WHEN turn_kind='subagent' THEN 1 ELSE 0 END) AS subagent_records,
                ${aggSelect(priced)}
         FROM usage_records ${sql}
         GROUP BY session_id, client
         ORDER BY ${SORT_SQL[sort]}, session_id ASC
         LIMIT :limit OFFSET :offset`,
      )
      .all(params) as (RawAgg & {
      session_id: string;
      client: ClientId;
      project_path: string | null;
      models: string | null;
      main_records: number;
      subagent_records: number;
    })[];

    const sessionRows = rows.map((r) => {
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

    const { total, without } = this.groupStats('session_id', filter, sort);
    return toPage(sessionRows, { total, without, offset, limit, sort });
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
    return this.groupedPage('model', { sessionId }, {}).rows;
  }

  /**
   * Which of `values` appear in `column` nowhere in the database.
   *
   * Deliberately unfiltered by period: it separates "you typed a name that does
   * not exist" from "that project was quiet last week". Both used to render as
   * the same empty report and the same exit 0.
   *
   * `column` is not caller data -- it comes from a fixed set in the service --
   * but it is asserted against an allow-list anyway, because a column name is
   * the one part of this query that cannot be a bound parameter.
   */
  absentValues(column: 'model' | 'project_path' | 'client', values: string[]): string[] {
    if (values.length === 0) return [];
    if (!SCOPE_COLUMNS.includes(column)) throw new Error(`Not a scope column: ${column}`);
    const wanted = column === 'project_path' ? values.map(normaliseProjectPath) : values;
    const params: Record<string, unknown> = {};
    const rows = this.db
      .prepare(
        `SELECT DISTINCT ${column} AS value FROM usage_records
          WHERE ${anyOf(column, 'sv', wanted, params)}`,
      )
      .all(params) as { value: string }[];
    const present = new Set(rows.map((r) => r.value));
    // Reported in the caller's own spelling, not the normalised one, so the
    // message echoes back what they actually typed.
    return values.filter((_, i) => !present.has(wanted[i] as string));
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
