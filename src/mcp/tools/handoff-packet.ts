import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatHandoffPacket } from '../../services/formatter.js';
import { readOnlyTool, textResult, type ToolContext } from './shared.js';

export function registerHandoffPacket(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'generate_handoff_packet',
    {
      ...readOnlyTool('Generate Handoff Packet'),
      description:
        "Compresses a session's raw history into a structured handoff packet for multi-phase tasks. " +
        "The packet contains only three things: what changed, what failed, and what's next. " +
        'Use this at phase boundaries to flush heavy raw context (stack traces, diffs, logs) ' +
        'and continue with a lightweight ~1-2KB packet instead of 50-200KB of raw history. ' +
        'Prevents token bloat in long-running multi-step tasks.',
      inputSchema: z.strictObject({
        sessionId: z
          .string()
          .min(1)
          .describe('Session ID (full or unambiguous prefix) to generate packet for.'),
        includeSubagents: z
          .boolean()
          .optional()
          .describe(
            'Include subagent/sidechain turns. Defaults to true; they often contain relevant work.',
          ),
        phaseName: z
          .string()
          .optional()
          .describe('Optional name for this phase (e.g., "refactoring", "testing", "deployment").'),
      }),
    },
    async (args) => {
      await ctx.ensureFresh();
      const packet = ctx.service.generateHandoffPacket(
        args.sessionId,
        args.includeSubagents,
        args.phaseName,
      );
      if (!packet) {
        return textResult(`Session "${args.sessionId}" not found.`);
      }
      if ('ambiguous' in packet) {
        return textResult(
          `Ambiguous session ID "${args.sessionId}". Matches: ${packet.ambiguous.join(', ')}. ` +
            'Provide a longer prefix.',
        );
      }
      return textResult(formatHandoffPacket(packet), {
        sessionId: packet.sessionId,
        phaseName: packet.phaseName,
        generatedAt: packet.generatedAt,
        whatChanged: packet.whatChanged,
        whatFailed: packet.whatFailed,
        whatNext: packet.whatNext,
        metadata: packet.metadata,
      });
    },
  );
}
