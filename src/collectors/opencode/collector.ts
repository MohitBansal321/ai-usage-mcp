import { openSqlite, type SqliteDatabase } from '../../db/driver.js';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CollectOptions,
  CollectResult,
  CollectorAvailability,
  StoreInfo,
  UsageCollector,
  UsageRecord,
} from '../../models/usage-record.js';
import { UNKNOWN_MODEL, UNKNOWN_PROVIDER } from '../../models/usage-record.js';
import { isWithin, msToIso, num } from '../collector.js';
import { discoverOpenCodeStores } from './stores.js';

/** Shape of the JSON blob in `message.data` (only the fields we rely on). */
interface OpenCodeMessageData {
  role?: string;
  agent?: string;
  cost?: number;
  modelID?: string;
  providerID?: string;
  path?: { cwd?: string; root?: string };
  time?: { created?: number; completed?: number };
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
  parent_id: string | null;
  directory: string | null;
  client_version: string | null;
  worktree: string | null;
}

export interface OpenCodeCursor {
  /** Per store path: the highest `message.time_updated` already ingested. */
  stores: Record<string, number>;
}

function isOpenCodeCursor(value: unknown): value is OpenCodeCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as OpenCodeCursor).stores === 'object' &&
    (value as OpenCodeCursor).stores !== null
  );
}

/**
 * Reads token usage straight out of OpenCode's SQLite database.
 *
 * Grain: one record per assistant *message*.
 *
 * Why message grain and not the `session` rollup columns, which look more
 * convenient: on the machine this was developed against, the `message` table and
 * the independent `part` (step-finish) table agree byte-for-byte, while the
 * `session` rollup was stale for 4 sessions and lost 545,977 input tokens --
 * three of them recorded `tokens_input = 0` despite having real messages.
 * OpenCode's own `stats` command reads the rollup for its headline block but the
 * message grain for its per-model block, so the two halves of its output do not
 * agree with each other. Message grain is the corroborated number, and it is
 * also the only grain that attributes tokens to the right model when a session
 * switches models partway through. `ai-usage verify` reconciles all three grains.
 */
export class OpenCodeCollector implements UsageCollector {
  readonly name = 'opencode';
  readonly client = 'opencode' as const;

  async isAvailable(): Promise<CollectorAvailability> {
    const stores = discoverOpenCodeStores();
    const usable = stores.filter((s) => s.exists);
    if (usable.length === 0) {
      return {
        available: false,
        reason:
          'No OpenCode database found. Looked for opencode.db under $XDG_DATA_HOME/opencode ' +
          'and ~/.local/share/opencode. Set AI_USAGE_OPENCODE_DB to point at it directly.',
        stores,
      };
    }
    return { available: true, stores };
  }

  async collect(options: CollectOptions): Promise<CollectResult> {
    const stores = discoverOpenCodeStores();
    const notes: string[] = [];
    const existing = stores.filter((s) => s.exists);

    if (existing.length === 0) {
      return {
        records: [],
        notes: ['OpenCode database not found; nothing collected.'],
        stores,
      };
    }

    const targets = options.allStores ? existing : existing.filter((s) => s.primary);
    const skipped = existing.filter((s) => !targets.includes(s));
    for (const s of skipped) {
      notes.push(
        `Additional OpenCode store detected but NOT collected: ${s.path}. ` +
          `It may hold separate history (a sandboxed launcher exporting its own ` +
          `XDG_DATA_HOME is the usual cause) or be a stale copy of the primary. ` +
          `Records are keyed by source message id, so --all-stores merges stores ` +
          `without double counting.`,
      );
    }

    const prior = isOpenCodeCursor(options.cursor) ? options.cursor : { stores: {} };
    const cursor: OpenCodeCursor = { stores: { ...prior.stores } };
    const records: UsageRecord[] = [];

    for (const store of targets) {
      const since = prior.stores[store.path] ?? 0;
      const result = this.collectStore(store, since, options, notes);
      records.push(...result.records);
      cursor.stores[store.path] = Math.max(since, result.maxTimeUpdated);
    }

    return { records, cursor, notes, stores };
  }

