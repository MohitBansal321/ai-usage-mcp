import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatSessionDetail } from '../../services/formatter.js';
import { errorResult, textResult, type ToolContext } from './shared.js';

export function registerSessionUsage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'session_usage',
    {
      title: 'Session usage',
      description:
        'Usage for one session: client, model(s), duration, token breakdown and cost. ' +
        'Accepts a full session id or an unambiguous fragment of one. Subagent turns are ' +
        'reported separately from main-thread turns.',
      inputSchema: {
        sessionId: z.string().min(1).describe('Session id, or an unambiguous part of one.'),
        includeSubagents: z
          .boolean()
          .optional()
          .describe('Include subagent turns in the totals. Defaults to true.'),
      },
    },
    async (args) => {
      await ctx.ensureFresh();
      const result = ctx.service.sessionUsage(args.sessionId, args.includeSubagents !== false);

      if (!result) {
        return errorResult(
          `No session matching "${args.sessionId}" was found in the local database. ` +
            `Use recent_sessions to list known sessions.`,
        );
      }
      if ('ambiguous' in result) {
        return errorResult(
          `"${args.sessionId}" matches ${result.ambiguous.length} sessions. Be more specific:\n` +
            result.ambiguous.map((id) => `  ${id}`).join('\n'),
        );
      }

      return textResult(formatSessionDetail(result, ctx.service.costService), {
        sessionId: result.session.sessionId,
        client: result.session.client,
        projectPath: result.session.projectPath ?? null,
        models: result.session.models,
        startedAt: result.session.startedAt,
        endedAt: result.session.endedAt,
        durationSeconds: result.session.durationSeconds,
        turns: {
          total: result.session.records,
          main: result.session.mainRecords,
          subagent: result.session.subagentRecords,
        },
        tokens: {
          inputTokens: result.session.inputTokens,
          outputTokens: result.session.outputTokens,
          cacheReadTokens: result.session.cacheReadTokens,
          cacheWriteTokens: result.session.cacheWriteTokens,
          reasoningTokens: result.session.reasoningTokens,
          totalTokens: result.session.totalTokens,
        },
        cost: result.session.cost,
      });
    },
  );
}
