import { sqliteDriver, type SqliteDatabase, type SqliteDriverName } from '../db/driver.js';
import { openDatabase, resolveDatabasePath, schemaVersion } from '../db/database.js';
import { SyncRepository, type SyncState } from '../db/repositories/sync-repository.js';
import {
  UsageRepository,
  type SessionRow,
  type UsageFilter,
} from '../db/repositories/usage-repository.js';
import { ClaudeCodeCollector } from '../collectors/claude-code/collector.js';
import { OpenCodeCollector } from '../collectors/opencode/collector.js';
import type { ClientId, StoreInfo, UsageCollector } from '../models/usage-record.js';
import {
  AggregationService,
  type ClientReport,
  type DailyReport,
  type ModelReport,
  type ProjectReport,
  type SessionDetail,
  type SummaryReport,
} from './aggregation-service.js';
import { CostService } from './cost-service.js';
import { resolvePeriod, type PeriodInput } from './period.js';
import { SyncService, type SyncOptions, type SyncReport } from './sync-service.js';
import { VerifyService, type VerifyReport } from './verify-service.js';

export interface UsageQuery extends PeriodInput {
  client?: ClientId;
  model?: string;
  projectPath?: string;
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
  pricing: { version: string; provenance: string; overridePath?: string };
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
  private filterFor(query: UsageQuery = {}): { filter: UsageFilter; label: string } {
    const period = resolvePeriod(query);
    const filter: UsageFilter = {
      includeSubagents: query.includeSubagents !== false,
    };
    if (period.since) filter.since = period.since;
    if (period.until) filter.until = period.until;
    if (query.client) filter.client = query.client;
    if (query.model) filter.model = query.model;
    if (query.projectPath) filter.projectPath = query.projectPath;
    return { filter, label: period.label };
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
    };
    if (this.costService.overridePath) pricing.overridePath = this.costService.overridePath;

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

  summary(query: UsageQuery = {}): SummaryReport {
    const { filter, label } = this.filterFor(query);
    return this.aggregation.summary(filter, label);
  }

  modelUsage(query: UsageQuery = {}, limit?: number): ModelReport {
    const { filter, label } = this.filterFor(query);
    return this.aggregation.models(filter, label, limit);
  }

  clientUsage(query: UsageQuery = {}): ClientReport {
    const { filter, label } = this.filterFor(query);
    return this.aggregation.clients(filter, label);
  }

  projectUsage(query: UsageQuery = {}, limit?: number): ProjectReport {
    const { filter, label } = this.filterFor(query);
    return this.aggregation.projects(filter, label, limit);
  }

  recentSessions(query: UsageQuery = {}, limit = 20): SessionRow[] {
    const { filter } = this.filterFor(query);
    return this.aggregation.recentSessions(filter, limit);
  }

  sessionUsage(
    sessionId: string,
    includeSubagents = true,
  ): SessionDetail | { ambiguous: string[] } | undefined {
    return this.aggregation.session(sessionId, includeSubagents);
  }

  dailyUsage(query: UsageQuery = {}): DailyReport {
    const { filter, label } = this.filterFor(query);
    return this.aggregation.daily(filter, label);
  }

  /** True when there is no data at all, so frontends can say so instead of printing zeros. */
  isEmpty(): boolean {
    return this.usageRepo.recordCount() === 0;
  }
}
