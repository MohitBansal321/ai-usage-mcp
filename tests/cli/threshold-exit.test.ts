import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assistantLine, buildClaudeProjects, tempDir } from '../fixtures/build-fixtures.js';

const CLI = resolve('dist/cli/index.js');

/**
 * The point of #60: this tool had nothing a scheduled job could branch on. A
 * report nobody reads cannot page anyone, so the exit code IS the feature --
 * which makes it a contract worth asserting on the shipped entrypoint rather
 * than in-process.
 */
describe('threshold exit codes', () => {
  let env: Record<string, string>;

  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error(`${CLI} is missing. Run \`npm run build\` first.`);
    const dir = tempDir('threshold-');
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
                input: 1_000_000,
                output: 1_000_000,
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
    execFileSync(process.execPath, [CLI, 'sync'], { env, encoding: 'utf8' });
  });

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

  // claude-opus-5 at $5/M input + $25/M output = $30 for this fixture.
  const FIELD = 'overall.cost.estimated';

  it('prints one bare value and nothing else', () => {
    const r = run('stats', '--field', FIELD);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('30');
    // No header, no label, no JSON: a shell can read it directly.
    expect(r.stdout).not.toContain('Usage summary');
  });

  it('exits 1 when the value is over the threshold, and says so on stderr', () => {
    const r = run('stats', '--field', FIELD, '--fail-over', '25');
    expect(r.status).toBe(1);
    // stdout stays the value, so a script can both branch AND capture it.
    expect(r.stdout.trim()).toBe('30');
    expect(r.stderr).toContain('over the --fail-over threshold');
  });

  it('exits 0 when the value is under the threshold', () => {
    const r = run('stats', '--field', FIELD, '--fail-over', '100');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('threshold');
  });

  it('exits 0 at exactly the threshold: "over" is strictly greater', () => {
    expect(run('stats', '--field', FIELD, '--fail-over', '30').status).toBe(0);
    expect(run('stats', '--field', FIELD, '--fail-over', '29.99').status).toBe(1);
  });

  it('exits 2 on a bad field, never 0 -- a silent pass is the worst alert failure', () => {
    const r = run('stats', '--field', 'cost.estimated', '--fail-over', '25');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Available:');
  });

  it('exits 2 on --fail-over with no --field', () => {
    const r = run('stats', '--fail-over', '25');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('requires --field');
  });

  it('works on every report, not just stats', () => {
    // Note the CLI's own JSON shape: grouped rows carry `key`. A wrong guess is
    // an exit 2 that names the available fields, not a silent empty string.
    expect(run('models', '--field', 'models.0.key').stdout.trim()).toBe('claude-opus-5');
    expect(run('daily', '--field', 'overall.records').stdout.trim()).toBe('1');
    expect(run('projects', '--field', 'page.total').stdout.trim()).toBe('1');
  });

  it('exports a header plus one row per record', () => {
    const r = run('export');
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toContain('id,timestamp,client');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('claude-opus-5');
  });

  it('exports JSON Lines when asked', () => {
    const r = run('export', '--format', 'jsonl');
    const parsed = JSON.parse(r.stdout.trim().split('\n')[0] as string);
    expect(parsed.model).toBe('claude-opus-5');
    expect(parsed.cost_basis).toBe('estimated');
  });

  it('warns on stderr when an export is truncated, keeping stdout clean', () => {
    const r = run('export', '--limit', '1');
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(2);
    expect(r.stderr).not.toContain('exported 1 of 1');
  });
});

/**
 * `budget` exits non-zero on a FACT (spend already over), never on a forecast.
 * Failing a nightly job on a projection would page somebody about arithmetic
 * rather than about spend.
 */
describe('budget exit codes', () => {
  let env2: Record<string, string>;

  beforeAll(() => {
    const dir = tempDir('budget-cli-');
    const projects = buildClaudeProjects(dir, [
      {
        slug: '-work-one',
        sessions: [
          {
            sessionId: 'cc-b',
            lines: [
              assistantLine({
                sessionId: 'cc-b',
                requestId: 'rb',
                messageId: 'mb',
                input: 1_000_000,
                output: 1_000_000,
                timestamp: new Date().toISOString(),
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
    ]);
    env2 = {
      ...process.env,
      AI_USAGE_DB: join(dir, 'usage.db'),
      AI_USAGE_OPENCODE_DB: join(dir, 'absent.db'),
      AI_USAGE_CLAUDE_PROJECTS: projects,
      AI_USAGE_NO_UPDATE_CHECK: '1',
    };
    execFileSync(process.execPath, [CLI, 'sync'], { env: env2, encoding: 'utf8' });
  });

  const budget = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, 'budget', ...args], { env: env2, encoding: 'utf8' });

  // The fixture is $30 of estimated cost this month.
  it('exits 1 when spend already exceeds the target', () => {
    const r = budget('--amount', '25', '--basis', 'estimated');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('OVER BY');
  });

  it('exits 0 when spend is under, even if a projection is over', () => {
    const r = budget('--amount', '100', '--basis', 'estimated');
    expect(r.status).toBe(0);
    // The forecast is still reported -- it just does not fail the command.
    expect(r.stdout).toContain('Run rate and projection');
  });

  it('refuses to guess a basis, and explains what each one means', () => {
    const r = budget('--amount', '100');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('requires --basis');
    expect(r.stderr).toContain('There is no default');
  });

  it('requires an amount', () => {
    expect(budget('--basis', 'estimated').status).toBe(2);
    expect(budget('--amount', '0', '--basis', 'estimated').status).toBe(2);
  });

  it('refuses a rolling window, which has no period end to project towards', () => {
    expect(budget('--amount', '100', '--basis', 'estimated', '--period', 'days').status).toBe(2);
  });

  it('shows both denominators, never one blended projection', () => {
    const r = budget('--amount', '100', '--basis', 'estimated');
    expect(r.stdout).toContain('Per calendar day');
    expect(r.stdout).toContain('Per active day');
  });

  it('composes with --field, so a projection can be thresholded on purpose', () => {
    const r = spawnSync(
      process.execPath,
      [
        CLI,
        'budget',
        '--amount',
        '100',
        '--basis',
        'estimated',
        '--field',
        'projections.perActiveDay.projected',
        '--fail-over',
        '50',
      ],
      { env: env2, encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(Number(r.stdout.trim())).toBeGreaterThan(50);
  });
});
