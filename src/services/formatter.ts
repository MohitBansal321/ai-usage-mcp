import type { AggregateRow, Page, SessionRow } from '../db/repositories/usage-repository.js';
import type { CostTotals } from '../models/usage-record.js';
import type {
  BreakdownReport,
  CacheHealthReport,
  ClientReport,
  DailyReport,
  HandoffPacket,
  ModelReport,
  PageInfo,
  ProjectReport,
  SessionDetail,
  SummaryReport,
  UnmatchedScope,
} from './aggregation-service.js';
import type { CostService } from './cost-service.js';
import type { Comparison, Delta } from './comparison.js';
import type { BudgetReport, Projection } from './budget-service.js';
import type { ImportResult, PruneResult, VacuumResult } from './lifecycle-service.js';
import { breakEvenReadsPerWrite, cacheMetrics } from './cache-metrics.js';
import type { TokenTotals } from '../models/usage-record.js';
import type { TimeGrain } from '../db/repositories/usage-repository.js';
import type { CounterfactualReport } from './counterfactual-service.js';
import type { PricingRefreshReport, StatusReport } from './usage-service.js';
import type { CommunityPricingState } from '../pricing/index.js';
import { updateCommand, type UpdateInfo } from './update-check.js';
import { VERSION } from '../version.js';
import type { SyncReport } from './sync-service.js';
import type { VerifyReport } from './verify-service.js';

/**
 * Text rendering shared by the CLI and the MCP tools.
 *
 * Presentation only -- no aggregation happens here. Both frontends render through
 * these functions so `ai-usage stats --today` and the `usage_summary` tool cannot
 * describe the same numbers differently.
 */

export function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Exact count plus a compact hint. Exactness first: rounded-only output is how
 *  `opencode stats` ends up displaying 76.1M for two different real numbers. */
export function tokens(n: number): string {
  const exact = int(n);
  if (Math.abs(n) < 10_000) return exact;
  return `${exact} (${compact(n)})`;
}

