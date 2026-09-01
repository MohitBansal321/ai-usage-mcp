import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type {
  CollectOptions,
  CollectResult,
  CollectorAvailability,
  UsageCollector,
  UsageRecord,
} from '../../models/usage-record.js';
import { UNKNOWN_MODEL } from '../../models/usage-record.js';
import type { CostService } from '../../services/cost-service.js';
import { isWithin, num } from '../collector.js';
import {
  discoverClaudeRoots,
  listTranscripts,
  resolveProjectSlug,
  transcriptLabel,
  unslugProjectPath,
  type TranscriptFile,
} from './transcripts.js';

/** The subset of a transcript line we depend on. */
interface TranscriptLine {
  type?: string;
  uuid?: string;
  requestId?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    stop_reason?: string | null;
    usage?: ClaudeUsage;
  };
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  output_tokens_details?: { thinking_tokens?: number };
  speed?: string;
  service_tier?: string;
  /** Present but deliberately unused -- see the dedupe notes below. */
  iterations?: unknown[];
}

/** One deduplicated API request. */
interface RequestAccumulator {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  reasoningTokens: number;
  model: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  speed?: string;
  requestId?: string;
  messageId?: string;
}

export interface ClaudeCursor {
  /** Per transcript path: size + mtime at the time it was fully ingested. */
  files: Record<string, { sizeBytes: number; mtimeMs: number }>;
}

function isClaudeCursor(value: unknown): value is ClaudeCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ClaudeCursor).files === 'object' &&
    (value as ClaudeCursor).files !== null
  );
}

/** Model ids that are not real models and must never be priced or counted. */
const SYNTHETIC_MODELS = new Set(['<synthetic>']);

/**
 * Reads token usage from Claude Code's JSONL session transcripts.
 *
 * Grain: one record per *API request*, keyed on `requestId` + `message.id`.
 *
 * The dedupe is the whole ballgame. Claude Code writes one line per content
 * block (thinking, tool_use, text) and repeats the same `usage` object on each,
 * with `output_tokens` growing to its final cumulative value on the line that
 * carries a `stop_reason`. On the machine this was verified against, 11,860 lines
 * carrying usage collapse to 5,006 real requests -- summing the lines naively
 * inflates every number by roughly 2.4x.
 *
 * Reduction rule: take the MAX of each field across the group.
 *  - input / cache_read / cache_creation are identical on every line of a group,
 *    so max is a no-op for them.
 *  - output_tokens is cumulative, so max selects the final value. This agreed
 *    with the `stop_reason`-bearing line in 4,886 of 4,889 groups; the 3
 *    exceptions were replayed lines with all-zero usage, where max is the
 *    correct choice and picking "the last line" would have been wrong.
 *  - `usage.iterations[]` is NOT summed: its entries are already included in the
 *    top-level totals (verified on 8,257 of 8,262 groups; the rest were empty
 *    arrays).
 */
export class ClaudeCodeCollector implements UsageCollector {
  readonly name = 'claude-code';
  readonly client = 'claude-code' as const;

  constructor(private readonly costService: CostService) {}

  async isAvailable(): Promise<CollectorAvailability> {
    const stores = discoverClaudeRoots();
    const primary = stores.find((s) => s.primary && s.exists);
    if (!primary) {
      return {
        available: false,
        reason:
          'No Claude Code transcripts found. Looked for a projects/ directory under ' +
          '$CLAUDE_CONFIG_DIR and ~/.claude. Set AI_USAGE_CLAUDE_PROJECTS to point at it.',
        stores,
      };
    }
    const files = listTranscripts(primary.path);
    if (files.length === 0) {
      return {
        available: false,
        reason: `Claude Code projects directory ${primary.path} contains no .jsonl transcripts. Usage unavailable for this installation.`,
        stores,
      };
    }
    return { available: true, stores };
  }

