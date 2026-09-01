import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  assistantLine,
  buildClaudeProjects,
  buildOpenCodeDb,
  tempDir,
} from '../fixtures/build-fixtures.js';

const SERVER = resolve('dist/mcp/server.js');
const CLI = resolve('dist/cli/index.js');

/**
 * The layering invariant from AGENTS.md: `ai-usage stats --today` must return
 * exactly what the `usage_summary` MCP tool returns. If these ever differ, a
 * frontend has grown its own business logic and the layering is broken.
 */
describe('CLI and MCP parity', () => {
  let dir: string;
  let env: Record<string, string>;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    for (const bin of [SERVER, CLI]) {
      if (!existsSync(bin)) throw new Error(`${bin} is missing. Run \`npm run build\` first.`);
    }
    dir = tempDir('parity-');
    const now = Date.now();

    const openCodeDb = buildOpenCodeDb(dir, {
      sessions: [{ id: 'oc-1', parentId: null }],
      messages: [
        {
          id: 'm1',
          sessionId: 'oc-1',
          timeCreated: now - 60_000,
          data: {
            role: 'assistant',
            cost: 0.125,
            modelID: 'big-pickle',
            providerID: 'opencode',
            tokens: { input: 321, output: 45, reasoning: 6, cache: { read: 7000, write: 12 } },
            time: { created: now - 60_000 },
            path: { root: '/work/project-one' },
          },
        },
      ],
    });

    const claudeProjects = buildClaudeProjects(dir, [
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'cc-1',
            lines: [
              assistantLine({
                sessionId: 'cc-1',
                requestId: 'r1',
                messageId: 'm1',
                input: 3,
                output: 271,
                cacheRead: 83_000,
                cacheWrite5m: 400,
                cacheWrite1h: 900,
                thinking: 88,
                timestamp: new Date(now - 50_000).toISOString(),
                stopReason: 'end_turn',
              }),
              assistantLine({
                sessionId: 'cc-1',
                requestId: 'r2',
                messageId: 'm2',
                input: 1,
                output: 33,
                cacheRead: 2000,
                model: 'claude-sonnet-5',
                timestamp: new Date(now - 40_000).toISOString(),
                stopReason: 'end_turn',
              }),
            ],
            subagents: [
              {
                name: 'agent-a',
                lines: [
                  assistantLine({
                    sessionId: 'cc-1',
                    requestId: 'r3',
                    messageId: 'm3',
                    input: 1,
                    output: 17,
                    cacheRead: 900,
                    timestamp: new Date(now - 30_000).toISOString(),
                    stopReason: 'end_turn',
                  }),
                ],
              },
            ],
          },
        ],
      },
    ]);

    env = {
      ...process.env,
      AI_USAGE_DB: join(dir, 'usage.db'),
      AI_USAGE_OPENCODE_DB: openCodeDb,
      AI_USAGE_CLAUDE_PROJECTS: claudeProjects,
      AI_USAGE_FRESHNESS_MS: '0',
      // Hermetic: the CLI and the server must render the same bytes, and neither
      // may reach the registry to do it.
      AI_USAGE_NO_UPDATE_CHECK: '1',
    };

    // Populate the shared database once, through the CLI.
    execFileSync(process.execPath, [CLI, 'sync'], { env, encoding: 'utf8' });

    transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env });
    client = new Client({ name: 'parity-client', version: '1.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function cli(args: string[]): string {
    return execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' }).trimEnd();
  }

  async function toolText(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    return (result.content as { type: string; text: string }[])[0]!.text.trimEnd();
  }

  it('stats --today matches usage_summary exactly', async () => {
    expect(cli(['stats', '--today'])).toBe(await toolText('usage_summary', { today: true }));
  });

  it('stats (all time) matches usage_summary with no period', async () => {
    expect(cli(['stats'])).toBe(await toolText('usage_summary', {}));
  });

  it('stats --no-subagents matches usage_summary includeSubagents=false', async () => {
    expect(cli(['stats', '--no-subagents'])).toBe(
      await toolText('usage_summary', { includeSubagents: false }),
    );
  });

  it('models matches model_usage', async () => {
    expect(cli(['models'])).toBe(await toolText('model_usage', {}));
  });

  it('clients matches client_usage', async () => {
    expect(cli(['clients'])).toBe(await toolText('client_usage', {}));
  });

  it('projects matches project_usage', async () => {
    expect(cli(['projects'])).toBe(await toolText('project_usage', {}));
  });

  it('projects --project narrows both frontends the same way', async () => {
    expect(cli(['projects', '--project', '/work/project-one'])).toBe(
      await toolText('project_usage', { projectPath: '/work/project-one' }),
    );
  });

  it('daily matches daily_usage', async () => {
    expect(cli(['daily'])).toBe(await toolText('daily_usage', {}));
  });

  it('daily --today matches daily_usage today=true', async () => {
    expect(cli(['daily', '--today'])).toBe(await toolText('daily_usage', { today: true }));
  });

  it('sessions matches recent_sessions', async () => {
    expect(cli(['sessions', '--limit', '5'])).toBe(await toolText('recent_sessions', { limit: 5 }));
  });

  it('session <id> matches session_usage', async () => {
    expect(cli(['session', 'cc-1'])).toBe(await toolText('session_usage', { sessionId: 'cc-1' }));
  });

  it('agrees on the numbers themselves, not just the rendering', async () => {
    const cliJson = JSON.parse(
      execFileSync(process.execPath, [CLI, 'stats', '--today', '--json'], {
        env,
        encoding: 'utf8',
      }),
    );
    const result = await client.callTool({ name: 'usage_summary', arguments: { today: true } });
    const structured = result.structuredContent as any;
    expect(structured.totals.inputTokens).toBe(cliJson.overall.inputTokens);
    expect(structured.totals.outputTokens).toBe(cliJson.overall.outputTokens);
    expect(structured.totals.cacheReadTokens).toBe(cliJson.overall.cacheReadTokens);
    expect(structured.totals.cacheWriteTokens).toBe(cliJson.overall.cacheWriteTokens);
    expect(structured.totals.totalTokens).toBe(cliJson.overall.totalTokens);
    expect(structured.cost.reported).toBe(cliJson.overall.cost.reported);
    expect(structured.cost.estimated).toBe(cliJson.overall.cost.estimated);
  });
});