  private collectStore(
    store: StoreInfo,
    sinceTimeUpdated: number,
    options: CollectOptions,
    notes: string[],
  ): { records: UsageRecord[]; maxTimeUpdated: number } {
    const opened = openReadOnly(store.path, notes);
    const records: UsageRecord[] = [];
    let maxTimeUpdated = sinceTimeUpdated;
    let unknownModel = 0;

    try {
      const rows = opened.db
        .prepare(
          `SELECT m.id, m.session_id, m.time_created, m.time_updated, m.data,
                  s.parent_id, s.directory, s.version AS client_version,
                  p.worktree
             FROM message m
             JOIN session s ON s.id = m.session_id
             LEFT JOIN project p ON p.id = s.project_id
            WHERE m.time_updated >= ?
            ORDER BY m.time_updated ASC`,
        )
        .iterate(sinceTimeUpdated) as IterableIterator<MessageRow>;

      for (const row of rows) {
        if (row.time_updated > maxTimeUpdated) maxTimeUpdated = row.time_updated;

        let data: OpenCodeMessageData;
        try {
          data = JSON.parse(row.data) as OpenCodeMessageData;
        } catch {
          notes.push(`Skipped OpenCode message ${row.id}: message.data is not valid JSON.`);
          continue;
        }

        // Only assistant turns consume tokens. A missing `tokens` object means the
        // turn produced no usage record -- not that usage was zero.
        if (data.role !== 'assistant' || !data.tokens) continue;

        const timestamp = msToIso(data.time?.created) ?? msToIso(row.time_created) ?? undefined;
        if (!timestamp) {
          notes.push(`Skipped OpenCode message ${row.id}: no usable timestamp.`);
          continue;
        }
        if (!isWithin(timestamp, options.since, options.until)) continue;

        const t = data.tokens;
        const inputTokens = num(t.input);
        const outputTokens = num(t.output);
        const reasoningTokens = num(t.reasoning);
        const cacheReadTokens = num(t.cache?.read);
        const cacheWriteTokens = num(t.cache?.write);

        const model = data.modelID ?? UNKNOWN_MODEL;
        const provider = data.providerID ?? UNKNOWN_PROVIDER;
        if (model === UNKNOWN_MODEL) unknownModel++;

        const projectPath = data.path?.root ?? row.directory ?? row.worktree ?? undefined;

        const record: UsageRecord = {
          id: `opencode:msg:${row.id}`,
          client: 'opencode',
          provider,
          model,
          sessionId: row.session_id,
          timestamp,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          reasoningTokens,
          // OpenCode treats `reasoning` as a sibling of `output`, not a subset of
          // it (verified: tokens.total === input + output + reasoning + cache.read),
          // so reasoning IS part of our total here. Claude Code is the opposite.
          totalTokens:
            inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens,
          // OpenCode reports cost directly. A reported 0 (free model) is a real
          // zero, not missing data, so the basis stays 'reported'.
          cost: num(data.cost),
          costBasis: 'reported',
          currency: 'USD',
          turnKind: row.parent_id ? 'subagent' : 'main',
          source: 'opencode.db:message',
        };
        if (projectPath) record.projectPath = projectPath;
        if (row.client_version) record.sourceVersion = row.client_version;

        records.push(record);
      }
    } finally {
      opened.close();
    }

    if (unknownModel > 0) {
      notes.push(
        `${unknownModel} OpenCode message(s) record no model id; reported as "${UNKNOWN_MODEL}".`,
      );
    }
    return { records, maxTimeUpdated };
  }
}

interface OpenedDb {
  db: SqliteDatabase;
  close(): void;
}

/**
 * Opens a possibly-live OpenCode database without disturbing it.
 *
 * Preferred path is a direct read-only connection: it takes ~15ms even on a
 * 900MB database, and a read-only connection cannot mutate the file. The
 * fallback copies the .db plus its -wal and -shm sidecars to a temp directory and
 * reads the copy -- correct but expensive, so it is only used if the direct open
 * fails (unreadable -shm, a lock we cannot share, an exclusive-locking database).
 */
function openReadOnly(path: string, notes: string[]): OpenedDb {
  try {
    const db = openSqlite(path, { readonly: true });
    // Touch the schema so a failure surfaces here rather than mid-iteration.
    db.prepare('SELECT 1 FROM session LIMIT 1').get();
    return { db, close: () => db.close() };
  } catch (directErr) {
    notes.push(
      `Direct read-only open of ${path} failed (${(directErr as Error).message}); ` +
        `falling back to a temporary snapshot copy.`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'ai-usage-opencode-'));
  const target = join(dir, 'opencode.db');
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${path}${suffix}`;
    if (existsSync(src)) copyFileSync(src, `${target}${suffix}`);
  }
  const db = openSqlite(target, { readonly: true });
  return {
    db,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