export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function usd(n: number): string {
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(2)}`;
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Names the models behind a count, capped.
 *
 * A machine that has drifted across a dozen OpenCode models lists all of them
 * otherwise, and the sentence that matters -- "no estimate was attempted" --
 * disappears into the middle of it. The remainder is counted rather than
 * dropped, so nothing is silently hidden; `--json` always carries the full list.
 */
const MAX_NAMED_MODELS = 5;

function namedModels(models: string[] | undefined): string {
  if (!models?.length) return '';
  if (models.length <= MAX_NAMED_MODELS) return `: ${models.join(', ')}`;
  const shown = models.slice(0, MAX_NAMED_MODELS).join(', ');
  return `: ${shown} and ${int(models.length - MAX_NAMED_MODELS)} more`;
}

/**
 * Renders cost as separate buckets, always labelled. Reported and estimated are
 * never added together -- that single blended number is the easiest way to lie
 * with this data.
 */
export function costLines(cost: CostTotals, costService: CostService, indent = '  '): string[] {
  const lines: string[] = [];
  if (cost.reportedRecords > 0) {
    lines.push(
      `${indent}Cost (reported by client, exact): ${usd(cost.reported)}  [${int(cost.reportedRecords)} records]`,
    );
  }
  if (cost.estimatedRecords > 0) {
    lines.push(
      `${indent}Cost (estimated, API-equivalent):  ${usd(cost.estimated)}  [${int(cost.estimatedRecords)} records]`,
    );
  }
  if (cost.unavailableRecords > 0) {
    lines.push(
      `${indent}Cost unavailable for ${int(cost.unavailableRecords)} record(s) (no price for that model).`,
    );
  }
  // Said out loud because otherwise it is invisible: a client that reports its
  // own cost files $0 for a model nobody has priced, which reads exactly like a
  // free model. The count above cannot show it -- those records are `reported`.
  if (cost.unpricedRecords !== undefined && cost.unpricedRecords > 0) {
    lines.push(
      `${indent}No estimate attempted for ${int(cost.unpricedRecords)} record(s) -- ` +
        `no price in table ${costService.pricingVersion} for that model` +
        `${namedModels(cost.unpricedModels)}. ` +
        `Any $0 above covers only what was reported, not those records.`,
    );
  }
  if (cost.reportedRecords === 0 && cost.estimatedRecords === 0 && cost.unavailableRecords === 0) {
    lines.push(`${indent}Cost: no records in this period.`);
  }
  if (cost.estimatedRecords > 0) {
    lines.push(`${indent}Note: ${costService.estimatedCostLabel()}`);
  }
  return lines;
}

/**
 * The derived cache figures, printed beside the raw counts.
 *
 * Cache-read is the overwhelming majority of tokens on any real machine, and the
 * raw counts alone cannot say whether that is a cache paying for itself or a
 * write premium being burnt on sessions too short to reuse it.
 */
export function cacheLines(row: TokenTotals, costService: CostService, indent = '  '): string[] {
  const metrics = cacheMetrics(row);
  if (metrics.hitRate === undefined) return [];

  const lines = [`${indent}Cache hit rate:    ${(metrics.hitRate * 100).toFixed(2)}%`];
  if (metrics.readsPerWrite !== undefined) {
    lines.push(
      `${indent}Reads per write:   ${metrics.readsPerWrite.toFixed(1)}  ` +
        `(1 write : ${metrics.readsPerWrite.toFixed(1)} reads)`,
    );
    const breakEven = breakEvenReadsPerWrite(costService.table.cacheMultipliers);
    if (breakEven) {
      const worst = Math.max(breakEven.write5m, breakEven.write1h);
      lines.push(
        `${indent}                   Break-even is ${breakEven.write5m.toFixed(2)} reads per ` +
          `5-minute write and ${breakEven.write1h.toFixed(2)} per 1-hour write, so this cache ` +
          `is ${metrics.readsPerWrite >= worst ? 'paying for itself' : 'NOT clearly paying for itself'}.`,
      );
    }
  } else {
    lines.push(`${indent}Reads per write:   n/a -- nothing was written to cache in this period.`);
  }
  return lines;
}

export function tokenLines(row: AggregateRow, indent = '  '): string[] {
  return [
    `${indent}Input:        ${tokens(row.inputTokens)}`,
    `${indent}Output:       ${tokens(row.outputTokens)}`,
    `${indent}Cache read:   ${tokens(row.cacheReadTokens)}`,
    `${indent}Cache write:  ${tokens(row.cacheWriteTokens)}`,
    `${indent}Reasoning:    ${tokens(row.reasoningTokens)}`,
    `${indent}Total:        ${tokens(row.totalTokens)}`,
  ];
}

/**
 * What this page is a page OF, and how to get the next one.
 *
 * A bare `--limit 5` says nothing about the other 275 rows, so "the top 5" was
 * indistinguishable from "all 5 there are". This line makes the difference
 * visible, and gives a caller the exact flag to walk the rest.
 */
export function pageLines(info: PageInfo, noun: string): string[] {
  const lines: string[] = [];
  const shown = info.limit === undefined ? info.total - info.offset : undefined;
  const count = shown ?? Math.min(info.limit as number, Math.max(0, info.total - info.offset));

  if (info.limit === undefined && info.offset === 0) {
    lines.push(`Showing all ${int(info.total)} ${noun}, sorted by ${info.sort}.`);
  } else {
    lines.push(
      `Showing ${int(count)} of ${int(info.total)} ${noun} ` +
        `(offset ${int(info.offset)}), sorted by ${info.sort}.`,
    );
  }
  if (info.hasMore && info.nextOffset !== undefined) {
    lines.push(`More available: re-run with --offset ${int(info.nextOffset)} for the next page.`);
  }
  // The trap that makes a cost sort quietly wrong if unsaid.
  if (info.rowsWithoutSortValue > 0 && info.sort.endsWith('-cost')) {
    const basis = info.sort === 'reported-cost' ? 'reported' : 'estimated';
    lines.push(
      `NOTE: ${int(info.rowsWithoutSortValue)} of those ${noun} carry no ${basis} cost at all, ` +
        `so they sort as $0. They are not cheap -- they are priced on the other basis, or not ` +
        `priced at all. Reported and estimated cost are never summed, so no single ordering ` +
        `can rank both.`,
    );
  }
  return lines;
}

/**
 * Scope values that match nothing anywhere in the database.
 *
 * Without this, a typo answers "No usage records for this period" and exits 0,
 * which is indistinguishable from a genuinely quiet period.
 */
export function unmatchedScopeLines(scope: UnmatchedScope | undefined): string[] {
  if (!scope) return [];
  const lines: string[] = [];
  const say = (label: string, values: string[] | undefined, hint: string) => {
    if (!values?.length) return;
    lines.push(
      `WARNING: no record anywhere in this database has ${label} ${values.map((v) => `"${v}"`).join(', ')}. ` +
        `An empty result below is that, not a quiet period. ${hint}`,
    );
  };
  say('model', scope.models, 'Run `ai-usage models` to see the ids actually present.');
  say('project', scope.projectPaths, 'Run `ai-usage projects` to see the paths actually present.');
  say('client', scope.clients, 'Known clients are claude-code and opencode.');
  return lines;
}

function subagentNote(
  report: { includeSubagents: boolean },
  turnKinds?: { main: number; subagent: number },
): string {
  if (report.includeSubagents) {
    const extra = turnKinds
      ? ` (${int(turnKinds.main)} main + ${int(turnKinds.subagent)} subagent turns)`
      : '';
    return `Subagent/sidechain turns: INCLUDED${extra}.`;
  }
  return 'Subagent/sidechain turns: EXCLUDED (main-thread turns only).';
}

export function formatSummary(report: SummaryReport, costService: CostService): string {
  const out: string[] = [];
  out.push(`Usage summary -- ${report.period.label}`);
  out.push(subagentNote(report, report.turnKinds));
  out.push(...unmatchedScopeLines(report.unmatchedScope));
  out.push('');

  if (report.overall.records === 0) {
    out.push('No usage records for this period.');
    out.push('If you expected data here, run `ai-usage sync` and then `ai-usage status`.');
    return out.join('\n');
  }

  out.push(`Records: ${int(report.overall.records)}   Sessions: ${int(report.overall.sessions)}`);
  if (report.overall.firstTimestamp && report.overall.lastTimestamp) {
    out.push(`Range:   ${report.overall.firstTimestamp} -> ${report.overall.lastTimestamp}`);
  }
  out.push('');
  out.push('Tokens (all clients):');
  out.push(...tokenLines(report.overall));
  out.push(...cacheLines(report.overall, costService));
  out.push('');
  out.push(...costLines(report.overall.cost, costService));
  if (report.comparison) out.push(...comparisonLines(report.comparison));

  out.push('');
  out.push('By client:');
  for (const client of report.byClient) {
    out.push(
      `  ${client.key}  --  ${int(client.records)} records, ${int(client.sessions)} sessions`,
    );
    out.push(...tokenLines(client, '    '));
    out.push(...cacheLines(client, costService, '    '));
    out.push(...costLines(client.cost, costService, '    '));
    out.push('');
  }
  return out.join('\n').trimEnd();
}

export function formatModels(report: ModelReport, costService: CostService): string {
  const out: string[] = [];
  out.push(`Usage by model -- ${report.period.label}`);
  out.push(subagentNote(report));
  out.push(...unmatchedScopeLines(report.unmatchedScope));
  out.push('');
  if (report.models.length === 0) {
    out.push('No usage records for this period.');
    return out.join('\n');
  }
  for (const model of report.models) {
    out.push(`${model.key}  --  ${int(model.records)} records, ${int(model.sessions)} sessions`);
    out.push(...tokenLines(model, '  '));
    out.push(...costLines(model.cost, costService, '  '));
    out.push('');
  }
  out.push(
    `Total across ${int(report.models.length)} model(s): ${tokens(report.overall.totalTokens)} tokens`,
  );
  out.push(...pageLines(report.page, 'models'));
  return out.join('\n');
}

/**
 * A signed figure, so a delta reads as a direction rather than a quantity.
 * `+0` and `-0` both render as `0`: nothing changed is not a direction.
 */
export function signed(n: number, render: (v: number) => string = int): string {
  if (n === 0) return render(0);
  return n > 0 ? `+${render(n)}` : `-${render(Math.abs(n))}`;
}

/**
 * `undefined` renders as "n/a", never as 100% or Infinity: there is no
 * percentage change from zero. Going from $0 to $5 is a new thing happening,
 * not a rise of any particular size.
 */
export function percent(ratio: number | undefined): string {
  if (ratio === undefined) return 'n/a, previous was zero';
  return `${signed(ratio * 100, (v) => v.toFixed(1))}%`;
}

function comparisonLines(comparison: Comparison): string[] {
  const d = comparison.delta;
  const row = (label: string, change: Delta, render: (v: number) => string = int): string =>
    `  ${`${label}:`.padEnd(18)}${signed(change.absolute, render).padStart(16)}   ${percent(change.ratio)}`;

  const out: string[] = [
    '',
    `Compared with ${comparison.previous.label}`,
    `  (${comparison.previous.since} -> ${comparison.previous.until})`,
    '',
    row('Records', d.records),
    row('Sessions', d.sessions),
    row('Total tokens', d.totalTokens),
    row('Cache read', d.cacheReadTokens),
  ];
  // The two cost bases are deltaed separately and never summed, exactly as they
  // are reported. A single "spend is up $40" across both would be the same lie
  // in motion.
  if (comparison.previousTotals.cost.reportedRecords > 0 || d.reportedCost.absolute !== 0) {
    out.push(row('Cost (reported)', d.reportedCost, usd));
  }
  if (comparison.previousTotals.cost.estimatedRecords > 0 || d.estimatedCost.absolute !== 0) {
    out.push(row('Cost (estimated)', d.estimatedCost, usd));
  }
  for (const caveat of comparison.caveats) out.push(`  Note: ${caveat}`);
  return out;
}

const GRAIN_NOUN: Record<TimeGrain, { one: string; many: string; title: string }> = {
  hour: { one: 'hour', many: 'hours', title: 'Usage by hour' },
  day: { one: 'day', many: 'days', title: 'Usage by day' },
  'hour-of-day': { one: 'hour', many: 'hours of the day', title: 'Usage by hour of day' },
};

/** Compact one line per bucket. Reported and estimated costs stay separate, as everywhere else. */
export function formatDaily(report: DailyReport): string {
  const noun = GRAIN_NOUN[report.grain];
  const out: string[] = [];
  out.push(`${noun.title} -- ${report.period.label}`);
  out.push(subagentNote(report));
  out.push(...unmatchedScopeLines(report.unmatchedScope));
  out.push('');
  if (report.overall.records === 0) {
    out.push('No usage records for this period.');
    return out.join('\n');
  }

  const active = report.days.filter((d) => d.records > 0);
  for (const bucket of report.days) {
    const cost: string[] = [];
    if (bucket.cost.reportedRecords > 0) cost.push(`reported ${usd(bucket.cost.reported)}`);
    if (bucket.cost.estimatedRecords > 0) cost.push(`estimated ${usd(bucket.cost.estimated)}`);
    const label = report.grain === 'hour-of-day' ? `${bucket.key}:00` : bucket.key;
    out.push(
      `${label}  ${int(bucket.records).padStart(6)} turns  total ${tokens(bucket.totalTokens)}` +
        (cost.length ? `  (${cost.join(', ')})` : '') +
        // A constructed zero is marked, so a reader can tell "nothing happened"
        // from "nothing was recorded" without going to the JSON.
        (bucket.zeroFilled ? '   --' : ''),
    );
  }
  out.push('');
  out.push(
    `Total across ${int(active.length)} active of ${int(report.days.length)} ${noun.many} shown: ` +
      `${tokens(report.overall.totalTokens)} tokens`,
  );
  if (report.days.length > active.length) {
    out.push(
      report.grain === 'hour-of-day'
        ? `Rows marked -- had no recorded activity on any day in this period.`
        : `Rows marked -- had no recorded activity. They are shown so the gaps in the series ` +
            `are visible; a trend read from active ${noun.many} alone puts them side by side and ` +
            `turns an ordinary one into an apparent spike.`,
    );
  }
  if (report.zeroFillNote) out.push(report.zeroFillNote);
  out.push(
    report.grain === 'hour-of-day'
      ? 'Hours are local, aggregated across every day in the period.'
      : `Buckets are local ${noun.many}, matching the period filter.`,
  );
  return out.join('\n');
}

/**
 * A tidy row set, one row per combination of the requested axes.
 *
 * Rendered as a table rather than the nested blocks the single-axis reports use,
 * because the whole point is to scan one dimension against another -- which
 * nested blocks make impossible.
 *
 * Cost columns show `--`, never `$0.00`, where a row has no records on that
 * basis. A rendered $0 would say "this cost nothing", which is a different claim
 * from "nothing here is priced this way".
 */
export function formatBreakdown(report: BreakdownReport): string {
  const out: string[] = [];
  out.push(`Usage breakdown: ${report.axes.join(' x ')} -- ${report.period.label}`);
  out.push(subagentNote(report));
  out.push(...unmatchedScopeLines(report.unmatchedScope));
  out.push('');

  if (report.rows.length === 0) {
    out.push('No usage records for this period.');
    return out.join('\n');
  }

  const headers = [...report.axes, 'turns', 'total tokens', 'reported', 'estimated'];
  const body = report.rows.map((row) => [
    ...report.axes.map((axis) => row.keys[axis] ?? '(unknown)'),
    int(row.records),
    int(row.totalTokens),
    row.cost.reportedRecords > 0 ? usd(row.cost.reported) : '--',
    row.cost.estimatedRecords > 0 ? usd(row.cost.estimated) : '--',
  ]);

  const widths = headers.map((header, i) =>
    Math.max(header.length, ...body.map((r) => (r[i] ?? '').length)),
  );
  // Axis values read left-aligned; every number reads right-aligned, so columns
  // of figures line up on their last digit.
  const pad = (value: string, i: number) =>
    i < report.axes.length
      ? value.padEnd(widths[i] as number)
      : value.padStart(widths[i] as number);

  out.push(headers.map(pad).join('  '));
  out.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of body) out.push(row.map(pad).join('  ').trimEnd());

  out.push('');
  out.push(...pageLines(report.page, 'rows'));
  out.push(
    'Combinations with no activity are absent rather than listed as zero: a project x day ' +
      'grid is mostly empty, and filling it would bury the rows that matter.',
  );
  out.push(
    'A `--` in a cost column means no record in that row is priced on that basis. It is not $0.',
  );
  return out.join('\n');
}

export function formatProjects(report: ProjectReport, costService: CostService): string {
  const out: string[] = [];
  out.push(`Usage by project -- ${report.period.label}`);
  out.push(subagentNote(report));
  out.push(...unmatchedScopeLines(report.unmatchedScope));
  out.push('');
  if (report.projects.length === 0) {
    out.push('No usage records for this period.');
    return out.join('\n');
  }
  for (const project of report.projects) {
    out.push(
      `${project.key}  --  ${int(project.records)} records, ${int(project.sessions)} sessions`,
    );
    out.push(...tokenLines(project, '  '));
    out.push(...costLines(project.cost, costService, '  '));
    out.push('');
  }
  out.push(
    `Total across ${int(report.projects.length)} project(s): ${tokens(report.overall.totalTokens)} tokens`,
  );
  out.push(...pageLines(report.page, 'projects'));
  out.push(
    'A project is the working directory the turn ran in. Turns whose project could not be ' +
      'resolved are grouped as (unknown) rather than dropped.',
  );
  return out.join('\n');
}

export function formatClients(report: ClientReport, costService: CostService): string {
  const out: string[] = [];
  out.push(`Usage by client -- ${report.period.label}`);
  out.push(subagentNote(report));
  out.push(...unmatchedScopeLines(report.unmatchedScope));
  out.push('');
  if (report.clients.length === 0) {
    out.push('No usage records for this period.');
    return out.join('\n');
  }
  for (const client of report.clients) {
    out.push(`${client.key}  --  ${int(client.records)} records, ${int(client.sessions)} sessions`);
    out.push(...tokenLines(client, '  '));
    out.push(...cacheLines(client, costService, '  '));
    out.push(...costLines(client.cost, costService, '  '));
    out.push('');
  }
  out.push(
    'Reported and estimated costs are listed separately on purpose and must not be added ' +
      'together: OpenCode reports what it actually charged, while the Claude Code figure is a ' +
      'list-price equivalent.',
  );
  return out.join('\n');
}

export function formatSessions(page: Page<SessionRow>, costService: CostService): string {
  const sessions = page.rows;
  if (sessions.length === 0) {
    return page.total === 0
      ? 'No sessions recorded. Run `ai-usage sync` first.'
      : `No sessions at offset ${int(page.offset)}; there are ${int(page.total)} in total.`;
  }
  const out: string[] = [`Sessions (${sessions.length}):`, ''];
  for (const s of sessions) {
    out.push(`${s.sessionId}  [${s.client}]`);
    out.push(`  Project:   ${s.projectPath ?? '(unknown)'}`);
    out.push(`  Models:    ${s.models.length ? s.models.join(', ') : '(unknown)'}`);
    out.push(`  Started:   ${s.startedAt}`);
    out.push(
      `  Duration:  ${duration(s.durationSeconds)}  (${int(s.records)} turns: ${int(s.mainRecords)} main, ${int(s.subagentRecords)} subagent)`,
    );
    out.push(...tokenLines(s, '  '));
    out.push(...costLines(s.cost, costService, '  '));
    out.push('');
  }
  out.push(...pageLines(page, 'sessions'));
  return out.join('\n').trimEnd();
}

export function formatSessionDetail(detail: SessionDetail, costService: CostService): string {
  const s = detail.session;
  const out: string[] = [];
  out.push(`Session ${s.sessionId}`);
  out.push(`  Client:    ${s.client}`);
  out.push(`  Project:   ${s.projectPath ?? '(unknown)'}`);
  out.push(`  Models:    ${s.models.length ? s.models.join(', ') : '(unknown)'}`);
  out.push(`  Started:   ${s.startedAt}`);
  out.push(`  Ended:     ${s.endedAt}`);
  out.push(`  Duration:  ${duration(s.durationSeconds)}`);
  out.push(
    `  Turns:     ${int(s.records)} (${int(s.mainRecords)} main, ${int(s.subagentRecords)} subagent)`,
  );
  out.push('');
  out.push('Tokens:');
  out.push(...tokenLines(s, '  '));
  out.push('');
  out.push(...costLines(s.cost, costService));
  if (s.subagentRecords > 0) {
    out.push('');
    out.push('Main-thread turns only:');
    out.push(...tokenLines(detail.main, '  '));
    out.push('Subagent turns only:');
    out.push(...tokenLines(detail.subagent, '  '));
  }
  if (detail.models.length > 1) {
    out.push('');
    out.push('Per model in this session:');
    for (const m of detail.models) {
      out.push(`  ${m.key}: ${tokens(m.totalTokens)} total, ${int(m.records)} turns`);
    }
  }
  return out.join('\n');
}

/**
 * Spend against a target.
 *
 * The two projections are rendered side by side, never merged. Extrapolating
 * month-end spend by hand meant picking a denominator -- calendar days or active
 * days -- and on a machine used on weekdays only those differ by more than 2x.
 * Showing one would be making that modelling choice silently on the user's
 * behalf; showing both makes the size of the assumption the visible thing.
 */
export function formatBudget(report: BudgetReport): string {
  const out: string[] = [];
  const pct = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

  out.push(`Budget -- ${report.period.label}, ${report.basis} cost basis`);
  out.push('');
  out.push(`  Budget:        ${usd(report.amount).padStart(12)}`);
  out.push(
    `  Spent so far:  ${usd(report.spent).padStart(12)}   ${pct(report.fractionUsed)} of budget`,
  );
  out.push(
    `  ${report.remaining >= 0 ? 'Remaining:    ' : 'OVER BY:      '} ` +
      `${usd(Math.abs(report.remaining)).padStart(12)}`,
  );
  out.push(
    `  Elapsed:       ${`${report.elapsed.days.toFixed(1)} of ${report.elapsed.totalDays} days`.padStart(12)}` +
      `   ${pct(report.elapsed.fraction)} of period`,
  );
  out.push('');

  out.push('Run rate and projection to period end:');
  const line = (label: string, p: Projection, denominator: string) =>
    `  ${label.padEnd(18)} ${usd(p.ratePerDay).padStart(10)}/day  ->  ${usd(p.projected).padStart(11)}` +
    (p.overBy !== undefined ? `   OVER by ${usd(p.overBy)}` : '   within budget') +
    `\n  ${' '.repeat(18)} (over ${denominator})`;
  out.push(
    line(
      'Per calendar day',
      report.projections.perCalendarDay,
      `${report.elapsed.days.toFixed(1)} elapsed calendar days`,
    ),
  );
  out.push(
    line(
      'Per active day',
      report.projections.perActiveDay,
      `${int(report.activeDays)} day(s) with any recorded activity`,
    ),
  );

  out.push('');
  for (const caveat of report.caveats) out.push(`Note: ${caveat}`);
  return out.join('\n');
}

export function formatPrune(result: PruneResult): string {
  const out: string[] = [];
  if (!result.applied) {
    out.push(`DRY RUN -- nothing has been deleted.`);
    out.push('');
    out.push(
      `${int(result.matched)} record(s) are older than ${result.cutoff} and WOULD be removed.`,
    );
    out.push(`${int(result.remaining)} record(s) are in the database now.`);
    out.push('');
    out.push('Re-run with --yes to actually delete them. This cannot be undone: the records');
    out.push("come from your coding agents' own files, and `ai-usage sync --full` restores only");
    out.push('what those files still contain -- a client that has rotated its own logs has not');
    out.push('kept them either.');
    return out.join('\n');
  }
  out.push(`Removed ${int(result.removed)} record(s) older than ${result.cutoff}.`);
  out.push(`${int(result.remaining)} record(s) remain.`);
  out.push('');
  out.push(
    'Deleting rows frees pages inside the database but does not shrink the file. Run ' +
      '`ai-usage vacuum` to reclaim the disk.',
  );
  return out.join('\n');
}

export function formatVacuum(result: VacuumResult): string {
  if (result.bytesBefore === undefined || result.bytesAfter === undefined) {
    return 'Database compacted. (No file to measure -- this database is in memory.)';
  }
  const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(2)} MB`;
  const reclaimed = result.reclaimedBytes ?? 0;
  return [
    `Database compacted.`,
    `  Before:    ${mb(result.bytesBefore)}`,
    `  After:     ${mb(result.bytesAfter)}`,
    reclaimed > 0
      ? `  Reclaimed: ${mb(reclaimed)}`
      : `  Reclaimed: nothing -- there was no free space to give back.`,
  ].join('\n');
}

