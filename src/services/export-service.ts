import {
  TURNS_MAX_LIMIT,
  type TurnRow,
  type UsageFilter,
  type UsageRepository,
} from '../db/repositories/usage-repository.js';

/**
 * Getting the data back out, one row per stored turn.
 *
 * "Local-first, your data is yours" was the promise, and every output was a
 * nested aggregate: no command emitted a record-level row, and no format any
 * spreadsheet or CSV loader consumes. The only route to the rows was
 * `sqlite3 usage.db '.mode csv' 'SELECT * FROM usage_records'`, which bypasses
 * the product entirely and depends on a schema the docs explicitly call internal
 * and unversioned. This is that route, supported.
 *
 * The column set is a STABLE, documented contract -- deliberately not
 * `SELECT *`. The table may grow a column without every downstream spreadsheet
 * breaking, and a column here may not silently change meaning.
 */

export type ExportFormat = 'csv' | 'jsonl';

export const EXPORT_FORMATS: ExportFormat[] = ['csv', 'jsonl'];

/**
 * The exported columns, in order.
 *
 * `cost` and `estimated_cost` are separate columns carrying `cost_basis`
 * alongside, for the same reason every report keeps them apart: a single `cost`
 * column would force a choice between blending two incomparable figures and
 * dropping one.
 */
export const EXPORT_COLUMNS = [
  'id',
  'timestamp',
  'client',
  'provider',
  'model',
  'session_id',
  'project_path',
  'turn_kind',
  'speed',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cache_write_5m_tokens',
  'cache_write_1h_tokens',
  'reasoning_tokens',
  'total_tokens',
  'cost_basis',
  'cost',
  'estimated_cost',
  'currency',
] as const;

export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

function valueFor(turn: TurnRow, column: ExportColumn): string | number | undefined {
  switch (column) {
    case 'id':
      return turn.id;
    case 'timestamp':
      return turn.timestamp;
    case 'client':
      return turn.client;
    case 'provider':
      return turn.provider;
    case 'model':
      return turn.model;
    case 'session_id':
      return turn.sessionId;
    case 'project_path':
      return turn.projectPath;
    case 'turn_kind':
      return turn.turnKind;
    case 'speed':
      return turn.speed;
    case 'input_tokens':
      return turn.inputTokens;
    case 'output_tokens':
      return turn.outputTokens;
    case 'cache_read_tokens':
      return turn.cacheReadTokens;
    case 'cache_write_tokens':
      return turn.cacheWriteTokens;
    case 'cache_write_5m_tokens':
      return turn.cacheWrite5mTokens;
    case 'cache_write_1h_tokens':
      return turn.cacheWrite1hTokens;
    case 'reasoning_tokens':
      return turn.reasoningTokens;
    case 'total_tokens':
      return turn.totalTokens;
    case 'cost_basis':
      return turn.costBasis;
    case 'cost':
      return turn.cost;
    case 'estimated_cost':
      return turn.estimatedCost;
    case 'currency':
      return 'USD';
  }
}

/**
 * RFC 4180 quoting.
 *
 * A project path is the field most likely to contain a comma or a quote, and an
 * unquoted one silently shifts every later column in the row -- a corruption
 * that looks like data.
 */
export function csvCell(value: string | number | undefined): string {
  // An absent value stays EMPTY, never "0" and never "null": a source that did
  // not report a figure must not arrive in a spreadsheet as a number.
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(turn: TurnRow): string {
  return EXPORT_COLUMNS.map((column) => csvCell(valueFor(turn, column))).join(',');
}

export function csvHeader(): string {
  return EXPORT_COLUMNS.join(',');
}

export function jsonlRow(turn: TurnRow): string {
  const out: Record<string, unknown> = {};
  for (const column of EXPORT_COLUMNS) {
    const value = valueFor(turn, column);
    // Absent stays absent rather than becoming null, matching how every other
    // surface reports a value the source did not give.
    if (value !== undefined) out[column] = value;
  }
  return JSON.stringify(out);
}

export interface ExportOptions {
  format?: ExportFormat;
  /** Stop after this many rows. Omit to export everything the filter matches. */
  limit?: number;
}

export interface ExportResult {
  rows: number;
  format: ExportFormat;
  /** Total rows the filter matches, so a truncated export is visibly truncated. */
  total: number;
}

/**
 * Streams rows to a writer rather than building one string.
 *
 * A record-level export of a busy database is hundreds of thousands of rows;
 * materialising that as a single string would hold the whole export in memory to
 * hand it to a pipe one line at a time anyway.
 */
export class ExportService {
  constructor(private readonly repo: UsageRepository) {}

  export(
    filter: UsageFilter,
    write: (line: string) => void,
    options: ExportOptions = {},
  ): ExportResult {
    const format = options.format ?? 'csv';
    const total = this.repo.countTurns(filter);
    const wanted = options.limit ?? total;

    if (format === 'csv') write(csvHeader());

    let written = 0;
    // Paged rather than read whole: `turns` is capped at TURNS_MAX_LIMIT
    // precisely so no single read can be unbounded, and an export is the one
    // caller that legitimately wants every row.
    while (written < wanted) {
      const batch = this.repo.turns(filter, {
        limit: Math.min(TURNS_MAX_LIMIT, wanted - written),
        offset: written,
      });
      if (batch.length === 0) break;
      for (const turn of batch) write(format === 'csv' ? csvRow(turn) : jsonlRow(turn));
      written += batch.length;
    }

    return { rows: written, format, total };
  }
}
