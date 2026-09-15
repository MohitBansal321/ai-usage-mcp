import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, openDatabase, schemaVersion } from '../../src/db/database.js';
import { migrations } from '../../src/db/migrations/index.js';
import { openSqlite, type SqliteDatabase } from '../../src/db/driver.js';
import { UsageRepository } from '../../src/db/repositories/usage-repository.js';
import type { UsageRecord } from '../../src/models/usage-record.js';
import { tempDir } from '../fixtures/build-fixtures.js';

/**
 * Migrations are append-only, so the case that matters is the one no fresh
 * install exercises: a database created by an *earlier* version being opened by
 * a later one. Every existing user's `usage.db` is on schema 1, and their rows
 * must survive the upgrade untouched.
 */
function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'r1',
    client: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-5',
    sessionId: 's1',
    timestamp: '2026-08-01T10:00:00.000Z',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    reasoningTokens: 5,
    totalTokens: 100,
    estimatedCost: 0.25,
    costBasis: 'estimated',
    currency: 'USD',
    turnKind: 'main',
    source: 'test',
    ...overrides,
  };
}

function columns(db: SqliteDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe('migrations', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = tempDir('migrations-');
    dbPath = join(dir, 'usage.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('declares versions that are unique, ordered and gapless', () => {
    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual([...new Set(versions)]);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(versions).toEqual(versions.map((_, i) => i + 1));
  });

  it('brings a fresh database to the latest version', () => {
    const db = openDatabase({ path: dbPath });
    migrate(db);
    expect(schemaVersion(db)).toBe(migrations.length);
    expect(columns(db, 'usage_records')).toContain('speed');
    db.close();
  });

  it('upgrades a schema-1 database in place, keeping its rows', () => {
    // Build a database exactly as a pre-0.6.0 install left it: migration 1 only.
    // Opened through the raw driver, because `openDatabase` migrates to head.
    const old = openSqlite(dbPath);
    old.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    migrations[0]!.up(old);
    old
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(1, migrations[0]!.name, new Date().toISOString());
    expect(columns(old, 'usage_records')).not.toContain('speed');

    // A row written by that old version. Inserted with the v1 column list rather
    // than through UsageRepository, because today's repository prepares an INSERT
    // naming `speed` and so cannot target a schema-1 table at all -- which is
    // exactly right, since `openDatabase` migrates to head before any repository
    // is constructed.
    const legacyRow = record({ id: 'legacy-1' });
    old
      .prepare(
        `INSERT INTO usage_records (
           id, client, provider, model, session_id, timestamp,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           reasoning_tokens, total_tokens, estimated_cost, cost_basis, currency,
           turn_kind, source, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        legacyRow.id,
        legacyRow.client,
        legacyRow.provider,
        legacyRow.model,
        legacyRow.sessionId,
        legacyRow.timestamp,
        legacyRow.inputTokens,
        legacyRow.outputTokens,
        legacyRow.cacheReadTokens ?? null,
        legacyRow.cacheWriteTokens ?? null,
        legacyRow.reasoningTokens ?? null,
        legacyRow.totalTokens,
        legacyRow.estimatedCost ?? null,
        legacyRow.costBasis,
        legacyRow.currency,
        legacyRow.turnKind,
        legacyRow.source,
        new Date().toISOString(),
      );
    old.close();

    // Reopening runs only the outstanding migration.
    const db = openDatabase({ path: dbPath });
    migrate(db);

    expect(schemaVersion(db)).toBe(migrations.length);
    expect(columns(db, 'usage_records')).toContain('speed');

    const repo = new UsageRepository(db);
    const totals = repo.totals();
    expect(totals.records).toBe(1);
    expect(totals.totalTokens).toBe(100);
    expect(totals.inputTokens).toBe(10);

    // The pre-existing row has no speed, and nothing invented one for it:
    // the source never said, and 'standard' would be an assertion we cannot make.
    const [legacy] = repo.turns();
    expect(legacy?.id).toBe('legacy-1');
    expect(legacy?.speed).toBeUndefined();

    db.close();
  });

  it('is idempotent -- migrating twice applies nothing the second time', () => {
    const db = openDatabase({ path: dbPath });
    migrate(db);
    const first = schemaVersion(db);
    expect(() => migrate(db)).not.toThrow();
    expect(schemaVersion(db)).toBe(first);
    // ALTER TABLE ADD COLUMN would throw on a second application, so a single
    // `speed` column is the proof the guard held.
    expect(columns(db, 'usage_records').filter((c) => c === 'speed')).toHaveLength(1);
    db.close();
  });
});

/**
 * Migration 3 repairs databases that already split one Windows project in two.
 * It runs on every platform, so it must be provably inert on POSIX data.
 */
describe('migration 3: normalise-windows-drive-letter', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = tempDir('migrate-drive-');
    dbPath = join(dir, 'usage.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const paths = (db: SqliteDatabase): string[] =>
    (
      db.prepare('SELECT DISTINCT project_path AS p FROM usage_records ORDER BY p').all() as {
        p: string;
      }[]
    ).map((r) => r.p);

  it('merges drive-letter variants and leaves POSIX paths untouched', () => {
    const db = openDatabase({ path: dbPath });
    migrate(db);
    const repo = new UsageRepository(db);
    repo.upsertMany([
      record({ id: 'w1', projectPath: 'd:\\repo' }),
      record({ id: 'w2', projectPath: 'D:\\repo' }),
      record({ id: 'w3', projectPath: 'c:/other' }),
      // POSIX paths differing only by case are DIFFERENT directories and must
      // both survive: merging them would invent a number rather than repair one.
      record({ id: 'p1', projectPath: '/home/x' }),
      record({ id: 'p2', projectPath: '/home/X' }),
    ]);

    // The REAL migration, not a copy of its SQL. Copying it here once already
    // hid a bug: the pattern needs `[\\/]` in source to reach SQLite as `[\/]`,
    // and a single backslash silently degrades to "forward slashes only".
    const normalise = migrations.find((m) => m.name === 'normalise-windows-drive-letter');
    expect(normalise, 'migration 3 should exist').toBeDefined();
    normalise!.up(db);

    const after = paths(db);
    expect(after).toContain('D:\\repo');
    expect(after).not.toContain('d:\\repo');
    expect(after).toContain('C:/other');
    // Both POSIX spellings still present and still distinct.
    expect(after).toContain('/home/x');
    expect(after).toContain('/home/X');
    db.close();
  });
});
