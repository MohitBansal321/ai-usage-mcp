import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatDaily } from '../../services/formatter.js';
import { clientEnum, periodShape, textResult, toQuery, type ToolContext } from './shared.js';

export function registerDailyUsage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'daily_usage',
    {
      title: 'Usage by day',
      description:
        'Per-day token usage and cost, newest day first. Use this for "how much did I use ' +
        'yesterday" or to see a trend over a period. Days are local calendar days, so they ' +
        'agree with the period filter rather than drifting by a timezone offset. Cost is ' +
        'labelled reported vs estimated per day.',
      inputSchema: {
        ...periodShape,
        client: clientEnum,
      },
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.dailyUsage(toQuery(args));
      return textResult(formatDaily(report), {
        period: report.period,
        includeSubagents: report.includeSubagents,
        days: report.days.map((d) => ({
          date: d.key,
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
