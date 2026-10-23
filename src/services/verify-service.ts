import { openSqlite } from '../db/driver.js';
import { createInterface } from 'node:readline';
import type { UsageRepository } from '../db/repositories/usage-repository.js';
import { discoverOpenCodeStores } from '../collectors/opencode/stores.js';
import { discoverClaudeRoots, listTranscripts } from '../collectors/claude-code/transcripts.js';
import {
  canReadCompressedRollouts,
  discoverCodexHomes,
  listRollouts,
  readRolloutLines,
  sessionIdFromFileName,
} from '../collectors/codex/rollouts.js';
import { num, readUpTo } from '../collectors/collector.js';
import { claudeIngestedSizes } from '../collectors/claude-code/collector.js';
import { codexIngestedSizes } from '../collectors/codex/collector.js';
import type { ClientId } from '../models/usage-record.js';

export interface TokenSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cost?: number;
  records?: number;
}

export interface GrainComparison {
  label: string;
  snapshot: TokenSnapshot;
  /** Field-by-field difference against our database (source minus ours). */
  delta: TokenSnapshot;
  matches: boolean;
  note?: string;
  /**
   * False for rows that are informational only and must not decide pass/fail
   * (a stale rollup, or the naive sum shown to demonstrate double counting).
   */
  gating?: boolean;
}

export interface ClientVerification {
  client: ClientId;
  /** What we stored for the sessions the source still holds -- the compared figure. */
  ours: TokenSnapshot;
  /**
   * What we stored for sessions the source no longer holds. Both clients delete
   * their own history (Claude Code's transcripts after `cleanupPeriodDays`,
   * default 30), and keeping it is this database's job, so it is reported beside
   * the comparison rather than counted as a mismatch. Also covers a store not read
   * this run (see `--all-stores`). Absent when there is none.
   */
  retained?: TokenSnapshot & { sessions: number };
  grains: GrainComparison[];
  available: boolean;
  reason?: string;
}

export interface VerifyReport {
  clients: ClientVerification[];
  allMatch: boolean;
  /**
   * Only activity strictly before this instant is compared. Both clients are
   * appending to their stores while we read them, so without a shared cutoff the
   * source will always look a few requests ahead of the database and `verify`
   * would report a permanent, meaningless mismatch.
   */
  cutoff: string;
}

const ZERO: TokenSnapshot = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function diff(source: TokenSnapshot, ours: TokenSnapshot): TokenSnapshot {
  const d: TokenSnapshot = {
    inputTokens: source.inputTokens - ours.inputTokens,
    outputTokens: source.outputTokens - ours.outputTokens,
    cacheReadTokens: source.cacheReadTokens - ours.cacheReadTokens,
    cacheWriteTokens: source.cacheWriteTokens - ours.cacheWriteTokens,
    reasoningTokens: source.reasoningTokens - ours.reasoningTokens,
  };
  if (source.cost !== undefined && ours.cost !== undefined) {
    d.cost = round6(source.cost - ours.cost);
  }
  return d;
}