export function formatImport(result: ImportResult): string {
  const out: string[] = [
    `Read ${int(result.read)} row(s); ${int(result.accepted)} accepted, ` +
      `${int(result.rejected.length)} rejected.`,
    `Records: ${int(result.recordsBefore)} -> ${int(result.recordsAfter)} ` +
      `(+${int(result.recordsAfter - result.recordsBefore)} new).`,
  ];
  if (result.accepted > result.recordsAfter - result.recordsBefore) {
    out.push('');
    out.push(
      `${int(result.accepted - (result.recordsAfter - result.recordsBefore))} imported row(s) ` +
        `were already present and updated in place rather than added. Record ids are derived ` +
        `deterministically from source identifiers, so importing the same data twice -- or ` +
        `merging two machines that both saw a turn -- cannot double count it.`,
    );
  }
  if (result.rejected.length > 0) {
    out.push('');
    out.push('Rejected rows (nothing from these was imported):');
    for (const rejection of result.rejected.slice(0, 20)) {
      out.push(`  line ${int(rejection.line)}: ${rejection.reason}`);
    }
    if (result.rejected.length > 20) {
      out.push(`  ... and ${int(result.rejected.length - 20)} more.`);
    }
  }
  return out.join('\n');
}

export function formatStatus(status: StatusReport, update?: UpdateInfo | null): string {
  const out: string[] = [];
  out.push('ai-usage status');
  out.push('');
  out.push(`Version:        ${update?.current ?? VERSION}`);
  out.push(`Database:       ${status.databasePath}`);
  out.push(`SQLite driver:  ${status.sqliteDriver}`);
  out.push(`Schema version: ${status.schemaVersion}`);
  out.push(`Total records:  ${int(status.totalRecords)}`);
  out.push(`Pricing table:  ${status.pricing.version}  (${status.pricing.provenance})`);
  if (status.pricing.overridePath) {
    // Which of the two override behaviours is in force matters: an overlay still
    // has every built-in price behind it, a replacement has none of them.
    out.push(
      status.pricing.mode === 'replace'
        ? `  REPLACED by:   ${status.pricing.overridePath} (built-in prices are NOT in effect)`
        : `  Overlaid from: ${status.pricing.overridePath}` +
            (status.pricing.baseVersion ? ` (on top of ${status.pricing.baseVersion})` : ''),
    );
  }
  if (status.pricing.community) {
    out.push(`  Community:     ${describeCommunityPricing(status.pricing.community)}`);
  }
  out.push('');
  out.push('Collectors:');
  for (const c of status.collectors) {
    out.push(`  ${c.name} [${c.client}] -- ${c.available ? 'available' : 'UNAVAILABLE'}`);
    if (c.reason) out.push(`    ${c.reason}`);
    out.push(
      `    Records stored: ${int(c.records)}${c.lastRecordAt ? `, newest ${c.lastRecordAt}` : ''}`,
    );
    out.push(`    Last sync:      ${c.lastSyncAt ?? 'never'}`);
    for (const store of c.stores) {
      const flags = [store.primary ? 'PRIMARY' : 'secondary', store.exists ? 'found' : 'missing'];
      out.push(
        `    - ${store.path} [${flags.join(', ')}]${store.detail ? ` -- ${store.detail}` : ''}`,
      );
    }
    const extras = c.stores.filter((s) => s.exists && !s.primary);
    if (extras.length > 0) {
      out.push(
        `    NOTE: ${extras.length} additional store(s) found, NOT collected by default. Each may be`,
      );
      out.push(
        `          separate history or a stale copy of the primary. Records are keyed by source`,
      );
      out.push(`          record id, so \`--all-stores\` merges them without double counting.`);
    }
  }
  if (status.totalRecords === 0) {
    out.push('');
    out.push('No records stored yet. Run `ai-usage sync`.');
  }
  if (update?.isOutdated) {
    out.push('');
    out.push(
      `Update available: ${update.current} installed, ${update.latest} latest -- ` +
        updateCommand(update.installKind),
    );
  }
  return out.join('\n');
}

