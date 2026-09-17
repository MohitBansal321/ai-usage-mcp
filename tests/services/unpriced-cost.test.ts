import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabase } from '../../src/db/driver.js';
import { openDatabase } from '../../src/db/database.js';
import { UsageRepository } from '../../src/db/repositories/usage-repository.js';
import type { UsageRecord } from '../../src/models/usage-record.js';
import { costLines } from '../../src/services/formatter.js';
import { CostService } from '../../src/services/cost-service.js';
import { builtinPricing } from '../../src/pricing/index.js';
import { tempDir } from '../fixtures/build-fixtures.js';

/**
 * "A reported cost of 0 is indistinguishable from an unknown price."
 *
 * OpenCode reports its own cost, so a model nobody has priced files a perfectly
 * ordinary `{reported: 0, reportedRecords: N, unavailableRecords: 0}` -- which
 * says, in the tool's own vocabulary, that nothing is missing. A genuinely free
 * model and an unpriced paid one rendered identically. These assert the two are
 * now distinguishable, without changing what `reported` means.
 */
function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'r1',
    client: 'opencode',
    provider: 'opencode',
    model: 'big-pickle',
    sessionId: 's1',
    projectPath: '/work/one',
    timestamp: '2026-08-01T10:00:00.000Z',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 60,
    cost: 0,
    costBasis: 'reported',
    currency: 'USD',
    turnKind: 'main',
    source: 'test',
    ...overrides,
  };
}

const PRICED = Object.keys(builtinPricing.models);

describe('unpriced records', () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: UsageRepository;

  beforeEach(() => {
    dir = tempDir('unpriced-');
    db = openDatabase({ path: join(dir, 'usage.db') });
    repo = new UsageRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts and names records whose model the table cannot price', () => {
    repo.upsertMany([
      record({ id: 'a', model: 'big-pickle' }),
      record({ id: 'b', model: 'big-pickle' }),
      record({ id: 'c', model: 'tiny-gherkin' }),
      record({ id: 'd', model: 'claude-opus-5', client: 'claude-code', costBasis: 'estimated' }),
    ]);

    const cost = repo.totals({ pricedModels: PRICED }).cost;

    expect(cost.unpricedRecords).toBe(3);
    expect(cost.unpricedModels).toEqual(['big-pickle', 'tiny-gherkin']);
    // The reported bucket is untouched: those records really were reported.
    expect(cost.reportedRecords).toBe(3);
    expect(cost.reported).toBe(0);
  });

  it('reports 0, not undefined, when every model is priced', () => {
    repo.upsertMany([
      record({ id: 'a', model: 'claude-opus-5', client: 'claude-code', costBasis: 'estimated' }),
    ]);
    const cost = repo.totals({ pricedModels: PRICED }).cost;

    expect(cost.unpricedRecords).toBe(0);
    expect(cost.unpricedModels).toEqual([]);
  });

  it('leaves the count undefined when no priced-model list was supplied', () => {
    repo.upsertMany([record({ id: 'a' })]);
    const cost = repo.totals().cost;

    // "Not asked" is not the same as "none", and must not be reported as 0.
    expect(cost.unpricedRecords).toBeUndefined();
    expect(cost.unpricedModels).toBeUndefined();
  });

  it('treats an empty priced list as "nothing is priced", not as "not asked"', () => {
    repo.upsertMany([record({ id: 'a' }), record({ id: 'b', model: 'claude-opus-5' })]);
    const cost = repo.totals({ pricedModels: [] }).cost;

    expect(cost.unpricedRecords).toBe(2);
    expect(cost.unpricedModels).toEqual(['big-pickle', 'claude-opus-5']);
  });

  it('carries the count into every grouping, not only the overall total', () => {
    repo.upsertMany([
      record({ id: 'a', model: 'big-pickle', projectPath: '/work/one' }),
      record({
        id: 'b',
        model: 'claude-opus-5',
        client: 'claude-code',
        costBasis: 'estimated',
        projectPath: '/work/two',
      }),
    ]);

    const byModel = repo.byModel({ pricedModels: PRICED });
    expect(byModel.find((m) => m.key === 'big-pickle')?.cost.unpricedRecords).toBe(1);
    expect(byModel.find((m) => m.key === 'claude-opus-5')?.cost.unpricedRecords).toBe(0);

    const byProject = repo.byProject({ pricedModels: PRICED });
    expect(byProject.find((p) => p.key === '/work/one')?.cost.unpricedRecords).toBe(1);
    expect(byProject.find((p) => p.key === '/work/two')?.cost.unpricedRecords).toBe(0);

    const byDay = repo.byDay({ pricedModels: PRICED });
    expect(byDay[0]?.cost.unpricedRecords).toBe(1);

    const sessions = repo.sessions({ pricedModels: PRICED });
    expect(sessions.every((s) => s.cost.unpricedRecords !== undefined)).toBe(true);
  });

  it('still filters correctly: the priced list must not leak into the WHERE clause', () => {
    repo.upsertMany([
      record({ id: 'a', model: 'big-pickle', timestamp: '2026-08-01T10:00:00.000Z' }),
      record({ id: 'b', model: 'big-pickle', timestamp: '2026-08-05T10:00:00.000Z' }),
    ]);
    const scoped = repo.totals({
      pricedModels: PRICED,
      since: '2026-08-04T00:00:00.000Z',
    });
    expect(scoped.records).toBe(1);
    expect(scoped.cost.unpricedRecords).toBe(1);
  });
});

