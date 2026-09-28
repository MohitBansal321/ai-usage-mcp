import type { TurnRow, UsageFilter, UsageRepository } from '../db/repositories/usage-repository.js';
import type { ClientId } from '../models/usage-record.js';
import { detectCacheBreaks, writePremiumPricer } from './cache-breaks.js';
import type { CostService } from './cost-service.js';

/** Context above this is carried, not needed: a compacted session restarts well below it. */
export const CARRY_THRESHOLD_TOKENS = 100_000;
/** A session whose context passed this size is named as a compaction candidate. */
const LARGE_CONTEXT_TOKENS = 200_000;
/** Findings smaller than this share of usage are not worth a fix line. */
const MATERIAL_SHARE = 0.05;
const TOP = 5;

export type Verdict = 'healthy' | 'some-waste' | 'high-waste' | 'no-data';

export interface ReportSession {
  sessionId: string;
  client: ClientId;
  title?: string;
  gitBranch?: string;
  projectPath?: string;
  turns: number;
  startedAt: string;
  endedAt: string;
  /** API-equivalent estimate of the session's turns; the weight used for shares. */
  estimatedCost: number;
  share: number;
  /** Largest context any one turn carried (input + cache read + cache write). */
  peakContextTokens: number;
  /** Weight spent re-reading context above {@link CARRY_THRESHOLD_TOKENS}. */
  carryCost: number;
  rebuilds: number;
}

export interface ReportBranch {
  gitBranch: string;
  sessions: number;
  turns: number;
  estimatedCost: number;
  share: number;
}

export interface UsageReport {
  period: string;
  turns: number;
  sessions: number;
  totalTokens: number;
  /**
   * The weight every share is a share OF: the API-equivalent estimate of the
   * turns that have one. On a subscription this is not money spent; it is a
   * relative measure of how heavy each turn was (model, token class, cache tier).
   */
  weight: { estimatedCost: number; weightedTurns: number; unweightedTurns: number };
  contextCarry: {
    thresholdTokens: number;
    estimatedCost: number;
    share: number;
    /** Turns that carried more than the threshold. */
    turns: number;
    sessionsOverLarge: number;
    largestContextTokens: number;
  };
  cacheRebuilds: {
    count: number;
    afterIdle: number;
    estimatedCost: number;
    share: number;
    /** Rebuilds on a model with no price, excluded from estimatedCost. */
    unpriced: number;
  };
  /** Context carry plus cache rebuilds, as a share of the weight. Avoidable in part, not whole. */
  wasteShare: number;
  verdict: Verdict;
  topSessions: ReportSession[];
  topBranches: ReportBranch[];
  fixes: string[];
  caveats: string[];
}

interface SessionAcc {
  sessionId: string;
  client: ClientId;
  turns: TurnRow[];
  estimatedCost: number;
  peak: number;
  carry: number;
  gitBranch?: string;
  projectPath?: string;
}

/**
 * Where a period's usage went, and how much of it did no new work.
 *
 * Two kinds of waste are measured, both from token counts alone:
 *  - **context carry**: every message re-sends the whole conversation, so a turn
 *    at 300k context re-reads 300k tokens to do one step of work. The part above
 *    {@link CARRY_THRESHOLD_TOKENS} is what compacting earlier would not have
 *    carried.
 *  - **cache rebuilds**: turns where the cached prefix was lost and the whole
 *    context was re-written at cache-write rates (see `detectCacheBreaks`).
 *
 * Neither is claimed as wholly avoidable -- some tasks need a large context --
 * and the report says so.
 */
export class ReportService {
  constructor(
    private readonly repo: UsageRepository,
    private readonly costService: CostService,
  ) {}

