import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/database.js';
import type { SqliteDatabase } from '../../src/db/driver.js';
import { UsageRepository } from '../../src/db/repositories/usage-repository.js';
import type { UsageRecord } from '../../src/models/usage-record.js';
import { CostService, billableOutputTokens } from '../../src/services/cost-service.js';
import { CounterfactualService } from '../../src/services/counterfactual-service.js';
import { tempDir } from '../fixtures/build-fixtures.js';

const M = 1_000_000;

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'r1',
    client: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-5',
    sessionId: 's1',
    timestamp: '2026-08-01T10:00:00.000Z',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costBasis: 'estimated',
    currency: 'USD',
    turnKind: 'main',
    source: 'test',
    ...overrides,
  };
}

describe('CounterfactualService', () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: UsageRepository;
  let service: CounterfactualService;
  const costService = new CostService();

  beforeEach(() => {
    dir = tempDir('counterfactual-');
    db = openDatabase({ path: join(dir, 'usage.db') });
    repo = new UsageRepository(db);
    service = new CounterfactualService(repo, costService);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prices the same tokens at each target model, cheapest first', () => {
    // 1M output on Opus 5 ($25/M) vs Sonnet 5 ($10/M) vs Haiku 4.5 ($5/M).
    repo.upsertMany([record({ outputTokens: M, totalTokens: M, speed: 'standard' })]);

    const report = service.counterfactual({}, 'all time', [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);

    expect(report.scenarios.map((s) => s.model)).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-5',
      'claude-opus-5',
    ]);
    const by = new Map(report.scenarios.map((s) => [s.model, s.estimatedCost]));
    expect(by.get('claude-opus-5')).toBeCloseTo(25, 6);
    expect(by.get('claude-sonnet-5')).toBeCloseTo(10, 6);
    expect(by.get('claude-haiku-4-5')).toBeCloseTo(5, 6);
  });

  it('marks the model that actually ran, rather than subtracting it', () => {
    repo.upsertMany([record({ model: 'claude-opus-5', outputTokens: M, totalTokens: M })]);
    const report = service.counterfactual({}, 'all time', ['claude-opus-5', 'claude-sonnet-5']);

    expect(report.scenarios.find((s) => s.model === 'claude-opus-5')!.isActual).toBe(true);
    expect(report.scenarios.find((s) => s.model === 'claude-sonnet-5')!.isActual).toBe(false);
  });

  it('keeps the actual cost on its own basis, never folded into a scenario', () => {
    repo.upsertMany([
      record({ id: 'rep', client: 'opencode', cost: 4, costBasis: 'reported', outputTokens: M }),
      record({ id: 'est', estimatedCost: 9, costBasis: 'estimated', outputTokens: M }),
    ]);
    const report = service.counterfactual({}, 'all time', ['claude-sonnet-5']);

    expect(report.overall.cost.reported).toBeCloseTo(4, 6);
    expect(report.overall.cost.reportedRecords).toBe(1);
    expect(report.overall.cost.estimated).toBeCloseTo(9, 6);
    expect(report.overall.cost.estimatedRecords).toBe(1);
    // The scenario is its own number and shares nothing with either bucket.
    const scenario = report.scenarios[0]!;
    expect(scenario.estimatedCost).not.toBeCloseTo(13, 6);
  });

  it("bills OpenCode's reasoning tokens, which sit beside output rather than inside it", () => {
    // The trap: pricing `outputTokens` alone would charge nothing for reasoning
    // on OpenCode, while doing the same for Claude Code would double-charge it.
    repo.upsertMany([
      record({ id: 'oc', client: 'opencode', outputTokens: M, reasoningTokens: M }),
    ]);
    const oc = service.counterfactual({}, 'all time', ['claude-sonnet-5']).scenarios[0]!;

    repo.upsertMany([record({ id: 'oc' })]); // clear it back to zero tokens
    repo.upsertMany([
      record({ id: 'cc', client: 'claude-code', outputTokens: M, reasoningTokens: M }),
    ]);
    const cc = service.counterfactual({ clients: ['claude-code'] }, 'all time', ['claude-sonnet-5'])
      .scenarios[0]!;

    // 2M billable output for OpenCode, 1M for Claude Code, at $10/M.
    expect(oc.estimatedCost).toBeCloseTo(20, 6);
    expect(cc.estimatedCost).toBeCloseTo(10, 6);
  });

  it('applies the fast premium only where the target model offers it', () => {
    repo.upsertMany([record({ outputTokens: M, totalTokens: M, speed: 'fast' })]);
    const report = service.counterfactual({}, 'all time', ['claude-opus-5', 'claude-sonnet-5']);
    const by = new Map(report.scenarios.map((s) => [s.model, s.estimatedCost]));

    // Opus 5 fast output is $50/M; Sonnet 5 has no fast rate, so it stays $10/M.
    expect(by.get('claude-opus-5')).toBeCloseTo(50, 6);
    expect(by.get('claude-sonnet-5')).toBeCloseTo(10, 6);
    expect(report.caveats.join(' ')).toContain('fast mode');
  });

  it('groups by speed so a mixed period is not priced at one blended rate', () => {
    repo.upsertMany([
      record({ id: 'fast', outputTokens: M, speed: 'fast' }),
      record({ id: 'std', outputTokens: M, speed: 'standard' }),
    ]);
    const groups = repo.repriceGroups({});
    expect(groups).toHaveLength(2);

    const opus = service
      .counterfactual({}, 'all time', ['claude-opus-5'])
      .scenarios.find((s) => s.model === 'claude-opus-5')!;
    // $50/M for the fast million, $25/M for the standard one -- not 2M at either rate.
    expect(opus.estimatedCost).toBeCloseTo(75, 6);
  });

  it('omits an unpriced target and says so, rather than guessing a rate', () => {
    repo.upsertMany([record({ outputTokens: M })]);
    const report = service.counterfactual({}, 'all time', ['claude-sonnet-5', 'gpt-5.4']);

    expect(report.scenarios.map((s) => s.model)).toEqual(['claude-sonnet-5']);
    expect(report.caveats.join(' ')).toContain('gpt-5.4');
  });

  it('defaults to every model the pricing table knows', () => {
    repo.upsertMany([record({ outputTokens: M })]);
    const report = service.counterfactual({}, 'all time');
    expect(report.scenarios.map((s) => s.model).sort()).toEqual(costService.pricedModels());
  });

  it('always carries the caveat that this is not a saving', () => {
    repo.upsertMany([record({ outputTokens: M })]);
    const report = service.counterfactual({}, 'all time', ['claude-sonnet-5']);
    expect(report.caveats.length).toBeGreaterThan(0);
    expect(report.caveats[0]).toContain('not a saving');
  });

  it('flags records with no recorded speed instead of asserting they were standard', () => {
    repo.upsertMany([record({ outputTokens: M, speed: undefined })]);
    const report = service.counterfactual({}, 'all time', ['claude-sonnet-5']);
    expect(report.caveats.join(' ')).toContain('no recorded speed');
  });

  it('reports an empty period without inventing scenarios worth zero', () => {
    const report = service.counterfactual({}, 'all time', ['claude-sonnet-5']);
    expect(report.overall.records).toBe(0);
    expect(report.scenarios.every((s) => s.estimatedCost === 0)).toBe(true);
    expect(report.scenarios[0]!.records).toBe(0);
  });
});

