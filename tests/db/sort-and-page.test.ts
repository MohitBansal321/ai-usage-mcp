import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabase } from '../../src/db/driver.js';
import { openDatabase } from '../../src/db/database.js';
import { UsageRepository } from '../../src/db/repositories/usage-repository.js';
import type { UsageRecord } from '../../src/models/usage-record.js';
import { tempDir } from '../fixtures/build-fixtures.js';

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'r1',
    client: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-5',
    sessionId: 's1',
    projectPath: '/work/one',
    timestamp: '2026-08-01T10:00:00.000Z',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 10,
    estimatedCost: 1,
    costBasis: 'estimated',
    currency: 'USD',
    turnKind: 'main',
    source: 'test',
    ...overrides,
  };
}

describe('sorting', () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: UsageRepository;

  beforeEach(() => {
    dir = tempDir('sort-');
    db = openDatabase({ path: join(dir, 'usage.db') });
    repo = new UsageRepository(db);
    repo.upsertMany([
      // Cheap but huge, and the most recent: the row a token sort surfaces.
      record({
        id: 'a',
        sessionId: 'big-cheap',
        totalTokens: 10_000,
        estimatedCost: 1,
        timestamp: '2026-08-09T10:00:00.000Z',
      }),
      // Expensive but small, and the oldest: invisible to both other sorts.
      record({
        id: 'b',
        sessionId: 'small-costly',
        totalTokens: 10,
        estimatedCost: 900,
        timestamp: '2026-08-01T10:00:00.000Z',
      }),
      // Priced on the OTHER basis entirely.
      record({
        id: 'c',
        sessionId: 'reported-only',
        client: 'opencode',
        model: 'big-pickle',
        totalTokens: 500,
        cost: 500,
        estimatedCost: undefined,
        costBasis: 'reported',
        timestamp: '2026-08-05T10:00:00.000Z',
      }),
    ]);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces the costliest session, which recency-plus-limit actively hides', () => {
    // The point of the issue: `--limit 1` on a recency-ordered list returns the
    // newest session, and the most expensive one is invisible unless it happens
    // to also be recent.
    expect(repo.sessions({}, { limit: 1 }).rows[0]?.sessionId).toBe('big-cheap');
    expect(repo.sessions({}, { limit: 1, sort: 'estimated-cost' }).rows[0]?.sessionId).toBe(
      'small-costly',
    );
    expect(repo.sessions({}, { limit: 1, sort: 'reported-cost' }).rows[0]?.sessionId).toBe(
      'reported-only',
    );
    expect(repo.sessions({}, { limit: 1, sort: 'tokens' }).rows[0]?.sessionId).toBe('big-cheap');
  });

  it('counts the rows an ordering cannot speak for', () => {
    // Two of the three sessions have no estimated cost... no: one has none.
    const byEstimate = repo.sessions({}, { sort: 'estimated-cost' });
    expect(byEstimate.rowsWithoutSortValue).toBe(1);

    const byReported = repo.sessions({}, { sort: 'reported-cost' });
    expect(byReported.rowsWithoutSortValue).toBe(2);

    // A non-cost ordering has no such notion, and must not invent one.
    expect(repo.sessions({}, { sort: 'tokens' }).rowsWithoutSortValue).toBe(0);
  });

  it('orders grouped rows by each key', () => {
    const byTokens = repo.byModel({}, { sort: 'tokens' }).rows.map((r) => r.key);
    expect(byTokens[0]).toBe('claude-opus-5');

    const byReported = repo.byModel({}, { sort: 'reported-cost' }).rows.map((r) => r.key);
    expect(byReported[0]).toBe('big-pickle');
  });

  it('breaks ties deterministically, or paging would drop and repeat rows', () => {
    repo.upsertMany([
      record({ id: 'tie1', sessionId: 'tie-a', totalTokens: 1, estimatedCost: 0 }),
      record({ id: 'tie2', sessionId: 'tie-b', totalTokens: 1, estimatedCost: 0 }),
      record({ id: 'tie3', sessionId: 'tie-c', totalTokens: 1, estimatedCost: 0 }),
    ]);
    const all = repo.sessions({}, { sort: 'tokens' }).rows.map((r) => r.sessionId);
    const paged = [
      ...repo.sessions({}, { sort: 'tokens', limit: 3, offset: 0 }).rows,
      ...repo.sessions({}, { sort: 'tokens', limit: 3, offset: 3 }).rows,
    ].map((r) => r.sessionId);
    expect(paged).toEqual(all);
    expect(new Set(paged).size).toBe(paged.length);
  });
});

