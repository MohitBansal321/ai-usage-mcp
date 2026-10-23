import { sqliteDriver, type SqliteDatabase, type SqliteDriverName } from '../db/driver.js';
import { openDatabase, resolveDatabasePath, schemaVersion } from '../db/database.js';
import { SyncRepository, type SyncState } from '../db/repositories/sync-repository.js';
import { PlanLimitRepository } from '../db/repositories/plan-limit-repository.js';
import { parseStatusLineInput } from '../collectors/claude-code/statusline.js';
import {
  UsageRepository,
  type Page,
  type GroupAxis,
  type PageRequest,
  type TimeGrain,
  type SessionRow,
  type UsageFilter,
} from '../db/repositories/usage-repository.js';
import { ClaudeCodeCollector } from '../collectors/claude-code/collector.js';
import {
  readClaudeIntegrations,
  type ClaudeIntegrations,
} from '../collectors/claude-code/settings.js';
import { OpenCodeCollector } from '../collectors/opencode/collector.js';
import { CodexCollector } from '../collectors/codex/collector.js';
import type { ClientId, StoreInfo, UsageCollector } from '../models/usage-record.js';
import {
  AggregationService,
  type BreakdownReport,
  type CacheHealthReport,
  type ClientReport,
  type DailyReport,
  type ModelReport,
  type ProjectReport,
  type SessionDetail,
  type SummaryReport,
} from './aggregation-service.js';
import { ContextService, type ContextLimits, type ContextReading } from './context-service.js';
import { CostService } from './cost-service.js';
import { ExportService, type ExportOptions, type ExportResult } from './export-service.js';
import { LifecycleService } from './lifecycle-service.js';
import {
  BudgetService,
  type BudgetBasis,
  type BudgetPeriod,
  type BudgetReport,
} from './budget-service.js';
import { CounterfactualService, type CounterfactualReport } from './counterfactual-service.js';
import { ComparePeriodError, resolvePeriod, type PeriodInput } from './period.js';
import {
  refreshCommunityPricing,
  type PricingRefreshOptions,
  type PricingRefreshResult,
} from './pricing-refresh.js';
import { RepriceService, type RepriceResult } from './reprice-service.js';
import { SyncService, type SyncOptions, type SyncReport } from './sync-service.js';
import { VerifyService, type VerifyReport } from './verify-service.js';
import { writePremiumPricer, type CacheBreakOptions } from './cache-breaks.js';
import { ReportService, type UsageReport } from './report-service.js';
import {
  PlanLimitService,
  type PlanUsageReport,
  type StatusLineReport,
} from './plan-limit-service.js';
import type { CommunityPricingState } from '../pricing/index.js';

/** A refresh, and what applying it did to the stored rows. */
export type PricingRefreshReport = PricingRefreshResult & {
  /** Present when the refresh changed the table and that priced stored rows. */
  repriced?: RepriceResult;
};

export interface UsageQuery extends PeriodInput {
  /** Restrict to any of these clients. */
  clients?: ClientId[];
  /** Restrict to any of these model ids. */
  models?: string[];
  /** Restrict to any of these project working directories. */
  projectPaths?: string[];
  /** Defaults to true -- subagent turns are real spend. */
  includeSubagents?: boolean;
}

export interface CollectorStatus {
  name: string;
  client: ClientId;
  available: boolean;
  reason?: string;
  stores: StoreInfo[];
  lastSyncAt?: string;
  records: number;
  lastRecordAt?: string;
  /** When the client last wrote to its default source, where the collector can tell. */
  lastWriteAt?: string;
  /** Set when a sync after the source's last write found no turn near it. */
  sourceAhead?: SourceAhead;
}

/**
 * A source written to well after the newest turn collected from it, by a client
 * a sync has looked at since. The usual cause is a format change -- OpenCode 2.x
 * moving new turns to a table we did not read hid two days of usage from a user,
 * and nothing said so. Opening a client without sending a prompt also writes, so
 * this is a prompt to check, never a claim that data is missing.
 */
export interface SourceAhead {
  lastWriteAt: string;
  lastRecordAt: string;
  gapMs: number;
}

/**
 * How far a source may run ahead of its newest turn before `status` says so.
 * On the machine this was calibrated on, OpenCode wrote 56 minutes after its
 * last turn as it shut down; the format change that motivated this left a gap of
 * 39 hours and growing.
 */
export const SOURCE_AHEAD_THRESHOLD_MS = 6 * 60 * 60 * 1000;

