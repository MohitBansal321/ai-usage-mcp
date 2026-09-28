import type { TurnRow } from '../db/repositories/usage-repository.js';
import type { CostService } from './cost-service.js';

/** Idle longer than this and Anthropic's default (5-minute) cache entry has expired. */
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface CacheBreakOptions {
  /** Minimum spike ratio (writes / rolling baseline) to flag as a break. Default 10. */
  spikeThreshold?: number;
  /** Minimum absolute cache writes on a turn to consider. Default 5000. */
  minCacheWrites?: number;
  /** Number of previous turns in the same stream averaged for the baseline. Default 5. */
  baselineWindow?: number;
}

export interface CacheBreakEvent {
  /** Position of the turn within the session's analyzed turns (0-based). */
  turnIndex: number;
  timestamp: string;
  model: string;
  turnKind: TurnRow['turnKind'];
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Tokens the previous turn in the same stream had cached (its reads + writes). */
  previousPrefixTokens: number;
  writeSpikeRatio: number;
  /** Rolling average of cache writes over the previous turns in the same stream. */
  baselineWriteAvg: number;
  /** Idle time since the previous turn in the same stream, in ms. */
  idleMs: number;
  /**
   * API-equivalent cost of writing this turn's cache instead of reading it, from
   * the versioned pricing table. Absent when the model has no price: unavailable,
   * never 0.
   */
  estimatedExtraCost?: number;
  explanation: string;
}

/** Prices one break's write premium; undefined when the model cannot be priced. */
export type BreakPricer = (turn: TurnRow) => number | undefined;

/**
 * A break's cost is the write premium: what the rewritten prefix cost at
 * cache-write rates, less what reading the same tokens back would have cost.
 */
export function writePremiumPricer(costService: CostService): BreakPricer {
  return (turn) => {
    const base = { model: turn.model, inputTokens: 0, outputTokens: 0, speed: turn.speed };
    const written = costService.estimate({
      ...base,
      cacheWriteTokens: turn.cacheWriteTokens,
      cacheWrite5mTokens: turn.cacheWrite5mTokens,
      cacheWrite1hTokens: turn.cacheWrite1hTokens,
    });
    const read = costService.estimate({ ...base, cacheReadTokens: turn.cacheWriteTokens });
    if (written.estimatedCost === undefined || read.estimatedCost === undefined) return undefined;
    return written.estimatedCost - read.estimatedCost;
  };
}

/**
 * Finds turns where the prefix cache was invalidated.
 *
 * A write spike alone is not a break: reading a large file writes a lot of new
 * cache while still reading the whole existing prefix. A break is a write spike
 * AND a prefix that was not reused -- the turn read back less than half of what
 * the previous turn had cached.
 *
 * Main turns and subagent turns keep separate caches, so each is baselined
 * against its own stream; mixing them would read every switch between the two
 * as a break.
 */
export function detectCacheBreaks(
  turns: TurnRow[],
  options: CacheBreakOptions = {},
  priceBreak?: BreakPricer,
): CacheBreakEvent[] {
  const spikeThreshold = options.spikeThreshold ?? 10;
  const minCacheWrites = options.minCacheWrites ?? 5000;
  const baselineWindow = options.baselineWindow ?? 5;

  const streams = new Map<TurnRow['turnKind'], { turn: TurnRow; index: number }[]>();
  const breaks: CacheBreakEvent[] = [];

  turns.forEach((turn, index) => {
    const history = streams.get(turn.turnKind) ?? [];
    streams.set(turn.turnKind, history);
    const previous = history[history.length - 1]?.turn;
    history.push({ turn, index });

    const cw = turn.cacheWriteTokens;
    if (cw < minCacheWrites || history.length <= baselineWindow || !previous) return;

    const window = history.slice(-baselineWindow - 1, -1);
    const baselineAvg =
      window.reduce((sum, h) => sum + h.turn.cacheWriteTokens, 0) / baselineWindow;
    // A zero baseline is the clearest spike there is, not a reason to skip it.
    const ratio = cw / Math.max(baselineAvg, 1);
    if (ratio < spikeThreshold) return;

    const previousPrefix = previous.cacheReadTokens + previous.cacheWriteTokens;
    if (turn.cacheReadTokens >= previousPrefix / 2) return;

    const idleMs = Date.parse(turn.timestamp) - Date.parse(previous.timestamp);
    const extra = priceBreak?.(turn);
    breaks.push({
      turnIndex: index,
      timestamp: turn.timestamp,
      model: turn.model,
      turnKind: turn.turnKind,
      cacheWriteTokens: cw,
      cacheReadTokens: turn.cacheReadTokens,
      previousPrefixTokens: previousPrefix,
      writeSpikeRatio: Math.round(ratio * 100) / 100,
      baselineWriteAvg: Math.round(baselineAvg),
      idleMs: Number.isFinite(idleMs) ? idleMs : 0,
      ...(extra !== undefined ? { estimatedExtraCost: extra } : {}),
      explanation: explain(turn, previous, baselineAvg, idleMs),
    });
  });

  return breaks;
}

function explain(turn: TurnRow, previous: TurnRow, baselineAvg: number, idleMs: number): string {
  const parts = [
    `Cache writes jumped from ~${Math.round(baselineAvg)} to ${turn.cacheWriteTokens} tokens ` +
      `while cache reads fell from ${previous.cacheReadTokens + previous.cacheWriteTokens} ` +
      `to ${turn.cacheReadTokens} -- the cached prefix was not reused.`,
  ];
  if (previous.model !== turn.model) {
    parts.push(
      `Likely cause: the model switched from ${previous.model} to ${turn.model}; each model has its own cache.`,
    );
  } else if (turn.speed !== previous.speed) {
    parts.push(
      `Likely cause: speed mode changed from ${previous.speed ?? 'standard'} to ${turn.speed ?? 'standard'}.`,
    );
  } else if (idleMs > CACHE_TTL_MS) {
    parts.push(
      `Likely cause: ${Math.round(idleMs / 60_000)} minutes idle since the previous turn; ` +
        'the default 5-minute cache entry expired.',
    );
  } else {
    parts.push(
      'Likely cause: something early in the context changed -- an edited CLAUDE.md/AGENTS.md, ' +
        'a changed tool or MCP server list, or a compaction/rewind that rebuilt the prefix.',
    );
  }
  return parts.join(' ');
}
