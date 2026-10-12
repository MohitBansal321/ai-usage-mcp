import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatPlanUsage } from '../../services/formatter.js';
import { readOnlyTool, textResult, type ToolContext } from './shared.js';

export function registerPlanUsage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'plan_usage',
    {
      ...readOnlyTool('Plan Usage'),
      description:
        'How much of the Claude Pro/Max 5-hour and weekly usage limits is used, as Claude Code ' +
        'itself last reported it, with when each window resets. Also the average pace within ' +
        'the window and the time it would reach 100% at that pace (a projection, labelled as ' +
        "one), and the tokens and API-equivalent cost of this machine's Claude Code turns since " +
        'the window began. The percentages are recorded only while `ai-usage statusline` is ' +
        'configured as the Claude Code status line; without it they are reported as ' +
        'unavailable, never as 0%. Answers "how close am I to my limit" and "will I run out ' +
        'before it resets".',
      inputSchema: z.strictObject({
        includeSubagents: z
          .boolean()
          .optional()
          .describe(
            "Count subagent turns in this machine's token figures. Defaults to true. Does not " +
              "affect the percentages, which are Claude Code's own.",
          ),
      }),
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.planUsage(
        args.includeSubagents !== undefined ? { includeSubagents: args.includeSubagents } : {},
      );
      return textResult(formatPlanUsage(report, ctx.service.costService), {
        windows: report.windows,
        noReadings: report.noReadings,
        caveats: report.caveats,
      });
    },
  );
}
