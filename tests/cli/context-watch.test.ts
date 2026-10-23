import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from '../fixtures/build-fixtures.js';

const CLI = resolve('dist/cli/index.js');

/**
 * `ai-usage hook` runs before every prompt and `ai-usage statusline` after every
 * reply, so both are exercised as the shipped binary, with real stdin and real
 * exit codes -- a hook that exits 2 would block and erase the user's prompt.
 */
describe('context watch (CLI)', () => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing. Run \`npm run build\` first.`);

  const dir = tempDir('context-watch-');
  const dbPath = join(dir, 'usage.db');
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AI_USAGE_DB: dbPath,
    AI_USAGE_OPENCODE_DB: join(dir, 'absent-opencode.db'),
    AI_USAGE_CLAUDE_PROJECTS: join(dir, 'absent-projects'),
    AI_USAGE_CODEX_HOME: join(dir, 'absent-codex-home'),
    AI_USAGE_NO_UPDATE_CHECK: '1',
  };
  delete baseEnv.NO_COLOR;
  delete baseEnv.AI_USAGE_CTX_WARN;
  delete baseEnv.AI_USAGE_CTX_LIMIT;

  const transcript = join(dir, 'session.jsonl');
  const writeTranscript = (tokens: number) =>
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        message: {
          model: 'claude-opus-5',
          usage: { input_tokens: 3, cache_read_input_tokens: tokens },
        },
      }) + '\n',
    );
  const payload = (path = transcript) =>
    JSON.stringify({ session_id: 's1', transcript_path: path });

  const run = (
    args: string[],
    input: string,
    env: Record<string, string | undefined> = {},
  ): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { ...baseEnv, ...env },
      input,
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  describe('hook', () => {
    it('prints nothing below the limit, and exits 0', () => {
      writeTranscript(77_000);
      const r = run(['hook'], payload());
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('prints the hook JSON at the limit, and exits 0', () => {
      writeTranscript(260_000);
      const r = run(['hook'], payload());
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(out.hookSpecificOutput.additionalContext).toContain('260k');
      expect(out.systemMessage).toContain('/compact');
    });

    it('honours --ctx-limit and AI_USAGE_CTX_LIMIT', () => {
      writeTranscript(120_000);
      expect(run(['hook'], payload()).stdout).toBe('');
      expect(run(['hook', '--ctx-limit', '100k'], payload()).stdout).toContain(
        'hookSpecificOutput',
      );
      expect(run(['hook'], payload(), { AI_USAGE_CTX_LIMIT: '100k' }).stdout).toContain(
        'hookSpecificOutput',
      );
    });

    it('stays silent right after a compact, when the size is unknown', () => {
      writeFileSync(
        transcript,
        [
          JSON.stringify({
            type: 'assistant',
            message: { model: 'm', usage: { cache_read_input_tokens: 458_000 } },
          }),
          JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
        ].join('\n') + '\n',
      );
      const r = run(['hook'], payload());
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('exits 0 and prints nothing on garbage, empty or incomplete stdin', () => {
      writeTranscript(260_000);
      for (const input of ['not json', '', '[]', '{}', '{"transcript_path":42}']) {
        const r = run(['hook'], input);
        expect(r.status, input).toBe(0);
        expect(r.stdout, input).toBe('');
      }
      const missing = run(['hook'], payload(join(dir, 'gone.jsonl')));
      expect(missing.status).toBe(0);
      expect(missing.stdout).toBe('');
    });

    it('exits 0 even for a mistyped flag, which must not block the prompt', () => {
      writeTranscript(260_000);
      const r = run(['hook', '--ctx-limit', 'lots', '--bogus'], payload());
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('--ctx-limit');
      // The bad value is ignored, so the default limit still applies.
      expect(r.stdout).toContain('hookSpecificOutput');
    });

    it('opens no database', () => {
      writeTranscript(260_000);
      run(['hook'], payload());
      expect(existsSync(dbPath)).toBe(false);
    });
  });

  describe('statusline', () => {
    const line = (tokens: number, args: string[] = [], env: Record<string, string> = {}) => {
      writeTranscript(tokens);
      const r = run(['statusline', ...args], payload(), env);
      expect(r.status).toBe(0);
      return r.stdout.trimEnd();
    };

    it('appends a green ctx segment below the warn limit', () => {
      expect(line(77_000).endsWith(' \u00b7 \x1b[32mctx 77k\x1b[0m')).toBe(true);
    });

    it('turns yellow from the warn limit and red from the compact limit', () => {
      expect(line(150_000).endsWith('\x1b[33mctx 150k\x1b[0m')).toBe(true);
      expect(line(260_000).endsWith('\x1b[31mctx 260k \u00b7 compact now\x1b[0m')).toBe(true);
    });

    it('respects --no-color and NO_COLOR', () => {
      expect(line(260_000, ['--no-color'])).toMatch(/ctx 260k · compact now$/);
      expect(line(260_000, [], { NO_COLOR: '1' })).not.toContain('\x1b');
    });

    it('takes its limits from flags and from the environment', () => {
      expect(line(90_000, ['--no-color', '--ctx-warn', '50k', '--ctx-limit', '80k'])).toMatch(
        /ctx 90k · compact now$/,
      );
      expect(line(90_000, ['--no-color'], { AI_USAGE_CTX_WARN: '80k' })).toMatch(/ctx 90k$/);
      expect(line(90_000, ['--no-color'], { AI_USAGE_CTX_LIMIT: '1m' })).toMatch(/ctx 90k$/);
    });

    it('shows no ctx segment, and still prints the line, when the size is unknown', () => {
      const r = run(['statusline', '--no-color'], payload(join(dir, 'gone.jsonl')));
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('today');
      expect(r.stdout).not.toContain('ctx');
      const noPath = run(['statusline', '--no-color'], JSON.stringify({ session_id: 's' }));
      expect(noPath.stdout).not.toContain('ctx');
    });

    it('exposes the reading in --json', () => {
      writeTranscript(260_000);
      const r = run(['statusline', '--json'], payload());
      expect(JSON.parse(r.stdout).context).toEqual({
        tokens: 260_003,
        level: 'compact',
        warnAt: 150_000,
        compactAt: 250_000,
      });
    });

    it('rejects contradictory or unreadable limits as a usage error', () => {
      writeTranscript(1);
      expect(
        run(['statusline', '--ctx-warn', '300k', '--ctx-limit', '100k'], payload()).status,
      ).toBe(2);
      expect(run(['statusline', '--ctx-limit', 'big'], payload()).status).toBe(2);
    });
  });
});
