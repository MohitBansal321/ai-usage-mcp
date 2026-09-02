import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabase } from '../../src/db/driver.js';
import { openDatabase } from '../../src/db/database.js';
import {
  TURNS_DEFAULT_LIMIT,
  TURNS_MAX_LIMIT,
  UsageRepository,
} from '../../src/db/repositories/usage-repository.js';
import type { UsageRecord } from '../../src/models/usage-record.js';
import { tempDir } from '../fixtures/build-fixtures.js';

/**
 * Direct repository tests. Everything else reaches this layer through
 * UsageService, which means the row-level read path and the cache-write TTL
 * split had no coverage of their own.
 */
function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'r1',
    client: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-5',
    sessionId: 's1',
    projectPath: '/work/one',
    timestamp: '2026-08-01T10:00:00.000Z',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    cacheWrite5mTokens: 25,
    cacheWrite1hTokens: 15,
    reasoningTokens: 5,
    totalTokens: 100,
    estimatedCost: 0.25,
    costBasis: 'estimated',
    currency: 'USD',
    turnKind: 'main',
    source: 'test',
    sourceVersion: '1',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  } as UsageRecord;
}

describe('UsageRepository', () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: UsageRepository;

  beforeEach(() => {
    dir = tempDir('usage-repo-');
    // `openDatabase` takes an options object; a bare string silently falls
    // through to `resolveDatabasePath()` and opens the user's real database.
    db = openDatabase({ path: join(dir, 'usage.db') });
    repo = new UsageRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads cache-write TTL columns back out of an aggregate', () => {
    repo.upsertMany([
      record({ id: 'a', cacheWrite5mTokens: 25, cacheWrite1hTokens: 15 }),
      record({ id: 'b', cacheWrite5mTokens: 5, cacheWrite1hTokens: 100 }),
    ]);
    const totals = repo.totals();
    // Written since the first release, never selected until now -- the combined
    // column alone cannot be re-priced, because the two TTLs bill differently.
    expect(totals.cacheWrite5mTokens).toBe(30);
    expect(totals.cacheWrite1hTokens).toBe(115);
    expect(totals.cacheWriteTokens).toBe(80);
  });

  it('returns individual turns oldest first', () => {
    repo.upsertMany([
      record({ id: 'b', timestamp: '2026-08-01T12:00:00.000Z' }),
      record({ id: 'a', timestamp: '2026-08-01T10:00:00.000Z' }),
      record({ id: 'c', timestamp: '2026-08-01T14:00:00.000Z' }),
    ]);
    expect(repo.turns().map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('bounds every row read and pages without gaps or repeats', () => {
    repo.upsertMany(
      Array.from({ length: 12 }, (_, i) =>
        record({ id: `t${i}`, timestamp: `2026-08-01T${String(i).padStart(2, '0')}:00:00.000Z` }),
      ),
    );
    expect(repo.countTurns()).toBe(12);

    const first = repo.turns({}, { limit: 5 });
    const second = repo.turns({}, { limit: 5, offset: 5 });
    const third = repo.turns({}, { limit: 5, offset: 10 });
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    expect(third).toHaveLength(2);

    const paged = [...first, ...second, ...third].map((t) => t.id);
    expect(new Set(paged).size).toBe(12);
    expect(paged).toEqual(repo.turns({}, { limit: 12 }).map((t) => t.id));
  });

  it('clamps a limit rather than letting a caller read an unbounded session', () => {
    repo.upsertMany([record({ id: 'only' })]);
    expect(repo.turns({}, { limit: 0 })).toHaveLength(1);
    expect(repo.turns({}, { limit: -5 })).toHaveLength(1);
    expect(repo.turns({}, { limit: TURNS_MAX_LIMIT + 1_000_000 })).toHaveLength(1);
    expect(TURNS_DEFAULT_LIMIT).toBeLessThanOrEqual(TURNS_MAX_LIMIT);
  });

  it('applies the same filters to rows as it does to aggregates', () => {
    repo.upsertMany([
      record({ id: 'main', turnKind: 'main', sessionId: 's1' }),
      record({ id: 'sub', turnKind: 'subagent', sessionId: 's1' }),
      record({ id: 'other', sessionId: 's2', projectPath: '/work/two' }),
    ]);
    expect(repo.turns({ includeSubagents: false }).map((t) => t.id)).toEqual(['main', 'other']);
    expect(repo.turns({ sessionId: 's1' })).toHaveLength(2);
    expect(repo.turns({ projectPath: '/work/two' }).map((t) => t.id)).toEqual(['other']);
    expect(repo.countTurns({ includeSubagents: false })).toBe(2);
  });

  it('carries per-turn cost with its basis, and omits absent values', () => {
    repo.upsertMany([
      record({ id: 'est', estimatedCost: 0.5, costBasis: 'estimated' }),
      record({ id: 'rep', cost: 0.25, estimatedCost: undefined, costBasis: 'reported' }),
    ]);
    const byId = new Map(repo.turns().map((t) => [t.id, t]));
    expect(byId.get('est')!.estimatedCost).toBe(0.5);
    expect(byId.get('est')!.cost).toBeUndefined();
    expect(byId.get('rep')!.cost).toBe(0.25);
    expect(byId.get('rep')!.costBasis).toBe('reported');
  });

  it('groups projects, keeping unresolved ones rather than dropping them', () => {
    repo.upsertMany([
      record({ id: 'a', projectPath: '/work/one' }),
      record({ id: 'b', projectPath: undefined }),
    ]);
    expect([...repo.byProject().map((p) => p.key)].sort()).toEqual(['(unknown)', '/work/one']);
  });
});
