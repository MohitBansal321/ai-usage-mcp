import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatCacheHealth } from '../../services/formatter.js';
import { readOnlyTool, textResult, type ToolContext } from './shared.js';

export function registerCacheHealth(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'cache_health',
    {
      ...readOnlyTool('Cache Health'),
      description:
        'Analyzes a session for cache breaks -- sudden spikes in cache write tokens that ' +
        'indicate the prefix cache was invalidated (e.g., by editing a core file mid-session, ' +
        'changing file load order, or modifying a global config like CLAUDE.md). ' +
        'Reports each break with the turn, token delta, estimated extra cost, and a human ' +
        'explanation of the likely cause. Also returns overall cache hit rate and reads-per-write.',
      inputSchema: z.strictObject({
        sessionId: z
          .string()
          .min(1)
          .describe('Session ID (full or unambiguous prefix) to analyze.'),
        includeSubagents: z
          .boolean()
          .optional()
          .describe(
            'Include subagent/sidechain turns. Defaults to true; they often re-read parent context.',
          ),
        spikeThreshold: z
          .number()
          .positive()
          .optional()
          .default(10)
          .describe('Minimum spike ratio (current writes / rolling average) to flag as a break.'),
        minCacheWrites: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .default(5000)
          .describe('Minimum absolute cache writes on a turn to consider (filters noise).'),
        baselineWindow: z
          .number()
          .int()
          .positive()
          .optional()
          .default(5)
          .describe('Number of previous turns to average for the baseline.'),
      }),
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.cacheHealth(args.sessionId, args.includeSubagents, {
        spikeThreshold: args.spikeThreshold,
        minCacheWrites: args.minCacheWrites,
        baselineWindow: args.baselineWindow,
      });
      if (!report) {
        return textResult(`Session "${args.sessionId}" not found.`);
      }
      if ('ambiguous' in report) {
        return textResult(
          `Ambiguous session ID "${args.sessionId}". Matches: ${report.ambiguous.join(', ')}. ` +
            'Provide a longer prefix.',
        );
      }
      return textResult(formatCacheHealth(report), {
        sessionId: report.sessionId,
        totalTurns: report.totalTurns,
        turnsAnalyzed: report.turnsAnalyzed,
        hitRate: report.hitRate,
        readsPerWrite: report.readsPerWrite,
        breakCount: report.summary.breakCount,
        breaks: report.breaks.map((b) => ({
          turnIndex: b.turnIndex,
          timestamp: b.timestamp,
          cacheWriteTokens: b.cacheWriteTokens,
          cacheReadTokens: b.cacheReadTokens,
          writeSpikeRatio: b.writeSpikeRatio,
          baselineWriteAvg: b.baselineWriteAvg,
          estimatedExtraCost: b.estimatedExtraCost,
          explanation: b.explanation,
        })),
        summary: report.summary,
      });
    },
  );
}
