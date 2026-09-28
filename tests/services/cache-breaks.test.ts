import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TurnRow } from '../../src/db/repositories/usage-repository.js';
import { detectCacheBreaks } from '../../src/services/cache-breaks.js';
import { UsageService } from '../../src/services/usage-service.js';
import { assistantLine, buildClaudeProjects, tempDir } from '../fixtures/build-fixtures.js';

const T0 = Date.parse('2026-09-01T10:00:00Z');

let seq = 0;
function turn(overrides: Partial<TurnRow> & { at?: number } = {}): TurnRow {
  const { at, ...rest } = overrides;
  seq += 1;
  return {
    id: `t${seq}`,
    client: 'claude-code',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    sessionId: 's',
    timestamp: new Date(T0 + (at ?? seq) * 10_000).toISOString(),
    turnKind: 'main',
    inputTokens: 5,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costBasis: 'estimated',
    ...rest,
  };
}

/** A warm session: each turn reads the growing prefix and writes ~500 new tokens. */
function warm(count: number, prefix = 40_000, extra: Partial<TurnRow> = {}): TurnRow[] {
  return Array.from({ length: count }, (_, i) =>
    turn({ cacheReadTokens: prefix + i * 500, cacheWriteTokens: 500, ...extra }),
  );
}

describe('detectCacheBreaks', () => {
  it('flags a write spike whose prefix was not read back', () => {
    const turns = [...warm(6), turn({ cacheReadTokens: 0, cacheWriteTokens: 43_000 })];
    const breaks = detectCacheBreaks(turns);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({ turnIndex: 6, writeSpikeRatio: 86, baselineWriteAvg: 500 });
    expect(breaks[0]!.previousPrefixTokens).toBe(40_000 + 5 * 500 + 500);
  });

  it('does not flag a large new file read that reused the whole prefix', () => {
    // The false positive a write-only detector reports: 30k new tokens written,
    // but the 43k prefix was read back in full, so nothing was invalidated.
    const turns = [...warm(6), turn({ cacheReadTokens: 43_000, cacheWriteTokens: 30_000 })];
    expect(detectCacheBreaks(turns)).toEqual([]);
  });

  it('flags a spike over a zero baseline instead of skipping it', () => {
    const turns = [
      ...warm(6, 40_000, { cacheWriteTokens: 0 }),
      turn({ cacheReadTokens: 0, cacheWriteTokens: 42_000 }),
    ];
    expect(detectCacheBreaks(turns)).toHaveLength(1);
  });

  it('baselines subagent turns separately from main turns', () => {
    // A subagent starts cold and reads nothing of the main prefix. Mixed into one
    // stream, every switch between the two would look like an invalidation.
    const turns: TurnRow[] = [];
    for (let i = 0; i < 8; i++) {
      turns.push(turn({ cacheReadTokens: 40_000 + i * 500, cacheWriteTokens: 500 }));
      turns.push(
        turn({ turnKind: 'subagent', cacheReadTokens: 8_000 + i * 300, cacheWriteTokens: 300 }),
      );
    }
    expect(detectCacheBreaks(turns)).toEqual([]);
  });

  it('respects the minimum write size and the spike threshold', () => {
    const small = [...warm(6), turn({ cacheReadTokens: 0, cacheWriteTokens: 4_000 })];
    expect(detectCacheBreaks(small)).toEqual([]);
    const big = [...warm(6), turn({ cacheReadTokens: 0, cacheWriteTokens: 43_000 })];
    expect(detectCacheBreaks(big, { spikeThreshold: 100 })).toEqual([]);
    expect(detectCacheBreaks(big, { minCacheWrites: 50_000 })).toEqual([]);
  });

  it('needs a full baseline window before flagging anything', () => {
    const turns = [...warm(3), turn({ cacheReadTokens: 0, cacheWriteTokens: 43_000 })];
    expect(detectCacheBreaks(turns)).toEqual([]);
    expect(detectCacheBreaks(turns, { baselineWindow: 3 })).toHaveLength(1);
  });

  it('names the likely cause', () => {
    const cold = { cacheReadTokens: 0, cacheWriteTokens: 43_000 };
    const idle = [...warm(6), turn({ ...cold, at: seq + 60 })];
    expect(detectCacheBreaks(idle)[0]!.explanation).toMatch(/minutes idle.*5-minute/);

    const switched = [...warm(6), turn({ ...cold, model: 'claude-opus-4-1' })];
    expect(detectCacheBreaks(switched)[0]!.explanation).toMatch(/model switched/);

    const edited = [...warm(6), turn(cold)];
    expect(detectCacheBreaks(edited)[0]!.explanation).toMatch(/early in the context changed/);
  });

  it('leaves the cost absent, not zero, when the pricer cannot price the model', () => {
    const turns = [...warm(6), turn({ cacheReadTokens: 0, cacheWriteTokens: 43_000 })];
    const [br] = detectCacheBreaks(turns, {}, () => undefined);
    expect(br).toBeDefined();
    expect(br!.estimatedExtraCost).toBeUndefined();
    expect('estimatedExtraCost' in br!).toBe(false);
  });
});

describe('UsageService.cacheHealth', () => {
  let dir: string | undefined;
  let service: UsageService | undefined;

  afterEach(() => {
    service?.close();
    delete process.env.AI_USAGE_CLAUDE_PROJECTS;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('prices a break as the write premium from the pricing table', async () => {
    dir = tempDir('cache-breaks-');
    const lines = [];
    for (let i = 0; i < 6; i++) {
      lines.push(
        assistantLine({
          sessionId: 'cache-sess',
          requestId: `r${i}`,
          messageId: `m${i}`,
          timestamp: new Date(T0 + i * 10_000).toISOString(),
          output: 100,
          cacheRead: 40_000 + i * 500,
          cacheWrite5m: 500,
          stopReason: 'end_turn',
        }),
      );
    }
    lines.push(
      assistantLine({
        sessionId: 'cache-sess',
        requestId: 'r-break',
        messageId: 'm-break',
        timestamp: new Date(T0 + 70_000).toISOString(),
        output: 100,
        cacheWrite5m: 43_000,
        stopReason: 'end_turn',
      }),
    );
    process.env.AI_USAGE_CLAUDE_PROJECTS = buildClaudeProjects(dir, [
      { slug: '-work-cache', sessions: [{ sessionId: 'cache-sess', lines }] },
    ]);
    service = UsageService.open({ dbPath: join(dir, 'usage.db') });
    await service.sync();

    const report = service.cacheHealth('cache-sess');
    if (!report || 'ambiguous' in report) throw new Error('session not resolved');
    expect(report.includeSubagents).toBe(false);
    expect(report.breaks).toHaveLength(1);

    const model = report.breaks[0]!.model;
    const table = service.costService.table;
    const price = table.models[model];
    expect(price).toBeDefined();
    const { read, write5m } = price!.cache ?? table.cacheMultipliers;
    const expected = (43_000 / 1_000_000) * price!.input * (write5m - read);
    expect(report.breaks[0]!.estimatedExtraCost).toBeCloseTo(expected, 10);
    expect(report.summary.estimatedExtraCost).toBeCloseTo(expected, 10);
    expect(report.summary.unpricedBreaks).toBe(0);
  });
});
