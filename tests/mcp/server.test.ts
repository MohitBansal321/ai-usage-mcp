import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
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
        {
          id: 'm1',
          sessionId: 'oc-1',
          timeCreated: now - 5000,
          data: ocAssistant(now - 5000, 500, 50),
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
                input: 2,
                output: 400,
                cacheRead: 90_000,
                cacheWrite1h: 800,
                thinking: 100,
                timestamp: new Date(now - 4000).toISOString(),
                stopReason: 'end_turn',
              }),
            ],
            subagents: [
              {
                name: 'agent-a',
                lines: [
                  assistantLine({
                    sessionId: 'cc-1',
                    requestId: 'r2',
                    messageId: 'm2',
                    input: 1,
                    output: 30,
                    cacheRead: 5000,
                    timestamp: new Date(now - 3000).toISOString(),
                    stopReason: 'end_turn',
                  }),
                ],
              },
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
        // Hermetic: no registry lookup, so no update notice can appear in a
        // result this suite compares byte for byte.
        AI_USAGE_NO_UPDATE_CHECK: '1',
      },
    });
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts and exposes exactly the expected tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'client_usage',
      'counterfactual_cost',
      'daily_usage',
      'model_usage',
      'project_usage',
      'recent_sessions',
      'session_usage',
      'usage_breakdown',
      'usage_summary',
    ]);
  });

  it('annotates every tool as a read-only, closed-world reader', async () => {
    const { tools } = await client.listTools();

    // Asserted over the whole surface rather than a list of names, so a tool
    // added later cannot ship without annotations: without them a client
    // prompts for confirmation on every call, which for a reporting server
    // that only reads local files is pure friction.
    expect(tools).toHaveLength(9);

    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true);
      expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(false);

      // destructiveHint and idempotentHint are meaningful only when
      // readOnlyHint is false, so they must stay absent.
      expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBeUndefined();
      expect(tool.annotations?.idempotentHint, `${tool.name} idempotentHint`).toBeUndefined();

      // Display-name precedence is title -> annotations.title -> name. Both are
      // populated so no client revision has to fall back to the snake_case name.
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect(tool.annotations?.title, `${tool.name} annotations.title`).toBe(tool.title);
      expect(tool.title, `${tool.name} title`).not.toBe(tool.name);
    }
  });

  it('exposes resources the user can pull in with an @ mention', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      'usage://session/latest',
      'usage://status',
      'usage://today',
    ]);
  });

  it('serves usage://today as the same numbers usage_summary reports', async () => {
    const read = await client.readResource({ uri: 'usage://today' });
    const text = (read.contents[0] as { text: string }).text;
    expect(text).toContain('Usage summary');
    const tool = await client.callTool({ name: 'usage_summary', arguments: { today: true } });
    expect(text).toBe((tool.content as { type: string; text: string }[])[0]!.text);
  });

  it('serves usage://session/latest without needing an argument', async () => {
    const read = await client.readResource({ uri: 'usage://session/latest' });
    const text = (read.contents[0] as { text: string }).text;
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('could not be resolved');
  });

  it('exposes prompts as slash commands, with their arguments declared', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      'daily-review',
      'project-cost',
      'why-was-today-expensive',
    ]);
    const daily = prompts.find((p) => p.name === 'daily-review')!;
    expect(daily.arguments?.map((a) => a.name)).toEqual(['days']);
  });

  it('renders a prompt that names the tools to call and the cost rule to hold to', async () => {
    const got = await client.getPrompt({ name: 'daily-review', arguments: { days: '3' } });
    const text = (got.messages[0]!.content as { type: string; text: string }).text;
    expect(text).toContain('last 3 days');
    expect(text).toContain('usage_summary');
    expect(text).toContain('daily_usage');
    // The honesty rule travels with the prompt so the agent cannot merge the buckets.
    expect(text).toContain('Never add the reported and estimated cost figures together');
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
    const result = await client.callTool({
      name: 'session_usage',
      arguments: { sessionId: 'cc-1' },
    });
    const structured = result.structuredContent as any;
    expect(structured.sessionId).toBe('cc-1');
    expect(structured.client).toBe('claude-code');
    expect(structured.tokens.outputTokens).toBe(430);
  });

  it('session_usage reports a miss as an error instead of inventing zeros', async () => {
    const result = await client.callTool({
      name: 'session_usage',
      arguments: { sessionId: 'nope' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('No session matching');
  });

  it('honours includeSubagents=false', async () => {
    const all = await client.callTool({ name: 'usage_summary', arguments: {} });
    const mainOnly = await client.callTool({
      name: 'usage_summary',
      arguments: { includeSubagents: false },
    });
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

describe('MCP server on a stale install', () => {
  let dir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    dir = tempDir('mcp-stale-');
    const config = join(dir, 'config');
    mkdirSync(config, { recursive: true });
    // A fresh cache entry claiming a much newer release. Seeding the cache is
    // what keeps this test off the network: the server never fetches.
    writeFileSync(
      join(config, 'update-check.json'),
      JSON.stringify({ checkedAt: Date.now(), latest: '999.0.0' }),
    );

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        ...process.env,
        AI_USAGE_HOME: config,
        AI_USAGE_DB: join(dir, 'usage.db'),
        // Deliberately empty sources: this test is about the notice, and it must
        // not read the real machine's usage.
        AI_USAGE_OPENCODE_DB: join(dir, 'absent.db'),
        AI_USAGE_CLAUDE_PROJECTS: join(dir, 'absent-projects'),
        AI_USAGE_FRESHNESS_MS: '0',
        AI_USAGE_NO_UPDATE_CHECK: '0',
        CI: '',
      },
    });
    client = new Client({ name: 'stale-client', version: '1.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tells the client at handshake time that the build is out of date', () => {
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('Server notice');
    expect(instructions).toContain('999.0.0 is the latest release');
    // Still the real instructions, with the notice added rather than replacing them.
    expect(instructions).toContain('Never present the reported and estimated cost figures');
  });

  it('does not also repeat itself on the tool results', async () => {
    const first = await client.callTool({ name: 'usage_summary', arguments: {} });
    const second = await client.callTool({ name: 'client_usage', arguments: {} });

    // The handshake already said it; a server that says it again on every call
    // is adware.
    expect(first.content).toHaveLength(1);
    expect(second.content).toHaveLength(1);
    expect(
      (first as { structuredContent?: Record<string, unknown> }).structuredContent,
    ).not.toHaveProperty('serverNotice');
  });

  it('serves the update state as a resource, for anyone who asks', async () => {
    const read = await client.readResource({ uri: 'usage://status' });
    const text = (read.contents[0] as { text: string }).text;

    expect(text).toContain('ai-usage status');
    expect(text).toContain('Update available:');
    expect(text).toContain('999.0.0 latest');
  });
});

describe('MCP server learning the price of a model released after its pricing table', () => {
  const NEW_MODEL = 'claude-future-9';
  let dir: string;
  let client: Client;
  let transport: StdioClientTransport;
  let prices: Server;
  let downloads = 0;

  beforeAll(async () => {
    dir = tempDir('mcp-community-');
    const config = join(dir, 'config');
    mkdirSync(config, { recursive: true });
    // A fresh "you are current" answer, so the update check stays off the network.
    writeFileSync(
      join(config, 'update-check.json'),
      JSON.stringify({ checkedAt: Date.now(), latest: '0.0.0' }),
    );

    // Stands in for LiteLLM's price list.
    prices = createServer((_req, res) => {
      downloads++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          [NEW_MODEL]: {
            litellm_provider: 'anthropic',
            mode: 'chat',
            input_cost_per_token: 4e-6,
            output_cost_per_token: 2e-5,
            cache_read_input_token_cost: 2e-7,
            cache_creation_input_token_cost: 5e-6,
            cache_creation_input_token_cost_above_1hr: 8e-6,
          },
        }),
      );
    });
    await new Promise<void>((done) => prices.listen(0, '127.0.0.1', done));
    const { port } = prices.address() as AddressInfo;

    const claudeProjects = buildClaudeProjects(dir, [
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'cc-new',
            lines: [
              assistantLine({
                sessionId: 'cc-new',
                requestId: 'r1',
                messageId: 'm1',
                model: NEW_MODEL,
                input: 1000,
                output: 2000,
                cacheRead: 1_000_000,
                timestamp: new Date(Date.now() - 1000).toISOString(),
                stopReason: 'end_turn',
              }),
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
        AI_USAGE_HOME: config,
        AI_USAGE_DB: join(dir, 'usage.db'),
        AI_USAGE_OPENCODE_DB: join(dir, 'absent.db'),
        AI_USAGE_CLAUDE_PROJECTS: claudeProjects,
        AI_USAGE_FRESHNESS_MS: '0',
        AI_USAGE_NO_UPDATE_CHECK: '0',
        AI_USAGE_NO_PRICING_REFRESH: '0',
        AI_USAGE_PRICING_URL: `http://127.0.0.1:${port}/prices.json`,
        CI: '',
      },
    });
    client = new Client({ name: 'community-client', version: '1.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await new Promise<void>((done) => prices.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('downloads the list in the background and prices the model without a restart', async () => {
    // The refresh races the first sync, and either order must end priced: a row
    // stored unpriced before the list lands is priced when it does.
    let cost: { estimated: number; estimatedRecords: number; unavailableRecords: number } = {
      estimated: 0,
      estimatedRecords: 0,
      unavailableRecords: 1,
    };
    for (let attempt = 0; attempt < 100 && cost.estimatedRecords === 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 100));
      const result = await client.callTool({ name: 'usage_summary', arguments: {} });
      cost = (result.structuredContent as any).cost;
    }

    expect(cost.estimatedRecords).toBe(1);
    expect(cost.unavailableRecords).toBe(0);
    // 1,000 x $4 + 2,000 x $20 + 1,000,000 cache-read x $0.20, per million.
    expect(cost.estimated).toBeCloseTo(0.244, 10);
    expect(downloads).toBe(1);
  }, 30_000);

  it('says where the price came from', async () => {
    const read = await client.readResource({ uri: 'usage://status' });
    const text = (read.contents[0] as { text: string }).text;
    expect(text).toMatch(/Pricing table: +builtin-[\d-]+\+litellm-\d{4}-\d{2}-\d{2}/);
    expect(text).toContain(`Community:     1 model(s) the built-in tables lack`);
    expect(text).toContain(NEW_MODEL);
  });
});