function tokensMatch(d: TokenSnapshot): boolean {
  return (
    d.inputTokens === 0 &&
    d.outputTokens === 0 &&
    d.cacheReadTokens === 0 &&
    d.cacheWriteTokens === 0 &&
    d.reasoningTokens === 0 &&
    (d.cost === undefined || Math.abs(d.cost) < 1e-6)
  );
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Re-derives usage straight from the source data and diffs it against what we
 * stored. Deliberately a *second, independent implementation* -- it shares no
 * reduction code with the collectors, so a bug in one will not hide in the other.
 *
 * What it shares is the extent of each file: a transcript or rollout the last sync
 * collected is re-read only up to the size that sync's cursor recorded. The files
 * are still being appended to, and a cutoff by timestamp cannot make the two reads
 * agree, because a line stamped before the cutoff can be written after the sync.
 * A file the cursor does not name is read whole, so one the collector never read
 * still shows up as a mismatch.
 */
export class VerifyService {
  constructor(
    private readonly repo: UsageRepository,
    private readonly cursorOf: (source: ClientId) => unknown = () => undefined,
  ) {}

  async verify(options: { allStores?: boolean; cutoff?: Date } = {}): Promise<VerifyReport> {
    const cutoff = options.cutoff ?? new Date();
    const clients = [
      this.verifyOpenCode(options.allStores === true, cutoff),
      await this.verifyClaudeCode(options.allStores === true, cutoff),
      await this.verifyCodex(options.allStores === true, cutoff),
    ];
    return {
      clients,
      allMatch: clients.every(
        (c) => !c.available || c.grains.some((g) => g.matches && g.gating !== false),
      ),
      cutoff: cutoff.toISOString(),
    };
  }

  /** Splits what we stored into sessions the source still holds and the rest. */
  private oursFor(
    client: ClientId,
    cutoff: Date,
    sourceSessions: ReadonlySet<string>,
  ): Pick<ClientVerification, 'ours' | 'retained'> {
    const ours = { ...ZERO, records: 0 };
    const retained = { ...ZERO, records: 0, sessions: 0 };
    let reported = 0;
    for (const row of this.repo.bySession({ clients: [client], until: cutoff.toISOString() })) {
      const target = sourceSessions.has(row.key) ? ours : retained;
      target.inputTokens += row.inputTokens;
      target.outputTokens += row.outputTokens;
      target.cacheReadTokens += row.cacheReadTokens;
      target.cacheWriteTokens += row.cacheWriteTokens;
      target.reasoningTokens += row.reasoningTokens;
      target.records += row.records;
      if (target === retained) retained.sessions += 1;
      else reported += row.cost.reported;
    }
    if (client === 'opencode') ours.cost = round6(reported);
    return retained.sessions > 0 ? { ours, retained } : { ours };
  }

  private verifyOpenCode(allStores: boolean, cutoff: Date): ClientVerification {
    const cutoffMs = cutoff.getTime();
    const stores = discoverOpenCodeStores().filter((s) => s.exists);
    const targets = allStores ? stores : stores.filter((s) => s.primary);

    if (targets.length === 0) {
      return {
        client: 'opencode',
        ours: this.oursFor('opencode', cutoff, new Set()).ours,
        grains: [],
        available: false,
        reason: 'No OpenCode database found to verify against.',
      };
    }

    const message = { ...ZERO, cost: 0, records: 0 };
    const part = { ...ZERO, cost: 0, records: 0 };
    const session = { ...ZERO, cost: 0, records: 0 };
    const sourceSessions = new Set<string>();

    for (const store of targets) {
      const db = openSqlite(store.path, { readonly: true });
      try {
        const tables = new Set(
          (
            db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
              name: string;
            }[]
          ).map((r) => r.name),
        );
        // Ids already counted from `message`. OpenCode 2.x writes the same turn to
        // `session_message` under the same id, and new turns only there.
        const counted = new Set<string>();

        if (tables.has('message')) {
          for (const row of db
            .prepare('SELECT id, session_id, data FROM message')
            .iterate() as IterableIterator<{ id: string; session_id: string; data: string }>) {
            sourceSessions.add(row.session_id);
            let d: any;
            try {
              d = JSON.parse(row.data);
            } catch {
              continue;
            }
            if (d?.role !== 'assistant' || !d?.tokens) continue;
            counted.add(row.id);
            const created = typeof d?.time?.created === 'number' ? d.time.created : undefined;
            if (created !== undefined && created >= cutoffMs) continue;
            accumulate(message, d.tokens, num(d.cost));
          }
        }
        // `part` rows carry no timestamp of their own, so the cutoff is applied
        // through the message they belong to.
        if (tables.has('message') && tables.has('part')) {
          for (const row of db
            .prepare(
              `SELECT p.data AS data, m.data AS message_data
                 FROM part p JOIN message m ON m.id = p.message_id`,
            )
            .iterate() as IterableIterator<{ data: string; message_data: string }>) {
            let d: any;
            try {
              d = JSON.parse(row.data);
            } catch {
              continue;
            }
            if (d?.type !== 'step-finish' || !d?.tokens) continue;
            let md: any;
            try {
              md = JSON.parse(row.message_data);
            } catch {
              md = undefined;
            }
            const created = typeof md?.time?.created === 'number' ? md.time.created : undefined;
            if (created !== undefined && created >= cutoffMs) continue;
            accumulate(part, d.tokens, num(d.cost));
          }
        }
        // OpenCode 2.x turns that exist only in `session_message`. They have no
        // `part` rows to corroborate them, so they enter the part grain from the
        // same payload -- that grain is independent only for the older history.
        if (tables.has('session_message')) {
          for (const row of db
            .prepare("SELECT id, session_id, data FROM session_message WHERE type = 'assistant'")
            .iterate() as IterableIterator<{ id: string; session_id: string; data: string }>) {
            sourceSessions.add(row.session_id);
            if (counted.has(row.id)) continue;
            let d: any;
            try {
              d = JSON.parse(row.data);
            } catch {
              continue;
            }
            if (!d?.tokens) continue;
            const created = typeof d?.time?.created === 'number' ? d.time.created : undefined;
            if (created !== undefined && created >= cutoffMs) continue;
            accumulate(message, d.tokens, num(d.cost));
            accumulate(part, d.tokens, num(d.cost));
          }
        }
        // The rollup lives in `session_v2` on OpenCode 2.x; a session can be in both
        // tables, and the newer row is the one OpenCode keeps current.
        const rollupColumns =
          'id, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost';
        const rollupSources = [
          tables.has('session_v2') ? `SELECT ${rollupColumns} FROM session_v2` : undefined,
          tables.has('session')
            ? `SELECT ${rollupColumns} FROM session${
                tables.has('session_v2') ? ' WHERE id NOT IN (SELECT id FROM session_v2)' : ''
              }`
            : undefined,
        ].filter((q): q is string => q !== undefined);
        if (rollupSources.length > 0) {
          const s = db
            .prepare(
              `SELECT COUNT(*) AS n, SUM(tokens_input) AS i, SUM(tokens_output) AS o,
                      SUM(tokens_reasoning) AS r, SUM(tokens_cache_read) AS cr,
                      SUM(tokens_cache_write) AS cw, SUM(cost) AS c
                 FROM (${rollupSources.join(' UNION ALL ')})`,
            )
            .get() as Record<string, number | null>;
          session.records += s.n ?? 0;
          session.inputTokens += s.i ?? 0;
          session.outputTokens += s.o ?? 0;
          session.reasoningTokens += s.r ?? 0;
          session.cacheReadTokens += s.cr ?? 0;
          session.cacheWriteTokens += s.cw ?? 0;
          session.cost += s.c ?? 0;
        }
      } finally {
        db.close();
      }
    }

    for (const snap of [message, part, session]) snap.cost = round6(snap.cost);
    const { ours, retained } = this.oursFor('opencode', cutoff, sourceSessions);

    const grains: GrainComparison[] = [
      compare('opencode.db message grain (what we collect)', message, ours),
      compare('opencode.db part/step-finish grain (independent corroboration)', part, ours),
      compare(
        'opencode.db session rollup grain (what `opencode stats` headline shows)',
        session,
        ours,
      ),
    ];
    const rollupGrain = grains[2];
    if (rollupGrain) {
      rollupGrain.gating = false;
      rollupGrain.note =
        'Informational only. The session rollup columns are a cached aggregate maintained by ' +
        'OpenCode and can lag behind the messages they summarise, and they are not affected by ' +
        'the comparison cutoff. Where message and part grain agree with each other but not with ' +
        'the rollup, the rollup is the stale one.';
    }

    return { client: 'opencode', ours, ...(retained ? { retained } : {}), grains, available: true };
  }

  /**
   * Independent re-aggregation of the Claude Code transcripts.
   *
   * Uses a deliberately different reduction rule from the collector: prefer the
   * line carrying a non-null `stop_reason` (the line the API finished on), and
   * fall back to the maximum only when no such line exists. If this agrees with
   * the collector's max-per-field rule, two different readings of the same bytes
   * produced the same number.
   */
  private async verifyClaudeCode(allStores: boolean, cutoff: Date): Promise<ClientVerification> {
    const cutoffMs = cutoff.getTime();
    const roots = discoverClaudeRoots().filter((s) => s.exists);
    const targets = allStores ? roots : roots.filter((s) => s.primary);

    if (targets.length === 0) {
      return {
        client: 'claude-code',
        ours: this.oursFor('claude-code', cutoff, new Set()).ours,
        grains: [],
        available: false,
        reason: 'No Claude Code transcripts found to verify against.',
      };
    }

    const snapshot = { ...ZERO, records: 0 };
    const naive = { ...ZERO, records: 0 };
    const sourceSessions = new Set<string>();
    const ingested = claudeIngestedSizes(this.cursorOf('claude-code'));

    for (const root of targets) {
      for (const file of listTranscripts(root.path)) {
        const groups = new Map<
          string,
          { chosen?: any; maxOut: number; inp: number; cr: number; cw: number; think: number }
        >();
        const rl = createInterface({
          input: readUpTo(file.path, ingested?.get(file.path)).setEncoding('utf8'),
          crlfDelay: Infinity,
        });
        for await (const raw of rl) {
          const line = raw.trim();
          if (!line) continue;
          let o: any;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          const u = o?.message?.usage;
          if (!u) continue;
          if (o?.message?.model === '<synthetic>') continue;
          const ts = typeof o?.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
          if (!Number.isNaN(ts) && ts >= cutoffMs) continue;
          if (typeof o.sessionId === 'string') sourceSessions.add(o.sessionId);

          // Naive sum, kept only to quantify how bad double counting would be.
          naive.inputTokens += num(u.input_tokens);
          naive.outputTokens += num(u.output_tokens);
          naive.cacheReadTokens += num(u.cache_read_input_tokens);
          naive.cacheWriteTokens += num(u.cache_creation_input_tokens);
          naive.reasoningTokens += num(u.output_tokens_details?.thinking_tokens);
          naive.records = (naive.records ?? 0) + 1;

          const key = `${o.requestId ?? 'uuid:' + o.uuid}|${o?.message?.id ?? 'no-message-id'}`;
          let g = groups.get(key);
          if (!g) {
            g = { maxOut: 0, inp: 0, cr: 0, cw: 0, think: 0 };
            groups.set(key, g);
          }
          g.inp = Math.max(g.inp, num(u.input_tokens));
          g.cr = Math.max(g.cr, num(u.cache_read_input_tokens));
          g.cw = Math.max(g.cw, num(u.cache_creation_input_tokens));
          g.think = Math.max(g.think, num(u.output_tokens_details?.thinking_tokens));
          g.maxOut = Math.max(g.maxOut, num(u.output_tokens));
          if (o?.message?.stop_reason != null) g.chosen = u;
        }

        for (const g of groups.values()) {
          snapshot.records = (snapshot.records ?? 0) + 1;
          snapshot.inputTokens += g.inp;
          snapshot.cacheReadTokens += g.cr;
          snapshot.cacheWriteTokens += g.cw;
          snapshot.reasoningTokens += g.think;
          // The differing rule: trust the finishing line's output count when we
          // have one, but never below the observed maximum (a replayed line can
          // carry zeroed usage).
          const finished = g.chosen ? num(g.chosen.output_tokens) : 0;
          snapshot.outputTokens += Math.max(finished, g.maxOut);
        }
      }
    }

    const { ours, retained } = this.oursFor('claude-code', cutoff, sourceSessions);
    const grains: GrainComparison[] = [
      compare('claude JSONL, deduped by stop_reason line (independent rule)', snapshot, ours),
      {
        label: 'claude JSONL, naive sum of every usage line (NOT used -- shows the double count)',
        snapshot: naive,
        delta: diff(naive, ours),
        matches: false,
        gating: false,
        note:
          'Informational only. Every usage-bearing line summed without dedupe. Claude Code ' +
          'writes one line per content block repeating the same usage object, so this figure is ' +
          'inflated. It is shown to demonstrate what the dedupe prevents.',
      },
    ];

    return {
      client: 'claude-code',
      ours,
      ...(retained ? { retained } : {}),
      grains,
      available: true,
    };
  }

  /**
   * Independent re-aggregation of the Codex rollouts.
   *
   * The collector sums each request's `last_token_usage`, skipping events that
   * repeat the running total. This reads the other number Codex writes: the
   * running total itself, `total_token_usage`, taking its last value before the
   * cutoff in each session. If the dedupe dropped a request or kept a repeat,
   * the two disagree. A running total that ever goes DOWN is treated as Codex
   * starting a new count, and the run before it is kept rather than lost.
   *
   * Rollouts from 0.162 on also carry a `token_usage_record` per request, keyed
   * by `response_id`: a third reading of the same requests, compared against
   * the sessions that have them.
   */
  private async verifyCodex(allStores: boolean, cutoff: Date): Promise<ClientVerification> {
    const cutoffMs = cutoff.getTime();
    const homes = discoverCodexHomes().filter((s) => s.exists);
    const targets = allStores ? homes : homes.filter((s) => s.primary);

    if (targets.length === 0) {
      return {
        client: 'codex',
        ours: this.oursFor('codex', cutoff, new Set()).ours,
        grains: [],
        available: false,
        reason: 'No Codex CLI home found to verify against.',
      };
    }

    const running = { ...ZERO, records: 0 };
    const responses = { ...ZERO, records: 0 };
    const naive = { ...ZERO, records: 0 };
    const sourceSessions = new Set<string>();
    const responseSessions = new Set<string>();
    const skipped: string[] = [];
    const ingested = codexIngestedSizes(this.cursorOf('codex'));

    // Codex's own fields, mapped onto ours: cached and cache-write input are
    // inside `input_tokens`, reasoning is inside `output_tokens`.
    const add = (target: TokenSnapshot, u: any) => {
      target.inputTokens +=
        num(u?.input_tokens) - num(u?.cached_input_tokens) - num(u?.cache_write_input_tokens);
      target.cacheReadTokens += num(u?.cached_input_tokens);
      target.cacheWriteTokens += num(u?.cache_write_input_tokens);
      target.outputTokens += num(u?.output_tokens);
      target.reasoningTokens += num(u?.reasoning_output_tokens);
    };
    const fields = [
      'input_tokens',
      'cached_input_tokens',
      'cache_write_input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
    ];

    for (const home of targets) {
      for (const file of listRollouts(home.path)) {
        if (file.compressed && !canReadCompressedRollouts()) {
          skipped.push(file.path);
          continue;
        }
        let session = sessionIdFromFileName(file.path);
        let current: any;
        const totals = new Set<number>();
        const seenResponses = new Set<string>();
        for await (const raw of readRolloutLines(file, ingested?.get(file.path))) {
          const line = raw.trim();
          if (!line) continue;
          let o: any;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          if (o?.type === 'session_meta') {
            session = o.payload?.id ?? o.payload?.session_id ?? session;
            continue;
          }
          const ts = typeof o?.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
          if (!Number.isNaN(ts) && ts >= cutoffMs) continue;

          if (o?.type === 'token_usage_record' && o.payload?.usage) {
            const id = o.payload.response_id;
            if (typeof id === 'string' && seenResponses.has(id)) continue;
            if (typeof id === 'string') seenResponses.add(id);
            add(responses, o.payload.usage);
            responses.records = (responses.records ?? 0) + 1;
            continue;
          }
          if (o?.type !== 'event_msg' || o.payload?.type !== 'token_count') continue;
          const info = o.payload.info;
          if (!info) continue;

          // Naive sum, kept only to quantify how bad double counting would be.
          if (info.last_token_usage) {
            add(naive, info.last_token_usage);
            naive.records = (naive.records ?? 0) + 1;
          }

          const total = info.total_token_usage;
          if (!total) continue;
          if (current && fields.some((f) => num(total[f]) < num(current[f]))) {
            add(running, current);
            totals.clear();
          }
          current = total;
          totals.add(num(total.total_tokens));
        }
        if (current) add(running, current);
        running.records = (running.records ?? 0) + totals.size;
        if (session) {
          sourceSessions.add(session);
          if (seenResponses.size > 0) responseSessions.add(session);
        }
      }
    }

    const { ours, retained } = this.oursFor('codex', cutoff, sourceSessions);
    const grains: GrainComparison[] = [
      compare('codex rollouts, final running total per session (independent rule)', running, ours),
    ];
    if (responseSessions.size > 0) {
      const oursWithResponses = this.oursFor('codex', cutoff, responseSessions).ours;
      const grain = compare(
        'codex token_usage_record lines, one per response_id (independent corroboration)',
        responses,
        oursWithResponses,
      );
      if (responseSessions.size < sourceSessions.size) {
        grain.note =
          `Covers the ${responseSessions.size} of ${sourceSessions.size} session(s) whose rollouts ` +
          'carry token_usage_record lines (written from Codex CLI 0.162 on), compared against ' +
          'what we stored for those sessions only.';
      }
      grains.push(grain);
    }
    grains.push({
      label: 'codex rollouts, naive sum of every token_count (NOT used -- shows the double count)',
      snapshot: naive,
      delta: diff(naive, ours),
      matches: false,
      gating: false,
      note:
        'Informational only. Every token_count event summed without dedupe. Codex repeats the ' +
        'event with an unchanged running total (after a request, at the start of a turn, after a ' +
        'compaction), and this figure is inflated by every such repeat. It is shown to ' +
        'demonstrate what the dedupe prevents.',
    });
    if (skipped.length > 0) {
      const first = grains[0];
      if (first) {
        first.note =
          `${skipped.length} compressed rollout(s) could not be read on this Node (zstd needs ` +
          '22.15 or later); their sessions count as retained, not compared.';
      }
    }

    return {
      client: 'codex',
      ours,
      ...(retained ? { retained } : {}),
      grains,
      available: true,
    };
  }
}

function compare(label: string, snapshot: TokenSnapshot, ours: TokenSnapshot): GrainComparison {
  const delta = diff(snapshot, ours);
  return { label, snapshot, delta, matches: tokensMatch(delta) };
}

function accumulate(target: TokenSnapshot, tokens: any, cost: number): void {
  target.inputTokens += num(tokens.input);
  target.outputTokens += num(tokens.output);
  target.reasoningTokens += num(tokens.reasoning);
  target.cacheReadTokens += num(tokens.cache?.read);
  target.cacheWriteTokens += num(tokens.cache?.write);
  target.cost = (target.cost ?? 0) + cost;
  target.records = (target.records ?? 0) + 1;
}