describe('paging', () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: UsageRepository;

  beforeEach(() => {
    dir = tempDir('page-');
    db = openDatabase({ path: join(dir, 'usage.db') });
    repo = new UsageRepository(db);
    repo.upsertMany(
      Array.from({ length: 25 }, (_, i) =>
        record({
          id: `r${i}`,
          sessionId: `s${String(i).padStart(2, '0')}`,
          projectPath: `/work/p${String(i).padStart(2, '0')}`,
          totalTokens: 1000 - i,
        }),
      ),
    );
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('says how many rows there are, not just how many it returned', () => {
    const page = repo.sessions({}, { limit: 5 });
    expect(page.rows).toHaveLength(5);
    expect(page.total).toBe(25);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(5);
  });

  it('walks every row across pages without gaps or repeats', () => {
    const seen: string[] = [];
    let offset = 0;
    for (;;) {
      const page = repo.sessions({}, { limit: 10, offset, sort: 'tokens' });
      seen.push(...page.rows.map((r) => r.sessionId));
      if (!page.hasMore) break;
      offset = page.nextOffset as number;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('reports the end of the list rather than offering a next page', () => {
    const last = repo.sessions({}, { limit: 10, offset: 20 });
    expect(last.rows).toHaveLength(5);
    expect(last.hasMore).toBe(false);
    expect(last.nextOffset).toBeUndefined();
  });

  it('returns an empty page past the end, still reporting the true total', () => {
    const past = repo.sessions({}, { limit: 10, offset: 999 });
    expect(past.rows).toHaveLength(0);
    expect(past.total).toBe(25);
    expect(past.hasMore).toBe(false);
  });

  it('counts groups matching the filter, not rows in the table', () => {
    const page = repo.byProject({ projectPaths: ['/work/p00', '/work/p01'] }, { limit: 1 });
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it('returns every row, and says so, when no limit is given', () => {
    const page = repo.byProject({});
    expect(page.rows).toHaveLength(25);
    expect(page.total).toBe(25);
    expect(page.limit).toBeUndefined();
    expect(page.hasMore).toBe(false);
  });
});

describe('multi-valued scope filters', () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: UsageRepository;

  beforeEach(() => {
    dir = tempDir('scope-');
    db = openDatabase({ path: join(dir, 'usage.db') });
    repo = new UsageRepository(db);
    repo.upsertMany([
      record({ id: 'a', model: 'claude-opus-5', projectPath: '/work/one' }),
      record({ id: 'b', model: 'claude-sonnet-5', projectPath: '/work/two' }),
      record({ id: 'c', model: 'claude-haiku-4-5', projectPath: '/work/three' }),
      record({ id: 'd', model: 'big-pickle', client: 'opencode', projectPath: '/work/three' }),
    ]);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches any of several models', () => {
    const rows = repo.byModel({ models: ['claude-opus-5', 'claude-sonnet-5'] }).rows;
    expect(rows.map((r) => r.key).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(repo.totals({ models: ['claude-opus-5', 'claude-sonnet-5'] }).records).toBe(2);
  });

  it('matches any of several projects', () => {
    expect(repo.totals({ projectPaths: ['/work/one', '/work/three'] }).records).toBe(3);
  });

  it('matches any of several clients', () => {
    expect(repo.totals({ clients: ['claude-code', 'opencode'] }).records).toBe(4);
    expect(repo.totals({ clients: ['opencode'] }).records).toBe(1);
  });

  it('combines scopes with AND, not OR', () => {
    expect(repo.totals({ models: ['claude-haiku-4-5'], projectPaths: ['/work/one'] }).records).toBe(
      0,
    );
    expect(
      repo.totals({ models: ['claude-haiku-4-5'], projectPaths: ['/work/three'] }).records,
    ).toBe(1);
  });

  it('treats an empty list as "none of them", never as "no filter"', () => {
    // Falling back to unfiltered is how an empty scope value used to answer a
    // narrowed question with the whole database.
    expect(repo.totals({ models: [] }).records).toBe(0);
    expect(repo.totals({ projectPaths: [] }).records).toBe(0);
  });

  it('still normalises a Windows drive letter across a list', () => {
    repo.upsertMany([record({ id: 'w', projectPath: 'D:\\repo' })]);
    expect(repo.totals({ projectPaths: ['d:\\repo'] }).records).toBe(1);
  });
});

describe('absentValues', () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: UsageRepository;

  beforeEach(() => {
    dir = tempDir('absent-');
    db = openDatabase({ path: join(dir, 'usage.db') });
    repo = new UsageRepository(db);
    repo.upsertMany([record({ id: 'a', model: 'claude-opus-5', projectPath: 'D:\\repo' })]);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('names only the values that exist nowhere in the database', () => {
    expect(repo.absentValues('model', ['claude-opus-5', 'nope'])).toEqual(['nope']);
    expect(repo.absentValues('model', ['claude-opus-5'])).toEqual([]);
  });

  it('echoes the caller spelling back, not the normalised one', () => {
    // The user typed `d:\repo`; telling them `D:\repo` is missing when it is not
    // would send them looking for the wrong thing.
    expect(repo.absentValues('project_path', ['d:\\repo'])).toEqual([]);
    expect(repo.absentValues('project_path', ['d:\\other'])).toEqual(['d:\\other']);
  });

  it('answers nothing for an empty request', () => {
    expect(repo.absentValues('model', [])).toEqual([]);
  });
});