  async collect(options: CollectOptions): Promise<CollectResult> {
    const stores = discoverClaudeRoots();
    const notes: string[] = [];
    const roots = options.allStores
      ? stores.filter((s) => s.exists)
      : stores.filter((s) => s.primary && s.exists);

    if (roots.length === 0) {
      return { records: [], notes: ['Claude Code transcripts not found; nothing collected.'], stores };
    }
    for (const s of stores.filter((s) => s.exists && !roots.includes(s))) {
      notes.push(`Additional Claude Code transcript root detected but NOT collected: ${s.path}.`);
    }

    const prior = isClaudeCursor(options.cursor) ? options.cursor : { files: {} };
    // A time-filtered sync must not mark files as fully ingested, or a later
    // unfiltered sync would skip them and silently under-report.
    const filtered = Boolean(options.since || options.until);
    const cursor: ClaudeCursor = { files: { ...prior.files } };

    const records: UsageRecord[] = [];
    let scanned = 0;
    let skipped = 0;
    let unpricedModels = new Set<string>();
    let syntheticSkipped = 0;
    let requestsSeen = 0;
    let linesWithUsage = 0;

    for (const root of roots) {
      for (const file of listTranscripts(root.path)) {
        const seenBefore = prior.files[file.path];
        if (
          seenBefore &&
          seenBefore.sizeBytes === file.sizeBytes &&
          seenBefore.mtimeMs === file.mtimeMs
        ) {
          skipped++;
          continue;
        }

        scanned++;
        const parsed = await this.readTranscript(file, notes);
        linesWithUsage += parsed.linesWithUsage;
        syntheticSkipped += parsed.syntheticSkipped;
        requestsSeen += parsed.requests.length;

        for (const acc of parsed.requests) {
          const record = this.toRecord(acc, file, unpricedModels);
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
      `Claude Code: read ${scanned} transcript(s), skipped ${skipped} unchanged; ` +
        `${linesWithUsage} usage line(s) collapsed to ${requestsSeen} API request(s) ` +
        `by requestId + message.id.`,
    );
    if (syntheticSkipped > 0) {
      notes.push(`Skipped ${syntheticSkipped} synthetic line(s) (model "<synthetic>", not a real model).`);
    }
    if (unpricedModels.size > 0) {
      notes.push(
        `No price available for model(s): ${[...unpricedModels].join(', ')}. ` +
          `Those records carry costBasis "unavailable".`,
      );
    }

    return { records, cursor: filtered ? prior : cursor, notes, stores };
  }

  /** Streams one transcript and reduces its lines to unique API requests. */
  private async readTranscript(
    file: TranscriptFile,
    notes: string[],
  ): Promise<{ requests: RequestAccumulator[]; linesWithUsage: number; syntheticSkipped: number }> {
    const groups = new Map<string, RequestAccumulator>();
    let linesWithUsage = 0;
    let syntheticSkipped = 0;
    let malformed = 0;

    const stream = createReadStream(file.path, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;

      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(line) as TranscriptLine;
      } catch {
        malformed++;
        continue;
      }

      const usage = parsed.message?.usage;
      if (!usage) continue;
      linesWithUsage++;

      const model = parsed.message?.model;
      if (model && SYNTHETIC_MODELS.has(model)) {
        syntheticSkipped++;
        continue;
      }

      // 14 of 11,860 usage lines carried no requestId. Falling back to the line's
      // own uuid keeps them as distinct requests instead of merging them.
      const requestKey = parsed.requestId ?? `uuid:${parsed.uuid ?? String(linesWithUsage)}`;
      const messageKey = parsed.message?.id ?? 'no-message-id';
      const key = `${requestKey}|${messageKey}`;

      let acc = groups.get(key);
      if (!acc) {
        acc = {
          key,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          reasoningTokens: 0,
          model: model ?? UNKNOWN_MODEL,
        };
        if (parsed.requestId) acc.requestId = parsed.requestId;
        if (parsed.message?.id) acc.messageId = parsed.message.id;
        groups.set(key, acc);
      }

      // MAX, not SUM -- see the class comment.
      acc.inputTokens = Math.max(acc.inputTokens, num(usage.input_tokens));
      acc.outputTokens = Math.max(acc.outputTokens, num(usage.output_tokens));
      acc.cacheReadTokens = Math.max(acc.cacheReadTokens, num(usage.cache_read_input_tokens));
      acc.cacheWriteTokens = Math.max(
        acc.cacheWriteTokens,
        num(usage.cache_creation_input_tokens),
      );
      acc.cacheWrite5mTokens = Math.max(
        acc.cacheWrite5mTokens,
        num(usage.cache_creation?.ephemeral_5m_input_tokens),
      );
      acc.cacheWrite1hTokens = Math.max(
        acc.cacheWrite1hTokens,
        num(usage.cache_creation?.ephemeral_1h_input_tokens),
      );
      acc.reasoningTokens = Math.max(
        acc.reasoningTokens,
        num(usage.output_tokens_details?.thinking_tokens),
      );

      if (model && model !== UNKNOWN_MODEL) acc.model = model;
      if (parsed.sessionId) acc.sessionId = parsed.sessionId;
      if (parsed.timestamp) acc.timestamp = parsed.timestamp;
      if (parsed.cwd) acc.cwd = parsed.cwd;
      if (parsed.version) acc.version = parsed.version;
      if (usage.speed) acc.speed = usage.speed;
    }

    if (malformed > 0) {
      notes.push(`${transcriptLabel(file)}: skipped ${malformed} unparseable line(s).`);
    }
    return { requests: [...groups.values()], linesWithUsage, syntheticSkipped };
  }

  private toRecord(
    acc: RequestAccumulator,
    file: TranscriptFile,
    unpricedModels: Set<string>,
  ): UsageRecord | undefined {
    if (!acc.timestamp || !acc.sessionId) return undefined;
    const timestampIso = new Date(acc.timestamp).toISOString();
    if (Number.isNaN(Date.parse(acc.timestamp))) return undefined;

    const estimate = this.costService.estimate({
      model: acc.model,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens,
      cacheWrite5mTokens: acc.cacheWrite5mTokens,
      cacheWrite1hTokens: acc.cacheWrite1hTokens,
      ...(acc.speed ? { speed: acc.speed } : {}),
    });
    if (estimate.costBasis === 'unavailable') unpricedModels.add(acc.model);

    // Prefer the project directory the slug resolves to on disk: it is stable for
    // the whole session, whereas the recorded `cwd` follows the agent around and
    // can end up pointing at a scratch directory mid-session.
    const projectPath =
      resolveProjectSlug(file.projectSlug) ?? acc.cwd ?? unslugProjectPath(file.projectSlug);

    const record: UsageRecord = {
      id: `claude-code:${acc.key}`,
      client: 'claude-code',
      // Claude Code talks to the Anthropic API (or a gateway presenting it).
      provider: 'anthropic',
      model: acc.model,
      sessionId: acc.sessionId,
      timestamp: timestampIso,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens,
      cacheWrite5mTokens: acc.cacheWrite5mTokens,
      cacheWrite1hTokens: acc.cacheWrite1hTokens,
      reasoningTokens: acc.reasoningTokens,
      // Thinking tokens are a *detail of* output_tokens here, so they are NOT
      // added again -- doing so would double-count and over-price.
      totalTokens:
        acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheWriteTokens,
      // Claude Code records no cost of its own; anything here is an estimate.
      costBasis: estimate.costBasis,
      currency: 'USD',
      turnKind: file.turnKind,
      source: `claude-jsonl:${file.turnKind}`,
    };
    if (estimate.estimatedCost !== undefined) record.estimatedCost = estimate.estimatedCost;
    if (projectPath) record.projectPath = projectPath;
    if (acc.version) record.sourceVersion = acc.version;
    return record;
  }
}
