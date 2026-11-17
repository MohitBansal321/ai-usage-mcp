import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchMode } from '../../src/mcp/terminal.js';
import { buildClaudeProjects, tempDir } from '../fixtures/build-fixtures.js';

const SERVER = resolve('dist/mcp/server.js');
const VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

describe('launchMode', () => {
  it('serves MCP when stdin is a pipe, as every MCP client spawns it', () => {
    expect(launchMode([], false)).toBe('server');
  });

  it('prints the report when a person starts it from a terminal', () => {
    expect(launchMode([], true)).toBe('report');
  });

  it('lets --stdio force server mode for a client that hands over a TTY', () => {
    expect(launchMode(['--stdio'], true)).toBe('server');
    expect(launchMode(['--stdio', '--help'], true)).toBe('server');
  });

  it('answers --version and --help whether or not stdin is a terminal', () => {
    for (const tty of [true, false]) {
      expect(launchMode(['--version'], tty)).toBe('version');
      expect(launchMode(['-v'], tty)).toBe('version');
      expect(launchMode(['--help'], tty)).toBe('help');
      expect(launchMode(['-h'], tty)).toBe('help');
    }
  });
});

function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AI_USAGE_DB: join(dir, 'usage.db'),
    AI_USAGE_HOME: join(dir, 'config'),
    AI_USAGE_OPENCODE_DB: join(dir, 'absent.db'),
    AI_USAGE_CLAUDE_PROJECTS: buildClaudeProjects(dir, []),
    AI_USAGE_CODEX_HOME: join(dir, 'absent-codex-home'),
    AI_USAGE_NO_UPDATE_CHECK: '1',
  };
}

describe('the built server started by hand', () => {
  it('prints its version and exits instead of waiting for JSON-RPC', () => {
    expect(existsSync(SERVER), 'run `npm run build` first').toBe(true);
    const r = spawnSync(process.execPath, [SERVER, '--version'], {
      env: isolatedEnv(tempDir('mcp-terminal-')),
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`ai-usage-mcp ${VERSION}\n`);
  });

  it('prints help that names the install commands', () => {
    const r = spawnSync(process.execPath, [SERVER, '--help'], {
      env: isolatedEnv(tempDir('mcp-terminal-')),
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('claude mcp add ai-usage -s user -- npx -y ai-usage-mcp');
    expect(r.stdout).toContain('--stdio');
  });

  // `script` gives the child a real pseudo-terminal, which is the only way to
  // reproduce `npx ai-usage-mcp` typed by a person. util-linux's flags differ
  // from BSD's, so this runs where CI and most contributors have util-linux.
  const hasScript = process.platform === 'linux' && spawnSync('script', ['--version']).status === 0;

  it.runIf(hasScript)('prints the report and exits when stdin is a terminal', () => {
    const r = spawnSync('script', ['-qec', `"${process.execPath}" "${SERVER}"`, '/dev/null'], {
      env: isolatedEnv(tempDir('mcp-terminal-')),
      encoding: 'utf8',
      timeout: 30_000,
      input: '',
    });
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Started from a terminal, it');
    expect(r.stdout).toContain('Usage report');
    expect(r.stdout).toContain('codex mcp add ai-usage -- npx -y ai-usage-mcp');
    expect(r.stdout).not.toContain('MCP server ready on stdio');
  });
});
