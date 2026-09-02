import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatSessions } from '../../services/formatter.js';
import {
  clientEnum,
  periodShape,
  readOnlyTool,
  textResult,
  toQuery,
  type ToolContext,
} from './shared.js';

export function registerRecentSessions(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'recent_sessions',
    {
      ...readOnlyTool('Recent sessions'),
      description:
        'Most recently active sessions with project path, client, model(s), duration, ' +
        'token breakdown and cost. Use the returned session id with session_usage for detail.',
      inputSchema: {
        ...periodShape,
        client: clientEnum,
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe('How many sessions to return (default 20).'),
      },
    },
    async (args) => {
      await ctx.ensureFresh();
      const sessions = ctx.service.recentSessions(toQuery(args), args.limit ?? 20);
      return textResult(formatSessions(sessions, ctx.service.costService), {
        count: sessions.length,
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          client: s.client,
          projectPath: s.projectPath ?? null,
          models: s.models,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          durationSeconds: s.durationSeconds,
          turns: { total: s.records, main: s.mainRecords, subagent: s.subagentRecords },
          tokens: {
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            cacheReadTokens: s.cacheReadTokens,
            cacheWriteTokens: s.cacheWriteTokens,
            reasoningTokens: s.reasoningTokens,
            totalTokens: s.totalTokens,
          },
          cost: s.cost,
        })),
      });
    },
  );
}