export function sourceAhead(
  status: Pick<CollectorStatus, 'lastWriteAt' | 'lastRecordAt' | 'lastSyncAt'>,
  thresholdMs = SOURCE_AHEAD_THRESHOLD_MS,
): SourceAhead | undefined {
  const { lastWriteAt, lastRecordAt, lastSyncAt } = status;
  if (!lastWriteAt || !lastRecordAt || !lastSyncAt) return undefined;
  const write = Date.parse(lastWriteAt);
  // A write after the last sync is simply not collected yet.
  if (write > Date.parse(lastSyncAt)) return undefined;
  const gapMs = write - Date.parse(lastRecordAt);
  if (!(gapMs > thresholdMs)) return undefined;
  return { lastWriteAt, lastRecordAt, gapMs };
}

export interface StatusReport {
  databasePath: string;
  /** Which SQLite implementation produced these numbers. */
  sqliteDriver: SqliteDriverName;
  schemaVersion: number;
  totalRecords: number;
  collectors: CollectorStatus[];
  pricing: {
    version: string;
    provenance: string;
    overridePath?: string;
    /** How the table was assembled: built-in, a user overlay, or a full replacement. */
    mode: 'builtin' | 'overlay' | 'replace';
    /** The built-in table an overlay sits on. Present only for `overlay`. */
    baseVersion?: string;
    /** What the community price list contributes, or why it is off. */
    community?: CommunityPricingState;
  };
  syncState: SyncState[];
  /** Whether the Claude Code status line and prompt hook are switched on. */
  claudeIntegrations: ClaudeIntegrations;
}

/**
 * The single entry point for every frontend.
 *
 * The MCP tools and the CLI both go through this class and nothing else. That is
 * what keeps the MCP layer ignorant of where data comes from, and it is why
 * `ai-usage stats --today` and the `usage_summary` tool cannot disagree: they run
 * the same method with the same arguments.
 */
export class UsageService {
  readonly costService: CostService;
  private readonly usageRepo: UsageRepository;
  private readonly syncRepo: SyncRepository;
  private readonly aggregation: AggregationService;
  private readonly syncService: SyncService;
  private readonly verifyService: VerifyService;
  private readonly reportService: ReportService;
  private readonly counterfactualService: CounterfactualService;
  private readonly exportService: ExportService;
  private readonly budgetService: BudgetService;
  private readonly lifecycleService: LifecycleService;
  private readonly repriceService: RepriceService;
  private readonly planLimitService: PlanLimitService;
  private readonly contextService = new ContextService();
  private readonly collectors: UsageCollector[];

  private constructor(
    private readonly db: SqliteDatabase,
    private readonly dbPath: string,
  ) {
    this.costService = new CostService();
    this.usageRepo = new UsageRepository(db);
    this.syncRepo = new SyncRepository(db);
    this.aggregation = new AggregationService(this.usageRepo);
    this.collectors = [
      new OpenCodeCollector(),
      new ClaudeCodeCollector(this.costService),
      new CodexCollector(this.costService),
    ];
    this.syncService = new SyncService(this.usageRepo, this.syncRepo, this.collectors);
    this.verifyService = new VerifyService(
      this.usageRepo,
      (source) => this.syncRepo.get(source)?.cursor,
    );
    this.reportService = new ReportService(this.usageRepo, this.costService);
    this.counterfactualService = new CounterfactualService(this.usageRepo, this.costService);
    this.exportService = new ExportService(this.usageRepo);
    this.budgetService = new BudgetService(this.usageRepo);
    this.lifecycleService = new LifecycleService(this.usageRepo, db, dbPath);
    this.repriceService = new RepriceService(this.usageRepo, this.costService);
    this.planLimitService = new PlanLimitService(new PlanLimitRepository(db), this.usageRepo);
  }

  static open(options: { dbPath?: string } = {}): UsageService {
    const path = options.dbPath ?? resolveDatabasePath();
    const db = openDatabase({ path });
    return new UsageService(db, path);
  }

  close(): void {
    this.db.close();
  }

  /** Translates a caller-facing query into a repository filter. */
  private filterFor(query: UsageQuery = {}): {
    filter: UsageFilter;
    label: string;
    previous?: { since: string; until: string; label: string };
  } {
    const period = resolvePeriod(query);
    const filter: UsageFilter = {
      includeSubagents: query.includeSubagents !== false,
      // Every read goes through here, so every aggregate can say how many of its
      // records the pricing table has no entry for -- which is what separates a
      // model that is genuinely free from one nobody has priced.
      pricedModels: this.costService.pricedModels(),
    };
    if (period.since) filter.since = period.since;
    if (period.until) filter.until = period.until;
    if (query.clients?.length) filter.clients = query.clients;
    if (query.models?.length) filter.models = query.models;
    if (query.projectPaths?.length) filter.projectPaths = query.projectPaths;
    return {
      filter,
      label: period.label,
      ...(period.previous ? { previous: period.previous } : {}),
    };
  }

