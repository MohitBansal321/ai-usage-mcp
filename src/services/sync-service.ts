import type { SyncRepository } from '../db/repositories/sync-repository.js';
import type { UsageRepository } from '../db/repositories/usage-repository.js';
import type {
  ClientId,
  CollectOptions,
  StoreInfo,
  UsageCollector,
} from '../models/usage-record.js';

export interface SyncOptions {
  since?: Date;
  until?: Date;
  /** Read every detected store, not only the one the client itself uses. */
  allStores?: boolean;
  /** Restrict to specific clients. */
  clients?: ClientId[];
  /** Ignore saved cursors and re-read everything. */
  full?: boolean;
}

export interface CollectorSyncResult {
  collector: string;
  client: ClientId;
  available: boolean;
  reason?: string;
  recordsWritten: number;
  notes: string[];
  stores: StoreInfo[];
  durationMs: number;
}

export interface SyncReport {
  results: CollectorSyncResult[];
  totalRecords: number;
  startedAt: string;
  durationMs: number;
}

export class SyncService {
  constructor(
    private readonly usageRepo: UsageRepository,
    private readonly syncRepo: SyncRepository,
    private readonly collectors: UsageCollector[],
  ) {}

  async sync(options: SyncOptions = {}): Promise<SyncReport> {
    const startedAt = new Date();
    const results: CollectorSyncResult[] = [];

    const selected = options.clients
      ? this.collectors.filter((c) => options.clients?.includes(c.client))
      : this.collectors;

    for (const collector of selected) {
      const t0 = Date.now();
      const availability = await collector.isAvailable();

      if (!availability.available) {
        results.push({
          collector: collector.name,
          client: collector.client,
          available: false,
          ...(availability.reason ? { reason: availability.reason } : {}),
          recordsWritten: 0,
          notes: [],
          stores: availability.stores,
          durationMs: Date.now() - t0,
        });
        continue;
      }

      const prior = this.syncRepo.get(collector.name);
      const collectOptions: CollectOptions = {
        ...(options.since ? { since: options.since } : {}),
        ...(options.until ? { until: options.until } : {}),
        ...(options.allStores ? { allStores: true } : {}),
        ...(options.full || !prior?.cursor ? {} : { cursor: prior.cursor }),
      };

      try {
        const result = await collector.collect(collectOptions);
        const written = this.usageRepo.upsertMany(result.records);
        this.syncRepo.set({
          source: collector.name,
          lastSyncAt: new Date().toISOString(),
          cursor: result.cursor,
          notes: result.notes.join('\n') || undefined,
        });
        results.push({
          collector: collector.name,
          client: collector.client,
          available: true,
          recordsWritten: written,
          notes: result.notes,
          stores: result.stores,
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        // A collector failure must never be reported as "zero usage".
        results.push({
          collector: collector.name,
          client: collector.client,
          available: false,
          reason: `Collection failed: ${(err as Error).message}`,
          recordsWritten: 0,
          notes: [],
          stores: availability.stores,
          durationMs: Date.now() - t0,
        });
      }
    }

    return {
      results,
      totalRecords: results.reduce((a, r) => a + r.recordsWritten, 0),
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
    };
  }
}
