import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabase } from '../../src/db/driver.js';
import { openDatabase } from '../../src/db/database.js';
import { UsageRepository } from '../../src/db/repositories/usage-repository.js';
import { PlanLimitRepository } from '../../src/db/repositories/plan-limit-repository.js';
import { parseStatusLineInput } from '../../src/collectors/claude-code/statusline.js';
import { PlanLimitService } from '../../src/services/plan-limit-service.js';
import { UsageService } from '../../src/services/usage-service.js';
import { CostService } from '../../src/services/cost-service.js';
import { formatPlanUsage, formatStatusLine } from '../../src/services/formatter.js';
import type { UsageRecord } from '../../src/models/usage-record.js';
import { emptyCostTotals, emptyTokenTotals } from '../../src/models/usage-record.js';
import type { AggregateRow } from '../../src/db/repositories/usage-repository.js';
import { assistantLine, buildClaudeProjects, tempDir } from '../fixtures/build-fixtures.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = new Date('2026-10-12T12:00:00.000Z');

/** The status-line payload, shaped as Claude Code documents it. */
function payload(
  fiveHour?: { pct: number; resetsAt: Date },
  sevenDay?: { pct: number; resetsAt: Date },
  extra: Record<string, unknown> = {},
): string {
  const rateLimits: Record<string, unknown> = {};
  if (fiveHour)
    rateLimits.five_hour = {
      used_percentage: fiveHour.pct,
      resets_at: Math.floor(fiveHour.resetsAt.getTime() / 1000),
    };
  if (sevenDay)
    rateLimits.seven_day = {
      used_percentage: sevenDay.pct,
      resets_at: Math.floor(sevenDay.resetsAt.getTime() / 1000),
    };
  return JSON.stringify({
    session_id: 'sess-1',
    version: '2.9.0',
    ...(fiveHour || sevenDay ? { rate_limits: rateLimits } : {}),
    ...extra,
  });
}

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'r1',
    client: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-5',
    sessionId: 's1',
    projectPath: '/work/one',
    timestamp: new Date(NOW.getTime() - HOUR).toISOString(),
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 300,
    cacheWriteTokens: 40,
    reasoningTokens: 0,
    totalTokens: 370,
    estimatedCost: 1.5,
    costBasis: 'estimated',
    currency: 'USD',
    turnKind: 'main',
    source: 'test',
    ...overrides,
  };
}

function row(overrides: Partial<AggregateRow> = {}): AggregateRow {
  return {
    ...emptyTokenTotals(),
    records: 0,
    sessions: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cost: emptyCostTotals(),
    ...overrides,
  };
}

describe('parseStatusLineInput', () => {
  it('reads both windows, the session and the version', () => {
    const resets = new Date('2026-10-12T14:00:00.000Z');
    const input = parseStatusLineInput(
      payload({ pct: 23.5, resetsAt: resets }, { pct: 41, resetsAt: resets }),
    );
    expect(input.sessionId).toBe('sess-1');
    expect(input.version).toBe('2.9.0');
    expect(input.readings).toEqual([
      { window: 'five_hour', usedPercent: 23.5, resetsAt: resets.toISOString() },
      { window: 'seven_day', usedPercent: 41, resetsAt: resets.toISOString() },
    ]);
  });

  it('has no readings for an API-key user, whose payload carries no rate_limits', () => {
    const input = parseStatusLineInput(payload());
    expect(input.readings).toEqual([]);
    expect(input.sessionId).toBe('sess-1');
  });

  it('never throws on input it cannot read', () => {
    for (const raw of ['', 'not json', '[]', 'null', '42', '{"rate_limits": "x"}']) {
      expect(parseStatusLineInput(raw).readings).toEqual([]);
    }
  });

  it('drops a malformed window without losing the other', () => {
    const resets = Math.floor(new Date('2026-10-12T14:00:00Z').getTime() / 1000);
    const input = parseStatusLineInput(
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 140, resets_at: resets },
          seven_day: { used_percentage: 12, resets_at: resets },
        },
      }),
    );
    expect(input.readings.map((r) => r.window)).toEqual(['seven_day']);
  });

  it('rejects a reset given in milliseconds rather than seconds', () => {
    const input = parseStatusLineInput(
      JSON.stringify({
        rate_limits: { five_hour: { used_percentage: 5, resets_at: NOW.getTime() * 1000 } },
      }),
    );
    expect(input.readings).toEqual([]);
  });
});