  report(filter: UsageFilter, period: string): UsageReport {
    const sessions: SessionAcc[] = [];
    let current: SessionAcc | undefined;
    let turns = 0;
    let totalTokens = 0;
    let weighted = 0;
    let weightedTurns = 0;
    let carryCost = 0;
    let carryTurns = 0;
    let largest = 0;

    for (const turn of this.repo.eachTurn(filter)) {
      if (!current || current.sessionId !== turn.sessionId || current.client !== turn.client) {
        current = {
          sessionId: turn.sessionId,
          client: turn.client,
          turns: [],
          estimatedCost: 0,
          peak: 0,
          carry: 0,
        };
        sessions.push(current);
      }
      current.turns.push(turn);
      if (turn.gitBranch) current.gitBranch = turn.gitBranch;
      if (turn.projectPath) current.projectPath = turn.projectPath;
      turns += 1;
      totalTokens += turn.totalTokens;

      const context = turn.inputTokens + turn.cacheReadTokens + turn.cacheWriteTokens;
      current.peak = Math.max(current.peak, context);
      largest = Math.max(largest, context);

      if (turn.estimatedCost === undefined) continue;
      weighted += turn.estimatedCost;
      weightedTurns += 1;
      current.estimatedCost += turn.estimatedCost;

      if (context > CARRY_THRESHOLD_TOKENS) {
        carryTurns += 1;
        const carried = Math.min(turn.cacheReadTokens, context - CARRY_THRESHOLD_TOKENS);
        const cost = this.costService.estimate({
          model: turn.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: carried,
          ...(turn.speed ? { speed: turn.speed } : {}),
        }).estimatedCost;
        if (cost !== undefined) {
          carryCost += cost;
          current.carry += cost;
        }
      }
    }

    const pricer = writePremiumPricer(this.costService);
    const rebuildsBySession = new Map<SessionAcc, number>();
    let rebuildCount = 0;
    let rebuildIdle = 0;
    let rebuildCost = 0;
    let rebuildUnpriced = 0;
    for (const s of sessions) {
      const breaks = detectCacheBreaks(s.turns, {}, pricer);
      rebuildsBySession.set(s, breaks.length);
      rebuildCount += breaks.length;
      for (const b of breaks) {
        if (b.idleMs > 5 * 60 * 1000) rebuildIdle += 1;
        if (b.estimatedExtraCost === undefined) rebuildUnpriced += 1;
        else rebuildCost += b.estimatedExtraCost;
      }
    }

    const share = (x: number) => (weighted > 0 ? x / weighted : 0);
    const wasteShare = share(carryCost + rebuildCost);
    const verdict: Verdict =
      weighted === 0
        ? 'no-data'
        : wasteShare < 0.15
          ? 'healthy'
          : wasteShare < 0.35
            ? 'some-waste'
            : 'high-waste';

    const topSessions = [...sessions]
      .sort((a, b) => b.estimatedCost - a.estimatedCost)
      .slice(0, TOP)
      .filter((s) => s.estimatedCost > 0)
      .map((s): ReportSession => {
        const first = s.turns[0];
        const last = s.turns[s.turns.length - 1];
        const title = this.repo.sessionTitle(s.client, s.sessionId);
        return {
          sessionId: s.sessionId,
          client: s.client,
          ...(title ? { title } : {}),
          ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}),
          ...(s.projectPath ? { projectPath: s.projectPath } : {}),
          turns: s.turns.length,
          startedAt: first?.timestamp ?? '',
          endedAt: last?.timestamp ?? '',
          estimatedCost: s.estimatedCost,
          share: share(s.estimatedCost),
          peakContextTokens: s.peak,
          carryCost: s.carry,
          rebuilds: rebuildsBySession.get(s) ?? 0,
        };
      });

    const branches = new Map<string, ReportBranch>();
    for (const s of sessions) {
      if (!s.gitBranch || s.estimatedCost === 0) continue;
      const b = branches.get(s.gitBranch) ?? {
        gitBranch: s.gitBranch,
        sessions: 0,
        turns: 0,
        estimatedCost: 0,
        share: 0,
      };
      b.sessions += 1;
      b.turns += s.turns.length;
      b.estimatedCost += s.estimatedCost;
      branches.set(s.gitBranch, b);
    }
    const topBranches = [...branches.values()]
      .map((b) => ({ ...b, share: share(b.estimatedCost) }))
      .sort((a, b) => b.estimatedCost - a.estimatedCost)
      .slice(0, TOP);

    const sessionsOverLarge = sessions.filter((s) => s.peak > LARGE_CONTEXT_TOKENS);
    const report: UsageReport = {
      period,
      turns,
      sessions: sessions.length,
      totalTokens,
      weight: {
        estimatedCost: weighted,
        weightedTurns,
        unweightedTurns: turns - weightedTurns,
      },
      contextCarry: {
        thresholdTokens: CARRY_THRESHOLD_TOKENS,
        estimatedCost: carryCost,
        share: share(carryCost),
        turns: carryTurns,
        sessionsOverLarge: sessionsOverLarge.length,
        largestContextTokens: largest,
      },
      cacheRebuilds: {
        count: rebuildCount,
        afterIdle: rebuildIdle,
        estimatedCost: rebuildCost,
        share: share(rebuildCost),
        unpriced: rebuildUnpriced,
      },
      wasteShare,
      verdict,
      topSessions,
      topBranches,
      fixes: [],
      caveats: [],
    };
    report.fixes = fixesFor(report, sessionsOverLarge, (s) =>
      this.repo.sessionTitle(s.client, s.sessionId),
    );
    report.caveats = caveatsFor(report);
    return report;
  }
}

