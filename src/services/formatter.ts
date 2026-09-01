import type { AggregateRow, SessionRow } from '../db/repositories/usage-repository.js';
import type { CostTotals } from '../models/usage-record.js';
import type {
  ClientReport,
  ModelReport,
  ProjectReport,
  SessionDetail,
  SummaryReport,
} from './aggregation-service.js';
import type { CostService } from './cost-service.js';
import type { StatusReport } from './usage-service.js';
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
  if (cost.reportedRecords === 0 && cost.estimatedRecords === 0 && cost.unavailableRecords === 0) {
    lines.push(`${indent}Cost: no records in this period.`);
  }
  if (cost.estimatedRecords > 0) {
    lines.push(`${indent}Note: ${costService.estimatedCostLabel()}`);
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
  out.push('');
  out.push(...costLines(report.overall.cost, costService));

  out.push('');
  out.push('By client:');
  for (const client of report.byClient) {
    out.push(
      `  ${client.key}  --  ${int(client.records)} records, ${int(client.sessions)} sessions`,
    );
    out.push(...tokenLines(client, '    '));
    out.push(...costLines(client.cost, costService, '    '));
    out.push('');
  }
  return out.join('\n').trimEnd();
}

export function formatModels(report: ModelReport, costService: CostService): string {
  const out: string[] = [];
  out.push(`Usage by model -- ${report.period.label}`);
  out.push(subagentNote(report));
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
  return out.join('\n');
}

export function formatProjects(report: ProjectReport, costService: CostService): string {
  const out: string[] = [];
  out.push(`Usage by project -- ${report.period.label}`);
  out.push(subagentNote(report));
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
  out.push('');
  if (report.clients.length === 0) {
    out.push('No usage records for this period.');
    return out.join('\n');
  }
  for (const client of report.clients) {
    out.push(`${client.key}  --  ${int(client.records)} records, ${int(client.sessions)} sessions`);
    out.push(...tokenLines(client, '  '));
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

export function formatSessions(sessions: SessionRow[], costService: CostService): string {
  if (sessions.length === 0) return 'No sessions recorded. Run `ai-usage sync` first.';
  const out: string[] = [`Recent sessions (${sessions.length}):`, ''];
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

export function formatStatus(status: StatusReport): string {
  const out: string[] = [];
  out.push('ai-usage status');
  out.push('');
  out.push(`Database:       ${status.databasePath}`);
  out.push(`Schema version: ${status.schemaVersion}`);
  out.push(`Total records:  ${int(status.totalRecords)}`);
  out.push(`Pricing table:  ${status.pricing.version}  (${status.pricing.provenance})`);
  if (status.pricing.overridePath) {
    out.push(`  Overridden by: ${status.pricing.overridePath}`);
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
  return out.join('\n');
}

export function formatSyncReport(report: SyncReport): string {
  const out: string[] = [
    `Sync finished in ${report.durationMs}ms -- ${int(report.totalRecords)} record(s) written.`,
    '',
  ];
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
