import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatClients } from '../../services/formatter.js';
import { periodShape, textResult, toQuery, type ToolContext } from './shared.js';

export function registerClientUsage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'client_usage',
    {
      title: 'Usage by client',
      description:
        'Token usage and cost per coding agent (Claude Code vs OpenCode). ' +
        'Note that the two cost figures are not comparable as a single number: OpenCode ' +
        'reports actual charged cost, while the Claude Code figure is an API-equivalent ' +
        'estimate (a Pro/Max subscription has $0 marginal cost per request).',
      inputSchema: periodShape,
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.clientUsage(toQuery(args));
      return textResult(formatClients(report, ctx.service.costService), {
        period: report.period,
        includeSubagents: report.includeSubagents,
        clients: report.clients.map((c) => ({
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
