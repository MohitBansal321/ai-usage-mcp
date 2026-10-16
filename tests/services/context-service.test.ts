import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ContextService,
  DEFAULT_CONTEXT_LIMITS,
  contextLevel,
  parseTokenCount,
  resolveContextLimits,
} from '../../src/services/context-service.js';
import { formatContextHook, formatStatusLine } from '../../src/services/formatter.js';
import type { StatusLineReport } from '../../src/services/plan-limit-service.js';
import type { AggregateRow } from '../../src/db/repositories/usage-repository.js';
import { parseStatusLineInput } from '../../src/collectors/claude-code/statusline.js';
import { tempDir } from '../fixtures/build-fixtures.js';

const limits = DEFAULT_CONTEXT_LIMITS;

function transcriptWith(tokens: number): string {
  const path = join(tempDir('context-service-'), 't.jsonl');
  writeFileSync(
    path,
    JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-5', usage: { cache_read_input_tokens: tokens } },
    }) + '\n',
  );
  return path;
}

describe('parseTokenCount', () => {
  it('reads k, m and plain counts', () => {
    expect(parseTokenCount('150k')).toBe(150_000);
    expect(parseTokenCount('150K')).toBe(150_000);
    expect(parseTokenCount('1.5m')).toBe(1_500_000);
    expect(parseTokenCount('250000')).toBe(250_000);
    expect(parseTokenCount(' 90k ')).toBe(90_000);
  });

  it('refuses anything else, and zero', () => {
    for (const bad of ['', 'k', 'abc', '-5k', '0', '0k', '1e5', '12 k', '1.5.2m'])
      expect(parseTokenCount(bad), bad).toBeUndefined();
  });
});

describe('resolveContextLimits', () => {
  it('defaults to 150k and 250k', () => {
    expect(resolveContextLimits({}, {})).toEqual({ warnAt: 150_000, compactAt: 250_000 });
  });

  it('takes the environment over the defaults, and flags over the environment', () => {
    const env = { AI_USAGE_CTX_WARN: '100k', AI_USAGE_CTX_LIMIT: '200k' };
    expect(resolveContextLimits({}, env)).toEqual({ warnAt: 100_000, compactAt: 200_000 });
    expect(resolveContextLimits({ warn: 50_000, limit: 80_000 }, env)).toEqual({
      warnAt: 50_000,
      compactAt: 80_000,
    });
  });

  it('ignores an unreadable environment value instead of throwing', () => {
    expect(resolveContextLimits({}, { AI_USAGE_CTX_LIMIT: 'lots' })).toEqual(
      DEFAULT_CONTEXT_LIMITS,
    );
  });

  it('pulls a warn threshold that exceeds the limit down to it', () => {
    expect(resolveContextLimits({ limit: 100_000 }, {})).toEqual({
      warnAt: 100_000,
      compactAt: 100_000,
    });
  });
});

describe('contextLevel', () => {
  it('changes exactly at the limits', () => {
    expect(contextLevel(149_999, limits)).toBe('ok');
    expect(contextLevel(150_000, limits)).toBe('warn');
    expect(contextLevel(249_999, limits)).toBe('warn');
    expect(contextLevel(250_000, limits)).toBe('compact');
  });
});

describe('ContextService', () => {
  const service = new ContextService();

  it('reports tokens, level and the limits it used', () => {
    expect(service.read(transcriptWith(260_000), limits)).toEqual({
      tokens: 260_000,
      level: 'compact',
      ...limits,
    });
  });

  it('is undefined, not zero, when the size is unknown', () => {
    expect(service.read(undefined, limits)).toBeUndefined();
    expect(service.read('/no/such/transcript.jsonl', limits)).toBeUndefined();
  });

  it('reads the transcript path out of a hook payload, and treats garbage as no data', () => {
    const path = transcriptWith(300_000);
    expect(service.readHookPayload(JSON.stringify({ transcript_path: path }), limits)?.tokens).toBe(
      300_000,
    );
    for (const raw of ['', 'not json', '[]', 'null', '{"transcript_path":7}', '{}'])
      expect(service.readHookPayload(raw, limits), raw).toBeUndefined();
  });

  it('is carried by the status-line payload too', () => {
    expect(parseStatusLineInput('{"transcript_path":"/x/y.jsonl"}').transcriptPath).toBe(
      '/x/y.jsonl',
    );
    expect(parseStatusLineInput('{"transcript_path":5}').transcriptPath).toBeUndefined();
  });
});

describe('the status-line ctx segment', () => {
  const today = {
    records: 0,
    cost: { reported: 0, estimated: 0, reportedRecords: 0, estimatedRecords: 0 },
  } as unknown as AggregateRow;
  const line = (tokens: number | undefined, color: boolean): string => {
    const report: StatusLineReport = { limits: [], today };
    if (tokens !== undefined) {
      report.context = { tokens, level: contextLevel(tokens, limits), ...limits };
    }
    return formatStatusLine(report, { color });
  };

  it('is green below the warn limit, after the existing segments', () => {
    expect(line(77_000, true)).toBe('today: no turns yet · \x1b[32mctx 77k\x1b[0m');
  });

  it('is yellow from the warn limit', () => {
    expect(line(150_000, true)).toBe('today: no turns yet · \x1b[33mctx 150k\x1b[0m');
  });

  it('is red, and says to compact, from the compact limit', () => {
    expect(line(260_000, true)).toBe('today: no turns yet · \x1b[31mctx 260k · compact now\x1b[0m');
  });

  it('drops the colour but keeps the words without colour', () => {
    expect(line(77_000, false)).toBe('today: no turns yet · ctx 77k');
    expect(line(260_000, false)).toBe('today: no turns yet · ctx 260k · compact now');
  });

  it('shows nothing when the size is unknown', () => {
    expect(line(undefined, false)).toBe('today: no turns yet');
  });

  it('abbreviates small and very large sizes', () => {
    expect(line(850, false)).toContain('ctx 850');
    expect(line(1_200_000, false)).toContain('ctx 1.2M');
  });
});

describe('formatContextHook', () => {
  const reading = (tokens: number) => ({ tokens, level: contextLevel(tokens, limits), ...limits });

  it('is silent below the compact limit, including the warn band, and when unknown', () => {
    expect(formatContextHook(reading(77_000))).toBeUndefined();
    expect(formatContextHook(reading(249_999))).toBeUndefined();
    expect(formatContextHook(undefined)).toBeUndefined();
  });

  it('prints the UserPromptSubmit JSON at the compact limit', () => {
    const out = JSON.parse(formatContextHook(reading(260_000)) as string);
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const text: string = out.hookSpecificOutput.additionalContext;
    expect(text).toContain('260k');
    expect(text).toContain('250k');
    expect(text).toContain('re-sends the whole conversation');
    expect(text).toContain('/compact');
    expect(text).toContain('/clear');
    expect(out.systemMessage).toContain('260k');
    expect(Object.keys(out).sort()).toEqual(['hookSpecificOutput', 'systemMessage']);
  });
});
