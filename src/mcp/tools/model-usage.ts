import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatModels } from '../../services/formatter.js';
import {
  clientEnum,
  pageShape,
  pageStructured,
  periodShape,
  readOnlyTool,
  textResult,
  toPageRequest,
  toQuery,
  type ToolContext,
} from './shared.js';

export function registerModelUsage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'model_usage',
    {
      ...readOnlyTool('Usage by model'),
      description:
        'Per-model token usage and cost, highest token count first. Use this to answer ' +
        '"which model consumed the most tokens". Cost is labelled reported vs estimated per model.',
      inputSchema: z.strictObject({ ...periodShape, client: clientEnum, ...pageShape }),
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.modelUsage(toQuery(args), toPageRequest(args));
      return textResult(formatModels(report, ctx.service.costService), {
        period: report.period,
        includeSubagents: report.includeSubagents,
        page: pageStructured(report.page),
        ...(report.unmatchedScope ? { unmatchedScope: report.unmatchedScope } : {}),
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
