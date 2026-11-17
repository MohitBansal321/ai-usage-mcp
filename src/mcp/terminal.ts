/**
 * What `ai-usage-mcp` does when a person, not an MCP client, starts it.
 *
 * An MCP client always spawns the server with pipes. Someone who types
 * `npx ai-usage-mcp` into a terminal gets a TTY on stdin instead, and before
 * this the server answered them with one line on stderr and then waited
 * forever for JSON-RPC that was never coming -- the first, and usually last,
 * thing a curious visitor saw. Now they get their own usage report, and the
 * one command that connects the server to their agent.
 */

export type LaunchMode = 'server' | 'report' | 'help' | 'version';

/**
 * Decides what this launch is for. `--stdio` forces server mode for the rare
 * client that hands the server a TTY; flags win over the TTY check so
 * `ai-usage-mcp --version` works from a script too.
 */
export function launchMode(argv: readonly string[], stdinIsTTY: boolean): LaunchMode {
  if (argv.includes('--stdio')) return 'server';
  if (argv.includes('--version') || argv.includes('-v')) return 'version';
  if (argv.includes('--help') || argv.includes('-h')) return 'help';
  return stdinIsTTY ? 'report' : 'server';
}

export const TERMINAL_INTRO =
  'ai-usage-mcp is an MCP server: it is meant to be started by your coding agent, which then\n' +
  'answers questions like "where did my tokens go this week?". Started from a terminal, it\n' +
  'prints your report instead.\n\n';

export const TERMINAL_OUTRO = `
Ask your agent instead of reading reports -- connect the server once:

  Claude Code   claude mcp add ai-usage -s user -- npx -y ai-usage-mcp
  Codex CLI     codex mcp add ai-usage -- npx -y ai-usage-mcp
  OpenCode      opencode mcp add ai-usage   (local server, command: npx -y ai-usage-mcp)

More reports without installing:  npx -y -p ai-usage-mcp ai-usage help
Docs: https://github.com/MohitBansal321/ai-usage-mcp#readme
`;

export const SERVER_HELP = `ai-usage-mcp -- local MCP server for Claude Code, Codex CLI and OpenCode usage and cost

Usage:
  ai-usage-mcp              From a terminal: print your 7-day usage report.
                            From an MCP client (stdin is a pipe): serve MCP on stdio.
  ai-usage-mcp --stdio      Serve MCP on stdio even when stdin is a terminal.
  ai-usage-mcp --version    Print the version.
  ai-usage-mcp --help       Print this help.
${TERMINAL_OUTRO}`;
