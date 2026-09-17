import { statSync } from 'node:fs';
import type { SqliteDatabase } from '../db/driver.js';
import type { UsageFilter, UsageRepository } from '../db/repositories/usage-repository.js';
import type { UsageRecord } from '../models/usage-record.js';

/**
 * Keeping the database from growing forever, and merging two machines into one.
 *
 * Three deliberate shapes here:
 *
 *  1. **Pruning is a command, not a policy.** A retention setting that silently
 *     deleted last quarter on some future run is a worse tool than one that
 *     never deletes: the data is gone and nothing asked. `prune` is explicit,
 *     dry-run by default, and can be put in a cron by someone who wants a policy.
 *  2. **Dry run is the default.** The only irreversible operation in this
 *     package reports what it would remove and changes nothing until told twice.
 *  3. **Import merges rather than replaces.** Record ids are derived
 *     deterministically from source identifiers, so the same turn imported twice
 *     -- or collected on both machines -- upserts to one row. That is what makes
 *     "laptop plus desktop" answerable at all.
 */

export interface PruneResult {
  cutoff: string;
  /** Records matched. With `apply: false` this is what WOULD be removed. */
  matched: number;
  removed: number;
  applied: boolean;
  remaining: number;
}

export interface VacuumResult {
  /**
   * Total on-disk footprint before and after: the database file PLUS its `-wal`
   * and `-shm` companions.
   *
   * Measuring only the `.db` is actively misleading under WAL, which is the mode
   * this package always opens in. Freshly written data lives in the `-wal` until
   * a checkpoint folds it back, so a 1.8MB database can show a 4KB `.db` -- and a
   * vacuum would report reclaiming nothing while most of the bytes sat next door.
   *
   * Absent when the database is in memory, which has no files to measure.
   */
  bytesBefore?: number;
  bytesAfter?: number;
  reclaimedBytes?: number;
}

export interface ImportResult {
  /** Lines read from the file, excluding blanks. */
  read: number;
  /** Rows that parsed and validated. */
  accepted: number;
  /** Rows written. Equal to `accepted`; re-importing the same rows changes no total. */
  written: number;
  /** Rows rejected, with the line number and why. Never silently dropped. */
  rejected: { line: number; reason: string }[];
  /** Records in the database before and after, so a merge's effect is visible. */
  recordsBefore: number;
  recordsAfter: number;
}

const REQUIRED_NUMBER_FIELDS = ['input_tokens', 'output_tokens', 'total_tokens'] as const;
const REQUIRED_STRING_FIELDS = [
  'id',
  'client',
  'provider',
  'model',
  'session_id',
  'timestamp',
  'cost_basis',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

/**
 * Turns one exported row back into a record, or says why it cannot.
 *
 * Strict on purpose: a row that half-parses would import a turn with invented
 * zeroes, and a merged database that quietly under-counts is worse than a failed
 * import. Rejections carry a line number so the offending row can be found.
 */
export function parseExportedRecord(row: unknown): { record: UsageRecord } | { reason: string } {
  if (!isRecord(row)) return { reason: 'not a JSON object' };

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = row[field];
    if (typeof value !== 'string' || value === '') return { reason: `missing or empty "${field}"` };
  }
  for (const field of REQUIRED_NUMBER_FIELDS) {
    if (typeof row[field] !== 'number' || !Number.isFinite(row[field]))
      return { reason: `"${field}" must be a finite number` };
  }
  const basis = row.cost_basis as string;
  if (basis !== 'reported' && basis !== 'estimated' && basis !== 'unavailable')
    return { reason: `cost_basis must be reported, estimated or unavailable (got "${basis}")` };
  const client = row.client as string;
  if (client !== 'claude-code' && client !== 'opencode')
    return { reason: `unknown client "${client}"` };
  const turnKind = (row.turn_kind as string | undefined) ?? 'main';
  if (turnKind !== 'main' && turnKind !== 'subagent')
    return { reason: `turn_kind must be main or subagent (got "${turnKind}")` };
  if (Number.isNaN(Date.parse(row.timestamp as string)))
    return { reason: `timestamp is not a valid date: "${row.timestamp as string}"` };

  const optional: Record<string, number | undefined> = {};
  for (const key of [
    'cache_read_tokens',
    'cache_write_tokens',
    'cache_write_5m_tokens',
    'cache_write_1h_tokens',
    'reasoning_tokens',
    'cost',
    'estimated_cost',
  ]) {
    const value = optionalNumber(row, key);
    if (value !== undefined && Number.isNaN(value)) return { reason: `"${key}" is not a number` };
    optional[key] = value;
  }

  const record: UsageRecord = {
    id: row.id as string,
    client,
    provider: row.provider as string,
    model: row.model as string,
    sessionId: row.session_id as string,
    timestamp: new Date(row.timestamp as string).toISOString(),
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    totalTokens: row.total_tokens as number,
    costBasis: basis,
    currency: 'USD',
    turnKind,
    source: typeof row.source === 'string' ? row.source : 'imported',
  };
  // Absent stays absent: an unreported figure must not arrive as 0 just because
  // it travelled through a file.
  if (typeof row.project_path === 'string') record.projectPath = row.project_path;
  if (typeof row.speed === 'string') record.speed = row.speed;
  if (optional.cache_read_tokens !== undefined) record.cacheReadTokens = optional.cache_read_tokens;
  if (optional.cache_write_tokens !== undefined)
    record.cacheWriteTokens = optional.cache_write_tokens;
  if (optional.cache_write_5m_tokens !== undefined)
    record.cacheWrite5mTokens = optional.cache_write_5m_tokens;
  if (optional.cache_write_1h_tokens !== undefined)
    record.cacheWrite1hTokens = optional.cache_write_1h_tokens;
  if (optional.reasoning_tokens !== undefined) record.reasoningTokens = optional.reasoning_tokens;
  if (optional.cost !== undefined) record.cost = optional.cost;
  if (optional.estimated_cost !== undefined) record.estimatedCost = optional.estimated_cost;

  return { record };
}