describe('formatter: an unpriced model is called out', () => {
  const costService = new CostService({ table: builtinPricing });

  it('says no estimate was attempted, and names the models', () => {
    const text = costLines(
      {
        reported: 0,
        reportedRecords: 1936,
        estimated: 0,
        estimatedRecords: 0,
        unavailableRecords: 0,
        unpricedRecords: 1936,
        unpricedModels: ['big-pickle'],
        currency: 'USD',
      },
      costService,
    ).join('\n');

    expect(text).toContain('No estimate attempted for 1,936 record(s)');
    expect(text).toContain('big-pickle');
    expect(text).toContain(builtinPricing.version);
    // The reported figure keeps its own meaning; the caveat sits beside it.
    expect(text).toContain('Cost (reported by client, exact): $0.00');
  });

  it('stays silent when every model is priced', () => {
    const text = costLines(
      {
        reported: 1,
        reportedRecords: 1,
        estimated: 0,
        estimatedRecords: 0,
        unavailableRecords: 0,
        unpricedRecords: 0,
        unpricedModels: [],
        currency: 'USD',
      },
      costService,
    ).join('\n');
    expect(text).not.toContain('No estimate attempted');
  });

  it('stays silent when the question was never asked', () => {
    const text = costLines(
      {
        reported: 1,
        reportedRecords: 1,
        estimated: 0,
        estimatedRecords: 0,
        unavailableRecords: 0,
        currency: 'USD',
      },
      costService,
    ).join('\n');
    expect(text).not.toContain('No estimate attempted');
  });
});

describe('formatter: the model list is capped', () => {
  const costService = new CostService({ table: builtinPricing });
  const many = Array.from({ length: 19 }, (_, i) => `model-${i}`);

  it('names the first few and counts the rest, so the sentence stays readable', () => {
    const text = costLines(
      {
        reported: 0,
        reportedRecords: 100,
        estimated: 0,
        estimatedRecords: 0,
        unavailableRecords: 0,
        unpricedRecords: 100,
        unpricedModels: many,
        currency: 'USD',
      },
      costService,
    ).join('\n');

    expect(text).toContain('model-0, model-1, model-2, model-3, model-4 and 14 more');
    expect(text).not.toContain('model-18');
    // Nothing is hidden: the count is still the full one.
    expect(text).toContain('No estimate attempted for 100 record(s)');
  });
});
