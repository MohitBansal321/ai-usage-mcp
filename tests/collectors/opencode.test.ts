import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { OpenCodeCollector } from '../../src/collectors/opencode/collector.js';
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
});
