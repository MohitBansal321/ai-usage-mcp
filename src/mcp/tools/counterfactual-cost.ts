import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatCounterfactual } from '../../services/formatter.js';
import {
  clientEnum,
  periodShape,
  readOnlyTool,
  textResult,
  toQuery,
  type ToolContext,
} from './shared.js';

export function registerCounterfactualCost(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'counterfactual_cost',
    {
      ...readOnlyTool('Cost on another model'),
      description:
        'What the tokens from a period would have cost at another model’s list rates, ' +
        'alongside what they actually cost. Use this for "would Sonnet have been cheaper ' +
        'than Opus for this". It re-prices the exact token counts that were recorded, ' +
        'grouped by client, model and speed so the fast-mode premium and the two different ' +
        'reasoning-token conventions are handled correctly. ' +
        'IMPORTANT: the result is a counterfactual, not a saving — the same task on a ' +
        'different model generally takes a different number of turns with a different context ' +
        'on each, and nothing on disk can say what that would have been. Report it as such, ' +
        'keep every scenario labelled an estimate, and never subtract a scenario from the ' +
        'reported cost to claim a number.',
      inputSchema: {
        ...periodShape,
        client: clientEnum,
        models: z
          .array(z.string())
          .optional()
          .describe(
            'Models to price against. Omit to compare every model the pricing table knows. ' +
              'A model with no price is omitted and called out rather than guessed at.',
          ),
      },
    },
    async (args) => {
      await ctx.ensureFresh();
      const report = ctx.service.counterfactualCost(toQuery(args), args.models);
      return textResult(formatCounterfactual(report, ctx.service.costService), {
        period: report.period,
        includeSubagents: report.includeSubagents,
        pricingVersion: report.pricingVersion,
        actual: {
          records: report.overall.records,
          sessions: report.overall.sessions,
          inputTokens: report.overall.inputTokens,
          outputTokens: report.overall.outputTokens,
          cacheReadTokens: report.overall.cacheReadTokens,
          cacheWriteTokens: report.overall.cacheWriteTokens,
          reasoningTokens: report.overall.reasoningTokens,
          totalTokens: report.overall.totalTokens,
          cost: report.overall.cost,
        },
        scenarios: report.scenarios.map((s) => ({
          model: s.model,
          // Named to travel with its basis: a consumer that reads this key
          // cannot mistake it for money that was actually charged.
          estimatedCost: s.estimatedCost,
          records: s.records,
          isActual: s.isActual,
          unpricedGroups: s.unpricedGroups,
        })),
        caveats: report.caveats,
      });
    },
  );
}
