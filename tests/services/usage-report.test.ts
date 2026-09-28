import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { UsageService } from '../../src/services/usage-service.js';
import { openSqlite } from '../../src/db/driver.js';
import { formatUsageReport } from '../../src/services/formatter.js';
import {
  assistantLine,
  buildClaudeProjects,
  buildOpenCodeDb,
  tempDir,
  type ClaudeLine,
} from '../fixtures/build-fixtures.js';

const MIN = 60_000;

/** One Claude Code turn at `at` ms ago, on a branch. */
function turn(
  sessionId: string,
  i: number,
  at: number,
  cacheRead: number,
  cacheWrite: number,
  gitBranch: string,
): ClaudeLine {
  return {
    ...assistantLine({
      sessionId,
      requestId: `${sessionId}-r${i}`,
      messageId: `${sessionId}-m${i}`,
      timestamp: new Date(Date.now() - at).toISOString(),
      output: 200,
      cacheRead,
      cacheWrite5m: cacheWrite,
      stopReason: 'end_turn',
    }),
    gitBranch,
  };
}

let dir: string | undefined;
let service: UsageService | undefined;

afterEach(() => {
  service?.close();
  delete process.env.AI_USAGE_CLAUDE_PROJECTS;
  delete process.env.AI_USAGE_OPENCODE_DB;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  service = undefined;
});

async function open(sessions: { sessionId: string; lines: ClaudeLine[] }[]): Promise<UsageService> {
  dir = tempDir('usage-report-');
  process.env.AI_USAGE_CLAUDE_PROJECTS = buildClaudeProjects(dir, [
    { slug: '-work-project-one', sessions },
  ]);
  process.env.AI_USAGE_OPENCODE_DB = buildOpenCodeDb(dir, {
    sessions: [
      { id: 'oc-placeholder', title: 'New session - 2026-09-01T10:00:00.000Z' },
      { id: 'oc-titled', title: 'Fix the login redirect' },
    ],
    messages: [],
  });
  service = UsageService.open({ dbPath: join(dir, 'usage.db') });
  await service.sync();
  return service;
}

/**
 * A long session: warm turns re-reading a 150k+ context, then a 40-minute break
 * after which the cache is gone and the whole context is re-written.
 */
function bigSession(): { sessionId: string; lines: ClaudeLine[] } {
  const lines: ClaudeLine[] = [
    { type: 'ai-title', aiTitle: 'Early working title', sessionId: 'big' },
  ];
  for (let i = 0; i < 6; i++) {
    lines.push(turn('big', i, 120 * MIN - i * MIN, 150_000 + i * 1_000, 1_000, 'feat/a'));
  }
  lines.push(turn('big', 6, 60 * MIN, 0, 157_000, 'feat/a'));
  lines.push({ type: 'ai-title', aiTitle: 'Refactor the tariff service', sessionId: 'big' });
  return { sessionId: 'big', lines };
}

function smallSession(): { sessionId: string; lines: ClaudeLine[] } {
  const lines: ClaudeLine[] = [];
  for (let i = 0; i < 4; i++) lines.push(turn('small', i, 30 * MIN - i * MIN, 20_000, 500, 'main'));
  return { sessionId: 'small', lines };
}

describe('usage report', () => {
  it('measures context carry and cache rebuilds, and says what to change', async () => {
    const s = await open([bigSession(), smallSession()]);
    const report = s.usageReport();

    expect(report.period).toContain('last 7 days');
    expect(report.turns).toBe(11);
    expect(report.sessions).toBe(2);

    // Carry: the part of each turn's cache read above 100k, priced as a cache read.
    const table = s.costService.table;
    const price = table.models['claude-opus-5']!;
    const read = (price.cache ?? table.cacheMultipliers).read;
    let carried = 0;
    for (let i = 0; i < 6; i++) {
      const cacheRead = 150_000 + i * 1_000;
      const context = cacheRead + 1_000;
      carried += Math.min(cacheRead, context - 100_000);
    }
    expect(report.contextCarry.estimatedCost).toBeCloseTo(
      (carried / 1_000_000) * price.input * read,
      10,
    );
    expect(report.contextCarry.turns).toBe(7);

    expect(report.cacheRebuilds.count).toBe(1);
    expect(report.cacheRebuilds.afterIdle).toBe(1);
    expect(report.wasteShare).toBeCloseTo(
      report.contextCarry.share + report.cacheRebuilds.share,
      10,
    );
    expect(report.verdict).not.toBe('healthy');
    expect(report.fixes.join('\n')).toMatch(/Compact earlier/);
    expect(report.fixes.join('\n')).toMatch(/gone cold/);
  });

  it('names sessions by their own title and branch, latest title winning', async () => {
    const s = await open([bigSession(), smallSession()]);
    const report = s.usageReport();

    const top = report.topSessions[0]!;
    expect(top.sessionId).toBe('big');
    expect(top.title).toBe('Refactor the tariff service');
    expect(top.gitBranch).toBe('feat/a');
    expect(report.topBranches.map((b) => b.gitBranch)).toEqual(['feat/a', 'main']);

    const text = formatUsageReport(report);
    expect(text).toContain('Refactor the tariff service');
    expect(text).toContain('feat/a');
  });

  it('calls a period of small, cheap sessions healthy', async () => {
    const s = await open([smallSession()]);
    const report = s.usageReport();
    expect(report.verdict).toBe('healthy');
    expect(report.wasteShare).toBe(0);
    expect(report.fixes).toEqual([
      'Nothing significant to fix: little of this period went to carrying old context.',
    ]);
  });

  it('says there is nothing to weigh rather than calling an empty period healthy', async () => {
    const s = await open([smallSession()]);
    const report = s.usageReport({ since: '2020-01-01T00:00:00Z', until: '2020-01-02T00:00:00Z' });
    expect(report.verdict).toBe('no-data');
    expect(formatUsageReport(report)).toContain('nothing to weigh');
  });
});

describe('session titles and branches', () => {
  it('shows them on sessions, and skips OpenCode placeholder titles', async () => {
    const s = await open([bigSession()]);

    const detail = s.sessionUsage('big');
    if (!detail || 'ambiguous' in detail) throw new Error('session not resolved');
    expect(detail.session.title).toBe('Refactor the tariff service');
    expect(detail.session.gitBranch).toBe('feat/a');

    const db = openSqlite(join(dir!, 'usage.db'), { readonly: true });
    try {
      const titles = db
        .prepare("SELECT session_id, title FROM session_titles WHERE client = 'opencode'")
        .all() as { session_id: string; title: string }[];
      expect(titles).toEqual([{ session_id: 'oc-titled', title: 'Fix the login redirect' }]);
    } finally {
      db.close();
    }
  });
});
