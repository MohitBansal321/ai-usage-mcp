import { openSqlite, type SqliteDatabase } from '../../db/driver.js';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CollectOptions,
  CollectResult,
  CollectorAvailability,
  SessionTitle,
  StoreInfo,
  UsageCollector,
  UsageRecord,
} from '../../models/usage-record.js';
import {
  normaliseProjectPath,
  UNKNOWN_MODEL,
  UNKNOWN_PROVIDER,
} from '../../models/usage-record.js';
import { isWithin, msToIso, num } from '../collector.js';
import { discoverOpenCodeStores } from './stores.js';

/** OpenCode's placeholder for a session it has not titled yet. */
const DEFAULT_TITLE = /^New session - \d{4}-\d{2}-\d{2}T/;

/** Shape of the JSON blob in `message.data` (only the fields we rely on). */
interface OpenCodeMessageData {
  role?: string;
  agent?: string;
  cost?: number;
  modelID?: string;
  providerID?: string;
  path?: { cwd?: string; root?: string };
  time?: { created?: number; completed?: number };
  tokens?: OpenCodeTokens;
}

/**
 * Shape of the JSON blob in `session_message.data` -- where OpenCode 2.x writes
 * turns instead of `message`. The role is the row's `type` column, not a field
 * here, and the model is nested rather than flat.
 */
interface OpenCodeSessionMessageData {
  cost?: number;
  model?: { id?: string; providerID?: string };
  time?: { created?: number; completed?: number };
  tokens?: OpenCodeTokens;
}

interface OpenCodeTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
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

/** One assistant turn, read out of either table and reduced to what a record needs. */
interface Turn {
  model: string | undefined;
  provider: string | undefined;
  /** Epoch ms from the payload; the row's own `time_created` is the fallback. */
  created: number | undefined;
  /** Working directory recorded in the payload itself (legacy `message` only). */
  root: string | undefined;
  cost: number | undefined;
  tokens: OpenCodeTokens;
}

export interface OpenCodeCursor {
  /** Per store path: the highest `message.time_updated` already ingested. */
  stores: Record<string, number>;
  /**
   * Per store path: the highest `session_message.time_updated` already ingested.
   * Absent in cursors written before OpenCode 2.x support, which reads as 0 and
   * so reads the table once from the start.
   */
  sessionMessages?: Record<string, number>;
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
    const cursor: OpenCodeCursor = {
      stores: { ...prior.stores },
      sessionMessages: { ...prior.sessionMessages },
    };
    const records: UsageRecord[] = [];
    const sessionTitles: SessionTitle[] = [];

    for (const store of targets) {
      const since = {
        message: prior.stores[store.path] ?? 0,
        sessionMessage: prior.sessionMessages?.[store.path] ?? 0,
      };
      const result = this.collectStore(store, since, options, notes);
      records.push(...result.records);
      sessionTitles.push(...result.titles);
      cursor.stores[store.path] = Math.max(since.message, result.maxMessageUpdated);
      cursor.sessionMessages![store.path] = Math.max(
        since.sessionMessage,
        result.maxSessionMessageUpdated,
      );
    }

