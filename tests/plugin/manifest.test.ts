import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The plugin manifest carries a `version` of its own, and the release workflow
 * only checks the tag against `package.json`. Nothing else would notice the two
 * drifting apart, and a stale plugin version means installed users silently stop
 * receiving updates -- so that equality is asserted here rather than trusted to
 * a step in a checklist.
 */
const root = resolve(__dirname, '..', '..');

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  mcpServers?: Record<string, { command: string; args?: string[] }>;
}

interface Marketplace {
  name: string;
  owner?: { name?: string };
  plugins: { name: string; source: string; description?: string }[];
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(resolve(root, relative), 'utf8')) as T;
}

describe('Claude Code plugin manifest', () => {
  const plugin = readJson<PluginManifest>('.claude-plugin/plugin.json');
  const marketplace = readJson<Marketplace>('.claude-plugin/marketplace.json');
  const pkg = readJson<{ version: string; name: string }>('package.json');

  it('declares the version package.json declares', () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it('uses a kebab-case name, since the name namespaces every command', () => {
    expect(plugin.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('starts the server the same way the README tells everyone else to', () => {
    // If these diverge, plugin users and config users are running different
    // things and only one set of install instructions can be right.
    expect(plugin.mcpServers?.['ai-usage']).toEqual({
      command: 'npx',
      args: ['-y', pkg.name],
    });
  });

  it('is listed by the marketplace in this same repo', () => {
    const entry = marketplace.plugins.find((p) => p.name === plugin.name);
    expect(entry, `marketplace.json lists no plugin named ${plugin.name}`).toBeDefined();
    expect(entry?.source).toBe('.');
  });

  it('ships every prompt in src/mcp/prompts.ts as a command, and no others', () => {
    // The three MCP prompts and the three slash commands are the same feature
    // through two surfaces. A prompt without a command is invisible in clients
    // that do not surface MCP prompts, which is most of them.
    const prompts = readFileSync(resolve(root, 'src/mcp/prompts.ts'), 'utf8');
    const registered = [...prompts.matchAll(/registerPrompt\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThan(0);

    const commands = readdirSync(resolve(root, 'commands'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''));

    expect(commands.sort()).toEqual([...registered].sort());
  });

  it('gives every command frontmatter with a name and a description', () => {
    const dir = resolve(root, 'commands');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      // Normalised because this asserts frontmatter STRUCTURE, not a line-ending
      // policy. `.gitattributes` pins these files to LF for Claude Code's sake;
      // a Windows checkout that still produced CRLF would be a delivery problem,
      // not a reason for this assertion to fail.
      const body = readFileSync(resolve(dir, file), 'utf8').replace(/\r\n/g, '\n');

      // Claude Code reads frontmatter only when the opening --- is the very
      // first line; otherwise the whole file, markers included, is content.
      expect(body.startsWith('---\n'), `${file} must open with frontmatter`).toBe(true);

      const end = body.indexOf('\n---\n', 4);
      expect(end, `${file} has an unterminated frontmatter block`).toBeGreaterThan(0);
      const frontmatter = body.slice(4, end);

      expect(frontmatter, `${file} name`).toMatch(/^name:\s*\S+/m);
      expect(frontmatter, `${file} description`).toMatch(/^description:\s*\S+/m);

      // The command name must match the filename, or the slash command a user
      // types is not the one the file appears to define.
      expect(frontmatter).toMatch(new RegExp(`^name:\\s*${file.replace(/\.md$/, '')}\\s*$`, 'm'));
    }
  });

  it('carries the cost-basis rule into every command', () => {
    // A paraphrasing model must not merge the two cost bases just because the
    // instruction that forbids it lives only in the MCP prompt.
    const dir = resolve(root, 'commands');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const body = readFileSync(resolve(dir, file), 'utf8').replace(/\r\n/g, '\n');
      expect(body, `${file} cost-basis rule`).toMatch(
        /Never add the reported and estimated cost figures together/,
      );
    }
  });
});
