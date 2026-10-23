import type {
  CollectOptions,
  CollectResult,
  CollectorAvailability,
  UsageCollector,
  UsageRecord,
} from '../../models/usage-record.js';
import {
  normaliseProjectPath,
  UNKNOWN_MODEL,
  UNKNOWN_PROVIDER,
} from '../../models/usage-record.js';
import { promptTokensOf, type CostService } from '../../services/cost-service.js';
import { isWithin, num } from '../collector.js';
import {
  canReadCompressedRollouts,
  discoverCodexHomes,
  listRollouts,
  readRolloutLines,
  rolloutLabel,
  sessionIdFromFileName,
  type RolloutFile,
} from './rollouts.js';

/**
 * The subset of a rollout line we depend on. Every line is
 * `{ timestamp, type, payload }`; only the payload fields named here are read.
 * `response_item` lines (the conversation itself) are never looked into.
 */
interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    /** session_meta. `session_id` sits beside it from 0.162 on, with the same value. */
    id?: string;
    session_id?: string;
    cwd?: string;
    cli_version?: string;
    model_provider?: string;
    git?: { branch?: string };
    /** turn_context. */
    model?: string;
    /** event_msg / token_count. `null` when the event only carries rate limits. */
    info?: {
      total_token_usage?: CodexUsage;
      last_token_usage?: CodexUsage;
    } | null;
  };
}

/** OpenAI-style usage: cached input is part of input, reasoning part of output. */
interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

/** One counted model request. */
interface RequestUsage {
  /** The session's cumulative `total_tokens` once this request was counted. */
  cumulativeTotal: number;
  timestamp: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  /** `undefined` when the CLI did not write the field (0.114.0 does not). */
  cacheWriteInputTokens: number | undefined;
  outputTokens: number;
  reasoningTokens: number;
}

interface SessionFacts {
  sessionId?: string;
  cwd?: string;
  turnCwd?: string;
  version?: string;
  provider?: string;
  gitBranch?: string;
}

/** Bumped whenever the collector starts reading something new from rollouts. */
export const CODEX_CURSOR_VERSION = 1;

export interface CodexCursor {
  version: typeof CODEX_CURSOR_VERSION;
  /** Per rollout path: size + mtime at the time it was fully ingested. */
  files: Record<string, { sizeBytes: number; mtimeMs: number }>;
}

function isCodexCursor(value: unknown): value is CodexCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as CodexCursor).version === CODEX_CURSOR_VERSION &&
    typeof (value as CodexCursor).files === 'object' &&
    (value as CodexCursor).files !== null
  );
}

const USAGE_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
] as const;

function sameUsage(a: CodexUsage, b: CodexUsage): boolean {
  return USAGE_FIELDS.every((f) => num(a[f]) === num(b[f]));
}

/**
 * Reads token usage from Codex CLI's session rollouts (`$CODEX_HOME/sessions`).
 *
 * Grain: one record per *model request*, read from `event_msg` lines of type
 * `token_count`. Each carries `info.last_token_usage` (that request) and
 * `info.total_token_usage` (the session's running total).
 *
 * The dedupe is the whole ballgame, again. Codex re-emits `token_count` with an
 * unchanged running total: once more after most requests, at the start of the
 * next turn, after a compaction, and with `info: null` for a rate-limit update.
 * On the 0.114.0 session verified, 76 `token_count` events held 36 real requests
 * -- summing every event's `last_token_usage` doubles the session. The compaction
 * repeat is worse than a copy: its `last_token_usage` is all zeros except
 * `total_tokens: 8376`.
 *
 * Reduction rule: a `token_count` is a new request only when its
 * `total_token_usage` differs from the previous event's. That is the running
 * total Codex itself keeps, so it moves exactly when Codex counted something:
 * on both sessions verified, `last_token_usage` equalled the change in the total
 * on every field of every counted event, and the counted events summed to the
 * final total exactly.
 *
 * `token_usage_record` lines (0.162 on) are NOT read here. Each is the same
 * request again -- the same `usage` as the `token_count` that follows it, plus a
 * `response_id` -- so reading both would count every request twice. `verify`
 * uses them as an independent check instead.
 *
 * Normalisation, which differs from both other clients: OpenAI counts cached
 * input INSIDE `input_tokens` and reasoning INSIDE `output_tokens` (verified:
 * `total_tokens === input_tokens + output_tokens` on every counted request,
 * with reasoning non-zero on most of them). Our `inputTokens` is uncached input,
 * as it is for Claude Code and OpenCode, so cached input is subtracted out of
 * it and stored as cache-read. Reasoning stays inside output, as for Claude Code.
 */
export class CodexCollector implements UsageCollector {
  readonly name = 'codex';
  readonly client = 'codex' as const;

  constructor(private readonly costService: CostService) {}

