import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { UsageService } from '../../src/services/usage-service.js';
import { ComparePeriodError } from '../../src/services/period.js';
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
    const known = service.summary({ projectPaths: ['/work/project-one'] });
    expect(known.overall.records).toBe(6);

    const missing = service.projectUsage({ projectPaths: ['/work/does-not-exist'] });
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

  /**
   * Asking for a comparison and getting a report without one is the failure
   * mode worth a test: a summary that simply omits the delta reads as "nothing
   * changed" rather than "I never checked". Only a period of fixed length has an
   * equally long window before it.
   */
  it('compares against the previous window for every period that has one', () => {
    for (const query of [
      { today: true },
      { days: 7 },
      { since: '2026-01-01', until: '2026-01-08' },
    ])
      expect(service.summary(query, { compare: true }).comparison).toBeDefined();
  });

  it('refuses an open-ended range too, not just all time', () => {
    // These are the cases the docs claimed were comparable: an open `since` has
    // no fixed length, so there is no equally long window to compare against.
    for (const query of [{ since: '2026-01-01' }, { until: '2026-01-08' }])
      expect(() => service.summary(query, { compare: true })).toThrow(ComparePeriodError);
  });

  it('names the period it could not compare, so the caller can see what to change', () => {
    expect(() => service.summary({}, { compare: true })).toThrow(/all time/);
    // Flag spellings stay out of it: this message reaches MCP clients too.
    expect(() => service.summary({}, { compare: true })).not.toThrow(/--days/);
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

  it('shows days with no activity, not just the days that had some', () => {
    const report = service.dailyUsage({ days: 10 });
    // Ten buckets for a ten-day window, whether or not each had usage. Returning
    // only active days makes the gaps invisible, so an ordinary day renders
    // beside one a week earlier and looks like a spike next to it.
    expect(report.days).toHaveLength(10);
    expect(report.days.some((d) => d.zeroFilled)).toBe(true);
    // A constructed zero is marked; an observed bucket is not.
    for (const day of report.days) {
      if (day.zeroFilled) expect(day.records).toBe(0);
      else expect(day.records).toBeGreaterThan(0);
    }
    // Zero-filling must not change any total.
    expect(report.overall.totalTokens).toBe(service.summary({ days: 10 }).overall.totalTokens);
  });

  it('buckets by hour and by hour-of-day as well as by day', () => {
    expect(service.dailyUsage({ days: 1 }, 'day').grain).toBe('day');

    const hourly = service.dailyUsage({ days: 1 }, 'hour');
    expect(hourly.days.every((d) => /^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(d.key))).toBe(true);

    // Every day collapsed onto one 24-slot clock: always 24 rows, always in
    // clock order, whether or not each hour was used.
    const clock = service.dailyUsage({ days: 30 }, 'hour-of-day');
    expect(clock.days).toHaveLength(24);
    expect(clock.days.map((d) => d.key)).toEqual(
      Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')),
    );
    // The grain changes the buckets, never the totals.
    expect(clock.days.reduce((sum, d) => sum + d.totalTokens, 0)).toBe(clock.overall.totalTokens);
  });

  it('compares a window against the equal-length one before it', () => {
    const report = service.summary({ days: 1 }, { compare: true });
    expect(report.comparison).toBeDefined();
    expect(report.comparison?.previous.until).toBe(report.period.since);
    // Reported and estimated are deltaed apart, and there is no combined figure.
    expect(report.comparison?.delta.reportedCost).toBeDefined();
    expect(report.comparison?.delta.estimatedCost).toBeDefined();
    expect(report.comparison?.caveats.join(' ')).toContain('never summed');
  });

  it('refuses to invent a previous window for an unbounded period', () => {
    // "All time" has no window before it, and constructing one would be
    // answering a question nobody asked. It used to decline by returning a
    // report with no comparison in it, which the caller could not distinguish
    // from "nothing changed" -- so it now declines out loud.
    expect(() => service.summary({}, { compare: true })).toThrow(ComparePeriodError);
  });

  it('leaves the comparison out unless it was asked for', () => {
    expect(service.summary({ days: 1 }).comparison).toBeUndefined();
  });

  it('says a scope value matches nothing, instead of reporting a quiet period', () => {
    // The failure this prevents: `--model typo` answering "No usage records for
    // this period" at exit 0, which is indistinguishable from a real quiet week.
    const report = service.summary({ models: ['claude-opus-5', 'no-such-model'] });
    expect(report.unmatchedScope?.models).toEqual(['no-such-model']);
    // The models that DO exist still filter normally.
    expect(report.overall.records).toBeGreaterThan(0);

    const projects = service.projectUsage({ projectPaths: ['/nope'] });
    expect(projects.unmatchedScope?.projectPaths).toEqual(['/nope']);
    expect(projects.projects).toEqual([]);
  });

  it('stays quiet when every scope value matches something', () => {
    expect(service.summary({ models: ['claude-opus-5'] }).unmatchedScope).toBeUndefined();
    expect(service.summary({}).unmatchedScope).toBeUndefined();
  });

  it('checks scope against the whole database, not the period', () => {
    // A project that exists but was quiet this period is NOT an unmatched scope:
    // conflating the two would cry wolf on every narrow window.
    const report = service.projectUsage({
      projectPaths: ['/work/project-one'],
      since: '2000-01-01T00:00:00.000Z',
      until: '2000-01-02T00:00:00.000Z',
    });
    expect(report.unmatchedScope).toBeUndefined();
    expect(report.projects).toEqual([]);
  });

  it('pages and sorts the same rows the unpaged report returns', () => {
    const all = service.projectUsage({}).projects.map((p) => p.key);
    const first = service.projectUsage({}, { limit: 1 });
    expect(first.projects.map((p) => p.key)).toEqual(all.slice(0, 1));
    expect(first.page.total).toBe(all.length);
    expect(first.page.hasMore).toBe(all.length > 1);
  });

  it('flags OpenCode records whose model the pricing table has never heard of', () => {
    // `big-pickle` is exactly the case from the issue: OpenCode reports its own
    // cost, so these land in the `reported` bucket and no estimate is attempted.
    // Without the unpriced count, nothing in the output says the estimate is
    // missing rather than zero.
    const opencode = service.clientUsage().clients.find((c) => c.key === 'opencode');
    expect(opencode?.cost.unpricedRecords).toBe(opencode?.records);
    expect(opencode?.cost.unpricedModels).toContain('big-pickle');

    // Claude Code's models are priced, so it reports a real 0 rather than undefined.
    const claude = service.clientUsage().clients.find((c) => c.key === 'claude-code');
    expect(claude?.cost.unpricedRecords).toBe(0);
  });

  it('reports status including store discovery and pricing provenance', async () => {
    const status = await service.status();
    expect(status.totalRecords).toBe(6);
    expect(status.collectors).toHaveLength(2);
    expect(status.collectors.every((c) => c.available)).toBe(true);
    // The built-in table is composed from one file per provider, each keeping its
    // own capture date, so provenance -- not the version string -- is where a
    // given provider's freshness is visible.
    expect(status.pricing.version).toBe('builtin-2026-09-26');
    expect(status.pricing.mode).toBe('builtin');
    expect(status.pricing.provenance).toContain('Anthropic');
    expect(status.pricing.provenance).toContain('OpenAI');
  });
});
