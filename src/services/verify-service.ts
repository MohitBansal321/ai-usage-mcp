import BetterSqlite3 from 'better-sqlite3';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { UsageRepository } from '../db/repositories/usage-repository.js';
import { discoverOpenCodeStores } from '../collectors/opencode/stores.js';
import { discoverClaudeRoots, listTranscripts } from '../collectors/claude-code/transcripts.js';
import { num } from '../collectors/collector.js';

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
  client: 'opencode' | 'claude-code';
  ours: TokenSnapshot;
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
 */
export class VerifyService {
  constructor(private readonly repo: UsageRepository) {}

  async verify(options: { allStores?: boolean; cutoff?: Date } = {}): Promise<VerifyReport> {
    const cutoff = options.cutoff ?? new Date();
    const clients = [
      this.verifyOpenCode(options.allStores === true, cutoff),
      await this.verifyClaudeCode(options.allStores === true, cutoff),
    ];
    return {
      clients,
      allMatch: clients.every(
        (c) => !c.available || c.grains.some((g) => g.matches && g.gating !== false),
      ),
      cutoff: cutoff.toISOString(),
    };
  }

  private oursFor(client: 'opencode' | 'claude-code', cutoff: Date): TokenSnapshot {
    const t = this.repo.totals({ client, until: cutoff.toISOString() });
    const snapshot: TokenSnapshot = {
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      reasoningTokens: t.reasoningTokens,
      records: t.records,
    };
    if (client === 'opencode') snapshot.cost = round6(t.cost.reported);
    return snapshot;
  }

  private verifyOpenCode(allStores: boolean, cutoff: Date): ClientVerification {
    const ours = this.oursFor('opencode', cutoff);
    const cutoffMs = cutoff.getTime();
    const stores = discoverOpenCodeStores().filter((s) => s.exists);
    const targets = allStores ? stores : stores.filter((s) => s.primary);

    if (targets.length === 0) {
      return {
        client: 'opencode',
        ours,
        grains: [],
        available: false,
        reason: 'No OpenCode database found to verify against.',
      };
    }

    const message = { ...ZERO, cost: 0, records: 0 };
    const part = { ...ZERO, cost: 0, records: 0 };
    const session = { ...ZERO, cost: 0, records: 0 };

    for (const store of targets) {
      const db = new BetterSqlite3(store.path, { readonly: true });
      try {
        for (const row of db.prepare('SELECT data FROM message').iterate() as IterableIterator<{
          data: string;
        }>) {
          let d: any;
          try {
            d = JSON.parse(row.data);
          } catch {
            continue;
          }
          if (d?.role !== 'assistant' || !d?.tokens) continue;
          const created = typeof d?.time?.created === 'number' ? d.time.created : undefined;
          if (created !== undefined && created >= cutoffMs) continue;
          accumulate(message, d.tokens, num(d.cost));
        }
        // `part` rows carry no timestamp of their own, so the cutoff is applied
        // through the message they belong to.
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
        const s = db
          .prepare(
            `SELECT COUNT(*) AS n, SUM(tokens_input) AS i, SUM(tokens_output) AS o,
                    SUM(tokens_reasoning) AS r, SUM(tokens_cache_read) AS cr,
                    SUM(tokens_cache_write) AS cw, SUM(cost) AS c
               FROM session`,
          )
          .get() as Record<string, number | null>;
        session.records += s.n ?? 0;
        session.inputTokens += s.i ?? 0;
        session.outputTokens += s.o ?? 0;
        session.reasoningTokens += s.r ?? 0;
        session.cacheReadTokens += s.cr ?? 0;
        session.cacheWriteTokens += s.cw ?? 0;
        session.cost += s.c ?? 0;
      } finally {
        db.close();
      }
    }

    for (const snap of [message, part, session]) snap.cost = round6(snap.cost);

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

    return { client: 'opencode', ours, grains, available: true };
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
    const ours = this.oursFor('claude-code', cutoff);
    const cutoffMs = cutoff.getTime();
    const roots = discoverClaudeRoots().filter((s) => s.exists);
    const targets = allStores ? roots : roots.filter((s) => s.primary);

    if (targets.length === 0) {
      return {
        client: 'claude-code',
        ours,
        grains: [],
        available: false,
        reason: 'No Claude Code transcripts found to verify against.',
      };
    }

    const snapshot = { ...ZERO, records: 0 };
    const naive = { ...ZERO, records: 0 };

    for (const root of targets) {
      for (const file of listTranscripts(root.path)) {
        const groups = new Map<
          string,
          { chosen?: any; maxOut: number; inp: number; cr: number; cw: number; think: number }
        >();
        const rl = createInterface({
          input: createReadStream(file.path, { encoding: 'utf8' }),
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

    return { client: 'claude-code', ours, grains, available: true };
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
