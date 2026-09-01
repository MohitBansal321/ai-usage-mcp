import type { Database } from 'better-sqlite3';

export interface SyncState {
  source: string;
  lastSyncAt?: string;
  cursor?: unknown;
  notes?: string;
}

export class SyncRepository {
  constructor(private readonly db: Database) {}

  get(source: string): SyncState | undefined {
    const row = this.db
      .prepare('SELECT source, last_sync_at, cursor, notes FROM sync_state WHERE source = ?')
      .get(source) as
      | { source: string; last_sync_at: string | null; cursor: string | null; notes: string | null }
      | undefined;
    if (!row) return undefined;
    const state: SyncState = { source: row.source };
    if (row.last_sync_at) state.lastSyncAt = row.last_sync_at;
    if (row.notes) state.notes = row.notes;
    if (row.cursor) {
      try {
        state.cursor = JSON.parse(row.cursor);
      } catch {
        // A cursor we can no longer parse must not wedge sync -- fall back to a
        // full re-read, which is safe because upserts are idempotent.
        state.cursor = undefined;
      }
    }
    return state;
  }

  set(state: SyncState): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (source, last_sync_at, cursor, notes)
         VALUES (@source, @lastSyncAt, @cursor, @notes)
         ON CONFLICT(source) DO UPDATE SET
           last_sync_at=excluded.last_sync_at,
           cursor=excluded.cursor,
           notes=excluded.notes`,
      )
      .run({
        source: state.source,
        lastSyncAt: state.lastSyncAt ?? null,
        cursor: state.cursor === undefined ? null : JSON.stringify(state.cursor),
        notes: state.notes ?? null,
      });
  }

  all(): SyncState[] {
    const rows = this.db.prepare('SELECT source FROM sync_state ORDER BY source').all() as {
      source: string;
    }[];
    return rows.map((r) => this.get(r.source)).filter((s): s is SyncState => Boolean(s));
  }

  clear(source: string): void {
    this.db.prepare('DELETE FROM sync_state WHERE source = ?').run(source);
  }
}