export class LifecycleService {
  constructor(
    private readonly repo: UsageRepository,
    private readonly db: SqliteDatabase,
    private readonly dbPath: string,
  ) {}

  /**
   * @param apply Must be explicitly true to delete anything. The default reports
   *   what would go and touches nothing.
   */
  prune(cutoff: string, options: { apply?: boolean; filter?: UsageFilter } = {}): PruneResult {
    const filter = options.filter ?? {};
    const matched = this.repo.countBefore(cutoff, filter);
    const applied = options.apply === true;
    const removed = applied ? this.repo.deleteBefore(cutoff, filter) : 0;
    return { cutoff, matched, removed, applied, remaining: this.repo.recordCount() };
  }

  /**
   * Compacts the file. Deleting rows frees pages inside the database but does
   * not shrink it, so a prune that reclaims no disk is a prune that looks like
   * it did nothing.
   */
  vacuum(): VacuumResult {
    const before = this.fileSize();
    // VACUUM cannot run inside a transaction, hence a bare exec.
    this.db.exec('VACUUM');
    // Fold the write-ahead log back into the database and truncate it. Without
    // this the freed pages are reported as reclaimed while the -wal still holds
    // the bytes, and the number a user sees does not match `du`.
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    const after = this.fileSize();
    return {
      ...(before !== undefined ? { bytesBefore: before } : {}),
      ...(after !== undefined ? { bytesAfter: after } : {}),
      ...(before !== undefined && after !== undefined ? { reclaimedBytes: before - after } : {}),
    };
  }

  /** Merges JSON Lines produced by `ai-usage export --format jsonl`. */
  import(lines: Iterable<string>): ImportResult {
    const recordsBefore = this.repo.recordCount();
    const rejected: { line: number; reason: string }[] = [];
    const records: UsageRecord[] = [];

    let lineNumber = 0;
    let read = 0;
    for (const raw of lines) {
      lineNumber += 1;
      if (raw.trim() === '') continue;
      read += 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        rejected.push({ line: lineNumber, reason: 'not valid JSON' });
        continue;
      }
      const result = parseExportedRecord(parsed);
      if ('reason' in result) {
        rejected.push({ line: lineNumber, reason: result.reason });
        continue;
      }
      records.push(result.record);
    }

    // Deterministic ids mean the same turn from two machines, or the same file
    // imported twice, upserts to one row rather than double counting.
    const written = this.repo.upsertMany(records);
    return {
      read,
      accepted: records.length,
      written,
      rejected,
      recordsBefore,
      recordsAfter: this.repo.recordCount(),
    };
  }

  /** The database's real footprint: the file plus its WAL companions. */
  private fileSize(): number | undefined {
    if (this.dbPath === ':memory:') return undefined;
    let total = 0;
    let found = false;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        total += statSync(`${this.dbPath}${suffix}`).size;
        found = true;
      } catch {
        // A missing -wal or -shm is normal, not an error.
      }
    }
    return found ? total : undefined;
  }
}
