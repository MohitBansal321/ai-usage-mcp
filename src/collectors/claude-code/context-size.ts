import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * The size of the context a Claude Code session is carrying right now, read from
 * the tail of its transcript. See docs/DATA_SOURCES.md §2.12.
 *
 * Every turn re-sends the whole conversation, so the LAST real assistant turn's
 * input side -- fresh input plus cache reads plus cache writes -- is how many
 * tokens the next message will re-read. This is not a usage total and is never
 * stored: it is a gauge of the moment, which is why it reads the file directly
 * and neither syncs nor touches the database.
 */

/** Tail window the first read covers; each retry multiplies it by GROWTH. */
export const INITIAL_WINDOW_BYTES = 256 * 1024;
const GROWTH = 4;

/**
 * The context size in tokens, or `null` when it cannot be known.
 *
 * Unknown is a real answer, not a failure, and is never replaced with an older
 * number:
 *  - a `compact_boundary` line AFTER the last assistant usage means the context
 *    was just compacted and no turn has measured the new one. The last usage
 *    still describes the PRE-compact context (seen live: 458k shown when the real
 *    context was ~73k), so it must not be reported;
 *  - an unreadable, missing or empty transcript, or one with no usable turn yet.
 *
 * Never throws: it runs inside a status line and a prompt hook, and neither may
 * fail on a transcript it cannot read.
 */
export function readContextSize(
  transcriptPath: string,
  options: { initialWindowBytes?: number } = {},
): number | null {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    let window = Math.max(1, options.initialWindowBytes ?? INITIAL_WINDOW_BYTES);
    for (;;) {
      const start = Math.max(0, size - window);
      const found = scanTail(fd, start, size);
      if (found !== undefined) return found;
      if (start === 0) return null;
      window *= GROWTH;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do about a failed close of a read-only handle.
      }
    }
  }
}

/**
 * Walks the lines in `[start, end)` from the newest backwards. Returns the
 * context size, `null` for a compact boundary reached first, or `undefined` when
 * this window held neither and a larger one should be tried.
 */
function scanTail(fd: number, start: number, end: number): number | null | undefined {
  const buffer = Buffer.alloc(end - start);
  let filled = 0;
  while (filled < buffer.length) {
    const n = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
    if (n === 0) break;
    filled += n;
  }
  const lines = buffer.toString('utf8', 0, filled).split('\n');
  // A window that starts mid-file begins in the middle of some line. It is
  // dropped whole: a truncated JSON line is unparseable at best, and at worst a
  // valid-looking suffix. (If it was in fact a whole line the window grows and
  // reads it next time, so nothing is lost.)
  if (start > 0) lines.shift();

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    // Cheap pre-filter: transcript lines can be megabytes (tool results), and
    // only these two shapes matter. The parse below is what actually decides.
    if (!line.includes('"usage"') && !line.includes('compact_boundary')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (e.type === 'system' && e.subtype === 'compact_boundary') return null;
    const tokens = contextTokens(e);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}

/** The input-side size of one main-chain assistant turn, or undefined if it is not one. */
function contextTokens(e: Record<string, unknown>): number | undefined {
  if (e.type !== 'assistant') return undefined;
  // Subagent turns carry their own, unrelated context.
  if (e.isSidechain === true) return undefined;
  const message = e.message;
  if (typeof message !== 'object' || message === null) return undefined;
  const m = message as Record<string, unknown>;
  // Placeholder/error turns, not a real request.
  if (m.model === '<synthetic>') return undefined;
  const usage = m.usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const total =
    count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens);
  // All-zero usage is a replayed line (DATA_SOURCES §2.3), not an empty context.
  return total > 0 ? total : undefined;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
