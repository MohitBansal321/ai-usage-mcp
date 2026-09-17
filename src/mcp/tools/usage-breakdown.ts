import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatBreakdown } from '../../services/formatter.js';
import { GROUP_AXES, MAX_GROUP_AXES } from '../../db/repositories/usage-repository.js';
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

export function registerUsageBreakdown(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'usage_breakdown',
    {
      ...readOnlyTool('Usage broken down by two dimensions'),
      description:
        'Token usage and cost cut by two or more dimensions at once -- project x day, ' +
        'model x day, client x day -- as one tidy row set. Use this for "which of my projects ' +
        'is getting more expensive", which the single-axis tools cannot answer: project_usage ' +
        'gives a total with no trend, and daily_usage narrowed to one project gives one series, ' +
        'so answering it otherwise means enumerating projects and issuing one call each. ' +
        'Combinations with no activity are absent rather than returned as zero rows. Cost stays ' +
        'labelled reported vs estimated per row and the two are never summed.',
      inputSchema: {
        ...periodShape,
        client: clientEnum,
        ...pageShape,
        axes: z
          .array(z.enum(GROUP_AXES as [string, ...string[]]))
          .min(1)
          .max(MAX_GROUP_AXES)
          .describe(
            `Dimensions to cross, in output order: ${GROUP_AXES.join(', ')}. ` +
              `At most ${MAX_GROUP_AXES}, and each at most once. The time axes bucket in ` +
              `local time, identically to daily_usage.`,
          ),
      },
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.breakdown(
        args.axes as Parameters<typeof ctx.service.breakdown>[0],
        toQuery(args),
        toPageRequest(args),
      );
      return textResult(formatBreakdown(report), {
        period: report.period,
        includeSubagents: report.includeSubagents,
        axes: report.axes,
        page: pageStructured(report.page),
        ...(report.unmatchedScope ? { unmatchedScope: report.unmatchedScope } : {}),
        rows: report.rows.map((row) => ({
          // Flat keys beside the aggregate: a tidy row, the shape every
          // downstream tool expects, rather than a nested cross-tab a consumer
          // would have to unpick.
          ...row.keys,
          records: row.records,
          sessions: row.sessions,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          reasoningTokens: row.reasoningTokens,
          totalTokens: row.totalTokens,
          cost: row.cost,
        })),
      });
    },
  );
}
