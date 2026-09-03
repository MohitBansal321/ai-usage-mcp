import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { migrations } from './migrations/index.js';
import { openSqlite, type SqliteDatabase } from './driver.js';

/**
 * Resolves where *our* database lives.
 *
 * Deliberately homedir-based and NOT XDG_DATA_HOME-based. A sandboxed launcher
 * (the VSCode snap, for instance) sets XDG_DATA_HOME to a private path, which is
 * precisely how OpenCode's own history ended up split across two databases on
 * this machine. The MCP server and the CLI must always agree on one file, so the
 * only ways to move it are explicit: AI_USAGE_DB or AI_USAGE_HOME.
 */
export function resolveDatabasePath(): string {
  if (process.env.AI_USAGE_DB) return process.env.AI_USAGE_DB;
  if (process.env.AI_USAGE_HOME) return join(process.env.AI_USAGE_HOME, 'usage.db');
  return join(homedir(), '.local', 'share', 'ai-usage-mcp', 'usage.db');
}

export interface OpenDatabaseOptions {
  path?: string;
  readonly?: boolean;
}

export function openDatabase(options: OpenDatabaseOptions = {}): SqliteDatabase {
  const path = options.path ?? resolveDatabasePath();
  if (path !== ':memory:' && !options.readonly) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = openSqlite(path, options.readonly ? { readonly: true } : {});
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!options.readonly) migrate(db);
  return db;
}

export function migrate(db: SqliteDatabase): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => (r as { version: number }).version),
  );
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      migration.up(db);
      insert.run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}

export function schemaVersion(db: SqliteDatabase): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    { v: number | null } | undefined;
  return row?.v ?? 0;
}
