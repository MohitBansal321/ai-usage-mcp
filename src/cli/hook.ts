import {
  ContextService,
  parseTokenCount,
  resolveContextLimits,
} from '../services/context-service.js';
import { formatContextHook } from '../services/formatter.js';
import { readStdin } from './stdin.js';

/**
 * `ai-usage hook`: Claude Code's UserPromptSubmit hook. Prints a notice when the
 * session's context is at or above the compact limit, and nothing otherwise.
 *
 * It ALWAYS returns 0. For this hook event Claude Code treats exit code 2 as
 * "block the prompt and erase it", so a hook that failed -- on garbage stdin, a
 * missing transcript, or a mistyped flag -- would eat what the user just typed.
 * That is why it reads its two flags itself instead of going through
 * `parseArgs`, which rejects what it does not understand: here an unknown or
 * malformed flag is reported on stderr and otherwise ignored.
 *
 * It runs on every prompt, so it is also the one command that must stay light:
 * `index.ts` dispatches here without loading the rest of the CLI, and it opens no
 * database, syncs nothing and loads no pricing -- it reads the tail of one file.
 */
export async function runContextHook(argv: string[]): Promise<number> {
  try {
    const flags: { warn?: number; limit?: number } = {};
    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      if (flag !== '--ctx-warn' && flag !== '--ctx-limit') {
        process.stderr.write(`ai-usage hook: ignoring unknown option "${String(flag)}".\n`);
        continue;
      }
      const value = parseTokenCount(argv[++i] ?? '');
      if (value === undefined) {
        process.stderr.write(
          `ai-usage hook: ${flag} expects a token count such as 150k; ignored.\n`,
        );
      } else if (flag === '--ctx-warn') flags.warn = value;
      else flags.limit = value;
    }
    const raw = await readStdin();
    const output = formatContextHook(
      new ContextService().readHookPayload(raw, resolveContextLimits(flags)),
    );
    if (output) process.stdout.write(`${output}\n`);
  } catch (err) {
    process.stderr.write(`ai-usage: hook failed: ${(err as Error).message}\n`);
  }
  return 0;
}
