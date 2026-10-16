import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readContextSize } from '../../src/collectors/claude-code/context-size.js';
import { tempDir } from '../fixtures/build-fixtures.js';

/** One assistant line as Claude Code writes it, reduced to what the reader looks at. */
function assistant(
  options: {
    input?: number;
    cacheRead?: number;
    cacheWrite?: number;
    model?: string;
    sidechain?: boolean;
  } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: options.sidechain ?? false,
    message: {
      model: options.model ?? 'claude-opus-5',
      usage: {
        input_tokens: options.input ?? 0,
        cache_read_input_tokens: options.cacheRead ?? 0,
        cache_creation_input_tokens: options.cacheWrite ?? 0,
        output_tokens: 99,
      },
    },
  });
}

const boundary = () =>
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
  });

/** A line of arbitrary content, as a large tool result would be. */
const user = (padding = 0) =>
  JSON.stringify({ type: 'user', message: { content: 'x'.repeat(padding) } });

describe('readContextSize', () => {
  const dir = tempDir('context-size-');
  let n = 0;
  const transcript = (lines: string[], trailingNewline = true): string => {
    const path = join(dir, `t${n++}.jsonl`);
    writeFileSync(path, lines.join('\n') + (trailingNewline ? '\n' : ''), 'utf8');
    return path;
  };

  it('sums input, cache read and cache write of the last assistant turn', () => {
    const path = transcript([assistant({ input: 2, cacheRead: 81_000, cacheWrite: 1_500 })]);
    expect(readContextSize(path)).toBe(82_502);
  });

  it('the last usage wins, not the largest or the first', () => {
    const path = transcript([
      assistant({ cacheRead: 400_000 }),
      user(),
      assistant({ cacheRead: 90_000 }),
      user(),
    ]);
    expect(readContextSize(path)).toBe(90_000);
  });

  it('reads a transcript whose last line has no trailing newline', () => {
    expect(readContextSize(transcript([user(), assistant({ input: 7 })], false))).toBe(7);
  });

  it('skips sidechain turns: a subagent has its own context', () => {
    const path = transcript([
      assistant({ cacheRead: 60_000 }),
      assistant({ cacheRead: 5_000, sidechain: true }),
    ]);
    expect(readContextSize(path)).toBe(60_000);
  });

  it('skips synthetic turns and all-zero usage', () => {
    const path = transcript([
      assistant({ cacheRead: 60_000 }),
      assistant({ cacheRead: 1_234, model: '<synthetic>' }),
      assistant({}),
    ]);
    expect(readContextSize(path)).toBe(60_000);
  });

  it('is unknown, not stale, when a compact_boundary comes after the last usage', () => {
    const path = transcript([assistant({ cacheRead: 458_000 }), user(), boundary()]);
    expect(readContextSize(path)).toBeNull();
  });

  it('counts usage again once a turn follows the boundary', () => {
    const path = transcript([
      assistant({ cacheRead: 458_000 }),
      boundary(),
      user(),
      assistant({ cacheRead: 73_000 }),
    ]);
    expect(readContextSize(path)).toBe(73_000);
  });

  it('does not mistake the words "compact_boundary" inside a message for a boundary', () => {
    const path = transcript([
      assistant({ cacheRead: 50_000 }),
      JSON.stringify({ type: 'user', message: { content: '"subtype":"compact_boundary"' } }),
    ]);
    expect(readContextSize(path)).toBe(50_000);
  });

  it('ignores a first line cut in half by the window, then grows to find the turn', () => {
    // The window starts inside the assistant line: its tail is not JSON, and the
    // answer must come from reading further back, not from the fragment.
    const lines = [assistant({ cacheRead: 111_000 }), user(400)];
    const path = transcript(lines);
    expect(readContextSize(path, { initialWindowBytes: 300 })).toBe(111_000);
  });

  it('grows the window ×4 past the first 256 KB until the turn is found', () => {
    // 3 MB of tool output after the last turn: needs two growths (1 MB, then 4 MB).
    const path = transcript([assistant({ cacheRead: 123_000 }), ...Array(30).fill(user(100_000))]);
    expect(readContextSize(path)).toBe(123_000);
  });

  it('finds a boundary that lies beyond the first window', () => {
    const path = transcript([
      assistant({ cacheRead: 9 }),
      boundary(),
      ...Array(4).fill(user(100_000)),
    ]);
    expect(readContextSize(path)).toBeNull();
  });

  it('is unknown for a file with no usable turn, and stops at the start of the file', () => {
    expect(readContextSize(transcript([user(), user()]))).toBeNull();
    expect(readContextSize(transcript(['not json', '{"type":"assistant"}', '']))).toBeNull();
  });

  it('is unknown, and does not throw, for a missing, empty or unreadable path', () => {
    expect(readContextSize(join(dir, 'does-not-exist.jsonl'))).toBeNull();
    expect(readContextSize(transcript([], false))).toBeNull();
    const directory = join(dir, 'a-directory');
    mkdirSync(directory);
    expect(readContextSize(directory)).toBeNull();
    expect(readContextSize('')).toBeNull();
  });

  it('treats non-numeric usage fields as zero rather than throwing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: 'm', usage: { input_tokens: 'many', cache_read_input_tokens: 12 } },
    });
    expect(readContextSize(transcript([line]))).toBe(12);
  });
});
