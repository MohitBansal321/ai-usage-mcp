import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatDaily } from '../../services/formatter.js';
import {
  clientEnum,
  periodShape,
  readOnlyTool,
  textResult,
  toQuery,
  type ToolContext,
} from './shared.js';

export function registerDailyUsage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'daily_usage',
    {
      ...readOnlyTool('Usage by day'),
      description:
        'Token usage and cost bucketed on the time axis, newest first. Use this for "how much ' +
        'did I use yesterday", for a trend over a period, or -- with grain "hour-of-day" -- for ' +
        '"when during the day do I burn tokens". Buckets with NO activity are included and ' +
        'flagged `zeroFilled`, because omitting them hides the gaps and makes an ordinary ' +
        'bucket look like a spike beside one weeks earlier. All buckets are local time, so ' +
        'they agree with the period filter rather than drifting by a timezone offset. Cost is ' +
        'labelled reported vs estimated per bucket.',
      inputSchema: {
        ...periodShape,
        client: clientEnum,
        grain: z
          .enum(['hour', 'day', 'hour-of-day'])
          .optional()
          .describe(
            'Time bucket (default day). "hour" is a finer timeline; "hour-of-day" collapses ' +
              'every day onto one 24-slot local clock, which is what answers "when during the ' +
              'day do I burn tokens". All are local time, matching the period filter.',
          ),
      },
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.dailyUsage(toQuery(args), args.grain);
      return textResult(formatDaily(report), {
        period: report.period,
        includeSubagents: report.includeSubagents,
        grain: report.grain,
        ...(report.zeroFillNote ? { zeroFillNote: report.zeroFillNote } : {}),
        ...(report.unmatchedScope ? { unmatchedScope: report.unmatchedScope } : {}),
        days: report.days.map((d) => ({
          date: d.key,
          // Distinguishes a bucket that was observed empty from one constructed
          // to make the gap visible. Both are honest zeroes; only one was seen.
          zeroFilled: d.zeroFilled === true,
          records: d.records,
          sessions: d.sessions,
          inputTokens: d.inputTokens,
          outputTokens: d.outputTokens,
          cacheReadTokens: d.cacheReadTokens,
          cacheWriteTokens: d.cacheWriteTokens,
          reasoningTokens: d.reasoningTokens,
          totalTokens: d.totalTokens,
          cost: d.cost,
        })),
      });
    },
  );
}
