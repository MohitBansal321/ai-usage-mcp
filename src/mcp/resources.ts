import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatSessionDetail, formatSummary } from '../services/formatter.js';
import type { ToolContext } from './tools/shared.js';

/**
 * Resources, as distinct from tools: the user pulls these into context with an
 * `@` mention, so they answer the two questions asked often enough not to be
 * worth a tool round-trip. Anything parameterised stays a tool.
 */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'usage-today',
    'usage://today',
    {
      title: "Today's usage",
      description:
        'Token usage and cost so far today, in local time, split by client. The same numbers ' +
        'the usage_summary tool returns for today.',
      mimeType: 'text/plain',
    },
    async (uri) => {
      await ctx.ensureFresh();
      const report = ctx.service.summary({ today: true });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/plain',
            text: formatSummary(report, ctx.service.costService),
          },
        ],
      };
    },
  );

  server.registerResource(
    'usage-latest-session',
    'usage://session/latest',
    {
      title: 'Most recent session',
      description:
        'Full detail for the most recently active session on this machine. Note that this is ' +
        'the latest session across every client, which is not necessarily the session you are ' +
        'reading this from -- an MCP server is not told which conversation is calling it.',
      mimeType: 'text/plain',
    },
    async (uri) => {
      await ctx.ensureFresh();
      const [latest] = ctx.service.recentSessions({}, 1);
      const text = latest
        ? (() => {
            const detail = ctx.service.sessionUsage(latest.sessionId);
            return detail && !('ambiguous' in detail)
              ? formatSessionDetail(detail, ctx.service.costService)
              : 'The most recent session could not be resolved.';
          })()
        : 'No sessions recorded yet. Run a coding agent, or `ai-usage sync`.';
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
    },
  );
}
