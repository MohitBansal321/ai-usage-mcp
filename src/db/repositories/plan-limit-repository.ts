import type { SqliteDatabase } from '../driver.js';
import type { ClientId } from '../../models/usage-record.js';
import type { PlanLimitReading, PlanLimitWindow } from '../../collectors/claude-code/statusline.js';

export interface StoredPlanLimitReading extends PlanLimitReading {
  /** ISO 8601, UTC: when this value first reached ai-usage. */
  observedAt: string;
  /** ISO 8601, UTC: the last time the same value was handed over again. */
  lastSeenAt: string;
  sourceVersion?: string;
}

interface Row {
  limit_window: PlanLimitWindow;
  observed_at: string;
  last_seen_at: string;
  used_percent: number;
  resets_at: string;
  source_version: string | null;
}

function fromRow(row: Row): StoredPlanLimitReading {
  const reading: StoredPlanLimitReading = {
    window: row.limit_window,
    observedAt: row.observed_at,
    lastSeenAt: row.last_seen_at,
    usedPercent: row.used_percent,
    resetsAt: row.resets_at,
  };
  if (row.source_version) reading.sourceVersion = row.source_version;
  return reading;
}

const COLUMNS = 'limit_window, observed_at, last_seen_at, used_percent, resets_at, source_version';

export class PlanLimitRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Stores a reading, or -- when it repeats the latest one for its window --
   * only moves that row's `last_seen_at`. A status line runs on every assistant
   * message, and almost all of those runs see the same percentage as the last.
   *
   * @returns true when a new row was written.
   */
  record(
    client: ClientId,
    reading: PlanLimitReading,
    observedAt: string,
    sourceVersion?: string,
  ): boolean {
    const latest = this.latest(client, reading.window);
    if (
      latest &&
      latest.usedPercent === reading.usedPercent &&
      latest.resetsAt === reading.resetsAt
    ) {
      if (observedAt > latest.lastSeenAt) {
        this.db
          .prepare(
            `UPDATE plan_limit_readings SET last_seen_at = ?
              WHERE client = ? AND limit_window = ? AND observed_at = ?`,
          )
          .run(observedAt, client, reading.window, latest.observedAt);
      }
      return false;
    }
    // OR IGNORE: two status lines landing in the same millisecond carry the same
    // reading, and the second adds nothing.
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO plan_limit_readings (client, ${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        client,
        reading.window,
        observedAt,
        observedAt,
        reading.usedPercent,
        reading.resetsAt,
        sourceVersion ?? null,
      );
    return Number(result.changes) > 0;
  }

  latest(client: ClientId, window: PlanLimitWindow): StoredPlanLimitReading | undefined {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM plan_limit_readings
          WHERE client = ? AND limit_window = ?
          ORDER BY observed_at DESC LIMIT 1`,
      )
      .get(client, window) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Every reading of a window first observed at or after `since`, oldest first. */
  since(client: ClientId, window: PlanLimitWindow, since: string): StoredPlanLimitReading[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM plan_limit_readings
          WHERE client = ? AND limit_window = ? AND observed_at >= ?
          ORDER BY observed_at ASC`,
      )
      .all(client, window, since) as Row[];
    return rows.map(fromRow);
  }
}