    return {
      records,
      cursor,
      notes,
      stores,
      ...(sessionTitles.length > 0 ? { sessionTitles } : {}),
    };
  }

  private collectStore(
    store: StoreInfo,
    since: { message: number; sessionMessage: number },
    options: CollectOptions,
    notes: string[],
  ): {
    records: UsageRecord[];
    maxMessageUpdated: number;
    maxSessionMessageUpdated: number;
    titles: SessionTitle[];
  } {
    const opened = openReadOnly(store.path, notes);
    const records: UsageRecord[] = [];
    const titles: SessionTitle[] = [];
    let maxMessageUpdated = since.message;
    let maxSessionMessageUpdated = since.sessionMessage;
    let unknownModel = 0;

    // OpenCode 2.x moved new turns from `message` to `session_message` and new
    // sessions from `session` to `session_v2`, leaving the old tables frozen. An
    // install can hold either or both, so read whatever is present.
    const tables = listTables(opened.db);
    const sessionTables = SESSION_TABLES.filter((t) => tables.has(t));
    const sessionColumn = (column: string): string => {
      const candidates = sessionTables.map((_, i) => `s${i}.${column}`);
      // COALESCE needs two arguments; a legacy-only install has one session table.
      return candidates.length > 1
        ? `COALESCE(${candidates.join(', ')})`
        : (candidates[0] ?? 'NULL');
    };
    const sessionJoins = sessionTables
      .map((t, i) => `LEFT JOIN ${t} s${i} ON s${i}.id = m.session_id`)
      .join('\n');
    const projectJoin = tables.has('project')
      ? `LEFT JOIN project p ON p.id = ${sessionColumn('project_id')}`
      : '';
    const select = `SELECT m.id, m.session_id, m.time_created, m.time_updated, m.data,
                  ${sessionColumn('parent_id')} AS parent_id,
                  ${sessionColumn('directory')} AS directory,
                  ${sessionColumn('version')} AS client_version,
                  ${projectJoin ? 'p.worktree' : 'NULL'} AS worktree`;

    const seen = new Set<string>();
    const ingest = (row: MessageRow, source: string, turn: Turn | undefined): void => {
      // Only assistant turns consume tokens. A missing `tokens` object means the
      // turn produced no usage record -- not that usage was zero.
      if (!turn) return;

      const timestamp = msToIso(turn.created) ?? msToIso(row.time_created) ?? undefined;
      if (!timestamp) {
        notes.push(`Skipped OpenCode message ${row.id}: no usable timestamp.`);
        return;
      }
      if (!isWithin(timestamp, options.since, options.until)) return;

      const t = turn.tokens;
      const inputTokens = num(t.input);
      const outputTokens = num(t.output);
      const reasoningTokens = num(t.reasoning);
      const cacheReadTokens = num(t.cache?.read);
      const cacheWriteTokens = num(t.cache?.write);

      const model = turn.model ?? UNKNOWN_MODEL;
      const provider = turn.provider ?? UNKNOWN_PROVIDER;
      if (model === UNKNOWN_MODEL) unknownModel++;

      const projectPath = turn.root ?? row.directory ?? row.worktree ?? undefined;

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
        cost: num(turn.cost),
        costBasis: 'reported',
        currency: 'USD',
        turnKind: row.parent_id ? 'subagent' : 'main',
        source: `opencode.db:${source}`,
      };
      if (projectPath) record.projectPath = normaliseProjectPath(projectPath);
      if (row.client_version) record.sourceVersion = row.client_version;

      if (seen.has(record.id)) return;
      seen.add(record.id);
      records.push(record);
    };

    try {
      if (tables.has('message')) {
        const rows = opened.db
          .prepare(
            `${select}
               FROM message m
               ${sessionJoins}
               ${projectJoin}
              WHERE m.time_updated >= ?
              ORDER BY m.time_updated ASC`,
          )
          .iterate(since.message) as IterableIterator<MessageRow>;

        for (const row of rows) {
          if (row.time_updated > maxMessageUpdated) maxMessageUpdated = row.time_updated;

          let data: OpenCodeMessageData;
          try {
            data = JSON.parse(row.data) as OpenCodeMessageData;
          } catch {
            notes.push(`Skipped OpenCode message ${row.id}: message.data is not valid JSON.`);
            continue;
          }
          ingest(
            row,
            'message',
            data.role === 'assistant' && data.tokens
              ? {
                  model: data.modelID,
                  provider: data.providerID,
                  created: data.time?.created,
                  root: data.path?.root,
                  cost: data.cost,
                  tokens: data.tokens,
                }
              : undefined,
          );
        }
      }

      if (tables.has('session_message')) {
        // The same turn can sit in both tables while a database straddles the
        // switch, under the same id. `message` wins: it is the older, corroborated
        // reading and it carries the payload's own working directory, so a turn
        // keeps the project it was first attributed to.
        const alreadyInMessage = tables.has('message')
          ? `AND NOT EXISTS (SELECT 1 FROM message lm
                              WHERE lm.id = m.id AND json_extract(lm.data, '$.tokens') IS NOT NULL)`
          : '';
        const rows = opened.db
          .prepare(
            `${select}
               FROM session_message m
               ${sessionJoins}
               ${projectJoin}
              WHERE m.type = 'assistant' AND m.time_updated >= ?
                ${alreadyInMessage}
              ORDER BY m.time_updated ASC`,
          )
          .iterate(since.sessionMessage) as IterableIterator<MessageRow>;

        for (const row of rows) {
          if (row.time_updated > maxSessionMessageUpdated) {
            maxSessionMessageUpdated = row.time_updated;
          }

          let data: OpenCodeSessionMessageData;
          try {
            data = JSON.parse(row.data) as OpenCodeSessionMessageData;
          } catch {
            notes.push(
              `Skipped OpenCode message ${row.id}: session_message.data is not valid JSON.`,
            );
            continue;
          }
          ingest(
            row,
            'session_message',
            data.tokens
              ? {
                  model: data.model?.id,
                  provider: data.model?.providerID,
                  created: data.time?.created,
                  root: undefined,
                  cost: data.cost,
                  tokens: data.tokens,
                }
              : undefined,
          );
        }
      }

      // Titles are read whole every sync: the session tables are small (hundreds of
      // rows), and a title changes without its messages changing, so the message
      // cursor cannot say which ones are stale. OpenCode names an untitled session
      // "New session - <timestamp>"; that is a placeholder, not a title. Tables are
      // read oldest-schema first so a session present in both takes the newer title.
      const byId = new Map<string, string>();
      for (const table of [...sessionTables].reverse()) {
        for (const s of opened.db
          .prepare(`SELECT id, title FROM ${table} WHERE title IS NOT NULL`)
          .iterate() as IterableIterator<{ id: string; title: string }>) {
          const title = s.title.trim();
          if (title && !DEFAULT_TITLE.test(title)) byId.set(s.id, title);
        }
      }
      for (const [sessionId, title] of byId) titles.push({ sessionId, title });
    } finally {
      opened.close();
    }

    if (unknownModel > 0) {
      notes.push(
        `${unknownModel} OpenCode message(s) record no model id; reported as "${UNKNOWN_MODEL}".`,
      );
    }
    return { records, maxMessageUpdated, maxSessionMessageUpdated, titles };
  }
}

/** Newest schema first: a session present in both tables takes its row from `session_v2`. */
const SESSION_TABLES = ['session_v2', 'session'] as const;

function listTables(db: SqliteDatabase): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
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