describe('billableOutputTokens', () => {
  it('adds reasoning only for a client that stores it beside output', () => {
    expect(billableOutputTokens('claude-code', 100, 40)).toBe(100);
    expect(billableOutputTokens('opencode', 100, 40)).toBe(140);
  });

  it('is a no-op when there are no reasoning tokens', () => {
    expect(billableOutputTokens('opencode', 100)).toBe(100);
    expect(billableOutputTokens('claude-code', 100)).toBe(100);
  });
});

/**
 * The one scenario in this service allowed to state a saving.
 *
 * Unlike a model counterfactual, the token counts really are invariant:
 * cache-read tokens ARE the context re-sent each turn, so without a cache they
 * would have been sent as ordinary input one for one, and the cache-write
 * premium would simply not have been paid.
 */
describe('no-cache scenario', () => {
  let dir: string;
  let db: SqliteDatabase;
  let service: CounterfactualService;
  let repo: UsageRepository;

  beforeEach(() => {
    dir = tempDir('nocache-');
    db = openDatabase({ path: join(dir, 'usage.db') });
    repo = new UsageRepository(db);
    service = new CounterfactualService(repo, new CostService());
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prices every cache token at the plain input rate', () => {
    // claude-opus-5: $5/M input, $25/M output. 1M cache-read at 0.1x = $0.50,
    // 1M 5-minute cache-write at 1.25x = $6.25. With cache: $5 + $0.50 + $6.25.
    // Without: 3M tokens of plain input = $15.
    repo.upsertMany([
      record({
        id: 'a',
        inputTokens: M,
        cacheReadTokens: M,
        cacheWriteTokens: M,
        cacheWrite5mTokens: M,
      }),
    ]);
    const [scenario] = service.counterfactual({}, 'all time', ['claude-opus-5']).noCache;

    expect(scenario?.withCache).toBeCloseTo(5 + 0.5 + 6.25, 6);
    expect(scenario?.withoutCache).toBeCloseTo(15, 6);
    // One read per write is already above the 0.28 break-even, so caching wins
    // even at this ratio -- which is the cross-check against
    // `breakEvenReadsPerWrite` rather than a separate claim.
    expect(scenario?.saved).toBeCloseTo(3.25, 6);
  });

  it('shows a LOSS below the break-even reuse ratio', () => {
    // 0.2 reads per write, under the 0.28 break-even for a 5-minute write.
    // With cache: 0.2M read at $0.50/M = $0.10, plus 1M write at $6.25/M.
    // Without:    1.2M plain input at $5/M = $6.00. Caching cost $0.35 more.
    repo.upsertMany([
      record({
        id: 'a',
        cacheReadTokens: 0.2 * M,
        cacheWriteTokens: M,
        cacheWrite5mTokens: M,
      }),
    ]);
    const [scenario] = service.counterfactual({}, 'all time', ['claude-opus-5']).noCache;

    expect(scenario?.withCache).toBeCloseTo(6.35, 6);
    expect(scenario?.withoutCache).toBeCloseTo(6, 6);
    // A negative saving is reported as such, not clamped to zero: burning the
    // write premium on sessions too short to reuse it is exactly what the issue
    // asks to be able to see.
    expect(scenario?.saved).toBeCloseTo(-0.35, 6);
  });

  it('shows a saving when reads outweigh writes, as they do in practice', () => {
    repo.upsertMany([
      record({
        id: 'a',
        inputTokens: 0,
        cacheReadTokens: 100 * M,
        cacheWriteTokens: M,
        cacheWrite5mTokens: M,
      }),
    ]);
    const [scenario] = service.counterfactual({}, 'all time', ['claude-opus-5']).noCache;

    // With cache: 100M reads at $0.50/M + 1M write at $6.25 = $56.25.
    // Without:    101M plain input at $5/M = $505.
    expect(scenario?.withCache).toBeCloseTo(56.25, 6);
    expect(scenario?.withoutCache).toBeCloseTo(505, 6);
    expect(scenario?.saved).toBeCloseTo(448.75, 6);
    expect(scenario?.savedFraction).toBeCloseTo(448.75 / 505, 6);
  });

  it('keeps each model separate rather than blending the answer', () => {
    repo.upsertMany([
      record({ id: 'a', model: 'claude-opus-5', cacheReadTokens: 10 * M }),
      record({ id: 'b', model: 'claude-haiku-4-5', cacheReadTokens: 10 * M }),
    ]);
    const { noCache } = service.counterfactual({}, 'all time', ['claude-opus-5']);

    expect(noCache.map((s) => s.model).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-5']);
    // Opus is 5x Haiku's input rate, so the saving differs by 5x too. One
    // blended figure would hide that entirely.
    const opus = noCache.find((s) => s.model === 'claude-opus-5');
    const haiku = noCache.find((s) => s.model === 'claude-haiku-4-5');
    expect((opus?.saved ?? 0) / (haiku?.saved ?? 1)).toBeCloseTo(5, 6);
  });

  it('says nothing at all when no cache was used', () => {
    repo.upsertMany([record({ id: 'a', inputTokens: M, outputTokens: M })]);
    const report = service.counterfactual({}, 'all time', ['claude-opus-5']);
    expect(report.noCache).toEqual([]);
    expect(report.caveats.join(' ')).not.toContain('no-cache figures');
  });

  it('states the assumption that lets it claim a saving at all', () => {
    repo.upsertMany([record({ id: 'a', cacheReadTokens: M })]);
    const report = service.counterfactual({}, 'all time', ['claude-opus-5']);
    expect(report.caveats.join(' ')).toContain('cache-read tokens ARE the context');
    expect(report.caveats.join(' ')).toContain('same requests carrying the same context');
  });

  it('skips a model the table cannot price rather than guessing', () => {
    repo.upsertMany([record({ id: 'a', model: 'big-pickle', cacheReadTokens: M })]);
    expect(service.counterfactual({}, 'all time', ['claude-opus-5']).noCache).toEqual([]);
  });
});
