import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabase } from '../../src/db/driver.js';
import { openDatabase } from '../../src/db/database.js';
import { MAX_GROUP_AXES, UsageRepository } from '../../src/db/repositories/usage-repository.js';
import type { UsageRecord } from '../../src/models/usage-record.js';
import { tempDir } from '../fixtures/build-fixtures.js';

/** An instant built from LOCAL components, because every time axis is local. */
function localIso(day: number, hour = 12): string {
  return new Date(2026, 7, day, hour, 0, 0, 0).toISOString();
}

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'r1',
    client: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-5',
    sessionId: 's1',
    projectPath: '/work/one',
    timestamp: localIso(1),
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

/**
 * "Which of my projects is getting more expensive" needed `projects --json` to
 * enumerate paths, then one `daily --project` call per path, then a client-side
 * join -- an N+1 that is not feasible as a single tool call at all.
 */
describe('crossTab', () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: UsageRepository;

  beforeEach(() => {
    dir = tempDir('crosstab-');
    db = openDatabase({ path: join(dir, 'usage.db') });
    repo = new UsageRepository(db);
    repo.upsertMany([
      record({ id: 'a', projectPath: '/work/one', timestamp: localIso(1), totalTokens: 100 }),
      record({ id: 'b', projectPath: '/work/one', timestamp: localIso(1), totalTokens: 50 }),
      record({ id: 'c', projectPath: '/work/one', timestamp: localIso(2), totalTokens: 20 }),
      record({ id: 'd', projectPath: '/work/two', timestamp: localIso(2), totalTokens: 500 }),
      record({
        id: 'e',
        projectPath: '/work/two',
        timestamp: localIso(2),
        model: 'claude-sonnet-5',
        client: 'opencode',
        totalTokens: 7,
        cost: 3,
        estimatedCost: undefined,
        costBasis: 'reported',
      }),
    ]);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('crosses project against day in one query', () => {
    const rows = repo.crossTab(['project', 'day'], {}, { sort: 'tokens' }).rows;

    expect(rows).toHaveLength(3);
    expect(rows[0]?.keys).toEqual({ project: '/work/two', day: '2026-08-02' });
    expect(rows[0]?.totalTokens).toBe(507);
    // Two records on the same project and day collapse into one cell.
    const oneDayOne = rows.find(
      (r) => r.keys.project === '/work/one' && r.keys.day === '2026-08-01',
    );
    expect(oneDayOne?.records).toBe(2);
    expect(oneDayOne?.totalTokens).toBe(150);
  });

  it('keeps every axis value on the row, in the order requested', () => {
    const rows = repo.crossTab(['day', 'project'], {}).rows;
    expect(Object.keys(rows[0]?.keys ?? {})).toEqual(['day', 'project']);
  });

  it('crosses three axes', () => {
    const rows = repo.crossTab(['client', 'model', 'day'], {}).rows;
    expect(
      rows.some((r) => r.keys.client === 'opencode' && r.keys.model === 'claude-sonnet-5'),
    ).toBe(true);
  });

  it('never merges the two cost bases in a cell', () => {
    const cell = repo
      .crossTab(['project', 'day'], {})
      .rows.find((r) => r.keys.project === '/work/two');
    expect(cell?.cost.reported).toBe(3);
    expect(cell?.cost.estimated).toBe(1);
    expect(cell?.cost.reportedRecords).toBe(1);
    expect(cell?.cost.estimatedRecords).toBe(1);
  });

  it('omits combinations with no activity rather than returning zero rows', () => {
    // A project x day grid is mostly empty; filling it would bury the rows that
    // matter. Two projects across two days is four cells, of which three exist.
    expect(repo.crossTab(['project', 'day'], {}).total).toBe(3);
  });

  it('pages and sorts like every other list', () => {
    const first = repo.crossTab(['project', 'day'], {}, { limit: 2, sort: 'tokens' });
    expect(first.rows).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(2);

    const walked = [
      ...first.rows,
      ...repo.crossTab(['project', 'day'], {}, { limit: 2, offset: 2, sort: 'tokens' }).rows,
    ];
    expect(walked).toHaveLength(3);
    expect(new Set(walked.map((r) => JSON.stringify(r.keys))).size).toBe(3);
  });

  it('honours the scope filters', () => {
    const rows = repo.crossTab(['project', 'day'], { projectPaths: ['/work/two'] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.keys.project).toBe('/work/two');
  });

  it('buckets time identically to the single-axis day report', () => {
    // Two reports that disagreed about what a day is would be worse than one.
    const cross = repo.crossTab(['day'], {}, { sort: 'tokens' }).rows;
    const daily = repo.byDay({});
    expect(cross.map((r) => r.keys.day).sort()).toEqual(daily.map((r) => r.key).sort());
    for (const row of cross) {
      const match = daily.find((d) => d.key === row.keys.day);
      expect(match?.totalTokens).toBe(row.totalTokens);
    }
  });

  it('refuses a request it cannot answer honestly', () => {
    expect(() => repo.crossTab([], {})).toThrow(/at least one axis/);
    expect(() => repo.crossTab(['day', 'day'], {})).toThrow(/distinct/);
    expect(() => repo.crossTab(['client', 'model', 'project', 'day'] as never, {})).toThrow(
      new RegExp(`at most ${MAX_GROUP_AXES} axes`),
    );
  });
});
