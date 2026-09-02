import { createRequire } from 'node:module';

/**
 * The one place in this project that chooses a SQLite driver.
 *
 * `better-sqlite3` is a native addon, so on a host without a working toolchain
 * `npm install` fails inside node-gyp -- and because that happens during `npx`,
 * the user never reaches the README section explaining the fix. `node:sqlite`
 * is built into Node and needs no compiler, so it is preferred whenever the
 * running Node exposes a usable copy.
 *
 * Availability, from Node's own `doc/api/sqlite.md` history:
 *   - added in v22.5.0, behind `--experimental-sqlite`
 *   - unflagged in v22.13.0 / v23.4.0, which is also exactly where
 *     `StatementSync.prototype.iterate()` arrived
 *   - release candidate since v24.15.0 / v25.7.0
 *
 * `iterate()` is therefore the honest capability probe: a Node old enough to
 * lack it is a Node whose `node:sqlite` we do not want. `better-sqlite3` stays
 * as an optional fallback for those, which is why it may be absent at runtime
 * and every load here is guarded.
 *
 * One behavioural difference the drivers do NOT paper over: `node:sqlite`
 * returns rows with a **null prototype**, better-sqlite3 returns ordinary
 * objects. Property access, spreading and `JSON.stringify` are identical, but
 * `row instanceof Object` is false and `row.hasOwnProperty(...)` is undefined
 * under `node:sqlite`. Read rows by property access only -- never call an
 * inherited method on one.
 *
 * No other module may import a SQLite driver directly.
 */

const requireFrom = createRequire(import.meta.url);

export type SqliteRow = Record<string, unknown>;

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): SqliteRunResult;
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /** Accepts better-sqlite3's forms: `'user_version'` to read, `'foo = bar'` to set. */
  pragma(source: string): SqliteRow[];
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
  close(): void;
}

export type SqliteDriverName = 'node:sqlite' | 'better-sqlite3';

export interface OpenSqliteOptions {
  /** Opens without write access, so reading never disturbs the writing process. */
  readonly?: boolean;
}

/* -------------------------------------------------------------------------- */
/* node:sqlite                                                                */
/* -------------------------------------------------------------------------- */

interface NodeStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

interface NodeDatabaseSync {
  prepare(sql: string): NodeStatement;
  exec(sql: string): void;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeDatabaseSync;
  StatementSync?: { prototype?: object };
}

function loadNodeSqlite(): NodeSqliteModule | undefined {
  try {
    const mod = requireFrom('node:sqlite') as NodeSqliteModule;
    // On v22.5-v22.12 the module only loads with --experimental-sqlite, and even
    // then has no iterate(). Treat a copy without it as absent rather than
    // discovering the gap mid-collection.
    const proto = mod.StatementSync?.prototype;
    if (!proto || typeof (proto as { iterate?: unknown }).iterate !== 'function') return undefined;
    if (typeof mod.DatabaseSync !== 'function') return undefined;
    return mod;
  } catch {
    return undefined;
  }
}

function wrapNodeStatement(stmt: NodeStatement): SqliteStatement {
  return {
    get: (...params) => stmt.get(...params),
    all: (...params) => stmt.all(...params),
    run: (...params) => {
      const result = stmt.run(...params);
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    },
    iterate: (...params) => stmt.iterate(...params),
  };
}

function wrapNodeDatabase(db: NodeDatabaseSync): SqliteDatabase {
  // better-sqlite3 nests transactions with savepoints; mirror that rather than
  // letting an inner BEGIN throw on a connection that is already in one.
  let depth = 0;

  return {
    prepare: (sql) => wrapNodeStatement(db.prepare(sql)),
    exec: (sql) => db.exec(sql),
    pragma: (source) => {
      const text = source.trim();
      if (text.includes('=')) {
        db.exec(`PRAGMA ${text}`);
        return [];
      }
      return db.prepare(`PRAGMA ${text}`).all() as SqliteRow[];
    },
    transaction<A extends unknown[]>(fn: (...args: A) => void) {
      return (...args: A): void => {
        const nested = depth > 0;
        const savepoint = `ai_usage_sp_${depth}`;
        db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
        depth += 1;
        try {
          fn(...args);
          db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        } catch (error) {
          if (nested) {
            db.exec(`ROLLBACK TO ${savepoint}`);
            db.exec(`RELEASE ${savepoint}`);
          } else {
            db.exec('ROLLBACK');
          }
          throw error;
        } finally {
          depth -= 1;
        }
      };
    },
    close: () => db.close(),
  };
}

/* -------------------------------------------------------------------------- */
/* better-sqlite3 (optional fallback)                                         */
/* -------------------------------------------------------------------------- */

interface BetterStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

interface BetterDatabase {
  prepare(sql: string): BetterStatement;
  exec(sql: string): void;
  pragma(source: string): unknown;
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
  close(): void;
}

type BetterSqlite3Ctor = new (path: string, options?: { readonly?: boolean }) => BetterDatabase;

function loadBetterSqlite3(): BetterSqlite3Ctor | undefined {
  try {
    const mod = requireFrom('better-sqlite3') as
      BetterSqlite3Ctor | { default?: BetterSqlite3Ctor };
    const ctor = typeof mod === 'function' ? mod : mod.default;
    return typeof ctor === 'function' ? ctor : undefined;
  } catch {
    return undefined;
  }
}

function wrapBetterDatabase(db: BetterDatabase): SqliteDatabase {
  return {
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params),
        run: (...params) => {
          const result = stmt.run(...params);
          return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
        },
        iterate: (...params) => stmt.iterate(...params),
      };
    },
    exec: (sql) => db.exec(sql),
    pragma: (source) => (db.pragma(source) ?? []) as SqliteRow[],
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}

/* -------------------------------------------------------------------------- */
/* selection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Forces a driver, for debugging a suspected driver difference and for testing
 * the fallback on a Node new enough not to need it. Unset in normal use.
 */
function forced(): SqliteDriverName | undefined {
  const value = process.env.AI_USAGE_SQLITE_DRIVER?.trim();
  if (value === 'node:sqlite' || value === 'better-sqlite3') return value;
  return undefined;
}

/**
 * Which driver this process will use. Reported by `ai-usage status` so a bug
 * report says which SQLite implementation produced the numbers.
 */
export function sqliteDriver(): SqliteDriverName {
  const pinned = forced();
  if (pinned) return pinned;
  return loadNodeSqlite() ? 'node:sqlite' : 'better-sqlite3';
}

export function openSqlite(path: string, options: OpenSqliteOptions = {}): SqliteDatabase {
  const pinned = forced();

  if (pinned !== 'better-sqlite3') {
    const nodeSqlite = loadNodeSqlite();
    if (nodeSqlite) {
      return wrapNodeDatabase(
        new nodeSqlite.DatabaseSync(path, options.readonly ? { readOnly: true } : {}),
      );
    }
    if (pinned === 'node:sqlite') {
      throw new Error(
        'AI_USAGE_SQLITE_DRIVER=node:sqlite, but this Node does not expose a usable ' +
          '`node:sqlite` (needs v22.13.0 or newer).',
      );
    }
  }

  const BetterSqlite3 = loadBetterSqlite3();
  if (BetterSqlite3) {
    return wrapBetterDatabase(new BetterSqlite3(path, options.readonly ? { readonly: true } : {}));
  }

  throw new Error(
    'No SQLite driver available. This Node does not expose a usable `node:sqlite` ' +
      '(needs v22.13.0 or newer) and the optional `better-sqlite3` fallback is not ' +
      'installed. Upgrade Node, or install better-sqlite3.',
  );
}
