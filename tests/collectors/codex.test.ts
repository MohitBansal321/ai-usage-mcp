import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { CodexCollector } from '../../src/collectors/codex/collector.js';
import { canReadCompressedRollouts } from '../../src/collectors/codex/rollouts.js';
import { CostService } from '../../src/services/cost-service.js';
import {
  buildCodexHome,
  CODEX_SESSION,
  codexRealSessionLines,
  codexRolloutName,
  codexSessionMeta,
  codexTokenCount,
  codexTurnContext,
  codexUsage,
  tempDir,
} from '../fixtures/build-fixtures.js';

const OTHER = '019ff4a1-8f65-7de0-b9aa-4150332411d3';

function collector() {
  return new CodexCollector(new CostService());
}

describe('CodexCollector', () => {
  let dir: string;
  // vitest.config.ts points this at a path that does not exist, so that no test
  // reads the developer's own ~/.codex. Restore it -- deleting it would not.
  const isolated = process.env.AI_USAGE_CODEX_HOME;

  beforeEach(() => {
    dir = tempDir('codex-collector-');
  });

  afterEach(() => {
    if (isolated === undefined) delete process.env.AI_USAGE_CODEX_HOME;
    else process.env.AI_USAGE_CODEX_HOME = isolated;
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(sessions: Parameters<typeof buildCodexHome>[1]): string {
    const home = buildCodexHome(dir, sessions);
    process.env.AI_USAGE_CODEX_HOME = home;
    return home;
  }

  it('moves cached input out of input_tokens, where OpenAI counts it', async () => {
    setup([{ sessionId: CODEX_SESSION, lines: codexRealSessionLines() }]);

    const records = (await collector().collect({})).records;
    expect(records).toHaveLength(4);
    const first = records.find((r) => r.timestamp === '2026-10-22T18:29:15.282Z')!;
    // input_tokens 14986 holds the 11264 cached ones; total_tokens = 14986 + 131.
    expect(first.inputTokens).toBe(14986 - 11264);
    expect(first.cacheReadTokens).toBe(11264);
    expect(first.cacheWriteTokens).toBe(0);
    expect(first.outputTokens).toBe(131);
    expect(first.totalTokens).toBe(15117);
  });

  it('counts each request once although token_usage_record repeats it', async () => {
    // The real 0.162 session: four token_usage_record lines, each followed by a
    // token_count with the same usage. Four requests, not eight.
    setup([{ sessionId: CODEX_SESSION, lines: codexRealSessionLines() }]);

    const records = (await collector().collect({})).records;
    expect(records).toHaveLength(4);
    const sum = (f: 'inputTokens' | 'cacheReadTokens' | 'outputTokens' | 'totalTokens') =>
      records.reduce((a, r) => a + (r[f] ?? 0), 0);
    // Codex's own running total at the end of the session: 65759 in, 52992 cached, 453 out.
    expect(sum('inputTokens') + sum('cacheReadTokens')).toBe(65759);
    expect(sum('cacheReadTokens')).toBe(52992);
    expect(sum('outputTokens')).toBe(453);
    expect(sum('totalTokens')).toBe(66212);
  });

  it('keeps reasoning inside output rather than adding it again', async () => {
    const last = codexUsage({ input: 11176, cached: 7040, output: 187, reasoning: 42 });
    setup([
      {
        sessionId: CODEX_SESSION,
        lines: [
          codexSessionMeta(),
          codexTurnContext({ model: 'gpt-5.4' }),
          codexTokenCount({ timestamp: '2026-08-12T06:21:51.772Z', total: last, last }),
        ],
      },
    ]);

    const record = (await collector().collect({})).records[0]!;
    expect(record.outputTokens).toBe(187);
    expect(record.reasoningTokens).toBe(42);
    // 11176 + 187, exactly what Codex wrote as total_tokens -- not + 42.
    expect(record.totalTokens).toBe(11363);
  });

  it('leaves cache-write unavailable when the CLI does not write the field', async () => {
    // 0.114.0 has no cache_write_input_tokens at all; 0.162 writes it as 0.
    const { cache_write_input_tokens: _absent, ...last } = codexUsage({
      input: 11176,
      cached: 7040,
      output: 187,
    });
    setup([
      {
        sessionId: CODEX_SESSION,
        lines: [
          codexSessionMeta({ cliVersion: '0.114.0' }),
          codexTurnContext({ model: 'gpt-5.4' }),
          codexTokenCount({ timestamp: '2026-08-12T06:21:51.772Z', total: last, last }),
        ],
      },
    ]);

    const record = (await collector().collect({})).records[0]!;
    expect(record.cacheWriteTokens).toBeUndefined();
    expect(record.inputTokens).toBe(11176 - 7040);
    expect(record.totalTokens).toBe(11363);
  });

  it('skips token_count events that repeat the running total, as 0.114 writes them', async () => {
    // The 0.114.0 pattern: a rate-limit event with info null, every request
    // repeated a few seconds later, the previous total re-emitted at the start of
    // the next turn, and a compaction repeat whose last_token_usage is zeros
    // with total_tokens 8376.
    const a = codexUsage({ input: 11176, cached: 7040, output: 187, reasoning: 42 });
    const b = codexUsage({ input: 11424, cached: 10624, output: 204, reasoning: 56 });
    const aPlusB = codexUsage({ input: 22600, cached: 17664, output: 391, reasoning: 98 });
    const compaction = { ...codexUsage({ input: 0, output: 0 }), total_tokens: 8376 };
    setup([
      {
        sessionId: CODEX_SESSION,
        lines: [
          codexSessionMeta({ cliVersion: '0.114.0' }),
          codexTurnContext({ model: 'gpt-5.4' }),
          codexTokenCount({ timestamp: '2026-08-12T06:21:47.710Z', noInfo: true }),
          codexTokenCount({ timestamp: '2026-08-12T06:21:51.772Z', total: a, last: a }),
          codexTokenCount({ timestamp: '2026-08-12T06:21:54.690Z', total: a, last: a }),
          codexTokenCount({ timestamp: '2026-08-12T06:21:58.767Z', total: aPlusB, last: b }),
          codexTurnContext({ model: 'gpt-5.4', turnId: 'turn-2' }),
          codexTokenCount({ timestamp: '2026-08-12T06:28:33.387Z', total: aPlusB, last: b }),
          codexTokenCount({
            timestamp: '2026-08-12T07:08:56.087Z',
            total: aPlusB,
            last: compaction,
          }),
        ],
      },
    ]);

    const result = await collector().collect({});
    expect(result.records).toHaveLength(2);
    const output = result.records.reduce((n, r) => n + r.outputTokens, 0);
    const reasoning = result.records.reduce((n, r) => n + (r.reasoningTokens ?? 0), 0);
    expect(output).toBe(391);
    expect(reasoning).toBe(98);
    expect(result.notes.join('\n')).toContain('6 token_count event(s) held 2 model request(s)');
  });

  it('takes the model from the turn it ran in, and the session facts from session_meta', async () => {
    const a = codexUsage({ input: 100, cached: 40, output: 10 });
    const ab = codexUsage({ input: 300, cached: 40, output: 30 });
    const b = codexUsage({ input: 200, output: 20 });
    setup([
      {
        sessionId: CODEX_SESSION,
        lines: [
          codexSessionMeta({ cwd: '/work/repo', branch: 'feat/x', cliVersion: '0.114.0' }),
          codexTurnContext({ model: 'gpt-5.6-luna', cwd: '/work/repo/sub' }),
          codexTokenCount({ timestamp: '2026-10-22T10:00:00.000Z', total: a, last: a }),
          codexTurnContext({ model: 'gpt-5.6-terra', turnId: 'turn-2' }),
          codexTokenCount({ timestamp: '2026-10-22T10:05:00.000Z', total: ab, last: b }),
        ],
      },
    ]);

    const records = (await collector().collect({})).records;
    expect(records.map((r) => r.model)).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra']);
    for (const r of records) {
      expect(r.client).toBe('codex');
      expect(r.provider).toBe('openai');
      expect(r.sessionId).toBe(CODEX_SESSION);
      expect(r.projectPath).toBe('/work/repo');
      expect(r.gitBranch).toBe('feat/x');
      expect(r.sourceVersion).toBe('0.114.0');
      expect(r.turnKind).toBe('main');
      expect(r.source).toBe('codex-jsonl:sessions');
      // Identity fields, instructions and the remote URL are never carried over.
      expect(JSON.stringify(r)).not.toMatch(/must-never|example\.invalid/);
    }
  });

  it('estimates cost from the pricing table: uncached input, cached input and output', async () => {
    const u = codexUsage({ input: 1_000_000, cached: 400_000, output: 100_000, reasoning: 50_000 });
    setup([
      {
        sessionId: CODEX_SESSION,
        lines: [
          codexSessionMeta(),
          codexTurnContext({ model: 'gpt-5.6-luna' }),
          codexTokenCount({ timestamp: '2026-10-22T10:00:00.000Z', total: u, last: u }),
        ],
      },
    ]);

    const record = (await collector().collect({})).records[0]!;
    expect(record.costBasis).toBe('estimated');
    // gpt-5.6-luna: $0.20 input, $0.02 cached input, $1.20 output per million.
    // Reasoning is inside output and is not charged a second time.
    expect(record.estimatedCost).toBeCloseTo(0.6 * 0.2 + 0.4 * 0.02 + 0.1 * 1.2, 10);
    expect(record.cost).toBeUndefined();
  });

  it('reports a turn with no model as (unknown) and unpriced, never as free', async () => {
    const u = codexUsage({ input: 500, cached: 100, output: 50 });
    setup([
      {
        sessionId: CODEX_SESSION,
        lines: [
          codexSessionMeta(),
          codexTurnContext({}),
          codexTokenCount({ timestamp: '2026-10-22T10:00:00.000Z', total: u, last: u }),
        ],
      },
    ]);

    const result = await collector().collect({});
    const record = result.records[0]!;
    expect(record.model).toBe('(unknown)');
    expect(record.costBasis).toBe('unavailable');
    expect(record.estimatedCost).toBeUndefined();
    expect(result.notes.join('\n')).toContain('No price available for model(s): (unknown)');
  });

  it('skips malformed lines, says so, and keeps the rest', async () => {
    const a = codexUsage({ input: 100, output: 10 });
    const ab = codexUsage({ input: 300, output: 30 });
    setup([
      {
        sessionId: CODEX_SESSION,
        lines: [
          codexSessionMeta(),
          codexTurnContext({ model: 'gpt-5.6-luna' }),
          codexTokenCount({ timestamp: '2026-10-22T10:00:00.000Z', total: a, last: a }),
          '{"timestamp":"2026-10-22T10:01:00.000Z","type":"event_msg","payload":{"type":"tok',
          'not json at all',
          codexTokenCount({
            timestamp: '2026-10-22T10:02:00.000Z',
            total: ab,
            last: codexUsage({ input: 200, output: 20 }),
          }),
        ],
      },
    ]);

    const result = await collector().collect({});
    expect(result.records).toHaveLength(2);
    expect(result.records.reduce((n, r) => n + r.inputTokens, 0)).toBe(300);
    expect(result.notes.join('\n')).toContain('skipped 2 unparseable line(s)');
  });

  it('falls back to the session id in the file name when there is no session_meta', async () => {
    const u = codexUsage({ input: 10, output: 1 });
    setup([
      {
        sessionId: '019ff4a1-8f65-7de0-b9aa-4150332411d3',
        lines: [
          codexTurnContext({ model: 'gpt-5.4' }),
          codexTokenCount({ timestamp: '2026-10-22T10:00:00.000Z', total: u, last: u }),
        ],
      },
    ]);

    const record = (await collector().collect({})).records[0]!;
    expect(record.sessionId).toBe('019ff4a1-8f65-7de0-b9aa-4150332411d3');
    expect(record.provider).toBe('(unknown)');
    expect(record.projectPath).toBe('/work/codex-project');
  });

  it('resumes from its cursor, re-reads only a rollout that grew, and stays idempotent', async () => {
    const home = setup([{ sessionId: CODEX_SESSION, lines: codexRealSessionLines() }]);
    const first = await collector().collect({});
    expect(first.records).toHaveLength(4);

    // Unchanged: nothing is read.
    const again = await collector().collect({ cursor: first.cursor });
    expect(again.records).toHaveLength(0);
    expect(again.notes.join('\n')).toContain('skipped 1 unchanged');

    // Codex appends to the same rollout: the file is read again whole, and the
    // four known requests come back under the same ids.
    const path = join(home, 'sessions', '2026', '10', '22', codexRolloutName(CODEX_SESSION));
    const total = codexUsage({ input: 65759 + 1000, cached: 52992, output: 453 + 5 });
    appendFileSync(
      path,
      JSON.stringify(
        codexTokenCount({
          timestamp: '2026-10-22T18:40:00.000Z',
          total,
          last: codexUsage({ input: 1000, output: 5 }),
        }),
      ) + '\n',
    );
    const grown = await collector().collect({ cursor: first.cursor });
    expect(grown.records).toHaveLength(5);
    const ids = new Set(first.records.map((r) => r.id));
    expect(grown.records.filter((r) => ids.has(r.id))).toHaveLength(4);

    // An unrecognised cursor is no cursor.
    expect(
      (await collector().collect({ cursor: { version: 99, files: {} } })).records,
    ).toHaveLength(5);
  });

  it('does not mark rollouts as ingested on a time-filtered sync', async () => {
    setup([{ sessionId: CODEX_SESSION, lines: codexRealSessionLines() }]);
    const filtered = await collector().collect({ since: new Date('2026-10-22T18:29:17.000Z') });
    expect(filtered.records).toHaveLength(3);
    const later = await collector().collect({ cursor: filtered.cursor });
    expect(later.records).toHaveLength(4);
  });

  it('reads archived_sessions too, and an archived rollout keeps its record ids', async () => {
    const home = setup([{ sessionId: CODEX_SESSION, lines: codexRealSessionLines() }]);
    const before = (await collector().collect({})).records.map((r) => r.id).sort();

    // Archiving moves the file out of the dated tree.
    mkdirSync(join(home, 'archived_sessions'), { recursive: true });
    renameSync(
      join(home, 'sessions', '2026', '10', '22', codexRolloutName(CODEX_SESSION)),
      join(home, 'archived_sessions', codexRolloutName(CODEX_SESSION)),
    );
    const after = (await collector().collect({})).records;
    expect(after.map((r) => r.id).sort()).toEqual(before);
    expect(after.every((r) => r.source === 'codex-jsonl:archived')).toBe(true);
  });

  it('reads a compressed rollout where this Node has zstd, and says so where it does not', async () => {
    const home = setup([{ sessionId: CODEX_SESSION, lines: codexRealSessionLines() }]);
    const path = join(home, 'sessions', '2026', '10', '22', codexRolloutName(CODEX_SESSION));
    const zstdCompressSync = (zlib as { zstdCompressSync?: (b: Buffer) => Buffer })
      .zstdCompressSync;
    if (zstdCompressSync) {
      writeFileSync(`${path}.zst`, zstdCompressSync(readFileSync(path)));
    } else {
      writeFileSync(`${path}.zst`, 'not readable on this Node anyway');
    }
    rmSync(path);

    const result = await collector().collect({});
    if (canReadCompressedRollouts()) {
      expect(result.records).toHaveLength(4);
    } else {
      expect(result.records).toHaveLength(0);
      expect(result.notes.join('\n')).toContain('Skipped 1 compressed rollout(s)');
    }
  });

  it.runIf(canReadCompressedRollouts())(
    'names a corrupt compressed rollout and leaves it out of the cursor',
    async () => {
      const home = setup([{ sessionId: CODEX_SESSION, lines: codexRealSessionLines() }]);
      const dayDir = join(home, 'sessions', '2026', '10', '22');
      writeFileSync(join(dayDir, `${codexRolloutName(OTHER)}.zst`), 'this is not zstd');

      const result = await collector().collect({});
      expect(result.records).toHaveLength(4);
      expect(result.notes.join('\n')).toMatch(/\.jsonl\.zst: could not be read/);
      const cursor = result.cursor as { files: Record<string, unknown> };
      expect(Object.keys(cursor.files).some((p) => p.endsWith('.zst'))).toBe(false);
    },
  );

  it('is unavailable, with a reason, when the home has no rollouts', async () => {
    process.env.AI_USAGE_CODEX_HOME = join(dir, 'missing');
    const missing = await collector().isAvailable();
    expect(missing.available).toBe(false);
    expect(missing.reason).toContain('AI_USAGE_CODEX_HOME');
    expect(missing.stores[0]?.primary).toBe(true);

    mkdirSync(join(dir, 'empty', 'sessions'), { recursive: true });
    process.env.AI_USAGE_CODEX_HOME = join(dir, 'empty');
    const empty = await collector().isAvailable();
    expect(empty.available).toBe(false);
    expect(empty.reason).toContain('no session rollouts');
  });
});
