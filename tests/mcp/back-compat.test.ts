import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assistantLine, buildClaudeProjects, tempDir } from '../fixtures/build-fixtures.js';

const SERVER = resolve('dist/mcp/server.js');

/**
 * The argument spellings callers used before 0.8.0.
 *
 * This file exists because dropping them would NOT have failed loudly. An
 * argument a tool does not declare is stripped before the handler ever sees it,
 * so a caller still passing `projectPath` would have had its filter silently
 * vanish and received the whole database presented as one project's usage --
 * the exact failure this codebase is organised around avoiding. The shipped
 * `project-cost` prompt was one such caller.
 *
 * `counterfactual_cost` was worse still: `models` meant "price against these"
 * before 0.8.0 and "include only these turns" after, so the same call kept
 * working and quietly answered a different question.
 */
describe('pre-0.8.0 MCP argument spellings', () => {
  let dir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    if (!existsSync(SERVER)) {
      throw new Error(`${SERVER} is missing. Run \`npm run build\` before the tests.`);
    }
    dir = tempDir('mcp-backcompat-');
    const now = Date.now();

    // Two projects and two models, so a filter that silently stopped filtering
    // returns visibly more than a filter that works.
    const projects = buildClaudeProjects(dir, [
      {
        slug: '-work-one',
        sessions: [
          {
            sessionId: 'cc-1',
            lines: [
              assistantLine({
                sessionId: 'cc-1',
                requestId: 'r1',
                messageId: 'm1',
                cwd: '/work/one',
                model: 'claude-opus-5',
                input: 1000,
                output: 100,
                timestamp: new Date(now - 60_000).toISOString(),
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
      {
        slug: '-work-two',
        sessions: [
          {
            sessionId: 'cc-2',
            lines: [
              assistantLine({
                sessionId: 'cc-2',
                requestId: 'r2',
                messageId: 'm2',
                cwd: '/work/two',
                model: 'claude-haiku-4-5',
                input: 2000,
                output: 200,
                timestamp: new Date(now - 50_000).toISOString(),
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
        AI_USAGE_DB: join(dir, 'usage.db'),
        AI_USAGE_OPENCODE_DB: join(dir, 'absent.db'),
        AI_USAGE_CLAUDE_PROJECTS: projects,
        AI_USAGE_FRESHNESS_MS: '0',
        AI_USAGE_NO_UPDATE_CHECK: '1',
      },
    });
    client = new Client({ name: 'back-compat', version: '1.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const text = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await client.callTool({ name, arguments: args });
    return (result.content as { type: string; text: string }[])[0]!.text;
  };

  it('still filters on the singular `projectPath`', async () => {
    const out = await text('project_usage', { projectPath: '/work/one' });
    expect(out).toContain('/work/one');
    // The assertion that matters: a stripped argument would list both.
    expect(out).not.toContain('/work/two');
  });

  it('agrees with the plural spelling', async () => {
    expect(await text('project_usage', { projectPath: '/work/one' })).toBe(
      await text('project_usage', { projectPaths: ['/work/one'] }),
    );
  });

  it('prefers the plural when a caller somehow sends both', async () => {
    expect(
      await text('project_usage', { projectPath: '/work/one', projectPaths: ['/work/two'] }),
    ).toBe(await text('project_usage', { projectPaths: ['/work/two'] }));
  });

  it('still accepts `client` as a bare string', async () => {
    const out = await text('usage_summary', { client: 'claude-code' });
    expect(out).toContain('Usage summary');
    expect(out).not.toContain('WARNING');
    expect(out).toBe(await text('usage_summary', { client: ['claude-code'] }));
  });

  it('keeps `models` meaning "price against these" on counterfactual_cost', async () => {
    // Before 0.8.0 this named the target models. If it had become the scope
    // filter the call would still succeed -- and answer a different question.
    const legacy = await text('counterfactual_cost', { models: ['claude-haiku-4-5'] });
    expect(legacy).toBe(await text('counterfactual_cost', { targetModels: ['claude-haiku-4-5'] }));

    // Both models' tokens are priced, because this is not a filter.
    expect(legacy).toContain('claude-haiku-4-5');
    expect(legacy).toMatch(/Records:\s+2/);
  });

  it('scopes counterfactual_cost by model under its own name', async () => {
    const scoped = await text('counterfactual_cost', {
      filterModels: ['claude-opus-5'],
      targetModels: ['claude-haiku-4-5'],
    });
    // One of the two turns, priced at the other model's rates: the "what would
    // my Opus turns have cost on Haiku" question.
    expect(scoped).toMatch(/Records:\s+1/);
    expect(scoped).toContain('claude-haiku-4-5');
  });

  it('lets targetModels win when both spellings are given', async () => {
    expect(
      await text('counterfactual_cost', {
        models: ['claude-opus-5'],
        targetModels: ['claude-haiku-4-5'],
      }),
    ).toBe(await text('counterfactual_cost', { targetModels: ['claude-haiku-4-5'] }));
  });
});
