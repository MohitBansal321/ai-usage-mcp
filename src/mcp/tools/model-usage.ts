import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatModels } from '../../services/formatter.js';
import { clientEnum, periodShape, textResult, toQuery, type ToolContext } from './shared.js';

export function registerModelUsage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'model_usage',
    {
      title: 'Usage by model',
      description:
        'Per-model token usage and cost, highest token count first. Use this to answer ' +
        '"which model consumed the most tokens". Cost is labelled reported vs estimated per model.',
      inputSchema: {
        ...periodShape,
        client: clientEnum,
        limit: z.number().int().positive().max(100).optional().describe('Return only the top N models.'),
      },
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.modelUsage(toQuery(args), args.limit);
      return textResult(formatModels(report, ctx.service.costService), {
        period: report.period,
        includeSubagents: report.includeSubagents,
        models: report.models.map((m) => ({
          model: m.key,
          records: m.records,
          sessions: m.sessions,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cacheReadTokens: m.cacheReadTokens,
          cacheWriteTokens: m.cacheWriteTokens,
          reasoningTokens: m.reasoningTokens,
          totalTokens: m.totalTokens,
          cost: m.cost,
        })),
      });
    },
  );
}
