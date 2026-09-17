import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabase } from '../../src/db/driver.js';
import { openDatabase } from '../../src/db/database.js';
import { UsageRepository } from '../../src/db/repositories/usage-repository.js';
import type { UsageRecord } from '../../src/models/usage-record.js';
import { ExportService } from '../../src/services/export-service.js';
import { LifecycleService, parseExportedRecord } from '../../src/services/lifecycle-service.js';
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
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    reasoningTokens: 5,
    totalTokens: 15,
    estimatedCost: 0.25,
    costBasis: 'estimated',
    currency: 'USD',
    turnKind: 'main',
    source: 'test',
    ...overrides,
  };
}

describe('prune', () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: UsageRepository;
  let service: LifecycleService;
  let path: string;

  beforeEach(() => {
    dir = tempDir('prune-');
    path = join(dir, 'usage.db');
    db = openDatabase({ path });
    repo = new UsageRepository(db);
    service = new LifecycleService(repo, db, path);
    repo.upsertMany([
      record({ id: 'old1', timestamp: '2025-06-01T00:00:00.000Z' }),
      record({ id: 'old2', timestamp: '2025-12-31T23:59:59.000Z' }),
      record({ id: 'boundary', timestamp: '2026-01-01T00:00:00.000Z' }),
      record({ id: 'new', timestamp: '2026-08-01T00:00:00.000Z' }),
    ]);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a DRY RUN by default, and deletes nothing', () => {
    // The only irreversible operation in this package must not act on a typo.
    const result = service.prune('2026-01-01T00:00:00.000Z');
    expect(result.applied).toBe(false);
    expect(result.matched).toBe(2);
    expect(result.removed).toBe(0);
    expect(repo.recordCount()).toBe(4);
  });

  it('deletes only when told twice', () => {
    const result = service.prune('2026-01-01T00:00:00.000Z', { apply: true });
    expect(result.applied).toBe(true);
    expect(result.removed).toBe(2);
    expect(repo.recordCount()).toBe(2);
  });

  it('treats the cutoff as EXCLUSIVE, as every other bound in this codebase is', () => {
    // --before 2026-01-01 removes 2025 and keeps New Year's Day. An off-by-one
    // in the one irreversible command is not worth a tidier boundary.
    service.prune('2026-01-01T00:00:00.000Z', { apply: true });
    const remaining = repo.turns().map((t) => t.id);
    expect(remaining).toContain('boundary');
    expect(remaining).not.toContain('old2');
  });

  it('honours a scope filter, so a prune cannot exceed the report that justified it', () => {
    repo.upsertMany([
      record({ id: 'oc', client: 'opencode', timestamp: '2025-06-01T00:00:00.000Z' }),
    ]);
    const result = service.prune('2026-01-01T00:00:00.000Z', {
      apply: true,
      filter: { clients: ['opencode'] },
    });
    expect(result.removed).toBe(1);
    expect(repo.turns().map((t) => t.id)).toContain('old1');
  });

  it('removes nothing when nothing is old enough', () => {
    const result = service.prune('2020-01-01T00:00:00.000Z', { apply: true });
    expect(result.matched).toBe(0);
    expect(result.removed).toBe(0);
    expect(repo.recordCount()).toBe(4);
  });
});

describe('vacuum', () => {
  it('measures the whole footprint, not just the .db file', () => {
    // The trap this asserts against: this package always opens in WAL mode, so
    // freshly written data lives in the `-wal` until a checkpoint folds it back.
    // A 1.8MB database shows a 4KB `.db`, and measuring only that reports
    // "reclaimed nothing" while most of the bytes sit next door.
    const dir = tempDir('vacuum-');
    const path = join(dir, 'usage.db');
    const db = openDatabase({ path });
    const repo = new UsageRepository(db);
    const service = new LifecycleService(repo, db, path);

    repo.upsertMany(
      Array.from({ length: 2000 }, (_, i) =>
        record({ id: `r${i}`, projectPath: '/work/a-fairly-long-path-to-occupy-some-pages' }),
      ),
    );
    expect(statSync(path).size).toBeLessThan(statSync(`${path}-wal`).size);

    repo.deleteBefore('2030-01-01T00:00:00.000Z');
    const result = service.vacuum();

    expect(result.bytesBefore).toBeGreaterThan(statSync(path).size);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore as number);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports no file to measure for an in-memory database', () => {
    const db = openDatabase({ path: ':memory:' });
    const result = new LifecycleService(new UsageRepository(db), db, ':memory:').vacuum();
    expect(result.bytesBefore).toBeUndefined();
    expect(result.reclaimedBytes).toBeUndefined();
    db.close();
  });
});