describe('PlanLimitService', () => {
  let dir: string;
  let db: SqliteDatabase;
  let limits: PlanLimitRepository;
  let usage: UsageRepository;
  let service: PlanLimitService;

  beforeEach(() => {
    dir = tempDir('plan-limits-');
    db = openDatabase({ path: join(dir, 'usage.db') });
    limits = new PlanLimitRepository(db);
    usage = new UsageRepository(db);
    service = new PlanLimitService(limits, usage);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

  function feed(offsetMs: number, fivePct: number, resetsAt = at(2 * HOUR)): void {
    service.record(parseStatusLineInput(payload({ pct: fivePct, resetsAt })), at(offsetMs));
  }

  it('reports unavailable, not 0%, before any reading', () => {
    const report = service.report({}, NOW);
    expect(report.noReadings).toBe(true);
    expect(report.windows.every((w) => w.state === 'none')).toBe(true);
    expect(report.caveats[0]).toContain('UNAVAILABLE -- not 0%');
  });

  it('stores a repeat of the same reading as one row, moving only its last-seen time', () => {
    feed(-30 * MIN, 10);
    feed(-20 * MIN, 10);
    feed(-10 * MIN, 10);
    const all = limits.since('claude-code', 'five_hour', '1970-01-01T00:00:00.000Z');
    expect(all).toHaveLength(1);
    expect(all[0]!.observedAt).toBe(at(-30 * MIN).toISOString());
    expect(all[0]!.lastSeenAt).toBe(at(-10 * MIN).toISOString());
    expect(all[0]!.sourceVersion).toBe('2.9.0');
  });

  it('reports the latest reading, the window start, and local turns since it', () => {
    usage.upsertMany([
      record({ id: 'in-window', timestamp: at(-1 * HOUR).toISOString() }),
      // Before the window began (reset - 5h = NOW - 3h): not counted.
      record({ id: 'before-window', timestamp: at(-4 * HOUR).toISOString() }),
      // Another client's turns do not count against a Claude plan.
      record({
        id: 'opencode',
        client: 'opencode',
        timestamp: at(-1 * HOUR).toISOString(),
        cost: 0.5,
        estimatedCost: undefined,
        costBasis: 'reported',
      }),
    ]);
    feed(-5 * MIN, 30);

    const w = service.report({}, NOW).windows.find((x) => x.window === 'five_hour')!;
    expect(w.state).toBe('current');
    expect(w.latest?.usedPercent).toBe(30);
    expect(w.windowStart).toBe(at(-3 * HOUR).toISOString());
    expect(w.local?.records).toBe(1);
    expect(w.local?.cost.estimated).toBe(1.5);
    expect(w.pace).toBeUndefined();
  });

  it('says the window has reset, and does not claim 0%, once the reset time passes', () => {
    feed(-3 * HOUR, 80, at(-1 * HOUR));
    const w = service.report({}, NOW).windows.find((x) => x.window === 'five_hour')!;
    expect(w.state).toBe('reset');
    expect(w.local).toBeUndefined();
    const text = formatPlanUsage(service.report({}, NOW), new CostService());
    expect(text).toContain('usage in the new window is unknown -- not 0%');
  });

  it('projects 100% before the reset when the pace gets there first', () => {
    // 20% -> 60% over one hour: 40%/h. 40% left -> one more hour, before the
    // reset two hours out.
    feed(-60 * MIN, 20);
    feed(0, 60);
    const pace = service.report({}, NOW).windows.find((x) => x.window === 'five_hour')!.pace!;
    expect(pace.percentPerHour).toBeCloseTo(40);
    expect(pace.readings).toBe(2);
    expect(pace.reachesFullAt).toBe(at(HOUR).toISOString());
    expect(pace.fullBeforeReset).toBe(true);
  });

  it('measures pace to when the reading was last seen, not when it last changed', () => {
    // 20% -> 60% by -60min, then unchanged for another hour: 20%/h, not 40%/h.
    feed(-120 * MIN, 20, at(3 * HOUR));
    feed(-60 * MIN, 60, at(3 * HOUR));
    feed(0, 60, at(3 * HOUR));
    const pace = service.report({}, NOW).windows.find((x) => x.window === 'five_hour')!.pace!;
    expect(pace.percentPerHour).toBeCloseTo(20);
    // 40% left at 20%/h is two more hours: NOW + 2h, still before the reset at NOW + 3h.
    expect(pace.reachesFullAt).toBe(at(2 * HOUR).toISOString());
    expect(pace.fullBeforeReset).toBe(true);
  });

  it('says the reset comes first when the pace is slow', () => {
    feed(-60 * MIN, 20);
    feed(0, 25);
    const pace = service.report({}, NOW).windows.find((x) => x.window === 'five_hour')!.pace!;
    expect(pace.percentPerHour).toBeCloseTo(5);
    expect(pace.fullBeforeReset).toBe(false);
  });

  it('gives no 100% time when usage is not rising', () => {
    feed(-60 * MIN, 50);
    feed(-30 * MIN, 40);
    const pace = service.report({}, NOW).windows.find((x) => x.window === 'five_hour')!.pace!;
    expect(pace.percentPerHour).toBe(0);
    expect(pace.reachesFullAt).toBeUndefined();
    expect(pace.fullBeforeReset).toBe(false);
  });

  it('computes no pace from readings too close together to mean anything', () => {
    feed(-2 * MIN, 20);
    feed(0, 30);
    const w = service.report({}, NOW).windows.find((x) => x.window === 'five_hour')!;
    expect(w.pace).toBeUndefined();
  });

  it("never measures pace across a reset, from the previous window's readings", () => {
    // The previous window ended at NOW - 30min, at 90%. The new one starts low.
    feed(-90 * MIN, 85, at(-30 * MIN));
    feed(-60 * MIN, 90, at(-30 * MIN));
    feed(-20 * MIN, 5, at(4.5 * HOUR));
    feed(0, 10, at(4.5 * HOUR));
    const pace = service.report({}, NOW).windows.find((x) => x.window === 'five_hour')!.pace!;
    expect(pace.readings).toBe(2);
    expect(pace.percentPerHour).toBeCloseTo(15);
  });
});

describe('formatStatusLine', () => {
  const today = row({
    records: 3,
    cost: { ...emptyCostTotals(), estimated: 12.4, estimatedRecords: 2 },
  });

  it('shows each current window, today, and the session cache', () => {
    const line = formatStatusLine(
      {
        limits: [
          { window: 'five_hour', usedPercent: 23.5, resetsAt: '2026-10-12T14:20:00.000Z' },
          { window: 'seven_day', usedPercent: 41, resetsAt: '2026-10-15T09:00:00.000Z' },
        ],
        today,
        session: { hitRate: 0.964, breakCount: 2, estimatedExtraCost: 1.1 },
      },
      { now: NOW },
    );
    expect(line).toMatch(/^5h 23\.5% ↻\d\d:\d\d · wk 41% ↻\w{3} \d\d:\d\d · /);
    expect(line).toContain('today $12.40 API-eq');
    expect(line).toContain('cache 96% 2 breaks +$1.10 API-eq');
    expect(line).not.toContain('\x1b[');
  });

  it('never presents reported and estimated cost as one figure', () => {
    const line = formatStatusLine({
      limits: [],
      today: row({
        records: 3,
        cost: {
          ...emptyCostTotals(),
          estimated: 12.4,
          estimatedRecords: 2,
          reported: 0.5,
          reportedRecords: 1,
        },
      }),
    });
    expect(line).toBe('today $12.40 API-eq, $0.50 reported');
  });

  it('says there are no turns rather than showing $0.00', () => {
    expect(formatStatusLine({ limits: [], today: row() })).toBe('today: no turns yet');
  });

  it('colours a limit past 90% red and a projected run-out', () => {
    const line = formatStatusLine(
      {
        limits: [
          {
            window: 'five_hour',
            usedPercent: 92,
            resetsAt: '2026-10-12T14:20:00.000Z',
            fullAt: '2026-10-12T13:00:00.000Z',
          },
        ],
        today,
      },
      { color: true, now: NOW },
    );
    expect(line).toContain('\x1b[31m92%\x1b[0m');
    expect(line).toContain('\x1b[31m100% by ');
  });
});

describe('UsageService status line', () => {
  let dir: string;
  let service: UsageService;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = tempDir('statusline-');
    // Hermetic: one Claude Code session of our own, and no OpenCode.
    process.env.AI_USAGE_OPENCODE_DB = join(dir, 'missing-opencode.db');
    process.env.AI_USAGE_CLAUDE_PROJECTS = buildClaudeProjects(dir, [
      {
        slug: '-work-one',
        sessions: [
          {
            sessionId: 'cc-1',
            lines: [
              assistantLine({
                sessionId: 'cc-1',
                requestId: 'r1',
                messageId: 'm1',
                input: 10,
                output: 50,
                cacheRead: 9000,
                cwd: '/work/one',
                timestamp: new Date(Date.now() - MIN).toISOString(),
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
    ]);
    service = UsageService.open({ dbPath: join(dir, 'usage.db') });
  });

  afterEach(() => {
    service.close();
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the payload, and shows only windows that have not reset', () => {
    const now = new Date();
    const raw = payload(
      { pct: 40, resetsAt: new Date(now.getTime() + HOUR) },
      // A weekly reading whose reset has already passed: left out, not shown as 0%.
      { pct: 90, resetsAt: new Date(now.getTime() - MIN) },
    );
    expect(service.recordStatusLine(raw, now)).toEqual({ sessionId: 'sess-1', written: 2 });
    expect(service.recordStatusLine(raw, now).written).toBe(0);

    const report = service.statusLine('sess-1', now);
    expect(report.limits.map((l) => [l.window, l.usedPercent])).toEqual([['five_hour', 40]]);
    // Nothing synced yet, and no turns stored for that session, so nothing is
    // claimed about its cache.
    expect(report.today.records).toBe(0);
    expect(report.session).toBeUndefined();
  });

  it("shows today's turns and the rendered session's cache once synced", async () => {
    await service.sync();
    const report = service.statusLine('cc-1');
    expect(report.today.records).toBe(1);
    expect(report.session?.breakCount).toBe(0);
    expect(report.session?.hitRate).toBeGreaterThan(0.99);
  });

  it('syncs only when the last sync is older than the freshness window', async () => {
    expect(await service.syncIfStale(60_000)).toBe(true);
    expect(await service.syncIfStale(60_000)).toBe(false);
    expect(await service.syncIfStale(0)).toBe(true);
  });
});
