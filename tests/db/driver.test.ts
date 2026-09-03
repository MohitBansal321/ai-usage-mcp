import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openSqlite, sqliteDriver } from '../../src/db/driver.js';

const requireFrom = createRequire(import.meta.url);

/**
 * The one place a driver may be imported directly: proving the two drivers
 * agree is the whole point of the file. Everything in `src/` must go through
 * `openSqlite`.
 */
function betterSqlite3():
  (new (path: string) => { exec(sql: string): void; close(): void }) | undefined {
  try {
    const mod = requireFrom('better-sqlite3') as { default?: unknown };
    const ctor = typeof mod === 'function' ? mod : mod.default;
    return typeof ctor === 'function' ? (ctor as never) : undefined;
  } catch {
    return undefined;
  }
}

function loadsNodeSqlite(): boolean {
  try {
    const mod = requireFrom('node:sqlite') as { StatementSync?: { prototype?: object } };
    const proto = mod.StatementSync?.prototype;
    return !!proto && typeof (proto as { iterate?: unknown }).iterate === 'function';
  } catch {
    return false;
  }
}

function temp() {
  return mkdtempSync(join(tmpdir(), 'ai-usage-driver-'));
}

describe('SQLite driver', () => {
  it('selects a driver and names it, for status output and bug reports', () => {
    expect(['node:sqlite', 'better-sqlite3']).toContain(sqliteDriver());
  });

  it('provides the surface the repositories and migrations rely on', () => {
    const dir = temp();
    try {
      const db = openSqlite(join(dir, 'x.db'));

      // pragma in both of better-sqlite3's forms: set, then read back
      db.pragma('journal_mode = WAL');
      expect(db.pragma('journal_mode')[0]).toMatchObject({ journal_mode: 'wal' });

      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)');

      // the repository binds a bare object against @named parameters
      const insert = db.prepare('INSERT INTO t (id, n) VALUES (@id, @n)');
      expect(insert.run({ id: 'a', n: 1 }).changes).toBe(1);

      expect(db.prepare('SELECT n FROM t WHERE id = ?').get('a')).toMatchObject({ n: 1 });
      expect(db.prepare('SELECT * FROM t').all()).toHaveLength(1);
      expect([...db.prepare('SELECT id FROM t').iterate()]).toHaveLength(1);

      // `changes` must be a number, never a bigint: the repositories do
      // arithmetic on it and return it as a count.
      expect(typeof db.prepare('DELETE FROM t WHERE id = ?').run('nope').changes).toBe('number');

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('commits a transaction and rolls one back, including a nested one', () => {
    const dir = temp();
    try {
      const db = openSqlite(join(dir, 'tx.db'));
      db.exec('CREATE TABLE t (n INTEGER)');
      const add = (n: number) => db.prepare('INSERT INTO t (n) VALUES (?)').run(n);
      const count = () => (db.prepare('SELECT count(*) c FROM t').get() as { c: number }).c;

      db.transaction(() => add(1))();
      expect(count()).toBe(1);

      expect(() =>
        db.transaction(() => {
          add(2);
          throw new Error('abandon');
        })(),
      ).toThrow('abandon');
      expect(count()).toBe(1);

      // migrate() runs each migration in a transaction; a migration that
      // itself opens one must not blow up on a doubled BEGIN.
      db.transaction(() => {
        add(3);
        db.transaction(() => add(4))();
      })();
      expect(count()).toBe(3);

      // an inner failure unwinds to the savepoint, leaving the outer intact
      db.transaction(() => {
        add(5);
        try {
          db.transaction(() => {
            add(6);
            throw new Error('inner');
          })();
        } catch {
          /* swallowed on purpose: the outer transaction continues */
        }
      })();
      expect(count()).toBe(4);

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a database the other driver wrote, so an existing usage.db needs no migration', () => {
    const BetterSqlite3 = betterSqlite3();
    if (!BetterSqlite3 || sqliteDriver() !== 'node:sqlite') {
      // Only one driver is installed here; there is nothing to compare against.
      return;
    }

    const dir = temp();
    try {
      const path = join(dir, 'cross.db');

      // written by the fallback driver, exactly like an existing user's file
      const legacy = new BetterSqlite3(path);
      legacy.exec('PRAGMA journal_mode = WAL');
      legacy.exec('CREATE TABLE usage_records (id TEXT PRIMARY KEY, total_tokens INTEGER)');
      legacy.exec("INSERT INTO usage_records VALUES ('r1', 11649), ('r2', 42)");
      legacy.close();

      // read back through the driver the package now prefers
      const db = openSqlite(path);
      expect(db.pragma('journal_mode')[0]).toMatchObject({ journal_mode: 'wal' });
      expect(db.prepare('SELECT count(*) c FROM usage_records').get()).toMatchObject({ c: 2 });
      expect(
        db.prepare('SELECT total_tokens FROM usage_records WHERE id = ?').get('r1'),
      ).toMatchObject({ total_tokens: 11649 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens read-only without disturbing the writer, and rejects writes', () => {
    const dir = temp();
    try {
      const path = join(dir, 'ro.db');
      const writable = openSqlite(path);
      writable.exec('CREATE TABLE t (n INTEGER)');
      writable.exec('INSERT INTO t (n) VALUES (7)');
      writable.close();

      const ro = openSqlite(path, { readonly: true });
      expect(ro.prepare('SELECT n FROM t').get()).toMatchObject({ n: 7 });
      expect(() => ro.exec('INSERT INTO t (n) VALUES (8)')).toThrow();
      ro.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SQLite driver fallback', () => {
  afterEach(() => {
    delete process.env.AI_USAGE_SQLITE_DRIVER;
  });

  it('runs the same surface through better-sqlite3 when pinned to it', () => {
    if (!betterSqlite3()) return; // optional dependency genuinely absent

    process.env.AI_USAGE_SQLITE_DRIVER = 'better-sqlite3';
    expect(sqliteDriver()).toBe('better-sqlite3');

    const dir = temp();
    try {
      const db = openSqlite(join(dir, 'fb.db'));
      db.pragma('journal_mode = WAL');
      expect(db.pragma('journal_mode')[0]).toMatchObject({ journal_mode: 'wal' });

      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)');
      expect(
        db.prepare('INSERT INTO t (id, n) VALUES (@id, @n)').run({ id: 'a', n: 1 }).changes,
      ).toBe(1);
      expect(db.prepare('SELECT n FROM t WHERE id = ?').get('a')).toMatchObject({ n: 1 });
      expect([...db.prepare('SELECT id FROM t').iterate()]).toHaveLength(1);
      expect(typeof db.prepare('DELETE FROM t WHERE id = ?').run('nope').changes).toBe('number');

      db.transaction(() => db.prepare('INSERT INTO t VALUES (?, ?)').run('b', 2))();
      expect(() =>
        db.transaction(() => {
          db.prepare('INSERT INTO t VALUES (?, ?)').run('c', 3);
          throw new Error('abandon');
        })(),
      ).toThrow('abandon');
      expect(db.prepare('SELECT count(*) c FROM t').get()).toMatchObject({ c: 2 });

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('agrees with node:sqlite on the numbers, reading one file both ways', () => {
    if (!betterSqlite3()) return;

    const dir = temp();
    try {
      const path = join(dir, 'agree.db');

      // seed through whichever driver is the default
      delete process.env.AI_USAGE_SQLITE_DRIVER;
      const seed = openSqlite(path);
      seed.exec('CREATE TABLE usage_records (id TEXT PRIMARY KEY, total_tokens INTEGER)');
      const insert = seed.prepare('INSERT INTO usage_records VALUES (@id, @total)');
      for (const [id, total] of [
        ['a', 11649],
        ['b', 42],
        ['c', 900000],
      ] as const) {
        insert.run({ id, total });
      }
      const viaDefault = seed.prepare('SELECT sum(total_tokens) s FROM usage_records').get();
      seed.close();

      // and read it back through the fallback
      process.env.AI_USAGE_SQLITE_DRIVER = 'better-sqlite3';
      const fallback = openSqlite(path, { readonly: true });
      const viaFallback = fallback.prepare('SELECT sum(total_tokens) s FROM usage_records').get();
      fallback.close();

      // Same file, same totals: this is what makes the fallback safe to keep
      // and an existing usage.db safe to leave alone. Compared with toEqual,
      // not toStrictEqual, because the two drivers disagree about the row's
      // prototype -- see the next test.
      expect(viaFallback).toEqual(viaDefault);
      expect(viaFallback).toMatchObject({ s: 911691 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('documents that node:sqlite rows have a null prototype', () => {
    if (!betterSqlite3() || !loadsNodeSqlite()) return;

    const dir = temp();
    try {
      const path = join(dir, 'proto.db');
      delete process.env.AI_USAGE_SQLITE_DRIVER;
      const seed = openSqlite(path);
      seed.exec('CREATE TABLE t (n INTEGER)');
      seed.exec('INSERT INTO t VALUES (5)');
      seed.close();

      process.env.AI_USAGE_SQLITE_DRIVER = 'node:sqlite';
      const viaNode = openSqlite(path, { readonly: true });
      const nodeRow = viaNode.prepare('SELECT n FROM t').get();
      viaNode.close();

      process.env.AI_USAGE_SQLITE_DRIVER = 'better-sqlite3';
      const viaBetter = openSqlite(path, { readonly: true });
      const betterRow = viaBetter.prepare('SELECT n FROM t').get();
      viaBetter.close();

      // The trap: same data, different prototype. Anything reading a row must
      // stick to property access, which is why this is pinned rather than
      // smoothed over in the driver.
      expect(Object.getPrototypeOf(nodeRow)).toBeNull();
      expect(Object.getPrototypeOf(betterRow)).toBe(Object.prototype);
      expect({ ...(nodeRow as object) }).toEqual({ ...(betterRow as object) });
      expect(JSON.stringify(nodeRow)).toBe(JSON.stringify(betterRow));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