describe('parseExportedRecord', () => {
  const valid = {
    id: 'x',
    client: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-5',
    session_id: 's',
    timestamp: '2026-08-01T10:00:00.000Z',
    cost_basis: 'estimated',
    input_tokens: 1,
    output_tokens: 2,
    total_tokens: 3,
  };

  it('accepts a row with only the required fields', () => {
    const result = parseExportedRecord(valid);
    expect('record' in result && result.record.id).toBe('x');
  });

  it('leaves an absent optional field absent, never 0', () => {
    // A figure the source never reported must not become a zero just because it
    // travelled through a file -- it would then be summed with the real ones.
    const result = parseExportedRecord(valid);
    expect('record' in result && result.record.cacheReadTokens).toBeUndefined();
    expect('record' in result && result.record.cost).toBeUndefined();
  });

  it('round-trips everything the exporter writes', () => {
    const dir = tempDir('roundtrip-');
    const db = openDatabase({ path: join(dir, 'usage.db') });
    const repo = new UsageRepository(db);
    const original = record({ id: 'full', speed: 'fast', cacheWrite1hTokens: 4 });
    repo.upsertMany([original]);

    const lines: string[] = [];
    new ExportService(repo).export({}, (line) => lines.push(line), { format: 'jsonl' });
    const parsed = parseExportedRecord(JSON.parse(lines[0] as string));

    expect('record' in parsed).toBe(true);
    if ('record' in parsed) {
      for (const key of [
        'id',
        'client',
        'model',
        'sessionId',
        'projectPath',
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'totalTokens',
        'estimatedCost',
        'costBasis',
        'speed',
      ] as const) {
        expect(parsed.record[key], key).toEqual(original[key]);
      }
    }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rejections: [string, unknown, RegExp][] = [
    ['not an object', 'nope', /not a JSON object/],
    ['missing id', { ...valid, id: undefined }, /missing or empty "id"/],
    ['empty model', { ...valid, model: '' }, /missing or empty "model"/],
    ['unknown client', { ...valid, client: 'cursor' }, /unknown client/],
    ['bad cost basis', { ...valid, cost_basis: 'guessed' }, /cost_basis must be/],
    ['bad turn kind', { ...valid, turn_kind: 'sidequest' }, /turn_kind must be/],
    ['non-numeric tokens', { ...valid, input_tokens: '1' }, /must be a finite number/],
    ['non-numeric optional', { ...valid, cost: 'free' }, /"cost" is not a number/],
    ['unparseable timestamp', { ...valid, timestamp: 'yesterday' }, /not a valid date/],
  ];

  for (const [name, row, message] of rejections) {
    it(`rejects: ${name}`, () => {
      const result = parseExportedRecord(row);
      expect('reason' in result).toBe(true);
      if ('reason' in result) expect(result.reason).toMatch(message);
    });
  }
});

describe('import', () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: UsageRepository;
  let service: LifecycleService;

  beforeEach(() => {
    dir = tempDir('import-');
    const path = join(dir, 'usage.db');
    db = openDatabase({ path });
    repo = new UsageRepository(db);
    service = new LifecycleService(repo, db, path);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function exported(records: UsageRecord[]): string[] {
    const source = tempDir('src-');
    const sourceDb = openDatabase({ path: join(source, 'usage.db') });
    const sourceRepo = new UsageRepository(sourceDb);
    sourceRepo.upsertMany(records);
    const lines: string[] = [];
    new ExportService(sourceRepo).export({}, (line) => lines.push(line), { format: 'jsonl' });
    sourceDb.close();
    rmSync(source, { recursive: true, force: true });
    return lines;
  }

  it('merges another machine’s export', () => {
    const result = service.import(exported([record({ id: 'a' }), record({ id: 'b' })]));
    expect(result.accepted).toBe(2);
    expect(result.recordsBefore).toBe(0);
    expect(result.recordsAfter).toBe(2);
  });

  it('cannot double count the same turn, however many times it is imported', () => {
    // The property that makes "laptop plus desktop" answerable: record ids are
    // derived deterministically from source identifiers, so the same turn seen
    // on both machines upserts to one row.
    const lines = exported([record({ id: 'a', totalTokens: 15 })]);
    service.import(lines);
    service.import(lines);
    const second = service.import(lines);

    expect(second.recordsAfter).toBe(1);
    expect(repo.totals().totalTokens).toBe(15);
  });

  it('merges two machines without either losing rows', () => {
    service.import(exported([record({ id: 'laptop-1' }), record({ id: 'shared' })]));
    service.import(exported([record({ id: 'desktop-1' }), record({ id: 'shared' })]));

    expect(repo.recordCount()).toBe(3);
    expect(
      repo
        .turns()
        .map((t) => t.id)
        .sort(),
    ).toEqual(['desktop-1', 'laptop-1', 'shared']);
  });

  it('skips blank lines without counting them as rows', () => {
    const result = service.import(['', ...exported([record({ id: 'a' })]), '', '   ']);
    expect(result.read).toBe(1);
    expect(result.rejected).toEqual([]);
  });

  it('rejects a bad row with its line number, and imports the rest', () => {
    // Silently dropping a row would leave a merged database under-counting for
    // ever after, with nothing to say so.
    const lines = ['not json', ...exported([record({ id: 'a' })]), '{"id":"partial"}'];
    const result = service.import(lines);

    expect(result.accepted).toBe(1);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]).toEqual({ line: 1, reason: 'not valid JSON' });
    expect(result.rejected[1]?.line).toBe(3);
    expect(repo.recordCount()).toBe(1);
  });
});
