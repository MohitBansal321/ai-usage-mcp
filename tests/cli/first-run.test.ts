import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assistantLine, buildClaudeProjects, tempDir } from '../fixtures/build-fixtures.js';

const CLI = resolve('dist/cli/index.js');

/**
 * The README's no-install line is `npx -p ai-usage-mcp ai-usage ...`, and that
 * always meets an empty database. The CLI never synced on its own, so the first
 * thing a new user saw was "0 turns" about a machine full of usage.
 */
describe('first run of a read command', () => {
  let env: Record<string, string>;

  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error(`${CLI} is missing. Run \`npm run build\` first.`);
    const dir = tempDir('first-run-');
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
                input: 1_000,
                output: 2_000,
                timestamp: new Date().toISOString(),
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
    ]);
    env = {
      ...process.env,
      AI_USAGE_DB: join(dir, 'usage.db'),
      AI_USAGE_OPENCODE_DB: join(dir, 'absent.db'),
      AI_USAGE_CLAUDE_PROJECTS: projects,
      AI_USAGE_NO_UPDATE_CHECK: '1',
    };
  });

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

  it('syncs once before answering, and says so on stderr only', () => {
    const first = run('stats', '--field', 'overall.records');
    expect(first.status).toBe(0);
    expect(first.stdout.trim()).toBe('1');
    expect(first.stderr).toContain('first run');

    const second = run('stats', '--field', 'overall.records');
    expect(second.stdout).toBe(first.stdout);
    expect(second.stderr).not.toContain('first run');
  });
});
