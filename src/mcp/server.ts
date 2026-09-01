#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { UsageService } from '../services/usage-service.js';
import { VERSION } from '../version.js';
import { registerClientUsage } from './tools/client-usage.js';
import { registerDailyUsage } from './tools/daily-usage.js';
import { registerModelUsage } from './tools/model-usage.js';
import { registerProjectUsage } from './tools/project-usage.js';
import { registerRecentSessions } from './tools/recent-sessions.js';
import { registerSessionUsage } from './tools/session-usage.js';
import { registerUsageSummary } from './tools/usage-summary.js';
import { initUpdateNotice, startUpdateWatch } from './notice.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import type { ToolContext } from './tools/shared.js';

/**
 * How long a sync is considered fresh. Incremental sync only re-reads source
 * files that changed, so this is cheap; the window exists to stop a burst of tool
 * calls from re-syncing several times in a row.
 */
const FRESHNESS_WINDOW_MS = Number(process.env.AI_USAGE_FRESHNESS_MS ?? 30_000);

/**
 * Keeps the local database current without making every tool handler think about
 * it. Concurrent callers share one in-flight sync rather than starting their own.
 */
function createFreshnessGate(service: UsageService): () => Promise<void> {
  let lastSyncAt = 0;
  let inFlight: Promise<void> | undefined;

  return async function ensureFresh(): Promise<void> {
    if (Date.now() - lastSyncAt < FRESHNESS_WINDOW_MS) return;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const report = await service.sync();
        for (const result of report.results) {
          if (!result.available && result.reason) {
            // stderr only: stdout is the MCP transport and must stay clean JSON-RPC.
            process.stderr.write(`[ai-usage] ${result.collector}: ${result.reason}\n`);
          }
        }
        lastSyncAt = Date.now();
      } catch (err) {
        // A failed refresh must not fail the read -- we answer from what we have
        // and say so on stderr rather than pretending there is no usage.
        process.stderr.write(`[ai-usage] sync failed: ${(err as Error).message}\n`);
        lastSyncAt = Date.now();
      } finally {
        inFlight = undefined;
      }
    })();

    return inFlight;
  };
}

async function main(): Promise<void> {
  const service = UsageService.open();

  // Cache-only, so this cannot delay the handshake. When it finds nothing, the
  // background watch below picks the notice up instead.
  const updateNotice = initUpdateNotice();

  const server = new McpServer(
    { name: 'ai-usage', version: VERSION },
    {
      instructions:
        'Reports real, locally collected token usage and cost across coding agents ' +
        '(Claude Code and OpenCode). All figures come from data those clients wrote to ' +
        'this machine; nothing is estimated unless it is explicitly labelled as an ' +
        'API-equivalent estimate, and missing values are reported as unavailable rather ' +
        'than as zero. Never present the reported and estimated cost figures as one number.' +
        (updateNotice ? `\n\n${updateNotice}` : ''),
    },
  );

  const ctx: ToolContext = { service, ensureFresh: createFreshnessGate(service) };

  registerUsageSummary(server, ctx);
  registerSessionUsage(server, ctx);
  registerModelUsage(server, ctx);
  registerClientUsage(server, ctx);
  registerProjectUsage(server, ctx);
  registerDailyUsage(server, ctx);

  registerResources(server, ctx);
  registerPrompts(server);
  registerRecentSessions(server, ctx);

  const shutdown = () => {
    try {
      service.close();
    } catch {
      /* closing on the way out */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[ai-usage] MCP server ready on stdio\n');

  // After the handshake, never during it: the registry lookup is allowed to be
  // slow, and no client should wait on it to start using the tools.
  void startUpdateWatch();
}

main().catch((err) => {
  process.stderr.write(`[ai-usage] fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
