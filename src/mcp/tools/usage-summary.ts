import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatSummary } from '../../services/formatter.js';
import { clientEnum, periodShape, textResult, toQuery, type ToolContext } from './shared.js';

export function registerUsageSummary(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'usage_summary',
    {
      title: 'Usage summary',
      description:
        'Total token usage and cost for a period, split by client (Claude Code, OpenCode). ' +
        'Tokens are broken out into input / output / cache-read / cache-write / reasoning, ' +
        'because cache tokens typically dwarf input and a single blended total is misleading. ' +
        'Reported cost (from OpenCode) and estimated cost (computed for Claude Code, which ' +
        'records none) are always listed separately and must not be summed.',
      inputSchema: { ...periodShape, client: clientEnum },
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.summary(toQuery(args));
      return textResult(formatSummary(report, ctx.service.costService), {
        period: report.period,
        includeSubagents: report.includeSubagents,
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
          cost: c.cost,
        })),
      });
    },
  );
}