/**
 * One line on the community price list: what it priced, or why it priced
 * nothing. "Nothing" has three causes a user would act on differently.
 */
function describeCommunityPricing(community: CommunityPricingState): string {
  if (community.disabledBy) return `off (${community.disabledBy})`;
  if (!community.fetchedAt) {
    return "LiteLLM's price list not downloaded yet -- it is fetched on the next sync or server start";
  }
  const day = community.fetchedAt.slice(0, 10);
  if (community.added.length === 0) {
    return `LiteLLM's price list, fetched ${day}; the built-in tables already price every model in it`;
  }
  return (
    `${community.added.length} model(s) the built-in tables lack, from LiteLLM's price list ` +
    `fetched ${day}: ${community.added.join(', ')}`
  );
}

function repricedLine(repriced: { models: string[]; records: number }): string {
  return (
    `Priced ${int(repriced.records)} stored record(s) that had no price when collected: ` +
    `${repriced.models.join(', ')}.`
  );
}

/**
 * What a price refresh did, or nothing when it did nothing worth saying: a
 * fresh cache or an opt-out is the ordinary state, not news.
 */
export function formatPricingRefresh(refresh: PricingRefreshReport): string[] {
  if (refresh.status === 'failed') {
    return [`Community prices: refresh failed (${refresh.reason}); prices in force are unchanged.`];
  }
  if (refresh.status !== 'updated') return [];
  const out = [`Community prices: downloaded ${int(refresh.models)} Anthropic price(s).`];
  if (refresh.repriced) out.push(repricedLine(refresh.repriced));
  return out;
}