  async status(): Promise<StatusReport> {
    const counts = new Map(this.usageRepo.countsByClient().map((c) => [c.client, c]));
    const collectors: CollectorStatus[] = [];

    for (const collector of this.collectors) {
      const availability = await collector.isAvailable();
      const state = this.syncRepo.get(collector.name);
      const count = counts.get(collector.client);
      const status: CollectorStatus = {
        name: collector.name,
        client: collector.client,
        available: availability.available,
        stores: availability.stores,
        records: count?.records ?? 0,
      };
      if (availability.reason) status.reason = availability.reason;
      if (state?.lastSyncAt) status.lastSyncAt = state.lastSyncAt;
      if (count?.lastTimestamp) status.lastRecordAt = count.lastTimestamp;
      if (availability.lastWriteAt) status.lastWriteAt = availability.lastWriteAt;
      const ahead = sourceAhead(status);
      if (ahead) status.sourceAhead = ahead;
      collectors.push(status);
    }

    const pricing: StatusReport['pricing'] = {
      version: this.costService.table.version,
      provenance: this.costService.table.provenance,
      mode: this.costService.pricingMode,
    };
    if (this.costService.overridePath) pricing.overridePath = this.costService.overridePath;
    if (this.costService.baseVersion) pricing.baseVersion = this.costService.baseVersion;
    if (this.costService.community) pricing.community = this.costService.community;

    return {
      databasePath: this.dbPath,
      sqliteDriver: sqliteDriver(),
      schemaVersion: schemaVersion(this.db),
      totalRecords: this.usageRepo.recordCount(),
      collectors,
      pricing,
      syncState: this.syncRepo.all(),
      claudeIntegrations: readClaudeIntegrations(),
    };
  }

  /**
   * Collects, then prices any stored rows the table has since learned to price.
   *
   * The second step runs on every sync, not only after a pricing change: a
   * background refresh can swap the table while a collector is mid-read, and
   * rows that collector priced with the old table land after the swap. The check
   * is one DISTINCT query, and writes nothing when no unpriced row can be priced.
   */
  async sync(options: SyncOptions = {}): Promise<SyncReport> {
    const report = await this.syncService.sync(options);
    const repriced = this.repriceService.repriceUnpriced();
    return repriced.records > 0 ? { ...report, repriced } : report;
  }

  /** Whether any collector has ever synced into this database. */
  hasSynced(): boolean {
    return this.syncRepo.all().some((s) => s.lastSyncAt !== undefined);
  }

  /**
   * Syncs only when the newest sync of any collector is older than `maxAgeMs`.
   *
   * For callers that run far more often than the data changes -- a status line
   * runs on every assistant message. Returns whether a sync ran.
   */
  async syncIfStale(maxAgeMs: number, now = new Date()): Promise<boolean> {
    const newest = Math.max(
      0,
      ...this.syncRepo.all().map((s) => (s.lastSyncAt ? new Date(s.lastSyncAt).getTime() : 0)),
    );
    if (now.getTime() - newest < maxAgeMs) return false;
    await this.sync();
    return true;
  }

  /**
   * Re-reads the pricing in force and prices whatever stored rows it now can.
   * Returns undefined when no price changed. Throws, leaving the current table
   * in force, if the override on disk has become malformed.
   */
  reloadPricing(): RepriceResult | undefined {
    if (!this.costService.reload()) return undefined;
    return this.repriceService.repriceUnpriced();
  }

  /**
   * Downloads the community price list when the cached copy is over a day old,
   * and applies it at once. Never throws: a failed download, or a new list that
   * cannot be applied, leaves the prices in force as they were.
   */
  async refreshPricing(options: PricingRefreshOptions = {}): Promise<PricingRefreshReport> {
    const result = await refreshCommunityPricing(options);
    if (result.status !== 'updated') return result;
    try {
      const repriced = this.reloadPricing();
      return repriced?.records ? { ...result, repriced } : result;
    } catch (err) {
      return { status: 'failed', reason: `downloaded, but not applied: ${(err as Error).message}` };
    }
  }

  verify(options: { allStores?: boolean; cutoff?: Date } = {}): Promise<VerifyReport> {
    return this.verifyService.verify(options);
  }

