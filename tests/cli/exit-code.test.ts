import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from '../fixtures/build-fixtures.js';

const CLI = resolve('dist/cli/index.js');

/**
 * Exit codes are part of the CLI's contract: `status` is scripted, and `verify`
 * is meant to be runnable in CI. A command that prints a correct report and then
 * exits non-zero is worse than one that fails outright, because the failure is
 * invisible until something downstream trusts the status.
 */
describe('CLI exit codes', () => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing. Run \`npm run build\` first.`);

  const dir = tempDir('exit-code-');
  const env = {
    ...process.env,
    AI_USAGE_DB: join(dir, 'usage.db'),
    AI_USAGE_OPENCODE_DB: join(dir, 'absent-opencode.db'),
    AI_USAGE_CLAUDE_PROJECTS: join(dir, 'absent-projects'),
    AI_USAGE_NO_UPDATE_CHECK: '1',
  };

  const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it('exits 0 on a successful command', () => {
    const r = run('status');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ai-usage status');
  });

  it('exits 2 on an unknown command', () => {
    expect(run('no-such-command').status).toBe(2);
  });

  it('exits 2 on an invalid option value', () => {
    expect(run('stats', '--days', 'abc').status).toBe(2);
    expect(run('stats', '--client', 'bogus').status).toBe(2);
  });

  /**
   * The regression this file exists for.
   *
   * `process.exit()` tears the process down while libuv handles are still
   * closing. On Windows, once the update check has opened a TLS connection to
   * the npm registry, that trips an assertion inside libuv --
   *
   *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
   *
   * -- and the process aborts with code 127 *after* printing a complete and
   * correct report. Every test above runs with `AI_USAGE_NO_UPDATE_CHECK=1`, and
   * the suite is hermetic by design, so no test here may reach the registry to
   * reproduce it directly. The invariant is asserted on the shipped entrypoint
   * instead: this CLI sets `process.exitCode` and lets the event loop drain.
   */
  it('never forces termination with process.exit()', () => {
    const built = readFileSync(CLI, 'utf8');
    const withoutComments = built.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(withoutComments).not.toMatch(/process\.exit\s*\(/);
    expect(withoutComments).toMatch(/process\.exitCode\s*=/);
  });
});

/**
 * `--since`/`--until` used to escape the parser and fail several layers in, as a
 * raw `RangeError: Invalid time value` with exit 1 -- while every other bad flag
 * gave one clean line and exit 2.
 */
describe('CLI date bounds', () => {
  const dir = tempDir('exit-code-dates-');
  const env = {
    ...process.env,
    AI_USAGE_DB: join(dir, 'usage.db'),
    AI_USAGE_OPENCODE_DB: join(dir, 'absent-opencode.db'),
    AI_USAGE_CLAUDE_PROJECTS: join(dir, 'absent-projects'),
    AI_USAGE_NO_UPDATE_CHECK: '1',
  };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

  it('rejects an unparseable bound with exit 2 and no stack trace', () => {
    for (const flag of ['--since', '--until']) {
      const r = run('stats', flag, 'not-a-date');
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`${flag} expects an ISO 8601 date`);
      expect(r.stderr).not.toContain('RangeError');
      expect(r.stderr).not.toContain('at resolvePeriod');
    }
  });

  it('still accepts a valid bound', () => {
    expect(run('stats', '--since', '2026-09-01').status).toBe(0);
  });
});