function fixesFor(
  report: UsageReport,
  large: SessionAcc[],
  titleOf: (s: SessionAcc) => string | undefined,
): string[] {
  const fixes: string[] = [];
  const carry = report.contextCarry;
  if (carry.share >= MATERIAL_SHARE) {
    const worst = [...large].sort((a, b) => b.peak - a.peak)[0];
    const worstName = worst ? (titleOf(worst) ?? worst.sessionId.slice(0, 8)) : undefined;
    fixes.push(
      `Compact earlier. Every message re-sends the whole conversation, so a long session ` +
        `re-reads its entire history on each step. ${carry.sessionsOverLarge} session(s) grew past ` +
        `${LARGE_CONTEXT_TOKENS / 1000}k tokens of context` +
        (worstName ? ` (largest: "${worstName}", ${Math.round((worst?.peak ?? 0) / 1000)}k)` : '') +
        `. Run /compact once a session passes ~${CARRY_THRESHOLD_TOKENS / 1000}k, and start a ` +
        `fresh session for each new task instead of continuing an old one.`,
    );
  }
  const rebuilds = report.cacheRebuilds;
  if (rebuilds.share >= MATERIAL_SHARE && rebuilds.afterIdle > 0) {
    fixes.push(
      `Don't resume a session that has gone cold. ${rebuilds.afterIdle} time(s) a session was ` +
        `continued after its prompt cache expired, and the whole context was re-written from ` +
        `scratch. After a long break, start a fresh session (or /compact first) rather than ` +
        `picking up where you left off.`,
    );
  }
  const other = rebuilds.count - rebuilds.afterIdle;
  if (rebuilds.share >= MATERIAL_SHARE && other >= 3) {
    fixes.push(
      `Keep the start of a session stable. ${other} cache rebuild(s) happened without an idle ` +
        `gap -- usually a model or speed switch mid-session, or editing CLAUDE.md, tools or MCP ` +
        `servers while a session is running. Make those changes between sessions.`,
    );
  }
  if (fixes.length === 0 && report.verdict !== 'no-data') {
    fixes.push('Nothing significant to fix: little of this period went to carrying old context.');
  }
  return fixes;
}

function caveatsFor(report: UsageReport): string[] {
  const caveats = [
    'Shares are weighted by API-equivalent list price -- a relative measure of how heavy each ' +
      'turn was, not money spent. Anthropic does not publish how subscription limits weight ' +
      'each token type, so treat the shares as a guide to where usage went, not as exact limit ' +
      'consumption.',
    'Waste here is avoidable in part, not whole: some tasks genuinely need a large context.',
  ];
  if (report.weight.unweightedTurns > 0) {
    caveats.push(
      `${report.weight.unweightedTurns} turn(s) have no estimate (a model with no price, or one ` +
        'the client reported its own cost for) and are counted in turns and tokens but not in ' +
        'the shares.',
    );
  }
  return caveats;
}
