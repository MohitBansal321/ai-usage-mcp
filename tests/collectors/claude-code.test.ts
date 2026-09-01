import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { ClaudeCodeCollector } from '../../src/collectors/claude-code/collector.js';
import { CostService } from '../../src/services/cost-service.js';
import { assistantLine, buildClaudeProjects, tempDir } from '../fixtures/build-fixtures.js';

function collector() {
  return new ClaudeCodeCollector(new CostService());
}

describe('ClaudeCodeCollector', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir('cc-collector-');
  });

  afterEach(() => {
    delete process.env.AI_USAGE_CLAUDE_PROJECTS;
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(projects: Parameters<typeof buildClaudeProjects>[1]) {
    process.env.AI_USAGE_CLAUDE_PROJECTS = buildClaudeProjects(dir, projects);
  }

  it('collapses the per-content-block lines of one request into a single record', async () => {
    // Exactly the real pattern: same requestId + message.id on every line, with
    // output_tokens growing to its final cumulative value on the stop_reason line.
    setup([
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'sess-1',
            lines: [
              assistantLine({
                requestId: 'req-1',
                messageId: 'msg-1',
                output: 5,
                input: 2,
                cacheRead: 1000,
                cacheWrite1h: 500,
                blockType: 'thinking',
                thinking: 4,
              }),
              assistantLine({
                requestId: 'req-1',
                messageId: 'msg-1',
                output: 350,
                input: 2,
                cacheRead: 1000,
                cacheWrite1h: 500,
                blockType: 'tool_use',
                stopReason: 'tool_use',
                thinking: 4,
              }),
            ],
          },
        ],
      },
    ]);

    const result = await collector().collect({});
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.outputTokens).toBe(350);
    expect(record.inputTokens).toBe(2);
    expect(record.cacheReadTokens).toBe(1000);
    expect(record.cacheWriteTokens).toBe(500);
  });

  it('never sums iterations[] into the totals', async () => {
    // The single line carries iterations that repeat its own usage. Summing them
    // would double every figure.
    setup([
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'sess-1',
            lines: [
              assistantLine({
                requestId: 'req-1',
                messageId: 'msg-1',
                input: 10,
                output: 100,
                cacheRead: 2000,
                stopReason: 'end_turn',
                includeIterations: true,
              }),
            ],
          },
        ],
      },
    ]);

    const record = (await collector().collect({})).records[0]!;
    expect(record.inputTokens).toBe(10);
    expect(record.outputTokens).toBe(100);
    expect(record.cacheReadTokens).toBe(2000);
  });

  it('prefers the maximum over a later replayed line carrying zeroed usage', async () => {
    setup([
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'sess-1',
            lines: [
              assistantLine({
                requestId: 'req-1',
                messageId: 'msg-1',
                input: 1,
                output: 492,
                cacheRead: 260293,
                cacheWrite5m: 585,
                stopReason: 'end_turn',
              }),
              assistantLine({
                requestId: 'req-1',
                messageId: 'msg-1',
                input: 0,
                output: 0,
                cacheRead: 0,
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
    ]);

    const record = (await collector().collect({})).records[0]!;
    expect(record.outputTokens).toBe(492);
    expect(record.cacheReadTokens).toBe(260293);
  });

  it('keeps distinct requests separate', async () => {
    setup([
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'sess-1',
            lines: [
              assistantLine({
                requestId: 'req-1',
                messageId: 'msg-1',
                output: 10,
                stopReason: 'end_turn',
              }),
              assistantLine({
                requestId: 'req-2',
                messageId: 'msg-2',
                output: 20,
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
    ]);
    const records = (await collector().collect({})).records;
    expect(records).toHaveLength(2);
    expect(records.reduce((a, r) => a + r.outputTokens, 0)).toBe(30);
  });

  it('excludes synthetic model lines', async () => {
    setup([
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'sess-1',
            lines: [
              assistantLine({
                requestId: 'req-1',
                messageId: 'msg-1',
                output: 10,
                model: '<synthetic>',
                stopReason: 'end_turn',
              }),
              assistantLine({
                requestId: 'req-2',
                messageId: 'msg-2',
                output: 20,
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
    ]);
    const result = await collector().collect({});
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.model).toBe('claude-opus-5');
    expect(result.notes.join(' ')).toContain('synthetic');
  });

  it('treats thinking tokens as part of output, not an extra class', async () => {
    setup([
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'sess-1',
            lines: [
              assistantLine({
                requestId: 'req-1',
                messageId: 'msg-1',
                input: 2,
                output: 500,
                thinking: 400,
                cacheRead: 1000,
                cacheWrite5m: 100,
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
    ]);
    const record = (await collector().collect({})).records[0]!;
    expect(record.reasoningTokens).toBe(400);
    // thinking is inside output_tokens, so it must NOT be added again
    expect(record.totalTokens).toBe(2 + 500 + 1000 + 100);
  });

  it('classifies subagent and workflow transcripts as subagent turns, and skips journals', async () => {
    setup([
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'sess-1',
            lines: [
              assistantLine({
                requestId: 'req-main',
                messageId: 'm-main',
                output: 1,
                stopReason: 'end_turn',
              }),
            ],
            subagents: [
              {
                name: 'agent-abc',
                lines: [
                  assistantLine({
                    requestId: 'req-sub',
                    messageId: 'm-sub',
                    output: 2,
                    stopReason: 'end_turn',
                  }),
                ],
              },
            ],
            workflowAgents: [
              {
                workflow: 'wf_1',
                name: 'agent-wf',
                lines: [
                  assistantLine({
                    requestId: 'req-wf',
                    messageId: 'm-wf',
                    output: 4,
                    stopReason: 'end_turn',
                  }),
                ],
              },
            ],
            journalLines: [
              assistantLine({
                requestId: 'req-journal',
                messageId: 'm-journal',
                output: 8,
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
    ]);

    const records = (await collector().collect({})).records;
    expect(records).toHaveLength(3);
    expect(records.find((r) => r.outputTokens === 1)!.turnKind).toBe('main');
    expect(records.find((r) => r.outputTokens === 2)!.turnKind).toBe('subagent');
    expect(records.find((r) => r.outputTokens === 4)!.turnKind).toBe('subagent');
    // journal.jsonl is bookkeeping, never usage
    expect(records.some((r) => r.outputTokens === 8)).toBe(false);
  });

  it('splits cache writes by TTL so they can be priced differently', async () => {
    setup([
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'sess-1',
            lines: [
              assistantLine({
                requestId: 'req-1',
                messageId: 'msg-1',
                cacheWrite5m: 1_000_000,
                cacheWrite1h: 1_000_000,
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
    ]);
    const record = (await collector().collect({})).records[0]!;
    expect(record.cacheWrite5mTokens).toBe(1_000_000);
    expect(record.cacheWrite1hTokens).toBe(1_000_000);
    expect(record.cacheWriteTokens).toBe(2_000_000);
    // 1.25x and 2x of the $5/M input rate on one million tokens each.
    expect(record.estimatedCost).toBeCloseTo(
      (1_000_000 / 1e6) * 5 * 1.25 + (1_000_000 / 1e6) * 5 * 2,
      6,
    );
  });

  it('marks cost unavailable for a model with no price, rather than guessing', async () => {
    setup([
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'sess-1',
            lines: [
              assistantLine({
                requestId: 'req-1',
                messageId: 'msg-1',
                output: 100,
                model: 'some-unreleased-model',
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
    ]);
    const result = await collector().collect({});
    const record = result.records[0]!;
    expect(record.costBasis).toBe('unavailable');
    expect(record.estimatedCost).toBeUndefined();
    expect(result.notes.join(' ')).toContain('some-unreleased-model');
  });

  it('skips unchanged files on a second run using its cursor', async () => {
    setup([
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'sess-1',
            lines: [
              assistantLine({
                requestId: 'req-1',
                messageId: 'msg-1',
                output: 10,
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
    ]);
    const c = collector();
    const first = await c.collect({});
    expect(first.records).toHaveLength(1);

    const second = await c.collect({ cursor: first.cursor });
    expect(second.records).toHaveLength(0);
    expect(second.notes.join(' ')).toContain('skipped 1 unchanged');
  });

  it('does not persist a cursor for a time-filtered sync', async () => {
    setup([
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'sess-1',
            lines: [
              assistantLine({
                requestId: 'req-1',
                messageId: 'msg-1',
                output: 10,
                stopReason: 'end_turn',
                timestamp: '2026-08-30T10:00:00.000Z',
              }),
            ],
          },
        ],
      },
    ]);
    const c = collector();
    const filtered = await c.collect({ since: new Date('2026-08-01T00:00:00Z') });
    expect(filtered.records).toHaveLength(1);
    // A later unfiltered run must still see the file, or filtered syncs would
    // permanently hide data.
    const full = await c.collect({ cursor: filtered.cursor });
    expect(full.records).toHaveLength(1);
  });

  it('is unavailable, with a reason, when no transcripts exist', async () => {
    process.env.AI_USAGE_CLAUDE_PROJECTS = `${dir}/nowhere`;
    const availability = await collector().isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('No Claude Code transcripts found');
  });
});
