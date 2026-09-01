import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { UsageService } from '../../src/services/usage-service.js';
import {
  assistantLine,
  buildClaudeProjects,
  buildOpenCodeDb,
  tempDir,
} from '../fixtures/build-fixtures.js';

const DAY = 24 * 60 * 60 * 1000;

function ocAssistant(
  created: number,
  tokens: Partial<Record<string, number>>,
  model = 'big-pickle',
  cost = 0.5,
) {
  return {
    role: 'assistant',
    cost,
    modelID: model,
    providerID: 'opencode',
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cache: { read: tokens.cacheRead ?? 0, write: tokens.cacheWrite ?? 0 },
    },
    time: { created },
    path: { root: '/work/project-one' },
  };
}

describe('UsageService', () => {
  let dir: string;
  let service: UsageService;

  beforeEach(async () => {
    dir = tempDir('usage-service-');
    const now = Date.now();

    process.env.AI_USAGE_OPENCODE_DB = buildOpenCodeDb(dir, {
      sessions: [
        { id: 'oc-main', parentId: null },
        { id: 'oc-child', parentId: 'oc-main' },
      ],
      messages: [
        {
          id: 'oc-1',
          sessionId: 'oc-main',
          timeCreated: now - 1000,
          data: ocAssistant(now - 1000, { input: 1000, output: 100, cacheRead: 5000 }),
        },
        {
          id: 'oc-2',
          sessionId: 'oc-child',
          timeCreated: now - 900,
          data: ocAssistant(now - 900, { input: 200, output: 20 }),
        },
        {
          id: 'oc-old',
          sessionId: 'oc-main',
          timeCreated: now - 10 * DAY,
          data: ocAssistant(now - 10 * DAY, { input: 7777, output: 7 }),
        },
      ],
    });

    process.env.AI_USAGE_CLAUDE_PROJECTS = buildClaudeProjects(dir, [
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'cc-sess-1',
            lines: [
              assistantLine({
                sessionId: 'cc-sess-1',
                requestId: 'r1',
                messageId: 'm1',
                input: 2,
                output: 500,
                cacheRead: 100_000,
                cacheWrite1h: 1000,
                thinking: 300,
                timestamp: new Date(now - 2000).toISOString(),
                stopReason: 'end_turn',
              }),
              assistantLine({
                sessionId: 'cc-sess-1',
                requestId: 'r2',
                messageId: 'm2',
                input: 2,
                output: 100,
                cacheRead: 50_000,
                model: 'claude-sonnet-5',
                timestamp: new Date(now - 1500).toISOString(),
                stopReason: 'end_turn',
              }),
            ],
            subagents: [
              {
                name: 'agent-1',
                lines: [
                  assistantLine({
                    sessionId: 'cc-sess-1',
                    requestId: 'r3',
                    messageId: 'm3',
                    input: 1,
                    output: 50,
                    cacheRead: 10_000,
                    timestamp: new Date(now - 1200).toISOString(),
                    stopReason: 'end_turn',
                  }),
                ],
              },
            ],
          },
        ],
      },
    ]);

    service = UsageService.open({ dbPath: join(dir, 'usage.db') });
    await service.sync();
  });

  afterEach(() => {
    service.close();
    delete process.env.AI_USAGE_OPENCODE_DB;
    delete process.env.AI_USAGE_CLAUDE_PROJECTS;
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores records from both collectors', () => {
    const summary = service.summary();
    expect(summary.overall.records).toBe(6);
    expect(summary.byClient.map((c) => c.key).sort()).toEqual(['claude-code', 'opencode']);
  });

  it('keeps reported and estimated cost in separate buckets', () => {
    const summary = service.summary();
    // OpenCode reports cost; Claude Code's is estimated. They must never merge.
    expect(summary.overall.cost.reportedRecords).toBe(3);
    expect(summary.overall.cost.estimatedRecords).toBe(3);
    expect(summary.overall.cost.reported).toBeCloseTo(1.5, 6);
    expect(summary.overall.cost.estimated).toBeGreaterThan(0);
  });

  it('excludes subagent turns when asked, and includes them by default', () => {
    const withSubagents = service.summary({ includeSubagents: true });
    const withoutSubagents = service.summary({ includeSubagents: false });
    expect(withSubagents.overall.records).toBe(6);
    // one OpenCode child-session message + one Claude subagent transcript request
    expect(withoutSubagents.overall.records).toBe(4);
    expect(withSubagents.turnKinds.subagent).toBe(2);
  });

  it('applies the period filter', () => {
    const allTime = service.summary();
    const lastWeek = service.summary({ days: 7 });
    expect(allTime.overall.records).toBe(6);
    expect(lastWeek.overall.records).toBe(5);
    expect(allTime.overall.inputTokens - lastWeek.overall.inputTokens).toBe(7777);
  });

  it('breaks tokens out by class rather than blending them', () => {
    const summary = service.summary();
    const claude = summary.byClient.find((c) => c.key === 'claude-code')!;
    expect(claude.inputTokens).toBe(5);
    expect(claude.outputTokens).toBe(650);
    expect(claude.cacheReadTokens).toBe(160_000);
    expect(claude.cacheWriteTokens).toBe(1000);
    expect(claude.reasoningTokens).toBe(300);
  });

  it('reports per-model usage', () => {
    const report = service.modelUsage();
    const models = report.models.map((m) => m.key).sort();
    expect(models).toEqual(['big-pickle', 'claude-opus-5', 'claude-sonnet-5']);
  });

  it('reports per-project usage across both clients', () => {
    const report = service.projectUsage();
    expect(report.projects.map((p) => p.key)).toEqual(['/work/project-one']);
    // Both collectors resolve to the same working directory, so the project row
    // must account for every record rather than one client's share.
    const project = report.projects[0]!;
    expect(project.records).toBe(6);
    expect(project.cost.reportedRecords).toBe(3);
    expect(project.cost.estimatedRecords).toBe(3);
    expect(project.totalTokens).toBe(report.overall.totalTokens);
  });

  it('filters every report by project, and reports nothing for an unknown one', () => {
    const known = service.summary({ projectPath: '/work/project-one' });
    expect(known.overall.records).toBe(6);

    const missing = service.projectUsage({ projectPath: '/work/does-not-exist' });
    expect(missing.projects).toEqual([]);
    expect(missing.overall.records).toBe(0);
  });

  it('honours the period and subagent filters on the project breakdown', () => {
    const lastWeek = service.projectUsage({ days: 7 });
    expect(lastWeek.projects[0]!.records).toBe(5);

    const mainOnly = service.projectUsage({ includeSubagents: false });
    expect(mainOnly.projects[0]!.records).toBe(4);
    expect(mainOnly.includeSubagents).toBe(false);
  });

  it('reports per-day usage with a period label and matching overall totals', () => {
    const report = service.dailyUsage();
    expect(report.days.length).toBeGreaterThan(0);
    expect(report.period.label).toBe('all time');
    const summed = report.days.reduce((n, d) => n + d.totalTokens, 0);
    expect(summed).toBe(report.overall.totalTokens);
    // Newest day first, and every key is a calendar date.
    const keys = report.days.map((d) => d.key);
    expect([...keys].sort().reverse()).toEqual(keys);
    for (const key of keys) expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('buckets days in local time so they agree with the period filter', () => {
    // A turn late on a local evening is a different UTC date east of Greenwich.
    // The day it lands in must match the local date the period bounds use, or
    // `--today` selects rows that the daily breakdown then files under yesterday.
    const localDate = (iso: string): string => {
      const d = new Date(iso);
      return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    };
    const today = service.dailyUsage({ today: true });
    const expected = localDate(new Date().toISOString());
    expect(today.days.map((d) => d.key)).toEqual([expected]);
    expect(today.days[0]!.records).toBe(today.overall.records);
  });

  it('resolves a session by an unambiguous fragment and splits its turn kinds', () => {
    // 'sess-1' is a fragment; it must resolve to the single matching session.
    const detail = service.sessionUsage('sess-1');
    expect(detail).toBeDefined();
    if (!detail || 'ambiguous' in detail) throw new Error('expected a session detail');
    expect(detail.session.client).toBe('claude-code');
    expect(detail.session.mainRecords).toBe(2);
    expect(detail.session.subagentRecords).toBe(1);
    // main + subagent must reconstruct the whole session
    expect(detail.main.totalTokens + detail.subagent.totalTokens).toBe(detail.session.totalTokens);
  });

  it('returns undefined for a session it has never seen', () => {
    expect(service.sessionUsage('no-such-session')).toBeUndefined();
  });

  it('is idempotent: syncing twice does not change any total', async () => {
    const before = service.summary();
    await service.sync({ full: true });
    const after = service.summary();
    expect(after.overall).toEqual(before.overall);
  });

  it('reconciles exactly against a fresh read of both sources', async () => {
    const report = await service.verify({ cutoff: new Date(Date.now() + 60_000) });
    expect(report.allMatch).toBe(true);
    for (const client of report.clients) {
      const gating = client.grains.filter((g) => g.gating !== false);
      expect(gating.some((g) => g.matches)).toBe(true);
    }
  });

  it('reports status including store discovery and pricing provenance', async () => {
    const status = await service.status();
    expect(status.totalRecords).toBe(6);
    expect(status.collectors).toHaveLength(2);
    expect(status.collectors.every((c) => c.available)).toBe(true);
    expect(status.pricing.version).toContain('anthropic');
  });
});
