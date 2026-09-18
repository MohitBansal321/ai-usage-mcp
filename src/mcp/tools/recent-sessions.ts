import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatSessions } from '../../services/formatter.js';
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

export function registerRecentSessions(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'recent_sessions',
    {
      ...readOnlyTool('Recent sessions'),
      description:
        'Most recently active sessions with project path, client, model(s), duration, ' +
        'token breakdown and cost. Use the returned session id with session_usage for detail.',
      inputSchema: z.strictObject({ ...periodShape, client: clientEnum, ...pageShape }),
    },
    async (args) => {
      await ctx.ensureFresh();
      const result = ctx.service.recentSessions(toQuery(args), toPageRequest(args));
      return textResult(formatSessions(result, ctx.service.costService), {
        count: result.rows.length,
        page: pageStructured({
          total: result.total,
          offset: result.offset,
          ...(result.limit !== undefined ? { limit: result.limit } : {}),
          hasMore: result.hasMore,
          ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}),
          sort: result.sort,
          rowsWithoutSortValue: result.rowsWithoutSortValue,
        }),
        sessions: result.rows.map((s) => ({
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