  summary(query: UsageQuery = {}, options: { compare?: boolean } = {}): SummaryReport {
    const { filter, label, previous } = this.filterFor(query);
    // Silently dropping the comparison is the one outcome to avoid: the caller
    // asked what changed, and a report that simply omits the answer reads as
    // "nothing changed" rather than "I did not check". Only a period with a
    // fixed length has a window before it -- see `resolvePeriod`.
    if (options.compare && !previous) {
      throw new ComparePeriodError(
        // Named without flag dashes on purpose: this message reaches an MCP
        // client too, where the arguments are `days`/`today`/`since`, and
        // telling one to pass `--days` would be advice it cannot act on.
        `Cannot compare "${label}" against the window before it: that needs a period of fixed ` +
          'length -- days, today, or since and until together. An open-ended period (since ' +
          'alone, until alone, or all time) has no equally long window before it.',
      );
    }
    return this.aggregation.summary(filter, label, options.compare ? previous : undefined);
  }

  modelUsage(query: UsageQuery = {}, page: PageRequest = {}): ModelReport {
    const { filter, label } = this.filterFor(query);
    return this.aggregation.models(filter, label, page);
  }

  clientUsage(query: UsageQuery = {}, page: PageRequest = {}): ClientReport {
    const { filter, label } = this.filterFor(query);
    return this.aggregation.clients(filter, label, page);
  }

  projectUsage(query: UsageQuery = {}, page: PageRequest = {}): ProjectReport {
    const { filter, label } = this.filterFor(query);
    return this.aggregation.projects(filter, label, page);
  }

  recentSessions(query: UsageQuery = {}, page: PageRequest = {}): Page<SessionRow> {
    const { filter } = this.filterFor(query);
    return this.aggregation.recentSessions(filter, page);
  }

  sessionUsage(
    sessionId: string,
    includeSubagents = true,
  ): SessionDetail | { ambiguous: string[] } | undefined {
    return this.aggregation.session(sessionId, includeSubagents, this.costService.pricedModels());
  }

  /**
   * Where a period's usage went and how much of it did no new work, with fixes.
   * A report of all time is rarely what anyone wants first, so with no period
   * given it covers the last 7 days -- and its label says so.
   */
  usageReport(query: UsageQuery = {}): UsageReport {
    const hasPeriod = Boolean(query.today || query.days || query.since || query.until);
    const { filter, label } = this.filterFor(hasPeriod ? query : { ...query, days: 7 });
    return this.reportService.report(filter, label);
  }

  cacheHealth(
    sessionId: string,
    includeSubagents = false,
    options: CacheBreakOptions = {},
  ): CacheHealthReport | { ambiguous: string[] } | undefined {
    return this.aggregation.cacheHealth(
      sessionId,
      includeSubagents,
      this.costService.pricedModels(),
      options,
      writePremiumPricer(this.costService),
    );
  }

  dailyUsage(query: UsageQuery = {}, grain: TimeGrain = 'day'): DailyReport {
    const { filter, label } = this.filterFor(query);
    return this.aggregation.daily(filter, label, grain);
  }

  /**
   * Totals cut by two or more dimensions at once -- `project x day`, `model x day`.
   *
   * Answering "which of my projects is getting more expensive" previously meant
   * enumerating projects, issuing one `daily --project` call each, and joining
   * the results: an N+1 pattern that is not feasible as a tool call at all.
   */
  breakdown(axes: GroupAxis[], query: UsageQuery = {}, page: PageRequest = {}): BreakdownReport {
    const { filter, label } = this.filterFor(query);
    return this.aggregation.breakdown(axes, filter, label, page);
  }

  counterfactualCost(query: UsageQuery = {}, models?: string[]): CounterfactualReport {
    const { filter, label } = this.filterFor(query);
    return this.counterfactualService.counterfactual(filter, label, models);
  }

