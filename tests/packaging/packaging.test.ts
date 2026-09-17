import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from '../fixtures/build-fixtures.js';

const ROOT = resolve('.');
const CLI = resolve('dist/cli/index.js');
const SERVER = resolve('dist/mcp/server.js');
const SMOKE_SCRIPT = resolve('.github/scripts/mcp-smoke.mjs');

/**
 * Everything the "Install from packed tarball" CI job asserts, run locally.
 *
 * That job was the ONE part of CI `npm run check` did not cover, which made the
 * claim in CLAUDE.md -- that `check` is "exactly what CI runs" -- untrue in the
 * only place it mattered. The consequence was not hypothetical: `usage_breakdown`
 * was added to the server and to `tests/mcp/server.test.ts`, both of which
 * `check` runs, but not to the hardcoded tool list in `mcp-smoke.mjs`, which it
 * did not. Five green local runs later, every pull request was failing.
 *
 * These tests deliberately run the REAL script and the REAL pack, rather than
 * re-implementing their assertions: a copy of a check is a thing that drifts
 * from the check.
 */
describe('packaging (the CI job `npm run check` used to miss)', () => {
  let dir: string;
  let env: Record<string, string>;

  beforeAll(() => {
    for (const bin of [CLI, SERVER]) {
      if (!existsSync(bin)) throw new Error(`${bin} is missing. Run \`npm run build\` first.`);
    }
    dir = tempDir('packaging-');
    // Isolated, as every test here must be: the smoke script and the CLI both
    // open a database, and neither may reach the developer's real one.
    env = {
      ...process.env,
      AI_USAGE_DB: join(dir, 'usage.db'),
      AI_USAGE_OPENCODE_DB: join(dir, 'absent-opencode.db'),
      AI_USAGE_CLAUDE_PROJECTS: join(dir, 'absent-projects'),
      AI_USAGE_NO_UPDATE_CHECK: '1',
    };
  });

  it('packs a tarball with no sources, tests or databases in it', () => {
    const out = tempDir('pack-');
    execFileSync('npm', ['pack', '--pack-destination', out], { cwd: ROOT, encoding: 'utf8' });
    const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'));
    expect(tarball, 'npm pack produced no tarball').toBeDefined();

    const files = execFileSync('tar', ['tzf', join(out, tarball as string)], {
      encoding: 'utf8',
    }).split('\n');
    const shipped = files.filter((f) => /package\/(src\/|tests\/)|\.db$/.test(f));

    expect(shipped, `these must not ship:\n${shipped.join('\n')}`).toEqual([]);
    expect(files.some((f) => f.startsWith('package/dist/'))).toBe(true);
    rmSync(out, { recursive: true, force: true });
  }, 60_000);

  it('runs both binaries the way the installed package does', () => {
    const version = spawnSync(process.execPath, [CLI, '--version'], { env, encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout).toContain('ai-usage-mcp');

    const status = spawnSync(process.execPath, [CLI, 'status'], { env, encoding: 'utf8' });
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('ai-usage status');
  }, 60_000);

  /**
   * The one that bit.
   *
   * `mcp-smoke.mjs` holds the third hand-maintained copy of the tool surface --
   * the others being the `registerX` calls and `tests/mcp/server.test.ts` -- and
   * that independence is the point: it catches a tool registered by accident as
   * well as one forgotten. What it should not do is catch it for the first time
   * in CI. Running the actual script here means any future drift in the list,
   * in the arguments a tool needs, or in the handshake itself, fails
   * `npm run check` on the machine that caused it.
   */
  it('passes the real CI MCP smoke script against the built server', () => {
    const result = spawnSync(process.execPath, [SMOKE_SCRIPT], {
      encoding: 'utf8',
      env: { ...env, AI_USAGE_MCP_BIN: `${process.execPath} ${SERVER}` },
    });

    expect(
      result.status,
      `mcp-smoke.mjs failed. Its stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain('MCP smoke test passed');
  }, 120_000);
});
