import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { tempDir } from '../fixtures/build-fixtures.js';

const ROOT = resolve('.');
const CLI = resolve('dist/cli/index.js');
const SERVER = resolve('dist/mcp/server.js');
const SMOKE_SCRIPT = resolve('.github/scripts/mcp-smoke.mjs');

function readTarPaths(tgzPath: string): string[] {
  const data = gunzipSync(readFileSync(tgzPath));
  const result: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    const header = data.slice(offset, offset + 512);
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '').trim();
    if (name.length === 0) break;
    result.push(name);
    const sizeStr = header.toString('ascii', 124, 136).trim();
    const size = parseInt(sizeStr, 8) || 0;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

describe('packaging (the CI job `npm run check` used to miss)', () => {
  let dir: string;
  let env: Record<string, string>;

  beforeAll(() => {
    for (const bin of [CLI, SERVER]) {
      if (!existsSync(bin)) throw new Error(`${bin} is missing. Run \`npm run build\` first.`);
    }
    dir = tempDir('packaging-');
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
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['pack', '--pack-destination', out], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: true,
    });
    const tarballName = readdirSync(out).find((f) => f.endsWith('.tgz'));
    expect(tarballName, 'npm pack produced no tarball').toBeDefined();
    const tarballPath = join(out, tarballName as string);
    expect(existsSync(tarballPath)).toBe(true);

    const paths = readTarPaths(tarballPath);
    const shipped = paths.filter((f) => /^(src\/|tests\/)|\.db$/.test(f));
    expect(shipped, `these must not ship:\n${shipped.join('\n')}`).toEqual([]);
    expect(paths.some((f) => f.startsWith('package/dist/') || f.startsWith('dist/'))).toBe(true);
    rmSync(out, { recursive: true, force: true });
  }, 120_000);

  it('runs both binaries the way the installed package does', () => {
    const version = spawnSync(process.execPath, [CLI, '--version'], { env, encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout).toContain('ai-usage-mcp');

    const status = spawnSync(process.execPath, [CLI, 'status'], { env, encoding: 'utf8' });
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('ai-usage status');
  }, 60_000);

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