  /**
   * Spend against a target for the current calendar month or week, with the
   * run rate and where it lands at period end.
   */
  budget(options: {
    amount: number;
    basis: BudgetBasis;
    period: BudgetPeriod;
    query?: UsageQuery;
    now?: Date;
  }): BudgetReport {
    // Scope filters apply; the PERIOD does not -- a budget is measured over its
    // own calendar window, and letting --days silently narrow it would report a
    // fraction of the month's spend against the whole month's budget.
    const { filter } = this.filterFor({ ...options.query, days: undefined, today: false });
    delete filter.since;
    delete filter.until;
    return this.budgetService.budget({
      amount: options.amount,
      basis: options.basis,
      period: options.period,
      filter,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  /**
   * Reads the JSON Claude Code hands a status-line command and keeps the
   * plan-limit readings it carried. Never throws on bad input: anything
   * unreadable is no data. Returns the session being rendered, and how many new
   * readings were stored.
   */
  recordStatusLine(
    raw: string,
    now = new Date(),
  ): { sessionId?: string; transcriptPath?: string; written: number } {
    const input = parseStatusLineInput(raw);
    const written = this.planLimitService.record(input, now);
    return {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
      written,
    };
  }

  /**
   * Usage against the Pro/Max 5-hour and weekly limits, as Claude Code last
   * reported it, with this machine's Claude Code turns in each window beside it.
   * Each window is measured over its own span, so no period applies.
   */
  planUsage(options: { includeSubagents?: boolean; now?: Date } = {}): PlanUsageReport {
    const { filter } = this.filterFor({ includeSubagents: options.includeSubagents });
    return this.planLimitService.report(filter, options.now);
  }

  /**
   * What a status line shows: current plan-limit readings, today's totals, and
   * the cache in the session being rendered, and -- given its transcript and the
   * limits -- how large that session's context is. Reads only -- record the
   * payload with `recordStatusLine` first.
   */
  statusLine(
    sessionId: string | undefined,
    now = new Date(),
    context?: { transcriptPath: string | undefined; limits: ContextLimits },
  ): StatusLineReport {
    const { filter } = this.filterFor({});
    const limits: StatusLineReport['limits'] = [];
    for (const w of this.planLimitService.report(filter, now).windows) {
      if (w.state !== 'current' || !w.latest) continue;
      limits.push({
        window: w.window,
        usedPercent: w.latest.usedPercent,
        resetsAt: w.latest.resetsAt,
        ...(w.pace?.fullBeforeReset && w.pace.reachesFullAt
          ? { fullAt: w.pace.reachesFullAt }
          : {}),
      });
    }
    const report: StatusLineReport = {
      limits,
      today: this.usageRepo.totals(this.filterFor({ today: true }).filter),
    };
    if (sessionId) {
      const health = this.cacheHealth(sessionId);
      if (health && !('ambiguous' in health)) {
        report.session = {
          breakCount: health.summary.breakCount,
          ...(health.hitRate !== undefined ? { hitRate: health.hitRate } : {}),
          ...(health.summary.estimatedExtraCost !== undefined
            ? { estimatedExtraCost: health.summary.estimatedExtraCost }
            : {}),
        };
      }
    }
    const reading = context && this.contextSize(context.transcriptPath, context.limits);
    if (reading) report.context = reading;
    return report;
  }

  /**
   * The session's context size against the limits, read from its transcript, or
   * undefined when unknown. Touches no database and never throws.
   */
  contextSize(
    transcriptPath: string | undefined,
    limits: ContextLimits,
  ): ContextReading | undefined {
    return this.contextService.read(transcriptPath, limits);
  }

  /**
   * The repository filter a query resolves to, for a caller that needs the
   * filter itself rather than a report -- currently only the record-level export.
   */
  exportFilter(query: UsageQuery = {}): { filter: UsageFilter; label: string } {
    const { filter, label } = this.filterFor(query);
    return { filter, label };
  }

  /**
   * One row per stored turn, streamed to `write`.
   *
   * The supported route to the underlying records. Previously the only way to
   * reach them was `sqlite3 usage.db '.mode csv' 'SELECT * FROM usage_records'`,
   * which bypasses the product entirely and depends on a schema the docs call
   * internal and unversioned.
   */
  exportRecords(
    filter: UsageFilter,
    write: (line: string) => void,
    options: ExportOptions = {},
  ): ExportResult {
    return this.exportService.export(filter, write, options);
  }

  /**
   * Removes records older than a cutoff. Dry run unless `apply` is true: the
   * only irreversible operation in this package reports what it would remove and
   * changes nothing until told twice.
   */
  prune(
    cutoff: string,
    options: { apply?: boolean; query?: UsageQuery } = {},
  ): ReturnType<LifecycleService['prune']> {
    const { filter } = this.filterFor(options.query ?? {});
    // The period from the query is irrelevant to a prune, which has its own
    // cutoff; leaving `since`/`until` in place would silently narrow what a
    // caller believed they were deleting.
    delete filter.since;
    delete filter.until;
    return this.lifecycleService.prune(cutoff, { ...options, filter });
  }

  /** Compacts the database file after a prune. */
  vacuum(): ReturnType<LifecycleService['vacuum']> {
    return this.lifecycleService.vacuum();
  }

  /** Merges JSON Lines from `ai-usage export --format jsonl`, idempotently. */
  importRecords(lines: Iterable<string>): ReturnType<LifecycleService['import']> {
    return this.lifecycleService.import(lines);
  }

  /** True when there is no data at all, so frontends can say so instead of printing zeros. */
  isEmpty(): boolean {
    return this.usageRepo.recordCount() === 0;
  }
}
