import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openSqlite } from '../../src/db/driver.js';
import { UsageService } from '../../src/services/usage-service.js';
import {
  buildCodexHome,
  CODEX_SESSION,
  codexRealSessionLines,
  codexRolloutName,
  codexSessionMeta,
  codexTokenCount,
  codexTurnContext,
  codexUsage,
  tempDir,
} from '../fixtures/build-fixtures.js';

const OTHER_SESSION = '019ff4a1-8f65-7de0-b9aa-4150332411d3';

/**
 * Two sessions in the shapes the two verified CLI versions write: 0.162's, with
 * a token_usage_record before each token_count, and 0.114's, which has none but
 * repeats token_count with an unchanged running total.
 */
function repeatingSession(): ReturnType<typeof codexRealSessionLines> {
  const a = codexUsage({ input: 11176, cached: 7040, output: 187, reasoning: 42 });
  const b = codexUsage({ input: 11424, cached: 10624, output: 204, reasoning: 56 });
  const ab = codexUsage({ input: 22600, cached: 17664, output: 391, reasoning: 98 });
  return [
    codexSessionMeta({ sessionId: OTHER_SESSION, cliVersion: '0.114.0', branch: 'dev' }),
    codexTurnContext({ model: 'gpt-5.4' }),
    codexTokenCount({ timestamp: '2026-08-12T06:21:47.710Z', noInfo: true }),
    codexTokenCount({ timestamp: '2026-08-12T06:21:51.772Z', total: a, last: a }),
    codexTokenCount({ timestamp: '2026-08-12T06:21:54.690Z', total: a, last: a }),
    codexTokenCount({ timestamp: '2026-08-12T06:21:58.767Z', total: ab, last: b }),
    codexTokenCount({ timestamp: '2026-08-12T06:22:01.000Z', total: ab, last: b }),
  ];
}

describe('verify: Codex', () => {
  let dir: string;
  let service: UsageService;
  const isolated = process.env.AI_USAGE_CODEX_HOME;

  beforeEach(() => {
    dir = tempDir('verify-codex-');
    process.env.AI_USAGE_CODEX_HOME = buildCodexHome(dir, [
      { sessionId: CODEX_SESSION, lines: codexRealSessionLines() },
      { sessionId: OTHER_SESSION, day: '2026/08/12', lines: repeatingSession() },
    ]);
    process.env.AI_USAGE_OPENCODE_DB = join(dir, 'absent-opencode.db');
    process.env.AI_USAGE_CLAUDE_PROJECTS = join(dir, 'absent-projects');
    service = UsageService.open({ dbPath: join(dir, 'usage.db') });
  });

  afterEach(() => {
    service.close();
    if (isolated === undefined) delete process.env.AI_USAGE_CODEX_HOME;
    else process.env.AI_USAGE_CODEX_HOME = isolated;
    delete process.env.AI_USAGE_OPENCODE_DB;
    delete process.env.AI_USAGE_CLAUDE_PROJECTS;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reconciles with a zero delta against the running total and token_usage_record', async () => {
    await service.sync();
    const report = await service.verify({ cutoff: new Date('2026-10-23T00:00:00.000Z') });
    const codex = report.clients.find((c) => c.client === 'codex')!;
    expect(codex.available).toBe(true);
    expect(codex.ours.records).toBe(6);
    const gating = codex.grains.filter((g) => g.gating !== false);
    expect(gating).toHaveLength(2);
    for (const grain of gating) expect(grain.matches, grain.label).toBe(true);
    // The token_usage_record grain covers only the 0.162 session, and says so.
    expect(gating[1]!.snapshot.records).toBe(4);
    expect(gating[1]!.note).toContain('1 of 2 session(s)');
    expect(report.allMatch).toBe(true);
  });

  it('reconciles while a session is still writing, comparing the bytes the sync read', async () => {
    await service.sync();
    // A request Codex finishes after our sync, stamped before the cutoff.
    const rollout = join(
      process.env.AI_USAGE_CODEX_HOME!,
      'sessions/2026/08/12',
      codexRolloutName(OTHER_SESSION, '2026/08/12'),
    );
    const c = codexUsage({ input: 500, cached: 0, output: 9, reasoning: 0 });
    const abc = codexUsage({ input: 23100, cached: 17664, output: 400, reasoning: 98 });
    appendFileSync(
      rollout,
      JSON.stringify(
        codexTokenCount({ timestamp: '2026-08-12T06:23:00.000Z', total: abc, last: c }),
      ) + '\n',
    );

    const report = await service.verify({ cutoff: new Date('2026-10-23T00:00:00.000Z') });
    const codex = report.clients.find((c) => c.client === 'codex')!;
    for (const grain of codex.grains.filter((g) => g.gating !== false))
      expect(grain.matches, grain.label).toBe(true);
    expect(codex.ours.records).toBe(6);

    await service.sync();
    const after = await service.verify({ cutoff: new Date('2026-10-23T00:00:00.000Z') });
    expect(after.clients.find((c) => c.client === 'codex')!.ours.records).toBe(7);
    expect(after.allMatch).toBe(true);
  });

  it('reports no cache hit rate for a Codex session, only the cached share of input', async () => {
    // OpenAI bills no cache write, so read / (read + write) was 100% for every session.
    await service.sync();
    const health = service.cacheHealth(OTHER_SESSION);
    if (!health || 'ambiguous' in health) throw new Error('expected a cache health report');
    expect(health.hitRate).toBeUndefined();
    expect(health.readsPerWrite).toBeUndefined();
    expect(health.cachedInputShare).toBeCloseTo(17_664 / 22_600, 10);
  });

  it('shows what summing every token_count would have produced', async () => {
    await service.sync();
    const report = await service.verify({ cutoff: new Date('2026-10-23T00:00:00.000Z') });
    const naive = report.clients
      .find((c) => c.client === 'codex')!
      .grains.find((g) => g.gating === false)!;
    expect(naive.label).toContain('naive');
    // Two repeats in the 0.114-shaped session: 187 + 187 + 204 + 204 output there.
    expect(naive.snapshot.outputTokens).toBe(453 + 782);
    expect(naive.delta.outputTokens).toBe(391);
  });

  it('fails if a counted request goes missing from the database', async () => {
    // Guard against the check going vacuous.
    await service.sync();
    const db = openSqlite(join(dir, 'usage.db'));
    db.prepare("DELETE FROM usage_records WHERE client = 'codex' AND timestamp = ?").run(
      '2026-10-22T18:29:17.240Z',
    );
    db.close();
    const report = await service.verify({ cutoff: new Date('2026-10-23T00:00:00.000Z') });
    const codex = report.clients.find((c) => c.client === 'codex')!;
    expect(codex.grains.filter((g) => g.gating !== false).every((g) => !g.matches)).toBe(true);
    expect(report.allMatch).toBe(false);
  });

  it('compares only activity before the cutoff', async () => {
    await service.sync();
    const report = await service.verify({ cutoff: new Date('2026-10-22T18:29:18.000Z') });
    const codex = report.clients.find((c) => c.client === 'codex')!;
    expect(codex.grains[0]!.matches).toBe(true);
    // Two of the 0.162 session's four requests, both of the 0.114 session's.
    expect(codex.ours.records).toBe(4);
  });
});
