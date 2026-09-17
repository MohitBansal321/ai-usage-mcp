import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatSummary } from '../../services/formatter.js';
import { cacheMetrics } from '../../services/cache-metrics.js';
import {
  clientEnum,
  periodShape,
  readOnlyTool,
  textResult,
  toQuery,
  type ToolContext,
} from './shared.js';

export function registerUsageSummary(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'usage_summary',
    {
      ...readOnlyTool('Usage summary'),
      description:
        'Total token usage and cost for a period, split by client (Claude Code, OpenCode). ' +
        'Tokens are broken out into input / output / cache-read / cache-write / reasoning, ' +
        'because cache tokens typically dwarf input and a single blended total is misleading. ' +
        'Reported cost (from OpenCode) and estimated cost (computed for Claude Code, which ' +
        'records none) are always listed separately and must not be summed. Also reports the ' +
        'cache hit rate and reads-per-write, which are what say whether the cache is paying ' +
        'for itself -- the raw cache counts alone cannot.',
      inputSchema: z.strictObject({
        ...periodShape,
        client: clientEnum,
        compare: z
          .enum(['previous'])
          .optional()
          .describe(
            'Also report the window of equal length immediately before this one, with the ' +
              'delta. Requires a period of fixed length -- days, today, or since AND until ' +
              'together. An open-ended period (since alone, until alone, or all time) has no ' +
              'equally long window before it and is rejected rather than answered without the ' +
              'comparison. Reported and estimated cost are deltaed separately and never summed.',
          ),
      }),
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.summary(toQuery(args), { compare: args.compare === 'previous' });
      return textResult(formatSummary(report, ctx.service.costService), {
        period: report.period,
        includeSubagents: report.includeSubagents,
        ...(report.unmatchedScope ? { unmatchedScope: report.unmatchedScope } : {}),
        ...(report.comparison
          ? {
              comparison: {
                previous: report.comparison.previous,
                delta: report.comparison.delta,
                caveats: report.comparison.caveats,
              },
            }
          : {}),
        totals: {
          records: report.overall.records,
          sessions: report.overall.sessions,
          inputTokens: report.overall.inputTokens,
          outputTokens: report.overall.outputTokens,
          cacheReadTokens: report.overall.cacheReadTokens,
          cacheWriteTokens: report.overall.cacheWriteTokens,
          reasoningTokens: report.overall.reasoningTokens,
          totalTokens: report.overall.totalTokens,
        },
        cache: cacheMetrics(report.overall),
        cost: report.overall.cost,
        byClient: report.byClient.map((c) => ({
          client: c.key,
          records: c.records,
          sessions: c.sessions,
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          cacheReadTokens: c.cacheReadTokens,
          cacheWriteTokens: c.cacheWriteTokens,
          reasoningTokens: c.reasoningTokens,
          totalTokens: c.totalTokens,
          cache: cacheMetrics(c),
          cost: c.cost,
        })),
      });
    },
  );
}
