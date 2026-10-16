import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Whether the two Claude Code integrations that are not an MCP server -- the
 * status line and the prompt hook -- are switched on.
 *
 * Both need an entry in Claude Code's own `settings.json`. Updating the package
 * cannot add that entry, so an existing user who upgrades gets the code and none
 * of the behaviour, and nothing tells them. `ai-usage status` reports this so
 * the place people already look when something seems off is also where they
 * find out what they have not turned on.
 *
 * Only the user-level settings file is read. Claude Code also merges a project's
 * `.claude/settings.json` and `.claude/settings.local.json`, and an entry there
 * is invisible from here -- which is why the report says "not found in <path>"
 * rather than "not installed".
 */
export interface ClaudeIntegrations {
  /** The user settings file that was read, or would have been. */
  settingsPath: string;
  /** False when the file does not exist -- the same as having no entries. */
  found: boolean;
  /** Set when the file exists but could not be read or parsed. */
  error?: string;
  /** A `statusLine` command that runs `ai-usage statusline`. */
  statusLine: boolean;
  /** A `UserPromptSubmit` hook command that runs `ai-usage hook`. */
  hook: boolean;
}

/**
 * Matches the subcommand however the binary was reached: `ai-usage hook`,
 * `npx -y -p ai-usage-mcp ai-usage hook`, or `node ~/src/ai-usage/dist/cli/index.js
 * hook` from a source checkout -- the `\S*` absorbs a path that runs through a
 * directory named after the package.
 */
const commandRunning = (sub: string) => new RegExp(`ai-usage\\S*\\s+${sub}(?:\\s|$)`);
const STATUSLINE = commandRunning('statusline');
const HOOK = commandRunning('hook');

/**
 * Where Claude Code keeps its user settings: the same candidates, in the same
 * order, as transcript discovery. The first that exists wins; with none, the
 * first candidate is named so the report says where the entry belongs.
 *
 * `AI_USAGE_CLAUDE_SETTINGS` overrides all of it, which is how the tests keep
 * every status report away from the developer's own `~/.claude`.
 */
export function claudeSettingsPath(): string {
  const override = process.env.AI_USAGE_CLAUDE_SETTINGS;
  if (override) return override;
  const candidates = [
    ...(process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : []),
    join(homedir(), '.claude'),
    join(homedir(), '.config', 'claude'),
  ].map((dir) => join(dir, 'settings.json'));
  return candidates.find((path) => existsSync(path)) ?? (candidates[0] as string);
}

export function readClaudeIntegrations(path: string = claudeSettingsPath()): ClaudeIntegrations {
  const none = { settingsPath: path, statusLine: false, hook: false };
  if (!existsSync(path)) return { ...none, found: false };

  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { ...none, found: true, error: (err as Error).message };
  }
  if (!isObject(settings)) {
    return { ...none, found: true, error: 'the file is not a JSON object' };
  }

  const statusLine = isObject(settings.statusLine) ? settings.statusLine.command : undefined;
  return {
    settingsPath: path,
    found: true,
    statusLine: typeof statusLine === 'string' && STATUSLINE.test(statusLine),
    hook: hookCommands(settings).some((command) => HOOK.test(command)),
  };
}

/**
 * Every command under `hooks.UserPromptSubmit[].hooks[]`. Each level is checked
 * rather than trusted: this is a file people edit by hand, and a malformed entry
 * should read as "no hook", not as a crash in `status`.
 */
function hookCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks;
  if (!isObject(hooks) || !Array.isArray(hooks.UserPromptSubmit)) return [];
  const commands: string[] = [];
  for (const matcher of hooks.UserPromptSubmit as unknown[]) {
    if (!isObject(matcher) || !Array.isArray(matcher.hooks)) continue;
    for (const hook of matcher.hooks as unknown[]) {
      if (isObject(hook) && typeof hook.command === 'string') commands.push(hook.command);
    }
  }
  return commands;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