  async isAvailable(): Promise<CollectorAvailability> {
    const stores = discoverCodexHomes();
    const primary = stores.find((s) => s.primary && s.exists);
    if (!primary) {
      return {
        available: false,
        reason:
          'No Codex CLI home found. Looked for $CODEX_HOME and ~/.codex. ' +
          'Set AI_USAGE_CODEX_HOME to point at it.',
        stores,
      };
    }
    const files = listRollouts(primary.path);
    if (files.length === 0) {
      return {
        available: false,
        reason: `Codex home ${primary.path} contains no session rollouts. Usage unavailable for this installation.`,
        stores,
      };
    }
    const lastWrite = files.reduce((latest, f) => Math.max(latest, f.mtimeMs), 0);
    return { available: true, stores, lastWriteAt: new Date(lastWrite).toISOString() };
  }

  async collect(options: CollectOptions): Promise<CollectResult> {
    const stores = discoverCodexHomes();
    const notes: string[] = [];
    const homes = options.allStores
      ? stores.filter((s) => s.exists)
      : stores.filter((s) => s.primary && s.exists);

    if (homes.length === 0) {
      return { records: [], notes: ['Codex CLI home not found; nothing collected.'], stores };
    }
    for (const s of stores.filter((s) => s.exists && !homes.includes(s))) {
      notes.push(
        `Additional Codex home detected but NOT collected: ${s.path} (${s.detail ?? 'extra store'}). ` +
          'It may hold separate history (the Codex snap keeps its own home) or be a stale copy ' +
          'of the primary. Records are keyed by session id and running total, so --all-stores ' +
          'merges homes without double counting.',
      );
    }

    const prior: CodexCursor = isCodexCursor(options.cursor)
      ? options.cursor
      : { version: CODEX_CURSOR_VERSION, files: {} };
    // A time-filtered sync must not mark files as fully ingested, or a later
    // unfiltered sync would skip them and silently under-report.
    const filtered = Boolean(options.since || options.until);
    const cursor: CodexCursor = { version: CODEX_CURSOR_VERSION, files: { ...prior.files } };

    const records: UsageRecord[] = [];
    let scanned = 0;
    let skipped = 0;
    let events = 0;
    let requests = 0;
    let cacheWriteRequests = 0;
    const unreadable: string[] = [];
    const unpricedModels = new Set<string>();
    const zstd = canReadCompressedRollouts();

    for (const home of homes) {
      for (const file of listRollouts(home.path)) {
        const seenBefore = prior.files[file.path];
        if (
          seenBefore &&
          seenBefore.sizeBytes === file.sizeBytes &&
          seenBefore.mtimeMs === file.mtimeMs
        ) {
          skipped++;
          continue;
        }
        if (file.compressed && !zstd) {
          unreadable.push(rolloutLabel(file));
          continue;
        }

        scanned++;
        let parsed;
        try {
          parsed = await this.readRollout(file, notes);
        } catch (err) {
          // An unreadable or corrupt file (a bad .zst, most likely): name it, and
          // leave it out of the cursor so the next sync tries again.
          notes.push(`${rolloutLabel(file)}: could not be read (${(err as Error).message}).`);
          continue;
        }
        events += parsed.events;
        requests += parsed.requests.length;

        for (const request of parsed.requests) {
          if ((request.cacheWriteInputTokens ?? 0) > 0) cacheWriteRequests++;
          const record = this.toRecord(request, parsed.facts, file, unpricedModels);
          if (!record) continue;
          if (!isWithin(record.timestamp, options.since, options.until)) continue;
          records.push(record);
        }

        if (!filtered) {
          cursor.files[file.path] = { sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs };
        }
      }
    }

    notes.push(
      `Codex: read ${scanned} rollout(s), skipped ${skipped} unchanged; ` +
        `${events} token_count event(s) held ${requests} model request(s) ` +
        `(an event repeating the previous running total is not a new request).`,
    );
    if (unreadable.length > 0) {
      notes.push(
        `Skipped ${unreadable.length} compressed rollout(s) (.jsonl.zst): this Node has no zstd ` +
          `(it needs 22.15 or later). Their usage is NOT included: ${unreadable.join(', ')}.`,
      );
    }
    if (cacheWriteRequests > 0) {
      notes.push(
        `${cacheWriteRequests} Codex request(s) reported cache_write_input_tokens. That field was ` +
          `always 0 in the data this collector was verified against; it is treated as part of ` +
          `input_tokens, like cached input. See docs/DATA_SOURCES.md.`,
      );
    }
    if (unpricedModels.size > 0) {
      notes.push(
        `No price available for model(s): ${[...unpricedModels].join(', ')}. ` +
          `Those records carry costBasis "unavailable".`,
      );
    }

    return { records, cursor: filtered ? prior : cursor, notes, stores };
  }

