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
        'Finds cache breaks in a session -- turns where the prompt-cache prefix was not reused, ' +
        'so the context was re-written at cache-write prices instead of read back cheaply. ' +
        'A break is a spike in cache writes AND a drop in cache reads; a write spike alone ' +
        '(e.g. reading one large file) is not one. Each break lists the turn, token counts, ' +
        'likely cause (model or speed switch, idle past the 5-minute TTL, or an early-context ' +
        'change such as an edited CLAUDE.md), and its API-equivalent write premium from the ' +
        'pricing table. Also returns the overall cache hit rate and reads-per-write.',
      inputSchema: z.strictObject({
        sessionId: z
          .string()
          .min(1)
          .describe('Session ID (full or unambiguous prefix) to analyze.'),
        includeSubagents: z
          .boolean()
          .optional()
          .describe(
            'Also analyze subagent/sidechain turns, baselined separately from main turns since ' +
              'they keep their own cache. Defaults to false.',
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
      return textResult(formatCacheHealth(report, ctx.service.costService), {
        ...report,
        pricingVersion: ctx.service.costService.pricingVersion,
      });
    },
  );
}
