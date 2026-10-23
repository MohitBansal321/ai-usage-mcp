import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { OpenCodeCollector } from '../../src/collectors/opencode/collector.js';
import { openSqlite } from '../../src/db/driver.js';
import { buildOpenCodeDb, tempDir } from '../fixtures/build-fixtures.js';

function assistant(options: {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  modelID?: string | undefined;
  providerID?: string | undefined;
  root?: string;
  created: number;
}) {
  const data: Record<string, unknown> = {
    role: 'assistant',
    cost: options.cost ?? 0,
    tokens: {
      input: options.input ?? 0,
      output: options.output ?? 0,
      reasoning: options.reasoning ?? 0,
      cache: { read: options.cacheRead ?? 0, write: options.cacheWrite ?? 0 },
    },
    time: { created: options.created },
    path: { root: options.root ?? '/work/project-one' },
  };
  if (options.modelID !== undefined) data.modelID = options.modelID;
  if (options.providerID !== undefined) data.providerID = options.providerID;
  return data;
}

/** An assistant turn as OpenCode 2.x writes it into `session_message.data`. */
function v2Assistant(options: {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cost?: number;
  modelID?: string;
  providerID?: string;
  created: number;
  withTokens?: boolean;
}) {
  const data: Record<string, unknown> = {
    time: { created: options.created, completed: options.created + 5 },
    agent: 'build',
    model: { id: options.modelID ?? 'v2-model', providerID: options.providerID ?? 'openrouter' },
    content: [{ type: 'text', text: 'never stored' }],
    cost: options.cost ?? 0,
  };
  if (options.withTokens !== false) {
    data.tokens = {
      input: options.input ?? 0,
      output: options.output ?? 0,
      reasoning: options.reasoning ?? 0,
      cache: { read: options.cacheRead ?? 0, write: 0 },
    };
  }
  return data;
}

