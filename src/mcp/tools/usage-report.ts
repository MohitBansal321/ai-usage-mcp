import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatUsageReport } from '../../services/formatter.js';
import {
  clientEnum,
  periodShape,
  readOnlyTool,
  textResult,
  toQuery,
  type ToolContext,
} from './shared.js';

export function registerUsageReport(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'usage_report',
    {
      ...readOnlyTool('Usage report'),
      description:
        'Where a period of usage went, how much of it did no new work, and what to change -- ' +
        'the first thing to run for "where are my tokens going" or "why do I hit my limit". ' +
        'Gives a verdict, the share of usage spent re-reading large contexts (every message ' +
        're-sends the whole conversation) and rebuilding a lost prompt cache, the heaviest ' +
        'sessions by their own titles and git branches, usage per branch, and plain-language ' +
        'fixes. Shares are weighted by API-equivalent list price as a relative measure; on a ' +
        'subscription that figure is not money spent. Defaults to the last 7 days.',
      inputSchema: z.strictObject({ ...periodShape, client: clientEnum }),
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.usageReport(toQuery(args));
      return textResult(formatUsageReport(report), { ...report });
    },
  );
}
