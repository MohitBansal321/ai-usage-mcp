import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabase } from '../../src/db/driver.js';
import { openDatabase } from '../../src/db/database.js';
import { UsageRepository } from '../../src/db/repositories/usage-repository.js';
import type { UsageRecord } from '../../src/models/usage-record.js';
import { EXPORT_COLUMNS, ExportService, csvCell } from '../../src/services/export-service.js';
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
    cacheWrite5mTokens: 1,
    cacheWrite1hTokens: 3,
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

describe('csvCell', () => {
  it('quotes a value containing a comma, quote or newline', () => {
    // A project path is the field most likely to carry one, and an unquoted one
    // silently shifts every later column -- a corruption that looks like data.
    expect(csvCell('C:\\My Repos, v2')).toBe('"C:\\My Repos, v2"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });

  it('leaves an ordinary value alone', () => {
    expect(csvCell('/work/one')).toBe('/work/one');
    expect(csvCell(42)).toBe('42');
  });

  it('writes an absent value as empty, never as 0 or null', () => {
    // A figure the source did not report must not arrive in a spreadsheet as a
    // number: it would be summed with the real ones.
    expect(csvCell(undefined)).toBe('');
  });
});

describe('ExportService', () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: UsageRepository;
  let service: ExportService;

  beforeEach(() => {
    dir = tempDir('export-');
    db = openDatabase({ path: join(dir, 'usage.db') });
    repo = new UsageRepository(db);
    service = new ExportService(repo);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function run(
    filter = {},
    options = {},
  ): { out: string[]; result: ReturnType<ExportService['export']> } {
    const out: string[] = [];
    const result = service.export(filter, (line) => out.push(line), options);
    return { out, result };
  }

  it('emits a header and one row per stored turn', () => {
    repo.upsertMany([record({ id: 'a' }), record({ id: 'b' })]);
    const { out, result } = run();

    expect(out[0]).toBe(EXPORT_COLUMNS.join(','));
    expect(out).toHaveLength(3);
    expect(result.rows).toBe(2);
    expect(result.total).toBe(2);
  });

  it('keeps reported and estimated cost in separate columns', () => {
    // One `cost` column would force a choice between blending two incomparable
    // figures and dropping one.
    repo.upsertMany([
      record({ id: 'est', estimatedCost: 0.25, costBasis: 'estimated' }),
      record({ id: 'rep', cost: 4, estimatedCost: undefined, costBasis: 'reported' }),
    ]);
    const { out } = run();
    const header = (out[0] as string).split(',');
    const rows = out.slice(1).map((l) => l.split(','));
    const col = (name: string) => header.indexOf(name);

    const estimated = rows.find((r) => r[col('id')] === 'est');
    expect(estimated?.[col('cost')]).toBe('');
    expect(estimated?.[col('estimated_cost')]).toBe('0.25');
    expect(estimated?.[col('cost_basis')]).toBe('estimated');

    const reported = rows.find((r) => r[col('id')] === 'rep');
    expect(reported?.[col('cost')]).toBe('4');
    expect(reported?.[col('estimated_cost')]).toBe('');
  });

  it('honours the filter', () => {
    repo.upsertMany([
      record({ id: 'a', model: 'claude-opus-5' }),
      record({ id: 'b', model: 'claude-sonnet-5' }),
    ]);
    const { result } = run({ models: ['claude-sonnet-5'] });
    expect(result.rows).toBe(1);
    expect(result.total).toBe(1);
  });

  it('says how many rows it did NOT export when limited', () => {
    repo.upsertMany(Array.from({ length: 5 }, (_, i) => record({ id: `r${i}` })));
    const { result } = run({}, { limit: 2 });
    expect(result.rows).toBe(2);
    // A truncated export has to be visibly truncated, or it reads as the whole set.
    expect(result.total).toBe(5);
  });

  it('pages past the internal read cap rather than stopping at it', () => {
    // `turns` is capped at 5000 so no single read is unbounded; an export is the
    // one caller that legitimately wants every row, so it reads in batches.
    repo.upsertMany(Array.from({ length: 120 }, (_, i) => record({ id: `r${i}` })));
    const { result, out } = run();
    expect(result.rows).toBe(120);
    expect(out).toHaveLength(121);
    // No row is emitted twice by the paging.
    expect(new Set(out.slice(1)).size).toBe(120);
  });

  it('emits JSON Lines with no header, one object per line', () => {
    repo.upsertMany([record({ id: 'a' })]);
    const { out } = run({}, { format: 'jsonl' });
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0] as string);
    expect(parsed.id).toBe('a');
    expect(parsed.total_tokens).toBe(15);
  });

  it('omits an absent field from JSONL rather than writing null', () => {
    repo.upsertMany([record({ id: 'a', cost: undefined, speed: undefined })]);
    const parsed = JSON.parse(run({}, { format: 'jsonl' }).out[0] as string);
    expect('cost' in parsed).toBe(false);
    expect('speed' in parsed).toBe(false);
    expect('estimated_cost' in parsed).toBe(true);
  });

  it('emits only a header for an empty result, not an empty file', () => {
    const { out, result } = run();
    expect(out).toEqual([EXPORT_COLUMNS.join(',')]);
    expect(result.rows).toBe(0);
  });
});
