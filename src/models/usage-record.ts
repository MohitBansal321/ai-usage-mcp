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

  /**
   * `usage.speed` exactly as the source recorded it -- 'fast' bills at premium
   * rates. Persisted so a later re-price applies the rate that actually applied
   * to these tokens; without it a fast-mode turn silently re-prices at standard
   * rates. `undefined` when the source did not say (OpenCode never does), which
   * is not the same as 'standard'.
   */
  speed?: string;

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
  /**
   * Records whose model has no entry in the pricing table, so no estimate could
   * be attempted for them.
   *
   * Distinct from `unavailableRecords`, which counts records we tried and failed
   * to price. A client that reports its own cost (OpenCode) files a $0 under
   * `reported` for a model nobody has priced, and that rendered identically to a
   * genuinely free model: `reported: 0, unavailableRecords: 0` asserted that
   * nothing was missing while the estimate was, in fact, missing.
   *
   * `undefined` means the question was not asked -- a caller that supplied no
   * list of priced models gets no count, rather than a 0 claiming there are none.
   */
  unpricedRecords?: number;
  /** The distinct models behind `unpricedRecords`, named the way `counterfactual` names them. */
  unpricedModels?: string[];
  currency: 'USD';
}

/**
 * Uppercases the drive letter of a Windows absolute path, and nothing else.
 *
 * The same directory reaches us as both `D:\repo` and `d:\repo` depending on how
 * the client happened to record it, and since Windows paths are case-insensitive
 * those are one project -- but grouping is a string comparison, so they split
 * into two, and every per-project report answered with a fraction of the truth.
 *
 * Only the drive letter is touched, and only when the string is unmistakably a
 * Windows absolute path (`X:\` or `X:/`). The rest of the path is left exactly as
 * recorded, because case-folding it would be wrong on POSIX, where `/home/x` and
 * `/home/X` are genuinely different directories -- merging those would invent a
 * number rather than repair one. A POSIX path can never match this pattern, so
 * this is a no-op there.
 *
 * Deliberately not `process.platform`-dependent: a database may be written on one
 * machine and read on another, so the rule has to be the same everywhere.
 */
export function normaliseProjectPath(path: string): string {
  return /^[a-z]:[\\/]/.test(path) ? `${path[0]!.toUpperCase()}${path.slice(1)}` : path;
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
