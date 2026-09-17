import { sqliteDriver, type SqliteDatabase, type SqliteDriverName } from '../db/driver.js';
import { openDatabase, resolveDatabasePath, schemaVersion } from '../db/database.js';
import { SyncRepository, type SyncState } from '../db/repositories/sync-repository.js';
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
import { OpenCodeCollector } from '../collectors/opencode/collector.js';
import type { ClientId, StoreInfo, UsageCollector } from '../models/usage-record.js';
import {
  AggregationService,
  type BreakdownReport,
  type ClientReport,
  type DailyReport,
  type ModelReport,
  type ProjectReport,
  type SessionDetail,
  type SummaryReport,
} from './aggregation-service.js';
import { CostService } from './cost-service.js';
import { CounterfactualService, type CounterfactualReport } from './counterfactual-service.js';
import { resolvePeriod, type PeriodInput } from './period.js';
import { SyncService, type SyncOptions, type SyncReport } from './sync-service.js';
import { VerifyService, type VerifyReport } from './verify-service.js';

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
  };
  syncState: SyncState[];
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
  private readonly counterfactualService: CounterfactualService;
  private readonly collectors: UsageCollector[];

  private constructor(
    private readonly db: SqliteDatabase,
    private readonly dbPath: string,
  ) {
    this.costService = new CostService();
    this.usageRepo = new UsageRepository(db);
    this.syncRepo = new SyncRepository(db);
    this.aggregation = new AggregationService(this.usageRepo);
    this.collectors = [new OpenCodeCollector(), new ClaudeCodeCollector(this.costService)];
    this.syncService = new SyncService(this.usageRepo, this.syncRepo, this.collectors);
    this.verifyService = new VerifyService(this.usageRepo);
    this.counterfactualService = new CounterfactualService(this.usageRepo, this.costService);
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
      collectors.push(status);
    }

    const pricing: StatusReport['pricing'] = {
      version: this.costService.table.version,
      provenance: this.costService.table.provenance,
      mode: this.costService.pricingMode,
    };
    if (this.costService.overridePath) pricing.overridePath = this.costService.overridePath;
    if (this.costService.baseVersion) pricing.baseVersion = this.costService.baseVersion;

    return {
      databasePath: this.dbPath,
      sqliteDriver: sqliteDriver(),
      schemaVersion: schemaVersion(this.db),
      totalRecords: this.usageRepo.recordCount(),
      collectors,
      pricing,
      syncState: this.syncRepo.all(),
    };
  }

  sync(options: SyncOptions = {}): Promise<SyncReport> {
    return this.syncService.sync(options);
  }

  verify(options: { allStores?: boolean; cutoff?: Date } = {}): Promise<VerifyReport> {
    return this.verifyService.verify(options);
  }

  summary(query: UsageQuery = {}, options: { compare?: boolean } = {}): SummaryReport {
    const { filter, label, previous } = this.filterFor(query);
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

  /** True when there is no data at all, so frontends can say so instead of printing zeros. */
  isEmpty(): boolean {
    return this.usageRepo.recordCount() === 0;
  }
}
