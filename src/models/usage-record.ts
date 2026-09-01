/**
 * The normalized shape every collector converges on.
 *
 * Design rule: optional fields stay optional. Different clients expose different
 * things, and forcing a value would mean fabricating one. Anything a source does
 * not report is `undefined` here and surfaces as "unavailable" downstream --
 * never as 0.
 */

export type ClientId = 'claude-code' | 'opencode';

/**
 * `reported`    -- the source told us the cost. Trust it.
 * `estimated`   -- we computed it from a versioned pricing table. API-equivalent,
 *                  NOT necessarily what the user paid (see README on subscriptions).
 * `unavailable` -- we could not honestly produce a number.
 */
export type CostBasis = 'reported' | 'estimated' | 'unavailable';

/**
 * Whether this record is a top-level turn or a subagent/sidechain turn.
 * Kept as data (not a filter applied at collection time) so the same DB can
 * answer both "what did I spend" and "what did the main thread spend".
 */
export type TurnKind = 'main' | 'subagent';

/** Sentinel used when a source genuinely does not record the model/provider. */
export const UNKNOWN_MODEL = '(unknown)';
export const UNKNOWN_PROVIDER = '(unknown)';

export interface UsageRecord {
  /** Stable, deterministic, derived from source identifiers so re-sync is idempotent. */
  id: string;
  client: ClientId;
  provider: string;
  model: string;
  sessionId: string;
  projectPath?: string;
  /** ISO 8601, UTC. */
  timestamp: string;

  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Cache writes split by TTL -- they are priced differently (1.25x vs 2x input). */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  /**
   * Sum of the distinct token classes this record represents.
   *
   * IMPORTANT: this is computed per-client because the sources disagree about
   * whether reasoning tokens are a subset of output tokens:
   *   - Claude Code: `thinking_tokens` is a *detail of* `output_tokens`  -> not added.
   *   - OpenCode:    `reasoning` is a *sibling of* `output`              -> added.
   * See docs/DATA_SOURCES.md. Never recompute this generically.
   */
  totalTokens: number;

  /** Exact cost, only when the source reports it. */
  cost?: number;
  /** Computed from a pricing table. Never mixed with `cost` in a single figure. */
  estimatedCost?: number;
  costBasis: CostBasis;
  currency: 'USD';

  turnKind: TurnKind;

  /** e.g. 'opencode.db:message', 'claude-jsonl:main'. Traceable back to the bytes. */
  source: string;
  /** Version of the *client* that produced the data, so bad data can be traced. */
  sourceVersion?: string;
}

export interface CollectOptions {
  /** Only collect activity at or after this instant. */
  since?: Date;
  /** Only collect activity strictly before this instant. */
  until?: Date;
  /**
   * Opaque, collector-owned resume state from the previous run.
   * Collectors must treat an unrecognised cursor as "no cursor".
   */
  cursor?: unknown;
  /** Read every store the collector can find, not just the primary one. */
  allStores?: boolean;
}

export interface CollectResult {
  records: UsageRecord[];
  /** Persisted and handed back on the next run. */
  cursor?: unknown;
  /** Human-readable notes (skipped files, unknown models, extra stores...). */
  notes: string[];
  /** Where the data physically came from, for `ai-usage status`. */
  stores: StoreInfo[];
}

export interface StoreInfo {
  path: string;
  /** The store the *client itself* would use. Non-primary stores are stale/secondary. */
  primary: boolean;
  exists: boolean;
  detail?: string;
}

export interface CollectorAvailability {
  available: boolean;
  /** Why not, when unavailable -- shown verbatim to the user. */
  reason?: string;
  stores: StoreInfo[];
}

export interface UsageCollector {
  readonly name: string;
  readonly client: ClientId;
  isAvailable(): Promise<CollectorAvailability>;
  collect(options: CollectOptions): Promise<CollectResult>;
}

/** Token classes broken out. A single blended total is misleading -- cache dwarfs input. */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/**
 * Cost is always reported as three separate buckets. Blending `reported` and
 * `estimated` into one unlabelled number is the single easiest way to lie with
 * this data, so the type makes it impossible.
 */
export interface CostTotals {
  reported: number;
  reportedRecords: number;
  estimated: number;
  estimatedRecords: number;
  unavailableRecords: number;
  currency: 'USD';
}

export function emptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

export function emptyCostTotals(): CostTotals {
  return {
    reported: 0,
    reportedRecords: 0,
    estimated: 0,
    estimatedRecords: 0,
    unavailableRecords: 0,
    currency: 'USD',
  };
}
