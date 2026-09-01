import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

function ocAssistant(created: number, input: number, output: number) {
  return {
    role: 'assistant',
    cost: 0.25,
    modelID: 'big-pickle',
    providerID: 'opencode',
    tokens: { input, output, reasoning: 0, cache: { read: 1000, write: 0 } },
    time: { created },
    path: { root: '/work/project-one' },
  };
}

describe('MCP server over stdio', () => {
  let dir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    if (!existsSync(SERVER)) {
      throw new Error(`${SERVER} is missing. Run \`npm run build\` before the tests.`);
    }
    dir = tempDir('mcp-server-');
    const now = Date.now();

    const openCodeDb = buildOpenCodeDb(dir, {
      sessions: [{ id: 'oc-1', parentId: null }],
      messages: [
        { id: 'm1', sessionId: 'oc-1', timeCreated: now - 5000, data: ocAssistant(now - 5000, 500, 50) },
      ],
    });
    const claudeProjects = buildClaudeProjects(dir, [
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'cc-1',
            lines: [
              assistantLine({ sessionId: 'cc-1', requestId: 'r1', messageId: 'm1', input: 2, output: 400, cacheRead: 90_000, cacheWrite1h: 800, thinking: 100, timestamp: new Date(now - 4000).toISOString(), stopReason: 'end_turn' }),
            ],
            subagents: [
              { name: 'agent-a', lines: [assistantLine({ sessionId: 'cc-1', requestId: 'r2', messageId: 'm2', input: 1, output: 30, cacheRead: 5000, timestamp: new Date(now - 3000).toISOString(), stopReason: 'end_turn' })] },
            ],
          },
        ],
      },
    ]);

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        ...process.env,
        AI_USAGE_DB: join(dir, 'usage.db'),
        AI_USAGE_OPENCODE_DB: openCodeDb,
        AI_USAGE_CLAUDE_PROJECTS: claudeProjects,
        AI_USAGE_FRESHNESS_MS: '0',
      } as Record<string, string>,
    });
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts and exposes exactly the five Phase 1 tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'client_usage',
      'model_usage',
      'recent_sessions',
      'session_usage',
      'usage_summary',
    ]);
  });

  it('usage_summary returns real collected totals split by client', async () => {
    const result = await client.callTool({ name: 'usage_summary', arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('Usage summary');
    expect(text).toContain('claude-code');
    expect(text).toContain('opencode');

    const structured = result.structuredContent as any;
    expect(structured.totals.records).toBe(3);
    // Cost buckets stay separate: OpenCode reported, Claude Code estimated.
    expect(structured.cost.reportedRecords).toBe(1);
    expect(structured.cost.estimatedRecords).toBe(2);
    expect(structured.totals.cacheReadTokens).toBe(96_000);
  });

  it('client_usage separates the two clients', async () => {
    const result = await client.callTool({ name: 'client_usage', arguments: {} });
    const structured = result.structuredContent as any;
    const names = structured.clients.map((c: any) => c.client).sort();
    expect(names).toEqual(['claude-code', 'opencode']);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('must not be added');
  });

  it('model_usage ranks models and labels their cost basis', async () => {
    const result = await client.callTool({ name: 'model_usage', arguments: {} });
    const structured = result.structuredContent as any;
    const models = structured.models.map((m: any) => m.model).sort();
    expect(models).toEqual(['big-pickle', 'claude-opus-5']);
    const opus = structured.models.find((m: any) => m.model === 'claude-opus-5');
    expect(opus.cost.estimatedRecords).toBe(2);
    expect(opus.cost.reportedRecords).toBe(0);
  });

  it('recent_sessions lists sessions with a turn-kind split', async () => {
    const result = await client.callTool({ name: 'recent_sessions', arguments: { limit: 10 } });
    const structured = result.structuredContent as any;
    expect(structured.count).toBe(2);
    const claudeSession = structured.sessions.find((s: any) => s.client === 'claude-code');
    expect(claudeSession.turns).toEqual({ total: 2, main: 1, subagent: 1 });
  });

  it('session_usage returns one session in detail', async () => {
    const result = await client.callTool({ name: 'session_usage', arguments: { sessionId: 'cc-1' } });
    const structured = result.structuredContent as any;
    expect(structured.sessionId).toBe('cc-1');
    expect(structured.client).toBe('claude-code');
    expect(structured.tokens.outputTokens).toBe(430);
  });

  it('session_usage reports a miss as an error instead of inventing zeros', async () => {
    const result = await client.callTool({ name: 'session_usage', arguments: { sessionId: 'nope' } });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('No session matching');
  });

  it('honours includeSubagents=false', async () => {
    const all = await client.callTool({ name: 'usage_summary', arguments: {} });
    const mainOnly = await client.callTool({ name: 'usage_summary', arguments: { includeSubagents: false } });
    expect((all.structuredContent as any).totals.records).toBe(3);
    expect((mainOnly.structuredContent as any).totals.records).toBe(2);
    const text = (mainOnly.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('EXCLUDED');
  });

  it('answers a period query without data as empty rather than fabricating numbers', async () => {
    const result = await client.callTool({
      name: 'usage_summary',
      arguments: { since: '2020-01-01T00:00:00Z', until: '2020-01-02T00:00:00Z' },
    });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('No usage records for this period');
    expect((result.structuredContent as any).totals.records).toBe(0);
  });
});
