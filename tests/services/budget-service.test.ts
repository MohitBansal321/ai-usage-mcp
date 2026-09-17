import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabase } from '../../src/db/driver.js';
import { openDatabase } from '../../src/db/database.js';
import { UsageRepository } from '../../src/db/repositories/usage-repository.js';
import type { UsageRecord } from '../../src/models/usage-record.js';
import { BudgetService, budgetWindow } from '../../src/services/budget-service.js';
import { tempDir } from '../fixtures/build-fixtures.js';

/** Local components, because every budget window is a LOCAL calendar period. */
function local(day: number, hour = 12): Date {
  return new Date(2026, 5, day, hour, 0, 0, 0); // June 2026: 30 days.
}

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'r1',
    client: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-5',
    sessionId: 's1',
    projectPath: '/work/one',
    timestamp: local(1).toISOString(),
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 10,
    estimatedCost: 10,
    costBasis: 'estimated',
    currency: 'USD',
    turnKind: 'main',
    source: 'test',
    ...overrides,
  };
}

describe('budgetWindow', () => {
  it('spans a whole local calendar month', () => {
    const { since, until, label } = budgetWindow('month', local(17));
    expect(since.getDate()).toBe(1);
    expect(since.getMonth()).toBe(5);
    expect(until.getMonth()).toBe(6);
    expect(until.getDate()).toBe(1);
    expect(label).toContain('June 2026');
  });

  it('starts a week on Monday, including when today is Sunday', () => {
    // getDay() calls Sunday 0, so a naive subtraction puts Sunday at the START
    // of the coming week rather than the end of the one it belongs to.
    const sunday = new Date(2026, 5, 21, 12, 0, 0, 0);
    expect(sunday.getDay()).toBe(0);
    const { since, until } = budgetWindow('week', sunday);
    expect(since.getDay()).toBe(1);
    expect(since.getDate()).toBe(15);
    expect(until.getDate()).toBe(22);
  });
});

describe('BudgetService', () => {
  let dir: string;
  let db: SqliteDatabase;
  let service: BudgetService;
  let repo: UsageRepository;

  beforeEach(() => {
    dir = tempDir('budget-');
    db = openDatabase({ path: join(dir, 'usage.db') });
    repo = new UsageRepository(db);
    service = new BudgetService(repo);
    // $10 on each of three separate days, inside June 2026.
    repo.upsertMany([
      record({ id: 'a', timestamp: local(1).toISOString() }),
      record({ id: 'b', timestamp: local(2).toISOString() }),
      record({ id: 'c', timestamp: local(3).toISOString() }),
    ]);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (amount: number, now: Date, basis: 'reported' | 'estimated' = 'estimated') =>
    service.budget({ amount, basis, period: 'month', now });

  it('reports spend against the target on the chosen basis only', () => {
    const report = run(100, local(6, 0));
    expect(report.spent).toBe(30);
    expect(report.remaining).toBe(70);
    expect(report.fractionUsed).toBeCloseTo(0.3, 9);
    expect(report.overBudget).toBe(false);
  });

  it('never blends the two bases', () => {
    repo.upsertMany([
      record({ id: 'rep', cost: 500, estimatedCost: undefined, costBasis: 'reported' }),
    ]);
    // The reported $500 must not touch the estimated figure, or vice versa.
    expect(run(100, local(6, 0), 'estimated').spent).toBe(30);
    expect(run(100, local(6, 0), 'reported').spent).toBe(500);
  });

  it('counts elapsed time in PARTIAL days, not whole ones', () => {
    // A projection made at noon on the 6th that pretends 5 days have passed
    // overstates the rate by a tenth.
    const report = run(100, local(6, 12));
    expect(report.elapsed.days).toBeCloseTo(5.5, 6);
    expect(report.elapsed.totalDays).toBe(30);
    expect(report.elapsed.fraction).toBeCloseTo(5.5 / 30, 6);
  });

  it('projects on two denominators, and they genuinely differ', () => {
    const report = run(100, local(6, 0));

    // $30 over 5 elapsed calendar days = $6/day -> $180 for a 30-day month.
    expect(report.projections.perCalendarDay.days).toBeCloseTo(5, 6);
    expect(report.projections.perCalendarDay.ratePerDay).toBeCloseTo(6, 6);
    expect(report.projections.perCalendarDay.projected).toBeCloseTo(180, 6);

    // $30 over 3 ACTIVE days = $10/day -> $300. The gap is the assumption.
    expect(report.activeDays).toBe(3);
    expect(report.projections.perActiveDay.ratePerDay).toBeCloseTo(10, 6);
    expect(report.projections.perActiveDay.projected).toBeCloseTo(300, 6);
  });

  it('flags only the projections that actually exceed the budget', () => {
    const report = run(200, local(6, 0));
    // $180 projected on calendar pace is within $200; $300 on active pace is not.
    expect(report.projections.perCalendarDay.overBy).toBeUndefined();
    expect(report.projections.perActiveDay.overBy).toBeCloseTo(100, 6);
  });

  it('is over budget on spend, not on a forecast', () => {
    // $30 spent against a $25 budget: a fact.
    expect(run(25, local(6, 0)).overBudget).toBe(true);
    // $30 spent against $100, projecting to $300: over on the forecast only,
    // which is a claim about the future and must not read as a breach.
    expect(run(100, local(6, 0)).overBudget).toBe(false);
  });

  it('does not project from no elapsed time', () => {
    // At the very first instant of the period there is no rate to project from,
    // and "$0, on track" would be a claim about the future made from no data.
    const report = service.budget({
      amount: 100,
      basis: 'estimated',
      period: 'month',
      now: new Date(2026, 5, 1, 0, 0, 0, 0),
    });
    expect(report.elapsed.days).toBe(0);
    expect(report.projections.perCalendarDay.ratePerDay).toBe(0);
    expect(report.projections.perCalendarDay.projected).toBe(0);
  });

  it('ignores spend outside the budget period', () => {
    repo.upsertMany([
      record({ id: 'may', timestamp: new Date(2026, 4, 20, 12).toISOString() }),
      record({ id: 'jul', timestamp: new Date(2026, 6, 2, 12).toISOString() }),
    ]);
    expect(run(100, local(6, 0)).spent).toBe(30);
  });

  it('always explains the two denominators', () => {
    expect(run(100, local(6, 0)).caveats.join(' ')).toContain('different denominators');
  });

  it('says an estimated budget is a shadow price, not a bill', () => {
    const caveats = run(100, local(6, 0), 'estimated').caveats.join(' ');
    expect(caveats).toContain('Pro or Max');
    expect(caveats).toContain('$0');
  });

  it('says a reported budget excludes Claude Code entirely', () => {
    const caveats = run(100, local(6, 0), 'reported').caveats.join(' ');
    expect(caveats).toContain('Claude Code reports no cost');
  });

  it('warns when $0 means "nothing measured" rather than "nothing spent"', () => {
    // Every record here is estimated, so the reported basis sees $0 -- which
    // would otherwise read as comfortably under budget.
    const report = run(100, local(6, 0), 'reported');
    expect(report.spent).toBe(0);
    expect(report.caveats.join(' ')).toContain('nothing was measured on this basis');
  });
});