export function formatSyncReport(report: SyncReport, refresh?: PricingRefreshReport): string {
  const out: string[] = [
    `Sync finished in ${report.durationMs}ms -- ${int(report.totalRecords)} record(s) written.`,
  ];
  if (report.repriced) out.push(repricedLine(report.repriced));
  if (refresh) out.push(...formatPricingRefresh(refresh));
  out.push('');
  for (const r of report.results) {
    out.push(
      `${r.collector} [${r.client}] -- ${r.available ? 'ok' : 'skipped'} (${r.durationMs}ms)`,
    );
    if (r.reason) out.push(`  ${r.reason}`);
    out.push(`  Records written: ${int(r.recordsWritten)}`);
    for (const note of r.notes) out.push(`  - ${note}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

export function formatVerify(report: VerifyReport): string {
  const out: string[] = [
    'Verification -- our stored totals vs a fresh, independent read of the source data',
    `Comparing activity strictly before ${report.cutoff} (both clients append while we read).`,
    '',
  ];
  for (const client of report.clients) {
    out.push(`== ${client.client} ==`);
    if (!client.available) {
      out.push(`  ${client.reason ?? 'Not available.'}`);
      out.push('');
      continue;
    }
    out.push(
      `  Ours (from local DB): input ${int(client.ours.inputTokens)}, output ${int(client.ours.outputTokens)}, cache-read ${int(client.ours.cacheReadTokens)}, cache-write ${int(client.ours.cacheWriteTokens)}, reasoning ${int(client.ours.reasoningTokens)}${client.ours.cost !== undefined ? `, cost ${usd(client.ours.cost)}` : ''}`,
    );
    out.push('');
    for (const grain of client.grains) {
      const verdict = grain.gating === false ? 'INFO    ' : grain.matches ? 'MATCH   ' : 'DIFFERS ';
      out.push(`  ${verdict} ${grain.label}`);
      out.push(
        `           source: input ${int(grain.snapshot.inputTokens)}, output ${int(grain.snapshot.outputTokens)}, ` +
          `cache-read ${int(grain.snapshot.cacheReadTokens)}, cache-write ${int(grain.snapshot.cacheWriteTokens)}, ` +
          `reasoning ${int(grain.snapshot.reasoningTokens)}${grain.snapshot.cost !== undefined ? `, cost ${usd(grain.snapshot.cost)}` : ''}`,
      );
      if (!grain.matches) {
        out.push(
          `           delta:  input ${int(grain.delta.inputTokens)}, output ${int(grain.delta.outputTokens)}, ` +
            `cache-read ${int(grain.delta.cacheReadTokens)}, cache-write ${int(grain.delta.cacheWriteTokens)}, ` +
            `reasoning ${int(grain.delta.reasoningTokens)}`,
        );
      }
      if (grain.note) out.push(`           note:   ${grain.note}`);
      out.push('');
    }
  }
  out.push(
    report.allMatch
      ? 'RESULT: every client reconciles exactly against at least one independent read of its source.'
      : 'RESULT: at least one client does NOT reconcile. Treat its numbers as suspect until resolved.',
  );
  return out.join('\n');
}

/**
 * "These tokens on another model."
 *
 * Deliberately shaped so the comparison cannot be misread as a saving: the
 * actual figure keeps its own basis at the top, every scenario is labelled an
 * estimate, the model that actually ran is marked in the list rather than
 * subtracted from it, and the caveats print with the numbers instead of being
 * left to the README.
 */
export function formatCounterfactual(
  report: CounterfactualReport,
  costService: CostService,
): string {
  const out: string[] = [];
  out.push(`Counterfactual cost -- ${report.period.label}`);
  out.push(subagentNote(report));
  out.push('');

  if (report.overall.records === 0) {
    out.push('No usage records for this period.');
    return out.join('\n');
  }

  out.push(`Records: ${int(report.overall.records)}   Sessions: ${int(report.overall.sessions)}`);
  out.push('');
  out.push('Tokens actually used:');
  out.push(...tokenLines(report.overall, '  '));
  out.push('');
  out.push('What they actually cost:');
  out.push(...costLines(report.overall.cost, costService, '  '));
  out.push('');

  out.push(`Those same tokens, priced at each model's list rates (${report.pricingVersion}):`);
  const width = Math.max(...report.scenarios.map((s) => s.model.length));
  for (const scenario of report.scenarios) {
    const marker = scenario.isActual ? '  <- actually used' : '';
    out.push(
      `  ${scenario.model.padEnd(width)}  ${usd(scenario.estimatedCost).padStart(10)}${marker}`,
    );
    if (scenario.unpricedGroups > 0) {
      out.push(
        `  ${' '.repeat(width)}  (${int(scenario.unpricedGroups)} group(s) could not be priced)`,
      );
    }
  }

  if (report.noCache.length > 0) {
    out.push('');
    out.push('Those same tokens with NO prompt caching at all:');
    const modelWidth = Math.max(...report.noCache.map((s) => s.model.length));
    for (const scenario of report.noCache) {
      out.push(
        `  ${scenario.model.padEnd(modelWidth)}  ${usd(scenario.withoutCache).padStart(11)}` +
          `  vs ${usd(scenario.withCache).padStart(11)} actually estimated` +
          `  ->  cache saved ${usd(scenario.saved)}` +
          (scenario.savedFraction !== undefined
            ? ` (${(scenario.savedFraction * 100).toFixed(1)}%)`
            : ''),
      );
    }
  }

  out.push('');
  for (const caveat of report.caveats) {
    out.push(`Note: ${caveat}`);
  }
  return out.join('\n');
}

export function formatHandoffPacket(packet: HandoffPacket): string {
  const out: string[] = [];
  out.push(
    `Handoff Packet -- Session ${packet.sessionId}${packet.phaseName ? ` (${packet.phaseName})` : ''}`,
  );
  out.push(`Generated: ${packet.generatedAt}`);
  out.push('');

  const m = packet.metadata;
  out.push(`Session: ${m.totalTurns} turns (${m.mainTurns} main, ${m.subagentTurns} subagent)`);
  out.push(`Models: ${m.modelsUsed.length ? m.modelsUsed.join(', ') : '(unknown)'}`);
  out.push(`Time span: ${m.timeSpan.start} -> ${m.timeSpan.end}`);
  out.push(`Total tokens: ${m.totalTokens.toLocaleString()}`);
  out.push('');

  const wc = packet.whatChanged;
  out.push('=== WHAT CHANGED ===');
  if (wc.filesModified.length) {
    out.push('Files modified:');
    for (const f of wc.filesModified) out.push(`  - ${f}`);
  } else {
    out.push('Files modified: (none detected)');
  }
  if (wc.keyDecisions.length) {
    out.push('Key decisions:');
    for (const d of wc.keyDecisions) out.push(`  - ${d}`);
  } else {
    out.push('Key decisions: (none recorded)');
  }
  if (wc.configChanges.length) {
    out.push('Config changes:');
    for (const c of wc.configChanges) out.push(`  - ${c}`);
  } else {
    out.push('Config changes: (none detected)');
  }
  out.push('');

  const wf = packet.whatFailed;
  out.push('=== WHAT FAILED ===');
  if (wf.errors.length) {
    out.push('Errors:');
    for (const e of wf.errors) out.push(`  - ${e}`);
  } else {
    out.push('Errors: (none)');
  }
  if (wf.testFailures.length) {
    out.push('Test failures:');
    for (const t of wf.testFailures) out.push(`  - ${t}`);
  } else {
    out.push('Test failures: (none)');
  }
  if (wf.blockers.length) {
    out.push('Blockers:');
    for (const b of wf.blockers) out.push(`  - ${b}`);
  } else {
    out.push('Blockers: (none)');
  }
  out.push('');

  const wn = packet.whatNext;
  out.push("=== WHAT'S NEXT ===");
  if (wn.nextSteps.length) {
    out.push('Next steps:');
    for (const s of wn.nextSteps) out.push(`  - ${s}`);
  } else {
    out.push('Next steps: (none inferred)');
  }
  if (wn.openQuestions.length) {
    out.push('Open questions:');
    for (const q of wn.openQuestions) out.push(`  - ${q}`);
  } else {
    out.push('Open questions: (none)');
  }
  if (wn.contextNeeded.length) {
    out.push('Context needed for continuation:');
    for (const c of wn.contextNeeded) out.push(`  - ${c}`);
  } else {
    out.push('Context needed: (none)');
  }

  out.push('');
  out.push('Usage: Feed this packet to the next agent phase instead of raw history.');
  out.push('The packet is ~1-2KB vs 50-200KB of raw context -- massive token savings.');

  return out.join('\n').trimEnd();
}

export function formatCacheHealth(report: CacheHealthReport): string {
  const out: string[] = [];
  out.push(`Cache health -- Session ${report.sessionId}`);
  out.push(`Turns analyzed: ${int(report.turnsAnalyzed)} of ${int(report.totalTurns)}`);
  out.push('');

  if (report.totalTurns === 0) {
    out.push('No turns in this session.');
    return out.join('\n');
  }

  out.push('Overall cache metrics:');
  if (report.hitRate !== undefined) {
    out.push(`  Hit rate:       ${(report.hitRate * 100).toFixed(2)}%`);
  } else {
    out.push(`  Hit rate:       n/a (no cache traffic)`);
  }
  if (report.readsPerWrite !== undefined) {
    out.push(`  Reads per write: ${report.readsPerWrite.toFixed(1)}`);
  } else {
    out.push(`  Reads per write: n/a (no cache writes)`);
  }
  out.push(`  Total cache reads:  ${tokens(report.summary.totalCacheReads)}`);
  out.push(`  Total cache writes: ${tokens(report.summary.totalCacheWrites)}`);
  out.push('');

  if (report.breaks.length === 0) {
    out.push('No cache breaks detected with current thresholds.');
    out.push('');
    out.push('A "cache break" is a sudden spike in cache_write_tokens -- typically caused by');
    out.push('editing a core file mid-session, changing the file load order, or modifying a');
    out.push('global config (CLAUDE.md, AGENTS.md). This invalidates the prefix cache, forcing');
    out.push('the agent to re-read all prior context at full write prices.');
    out.push('');
    out.push(
      'Adjust --spike-threshold (default 10x) or --min-cache-writes (default 5000) to tune sensitivity.',
    );
    return out.join('\n');
  }

  out.push(`Cache breaks detected: ${report.breaks.length}`);
  out.push(`Max spike ratio: ${report.summary.maxWriteSpikeRatio}x baseline`);
  out.push('');

  for (const br of report.breaks) {
    out.push(`--- Break at turn ${br.turnIndex} (${br.timestamp}) ---`);
    out.push(
      `  Cache writes:  ${tokens(br.cacheWriteTokens)}  (baseline ~${int(br.baselineWriteAvg)})`,
    );
    out.push(`  Cache reads:   ${tokens(br.cacheReadTokens)}`);
    out.push(`  Spike ratio:   ${br.writeSpikeRatio}x`);
    out.push(`  Est. extra cost from write premium: ${usd(br.estimatedExtraCost)}`);
    out.push(`  Explanation: ${br.explanation}`);
    out.push('');
  }

  out.push('What this means:');
  out.push('Each break represents a moment the prefix cache was invalidated. The agent had to');
  out.push(
    're-write the entire context prefix at cache-write prices (1.25x-2x input rate) instead',
  );
  out.push('of reading it at cache-read prices (0.1x input rate). On a 50k token context, that');
  out.push('cost difference is roughly 50,000 * (1.25 - 0.1) * $0.000015 = $0.0086 per break --');
  out.push('small per event, but repeated breaks in a 5-hour rate limit window can exhaust it.');
  out.push('');
  out.push('To avoid breaks:');
  out.push('  - Do not edit core files (entrypoints, configs, CLAUDE.md) mid-session');
  out.push('  - Keep file load order stable; avoid re-globbing large directories');
  out.push('  - Use subagents for exploratory work that might touch many files');
  out.push('  - Consider /compact to reset the prefix cleanly before a major context shift');

  return out.join('\n').trimEnd();
}
