import { parseHookTranscriptPath } from '../collectors/claude-code/hook-input.js';
import { readContextSize } from '../collectors/claude-code/context-size.js';

/**
 * Warns while a session's context is growing expensive, rather than after the
 * fact (`usage_report` finds the same waste in hindsight).
 *
 * This service deliberately has no database, no sync and no pricing: it runs in
 * a prompt hook that must answer in tens of milliseconds, and the context size
 * is a gauge of the moment, not a record anyone keeps. `UsageService` exposes it
 * for the status line; the hook uses it directly because opening the database
 * is exactly the cost the hook cannot pay.
 */

export interface ContextLimits {
  /** From here the size is a heads-up (yellow). */
  warnAt: number;
  /** From here compacting is advised (red; the hook speaks up). */
  compactAt: number;
}

export type ContextLevel = 'ok' | 'warn' | 'compact';

export interface ContextReading extends ContextLimits {
  /** Tokens the next message will re-read: input + cache read + cache write of the last turn. */
  tokens: number;
  level: ContextLevel;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = { warnAt: 150_000, compactAt: 250_000 };

/**
 * `150k`, `1.5m` or `150000` as a token count; undefined for anything else, so
 * each caller decides whether that is a usage error (a flag) or ignorable (the
 * environment).
 */
export function parseTokenCount(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(raw.trim());
  if (!match) return undefined;
  const unit = (match[2] ?? '').toLowerCase();
  const n = Math.round(Number(match[1]) * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1));
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Flag, then `AI_USAGE_CTX_WARN` / `AI_USAGE_CTX_LIMIT`, then the defaults.
 *
 * A warn threshold above the compact limit would make the yellow band
 * unreachable, so it is pulled down to the limit instead of being honoured.
 * Throwing is not an option here: this runs in a hook that must never fail.
 */
export function resolveContextLimits(
  flags: { warn?: number | undefined; limit?: number | undefined } = {},
  env: NodeJS.ProcessEnv = process.env,
): ContextLimits {
  const fromEnv = (name: string) => {
    const raw = env[name];
    return raw === undefined ? undefined : parseTokenCount(raw);
  };
  const compactAt =
    flags.limit ?? fromEnv('AI_USAGE_CTX_LIMIT') ?? DEFAULT_CONTEXT_LIMITS.compactAt;
  const warnAt = flags.warn ?? fromEnv('AI_USAGE_CTX_WARN') ?? DEFAULT_CONTEXT_LIMITS.warnAt;
  return { warnAt: Math.min(warnAt, compactAt), compactAt };
}

export function contextLevel(tokens: number, limits: ContextLimits): ContextLevel {
  if (tokens >= limits.compactAt) return 'compact';
  if (tokens >= limits.warnAt) return 'warn';
  return 'ok';
}

export class ContextService {
  /**
   * The session's current context against the limits, or undefined when it is
   * unknown: no transcript path, an unreadable file, no turn yet, or a compact
   * that no new turn has measured. Never throws.
   */
  read(transcriptPath: string | undefined, limits: ContextLimits): ContextReading | undefined {
    if (!transcriptPath) return undefined;
    const tokens = readContextSize(transcriptPath);
    if (tokens === null) return undefined;
    return { tokens, level: contextLevel(tokens, limits), ...limits };
  }

  /** `read`, for the raw JSON a Claude Code hook receives on stdin. Garbage is no data. */
  readHookPayload(raw: string, limits: ContextLimits): ContextReading | undefined {
    return this.read(parseHookTranscriptPath(raw), limits);
  }
}
