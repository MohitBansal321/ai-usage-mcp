import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatProjects } from '../../services/formatter.js';
import { clientEnum, periodShape, textResult, toQuery, type ToolContext } from './shared.js';

export function registerProjectUsage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'project_usage',
    {
      title: 'Usage by project',
      description:
        'Per-project token usage and cost, highest token count first. A project is the working ' +
        'directory a turn ran in. Use this to answer "which repository is my spend going to". ' +
        'Turns whose project could not be resolved are grouped as (unknown) rather than dropped, ' +
        'and cost is labelled reported vs estimated per project.',
      inputSchema: {
        ...periodShape,
        client: clientEnum,
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe('Return only the top N projects.'),
      },
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.projectUsage(toQuery(args), args.limit);
      return textResult(formatProjects(report, ctx.service.costService), {
        period: report.period,
        includeSubagents: report.includeSubagents,
        projects: report.projects.map((p) => ({
          project: p.key,
          records: p.records,
          sessions: p.sessions,
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens,
          cacheReadTokens: p.cacheReadTokens,
          cacheWriteTokens: p.cacheWriteTokens,
          reasoningTokens: p.reasoningTokens,
          totalTokens: p.totalTokens,
          cost: p.cost,
        })),
      });
    },
  );
}