describe('OpenCodeCollector', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir('oc-collector-');
  });

  afterEach(() => {
    delete process.env.AI_USAGE_OPENCODE_DB;
    rmSync(dir, { recursive: true, force: true });
  });

  it('collects one record per assistant message and normalises the fields', async () => {
    const dbPath = buildOpenCodeDb(dir, {
      sessions: [{ id: 'ses-1', version: '1.18.25' }],
      messages: [
        {
          id: 'msg-a',
          sessionId: 'ses-1',
          timeCreated: 1_772_000_000_000,
          data: assistant({
            input: 100,
            output: 20,
            reasoning: 5,
            cacheRead: 900,
            cacheWrite: 10,
            cost: 0.25,
            modelID: 'big-pickle',
            providerID: 'opencode',
            created: 1_772_000_000_000,
          }),
        },
        // A user turn consumes no tokens and must not produce a record.
        { id: 'msg-u', sessionId: 'ses-1', timeCreated: 1_772_000_000_001, data: { role: 'user' } },
      ],
    });
    process.env.AI_USAGE_OPENCODE_DB = dbPath;

    const result = await new OpenCodeCollector().collect({});
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;

    expect(record.client).toBe('opencode');
    expect(record.model).toBe('big-pickle');
    expect(record.provider).toBe('opencode');
    expect(record.sessionId).toBe('ses-1');
    expect(record.inputTokens).toBe(100);
    expect(record.outputTokens).toBe(20);
    expect(record.reasoningTokens).toBe(5);
    expect(record.cacheReadTokens).toBe(900);
    expect(record.cacheWriteTokens).toBe(10);
    expect(record.projectPath).toBe('/work/project-one');
    expect(record.sourceVersion).toBe('1.18.25');
    expect(record.source).toBe('opencode.db:message');
    expect(record.turnKind).toBe('main');
  });

  it('treats reasoning tokens as a sibling of output in the total, matching OpenCode', async () => {
    const dbPath = buildOpenCodeDb(dir, {
      sessions: [{ id: 'ses-1' }],
      messages: [
        {
          id: 'msg-a',
          sessionId: 'ses-1',
          timeCreated: 1_772_000_000_000,
          data: assistant({
            input: 100,
            output: 20,
            reasoning: 5,
            cacheRead: 900,
            cacheWrite: 10,
            created: 1_772_000_000_000,
          }),
        },
      ],
    });
    process.env.AI_USAGE_OPENCODE_DB = dbPath;

    const result = await new OpenCodeCollector().collect({});
    // OpenCode's own tokens.total === input + output + reasoning + cache.read,
    // so reasoning is additive here (unlike Claude Code, where it is inside output).
    expect(result.records[0]!.totalTokens).toBe(100 + 20 + 5 + 900 + 10);
  });

  it('reports cost as exact, including a genuine zero from a free model', async () => {
    const dbPath = buildOpenCodeDb(dir, {
      sessions: [{ id: 'ses-1' }],
      messages: [
        {
          id: 'free',
          sessionId: 'ses-1',
          timeCreated: 1_772_000_000_000,
          data: assistant({
            input: 10,
            cost: 0,
            modelID: 'free-model',
            created: 1_772_000_000_000,
          }),
        },
        {
          id: 'paid',
          sessionId: 'ses-1',
          timeCreated: 1_772_000_000_001,
          data: assistant({
            input: 10,
            cost: 1.5,
            modelID: 'paid-model',
            created: 1_772_000_000_001,
          }),
        },
      ],
    });
    process.env.AI_USAGE_OPENCODE_DB = dbPath;

    const records = (await new OpenCodeCollector().collect({})).records;
    for (const record of records) {
      expect(record.costBasis).toBe('reported');
      expect(record.estimatedCost).toBeUndefined();
    }
    expect(records.find((r) => r.model === 'free-model')!.cost).toBe(0);
    expect(records.find((r) => r.model === 'paid-model')!.cost).toBe(1.5);
  });

  it('marks messages from a child session as subagent turns', async () => {
    const dbPath = buildOpenCodeDb(dir, {
      sessions: [
        { id: 'ses-parent', parentId: null },
        { id: 'ses-child', parentId: 'ses-parent' },
      ],
      messages: [
        {
          id: 'm1',
          sessionId: 'ses-parent',
          timeCreated: 1_772_000_000_000,
          data: assistant({ input: 1, created: 1_772_000_000_000 }),
        },
        {
          id: 'm2',
          sessionId: 'ses-child',
          timeCreated: 1_772_000_000_001,
          data: assistant({ input: 2, created: 1_772_000_000_001 }),
        },
      ],
    });
    process.env.AI_USAGE_OPENCODE_DB = dbPath;

    const records = (await new OpenCodeCollector().collect({})).records;
    expect(records.find((r) => r.sessionId === 'ses-parent')!.turnKind).toBe('main');
    expect(records.find((r) => r.sessionId === 'ses-child')!.turnKind).toBe('subagent');
  });

  it('reports a missing model as unknown instead of inventing one', async () => {
    const dbPath = buildOpenCodeDb(dir, {
      sessions: [{ id: 'ses-1' }],
      messages: [
        {
          id: 'm1',
          sessionId: 'ses-1',
          timeCreated: 1_772_000_000_000,
          data: assistant({ input: 5, created: 1_772_000_000_000 }),
        },
      ],
    });
    process.env.AI_USAGE_OPENCODE_DB = dbPath;

    const result = await new OpenCodeCollector().collect({});
    expect(result.records[0]!.model).toBe('(unknown)');
    expect(result.records[0]!.provider).toBe('(unknown)');
    expect(result.notes.join(' ')).toContain('no model id');
  });

  it('resumes from its cursor and stays idempotent across runs', async () => {
    const dbPath = buildOpenCodeDb(dir, {
      sessions: [{ id: 'ses-1' }],
      messages: [
        {
          id: 'm1',
          sessionId: 'ses-1',
          timeCreated: 1_000,
          timeUpdated: 1_000,
          data: assistant({ input: 5, created: 1_000 }),
        },
        {
          id: 'm2',
          sessionId: 'ses-1',
          timeCreated: 2_000,
          timeUpdated: 2_000,
          data: assistant({ input: 6, created: 2_000 }),
        },
      ],
    });
    process.env.AI_USAGE_OPENCODE_DB = dbPath;

    const collector = new OpenCodeCollector();
    const first = await collector.collect({});
    expect(first.records).toHaveLength(2);

    const second = await collector.collect({ cursor: first.cursor });
    // The cursor is inclusive of its boundary, so the newest message may be
    // re-read; ids are deterministic so a re-read cannot change any total.
    expect(second.records.length).toBeLessThanOrEqual(2);
    for (const record of second.records) {
      expect(first.records.some((r) => r.id === record.id)).toBe(true);
    }
  });

  it('honours since/until bounds', async () => {
    const dbPath = buildOpenCodeDb(dir, {
      sessions: [{ id: 'ses-1' }],
      messages: [
        {
          id: 'old',
          sessionId: 'ses-1',
          timeCreated: Date.parse('2026-01-01T00:00:00Z'),
          data: assistant({ input: 1, created: Date.parse('2026-01-01T00:00:00Z') }),
        },
        {
          id: 'new',
          sessionId: 'ses-1',
          timeCreated: Date.parse('2026-06-01T00:00:00Z'),
          data: assistant({ input: 2, created: Date.parse('2026-06-01T00:00:00Z') }),
        },
      ],
    });
    process.env.AI_USAGE_OPENCODE_DB = dbPath;

    const result = await new OpenCodeCollector().collect({
      since: new Date('2026-03-01T00:00:00Z'),
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.inputTokens).toBe(2);
  });

  it('is unavailable, with a reason, when no database exists', async () => {
    process.env.AI_USAGE_OPENCODE_DB = `${dir}/absent.db`;
    const availability = await new OpenCodeCollector().isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('No OpenCode database found');
  });

  it('does not count the empty -wal its own read creates as OpenCode writing', async () => {
    // OpenCode deletes -wal on a clean close; a read-only open recreates it, empty and
    // stamped now. Counting that made `status` warn about our own sync, on a real machine.
    const dbPath = buildOpenCodeDb(dir, {
      sessions: [{ id: 's1' }],
      messages: [
        {
          id: 'm1',
          sessionId: 's1',
          timeCreated: 1_000,
          data: assistant({ input: 1, created: 1_000 }),
        },
      ],
    });
    const wal = openSqlite(dbPath);
    wal.exec('PRAGMA journal_mode=WAL');
    wal.close();
    const lastOpenCodeWrite = new Date('2026-10-19T12:06:00Z');
    utimesSync(dbPath, lastOpenCodeWrite, lastOpenCodeWrite);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);

    process.env.AI_USAGE_OPENCODE_DB = dbPath;
    const collector = new OpenCodeCollector();
    await collector.collect({});
    expect(statSync(`${dbPath}-wal`).size).toBe(0);
    expect((await collector.isAvailable()).lastWriteAt).toBe(lastOpenCodeWrite.toISOString());

    // A -wal holding frames is a real write that has not reached the main file yet.
    const turnInWal = new Date('2026-10-20T08:00:00Z');
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(32));
    utimesSync(`${dbPath}-wal`, turnInWal, turnInWal);
    expect((await collector.isAvailable()).lastWriteAt).toBe(turnInWal.toISOString());
  });

  describe('OpenCode 2.x schema (session_message / session_v2)', () => {
    it('collects turns that exist only in session_message, with session facts from session_v2', async () => {
      const dbPath = buildOpenCodeDb(dir, {
        sessions: [],
        messages: [],
        sessionsV2: [
          { id: 'ses-new', directory: '/work/v2-project', version: '2.0.30', title: 'Fresh title' },
          { id: 'ses-child', parentId: 'ses-new', directory: '/work/v2-project' },
        ],
        sessionMessages: [
          {
            id: 'msg-new',
            sessionId: 'ses-new',
            timeCreated: 1_792_000_000_000,
            data: v2Assistant({
              input: 700,
              output: 80,
              reasoning: 40,
              cacheRead: 148_480,
              cost: 0.5,
              modelID: 'thinkingmachines/inkling:free',
              providerID: 'openrouter',
              created: 1_792_000_000_000,
            }),
          },
          {
            id: 'msg-sub',
            sessionId: 'ses-child',
            timeCreated: 1_792_000_000_001,
            data: v2Assistant({ input: 1, created: 1_792_000_000_001 }),
          },
          // Not assistant turns: no usage record.
          {
            id: 'msg-user',
            sessionId: 'ses-new',
            type: 'user',
            timeCreated: 1_792_000_000_002,
            data: { time: { created: 1_792_000_000_002 } },
          },
          {
            id: 'msg-idle',
            sessionId: 'ses-new',
            type: 'idle',
            timeCreated: 1_792_000_000_003,
            data: {},
          },
        ],
      });
      process.env.AI_USAGE_OPENCODE_DB = dbPath;

      const result = await new OpenCodeCollector().collect({});
      expect(result.records).toHaveLength(2);

      const main = result.records.find((r) => r.id === 'opencode:msg:msg-new')!;
      expect(main.model).toBe('thinkingmachines/inkling:free');
      expect(main.provider).toBe('openrouter');
      expect(main.inputTokens).toBe(700);
      expect(main.outputTokens).toBe(80);
      expect(main.reasoningTokens).toBe(40);
      expect(main.cacheReadTokens).toBe(148_480);
      expect(main.totalTokens).toBe(700 + 80 + 40 + 148_480);
      expect(main.cost).toBe(0.5);
      expect(main.costBasis).toBe('reported');
      expect(main.projectPath).toBe('/work/v2-project');
      expect(main.sourceVersion).toBe('2.0.30');
      expect(main.turnKind).toBe('main');
      expect(main.source).toBe('opencode.db:session_message');
      expect(result.records.find((r) => r.id === 'opencode:msg:msg-sub')!.turnKind).toBe(
        'subagent',
      );
      expect(result.sessionTitles).toContainEqual({ sessionId: 'ses-new', title: 'Fresh title' });
    });

    it('skips an assistant turn that recorded no tokens rather than counting it as zero', async () => {
      const dbPath = buildOpenCodeDb(dir, {
        sessions: [],
        messages: [],
        sessionsV2: [{ id: 'ses-1' }],
        sessionMessages: [
          {
            id: 'aborted',
            sessionId: 'ses-1',
            timeCreated: 1_792_000_000_000,
            data: v2Assistant({ created: 1_792_000_000_000, withTokens: false }),
          },
        ],
      });
      process.env.AI_USAGE_OPENCODE_DB = dbPath;

      expect((await new OpenCodeCollector().collect({})).records).toHaveLength(0);
    });

    it('does not double count a turn present in both tables, and keeps the legacy attribution', async () => {
      const dbPath = buildOpenCodeDb(dir, {
        sessions: [{ id: 'ses-1', directory: '/work/session-dir' }],
        messages: [
          {
            id: 'both',
            sessionId: 'ses-1',
            timeCreated: 1_000,
            data: assistant({
              input: 10,
              modelID: 'm',
              root: '/work/payload-root',
              created: 1_000,
            }),
          },
        ],
        sessionsV2: [{ id: 'ses-1', directory: '/work/session-dir' }],
        sessionMessages: [
          {
            id: 'both',
            sessionId: 'ses-1',
            timeCreated: 1_000,
            data: v2Assistant({ input: 10, modelID: 'm', created: 1_000 }),
          },
          {
            id: 'only-v2',
            sessionId: 'ses-1',
            timeCreated: 2_000,
            data: v2Assistant({ input: 5, modelID: 'm', created: 2_000 }),
          },
        ],
      });
      process.env.AI_USAGE_OPENCODE_DB = dbPath;

      const records = (await new OpenCodeCollector().collect({})).records;
      expect(records.map((r) => r.id).sort()).toEqual([
        'opencode:msg:both',
        'opencode:msg:only-v2',
      ]);
      const both = records.find((r) => r.id === 'opencode:msg:both')!;
      expect(both.source).toBe('opencode.db:message');
      expect(both.projectPath).toBe('/work/payload-root');
      expect(records.reduce((n, r) => n + r.inputTokens, 0)).toBe(15);
    });

    it('works when the legacy tables are gone entirely', async () => {
      const dbPath = buildOpenCodeDb(dir, {
        sessions: [],
        messages: [],
        sessionsV2: [{ id: 'ses-1' }],
        sessionMessages: [
          {
            id: 'm1',
            sessionId: 'ses-1',
            timeCreated: 1_000,
            data: v2Assistant({ input: 3, created: 1_000 }),
          },
        ],
        withoutLegacyMessages: true,
      });
      process.env.AI_USAGE_OPENCODE_DB = dbPath;

      const result = await new OpenCodeCollector().collect({});
      expect(result.records).toHaveLength(1);
    });

    it('keeps a turn whose session row is missing from every session table', async () => {
      const dbPath = buildOpenCodeDb(dir, {
        sessions: [],
        messages: [],
        sessionsV2: [{ id: 'other' }],
        sessionMessages: [
          {
            id: 'orphan',
            sessionId: 'ses-gone',
            timeCreated: 1_000,
            data: v2Assistant({ input: 4, created: 1_000 }),
          },
        ],
      });
      process.env.AI_USAGE_OPENCODE_DB = dbPath;

      const records = (await new OpenCodeCollector().collect({})).records;
      expect(records).toHaveLength(1);
      expect(records[0]!.turnKind).toBe('main');
      expect(records[0]!.projectPath).toBeUndefined();
    });

    it('resumes each table from its own cursor, and reads session_message from the start under an old cursor', async () => {
      const dbPath = buildOpenCodeDb(dir, {
        sessions: [{ id: 'ses-1' }],
        messages: [
          {
            id: 'legacy',
            sessionId: 'ses-1',
            timeCreated: 1_000,
            data: assistant({ input: 1, created: 1_000 }),
          },
        ],
        sessionsV2: [{ id: 'ses-1' }],
        sessionMessages: [
          {
            id: 'v2-a',
            sessionId: 'ses-1',
            timeCreated: 5_000,
            data: v2Assistant({ input: 2, created: 5_000 }),
          },
          {
            id: 'v2-b',
            sessionId: 'ses-1',
            timeCreated: 6_000,
            data: v2Assistant({ input: 3, created: 6_000 }),
          },
        ],
      });
      process.env.AI_USAGE_OPENCODE_DB = dbPath;
      // The cursor is keyed by canonical path (macOS temp dirs sit behind a symlink).
      const storeKey = realpathSync(dbPath);
      const collector = new OpenCodeCollector();

      const first = await collector.collect({});
      expect(first.records).toHaveLength(3);
      expect(first.cursor).toEqual({
        stores: { [storeKey]: 1_000 },
        sessionMessages: { [storeKey]: 6_000 },
      });

      // A cursor written before 2.x support has no sessionMessages watermark; it
      // must not hide the newer table.
      const old = await collector.collect({ cursor: { stores: { [storeKey]: 1_000 } } });
      expect(old.records.map((r) => r.id)).toContain('opencode:msg:v2-a');
      expect(old.records.map((r) => r.id)).toContain('opencode:msg:v2-b');

      // A current cursor resumes at the boundary, not from the start.
      const next = await collector.collect({ cursor: first.cursor });
      expect(next.records.map((r) => r.id).sort()).toEqual([
        'opencode:msg:legacy',
        'opencode:msg:v2-b',
      ]);
    });
  });
});
