import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  claudeSettingsPath,
  readClaudeIntegrations,
} from '../../src/collectors/claude-code/settings.js';
import { tempDir } from '../fixtures/build-fixtures.js';

const dirs: string[] = [];

function settingsFile(content: unknown): string {
  const dir = tempDir('claude-settings-');
  dirs.push(dir);
  const path = join(dir, 'settings.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

/** The shape the README tells people to add, as observed in a real settings.json. */
function hookEntry(command: string) {
  return { UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readClaudeIntegrations', () => {
  it('finds both entries exactly as the README spells them', () => {
    const path = settingsFile({
      statusLine: { type: 'command', command: 'ai-usage statusline' },
      hooks: hookEntry('ai-usage hook'),
    });
    expect(readClaudeIntegrations(path)).toEqual({
      settingsPath: path,
      found: true,
      statusLine: true,
      hook: true,
    });
  });

  it('recognises the npx form, a source checkout, and flags after the subcommand', () => {
    const path = settingsFile({
      statusLine: { type: 'command', command: 'npx -y -p ai-usage-mcp ai-usage statusline' },
      hooks: hookEntry('node /home/u/src/ai-usage/dist/cli/index.js hook --ctx-limit 200k'),
    });
    expect(readClaudeIntegrations(path)).toMatchObject({ statusLine: true, hook: true });
  });

  it('finds the hook among other hooks and other events', () => {
    const path = settingsFile({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'ai-usage hook' }] }],
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'node ~/.claude/hooks/other.mjs hook' }] },
          { hooks: [{ type: 'command', command: 'ai-usage hook' }] },
        ],
      },
    });
    expect(readClaudeIntegrations(path)).toMatchObject({ statusLine: false, hook: true });
  });

  it('does not mistake another tool, or the wrong event, for ours', () => {
    const path = settingsFile({
      statusLine: { type: 'command', command: 'ccusage statusline' },
      hooks: {
        // The right command under the wrong event never runs before a prompt.
        SessionStart: [{ hooks: [{ type: 'command', command: 'ai-usage hook' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'ai-usage hooks-of-mine' }] }],
      },
    });
    expect(readClaudeIntegrations(path)).toMatchObject({ statusLine: false, hook: false });
  });

  it('treats a missing file as no entries, not as an error', () => {
    const path = join(tempDir('claude-settings-'), 'settings.json');
    dirs.push(join(path, '..'));
    expect(readClaudeIntegrations(path)).toEqual({
      settingsPath: path,
      found: false,
      statusLine: false,
      hook: false,
    });
  });

  it('reports a malformed file rather than claiming nothing is installed', () => {
    const broken = readClaudeIntegrations(settingsFile('{ "statusLine": '));
    expect(broken.found).toBe(true);
    expect(broken.error).toBeDefined();

    expect(readClaudeIntegrations(settingsFile('[]')).error).toBe('the file is not a JSON object');
  });

  it('reads malformed entries inside a valid file as absent', () => {
    const path = settingsFile({
      statusLine: 'ai-usage statusline',
      hooks: { UserPromptSubmit: [null, { hooks: 'ai-usage hook' }, { hooks: [{ command: 7 }] }] },
    });
    expect(readClaudeIntegrations(path)).toMatchObject({
      found: true,
      statusLine: false,
      hook: false,
    });
    expect(readClaudeIntegrations(path).error).toBeUndefined();
  });
});

describe('claudeSettingsPath', () => {
  const saved = {
    override: process.env.AI_USAGE_CLAUDE_SETTINGS,
    configDir: process.env.CLAUDE_CONFIG_DIR,
  };

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('AI_USAGE_CLAUDE_SETTINGS', saved.override);
    restore('CLAUDE_CONFIG_DIR', saved.configDir);
  });

  it('honours the override, which keeps the suite off the real ~/.claude', () => {
    process.env.AI_USAGE_CLAUDE_SETTINGS = '/somewhere/settings.json';
    expect(claudeSettingsPath()).toBe('/somewhere/settings.json');
  });

  it('prefers CLAUDE_CONFIG_DIR when it holds a settings file', () => {
    delete process.env.AI_USAGE_CLAUDE_SETTINGS;
    const dir = tempDir('claude-config-');
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{}');
    process.env.CLAUDE_CONFIG_DIR = dir;
    expect(claudeSettingsPath()).toBe(join(dir, 'settings.json'));
  });
});
