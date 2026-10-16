#!/usr/bin/env node
/**
 * Entry point. A dispatcher and nothing else: the real CLI is `main.ts`.
 *
 * The split exists for one command. `ai-usage hook` runs before every prompt a
 * user sends, and loading the whole CLI -- every service, the SQLite driver, the
 * pricing tables -- costs several times what the hook itself does. Static imports
 * load before any code runs, so the only way to skip them is to not import them.
 */
const argv = process.argv.slice(2);
const isHook = argv[0] === 'hook' && !argv.includes('--help') && !argv.includes('-h');

if (isHook) {
  import('./hook.js')
    .then((m) => m.runContextHook(argv))
    .then((code) => {
      process.exitCode = code;
    })
    // A hook that cannot even load must still not block the prompt.
    .catch((err) => {
      process.stderr.write(`ai-usage: hook failed: ${(err as Error).message}\n`);
      process.exitCode = 0;
    });
} else {
  import('./main.js').catch((err) => {
    process.stderr.write(`ai-usage: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  });
}