  /** Streams one rollout and reduces its `token_count` events to model requests. */
  private async readRollout(
    file: RolloutFile,
    notes: string[],
  ): Promise<{ requests: RequestUsage[]; events: number; facts: SessionFacts }> {
    const requests: RequestUsage[] = [];
    const facts: SessionFacts = {};
    let model: string | undefined;
    let previousTotal: CodexUsage | undefined;
    let events = 0;
    let malformed = 0;
    let missingLast = 0;

    for await (const raw of readRolloutLines(file)) {
      const line = raw.trim();
      if (!line) continue;

      let parsed: RolloutLine;
      try {
        parsed = JSON.parse(line) as RolloutLine;
      } catch {
        malformed++;
        continue;
      }
      const payload = parsed.payload;
      if (!payload) continue;

      if (parsed.type === 'session_meta') {
        const id = payload.id ?? payload.session_id;
        if (id) facts.sessionId = id;
        if (payload.cwd) facts.cwd = payload.cwd;
        if (payload.cli_version) facts.version = payload.cli_version;
        if (payload.model_provider) facts.provider = payload.model_provider;
        if (payload.git?.branch) facts.gitBranch = payload.git.branch;
        continue;
      }

      // The model is per turn, not per session: it is on `turn_context`, which
      // precedes the turn's requests.
      if (parsed.type === 'turn_context') {
        if (payload.model) model = payload.model;
        if (payload.cwd) facts.turnCwd = payload.cwd;
        continue;
      }

      if (parsed.type !== 'event_msg' || payload.type !== 'token_count') continue;
      events++;
      const total = payload.info?.total_token_usage;
      // `info: null` -- a rate-limit update with no usage in it.
      if (!total) continue;
      // The running total did not move, so Codex counted nothing new: a repeat.
      if (previousTotal && sameUsage(total, previousTotal)) continue;
      previousTotal = total;

      const last = payload.info?.last_token_usage;
      if (!last || !parsed.timestamp) {
        missingLast++;
        continue;
      }
      requests.push({
        cumulativeTotal: num(total.total_tokens),
        timestamp: parsed.timestamp,
        model: model ?? UNKNOWN_MODEL,
        inputTokens: num(last.input_tokens),
        cachedInputTokens: num(last.cached_input_tokens),
        cacheWriteInputTokens:
          last.cache_write_input_tokens === undefined
            ? undefined
            : num(last.cache_write_input_tokens),
        outputTokens: num(last.output_tokens),
        reasoningTokens: num(last.reasoning_output_tokens),
      });
    }

    facts.sessionId ??= sessionIdFromFileName(file.path);
    if (malformed > 0) {
      notes.push(`${rolloutLabel(file)}: skipped ${malformed} unparseable line(s).`);
    }
    if (missingLast > 0) {
      notes.push(
        `${rolloutLabel(file)}: ${missingLast} token_count event(s) moved the running total ` +
          `but carried no last_token_usage or timestamp; not counted.`,
      );
    }
    return { requests, events, facts };
  }

  private toRecord(
    request: RequestUsage,
    facts: SessionFacts,
    file: RolloutFile,
    unpricedModels: Set<string>,
  ): UsageRecord | undefined {
    if (!facts.sessionId) return undefined;
    const t = Date.parse(request.timestamp);
    if (Number.isNaN(t)) return undefined;

    // Cached input (and, unverified, cache-write input) is inside `input_tokens`;
    // what is left is the uncached input every other client reports as input.
    const cacheRead = request.cachedInputTokens;
    const cacheWrite = request.cacheWriteInputTokens;
    const input = Math.max(0, request.inputTokens - cacheRead - (cacheWrite ?? 0));

    const estimate = this.costService.estimate({
      model: request.model,
      inputTokens: input,
      outputTokens: request.outputTokens,
      cacheReadTokens: cacheRead,
      ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
      promptTokens: promptTokensOf({
        inputTokens: input,
        cacheReadTokens: cacheRead,
        ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
      }),
    });
    if (estimate.costBasis === 'unavailable') unpricedModels.add(request.model);

    // The session's own `cwd` is stable for its whole life; a turn's can differ.
    const projectPath = facts.cwd ?? facts.turnCwd;

    const record: UsageRecord = {
      // The running total identifies the request within its session, and is the
      // same however many times the event was written or the file was moved
      // (archiving moves it), so re-sync is idempotent.
      id: `codex:${facts.sessionId}:${request.cumulativeTotal}`,
      client: 'codex',
      provider: facts.provider ?? UNKNOWN_PROVIDER,
      model: request.model,
      sessionId: facts.sessionId,
      timestamp: new Date(t).toISOString(),
      inputTokens: input,
      outputTokens: request.outputTokens,
      cacheReadTokens: cacheRead,
      reasoningTokens: request.reasoningTokens,
      // Reasoning is a *detail of* output here, so it is NOT added again.
      totalTokens: input + request.outputTokens + cacheRead + (cacheWrite ?? 0),
      // Codex records no cost of its own; anything here is an estimate.
      costBasis: estimate.costBasis,
      currency: 'USD',
      // No subagent rollout has been observed, so nothing is classified as one.
      turnKind: 'main',
      source: `codex-jsonl:${file.archived ? 'archived' : 'sessions'}`,
    };
    if (estimate.estimatedCost !== undefined) record.estimatedCost = estimate.estimatedCost;
    // Absent, not 0, when the CLI did not report it: 0.114.0 has no such field.
    if (cacheWrite !== undefined) record.cacheWriteTokens = cacheWrite;
    if (projectPath) record.projectPath = normaliseProjectPath(projectPath);
    if (facts.version) record.sourceVersion = facts.version;
    if (facts.gitBranch) record.gitBranch = facts.gitBranch;
    return record;
  }
}
