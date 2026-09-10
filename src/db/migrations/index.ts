import type { SqliteDatabase } from '../driver.js';

export interface Migration {
  version: number;
  name: string;
  up(db: SqliteDatabase): void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    up(db) {
      db.exec(`
        CREATE TABLE usage_records (
          id                    TEXT PRIMARY KEY,
          client                TEXT NOT NULL,
          provider              TEXT NOT NULL,
          model                 TEXT NOT NULL,
          session_id            TEXT NOT NULL,
          project_path          TEXT,
          timestamp             TEXT NOT NULL,

          input_tokens          INTEGER NOT NULL,
          output_tokens         INTEGER NOT NULL,
          cache_read_tokens     INTEGER,
          cache_write_tokens    INTEGER,
          cache_write_5m_tokens INTEGER,
          cache_write_1h_tokens INTEGER,
          reasoning_tokens      INTEGER,
          total_tokens          INTEGER NOT NULL,

          cost                  REAL,
          estimated_cost        REAL,
          cost_basis            TEXT NOT NULL CHECK (cost_basis IN ('reported','estimated','unavailable')),
          currency              TEXT NOT NULL DEFAULT 'USD',

          turn_kind             TEXT NOT NULL DEFAULT 'main' CHECK (turn_kind IN ('main','subagent')),

          source                TEXT NOT NULL,
          source_version        TEXT,
          created_at            TEXT NOT NULL
        );

        CREATE INDEX idx_usage_timestamp  ON usage_records (timestamp);
        CREATE INDEX idx_usage_client_ts  ON usage_records (client, timestamp);
        CREATE INDEX idx_usage_model      ON usage_records (model);
        CREATE INDEX idx_usage_session    ON usage_records (session_id);
        CREATE INDEX idx_usage_turn_kind  ON usage_records (turn_kind);

        CREATE TABLE sync_state (
          source       TEXT PRIMARY KEY,
          last_sync_at TEXT,
          cursor       TEXT,
          notes        TEXT
        );
      `);
    },
  },
  {
    version: 2,
    name: 'add-speed',
    up(db) {
      // Claude Code records `usage.speed` per request, and 'fast' bills at premium
      // rates. It was read at collection time, used for the estimate, and then
      // dropped -- so the tokens were kept but the rate that applied to them was
      // not. Anything that re-prices a stored row would silently apply standard
      // rates to a fast-mode turn and under-report.
      //
      // Nullable with no backfill on purpose: rows collected before this migration
      // genuinely have no recorded speed, and inventing 'standard' for them would
      // assert something the source never said. They stay NULL until re-synced,
      // which `ai-usage sync --full` will do.
      db.exec(`ALTER TABLE usage_records ADD COLUMN speed TEXT`);
    },
  },
];
