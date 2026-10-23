# Installing in other MCP clients, and updating

## Other MCP clients

**The client you ask from does not have to be a client you measure.** This server reports on the
Claude Code and OpenCode data already on your disk no matter who asks for it — so if you spend
your day in Cursor but your tokens go through Claude Code, ask Cursor and you still get the real
numbers.

**Cursor**, **Google Antigravity**, **Windsurf** and **Claude Desktop** all take the same block.
Only the file path changes:

```json
{
  "mcpServers": {
    "ai-usage": {
      "command": "npx",
      "args": ["-y", "ai-usage-mcp"]
    }
  }
}
```

| Client                 | File to put it in                                                      |
| ---------------------- | ---------------------------------------------------------------------- |
| **Cursor**             | `~/.cursor/mcp.json` (all projects), or `.cursor/mcp.json` in one repo |
| **Google Antigravity** | `~/.gemini/antigravity/mcp_config.json`                                |
| **Windsurf**           | `~/.codeium/windsurf/mcp_config.json`                                  |
| **Claude Desktop**     | **Settings → Developer → Edit Config** — see the paths below           |

For **Claude Desktop**, that button creates the file if it does not exist and opens it either
way, which is more reliable than editing by hand:

| Platform | Path                                                              |
| -------- | ----------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows  | `%APPDATA%\Claude\claude_desktop_config.json`                     |

Claude Desktop on Linux is in beta and Anthropic publishes no config path for it, so use the
**Edit Config** button rather than guessing one. Fully quit and relaunch afterwards — the file is
read at startup.

Two clients need a different shape:

**Codex** uses TOML, not JSON. Easiest is the CLI:

```bash
codex mcp add ai-usage -- npx -y ai-usage-mcp
```

Or add the table by hand to `~/.codex/config.toml` (or a project-scoped `.codex/config.toml`):

```toml
[mcp_servers.ai-usage]
command = "npx"
args = ["-y", "ai-usage-mcp"]
```

Confirm with `codex mcp list`.

**GitHub Copilot CLI** uses `~/.copilot/mcp-config.json`, where the top-level key is `servers`,
**not** `mcpServers`:

```json
{
  "servers": {
    "ai-usage": {
      "command": "npx",
      "args": ["-y", "ai-usage-mcp"]
    }
  }
}
```

On native Windows, use the `cmd /c` form in any of these — `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "ai-usage-mcp"]`, or `command = "cmd"` with
`args = ["/c", "npx", "-y", "ai-usage-mcp"]` for Codex. See the note under
[Claude Code](../README.md#claude-code) for why.

<sub>Provenance, 2026-09-08: Cursor, Windsurf, Codex and Claude Desktop paths are from each
vendor's own documentation. The Antigravity and Copilot CLI paths and key names were read off
installed copies of those apps on Linux, since neither publishes the path — including Copilot
CLI's `servers` key, which differs from every other client here.</sub>

## Updating

`npx -y ai-usage-mcp` — the form the instructions above use — re-resolves the version every
time your client cold-starts the server, so it keeps itself current. Restart the client to pick
up a new release.

A **global install is pinned** until you update it by hand:

```bash
npm install -g ai-usage-mcp@latest
ai-usage --version
```

`ai-usage status` tells you when you are behind:

```text
Update available: 0.1.0 installed, 0.2.0 latest -- npm i -g ai-usage-mcp@latest
  New in 0.2.0: a live context-size warning for Claude Code sessions
```

The second line is there when that release published a highlight. The MCP server's notice
carries it too.

**The MCP server says so too**, because most people never run the CLI. When the server finds a
newer release it says it **once per process**, through whichever channel comes first: a line
added to the `instructions` it returns at handshake time, or a one-off note attached to the
next tool result. It is a separate content block, so the numbers a tool returns stay exactly
what the CLI prints for the same query, and it never repeats itself on later calls. The same
line goes to the server's stderr log, and `@usage://status` shows the state on demand.

The advice differs by how you installed it, and the notice says the right one:

| Installed as                        | What actually fixes it                                |
| ----------------------------------- | ----------------------------------------------------- |
| `npm i -g ai-usage-mcp`             | `npm i -g ai-usage-mcp@latest`                        |
| `npx -y ai-usage-mcp`               | Restart the server -- npx re-resolves on a cold start |
| A version pinned in your MCP config | Change it there; no command will do it for you        |
| A project dependency                | `npm i ai-usage-mcp@latest`                           |
| A source checkout                   | `git pull && npm run build`                           |

That check is one of the package's two network requests (the other downloads prices for new
models -- see [New models are priced automatically](PRICING.md#new-models-are-priced-automatically)): a
version lookup against the npm registry, at most once a day, cached in
`<config dir>/update-check.json`, skipped when `CI` is set, and silently abandoned after 1.5s
if you are offline. It sends no usage data and no identifier -- just a GET for a version
string. Set `AI_USAGE_NO_UPDATE_CHECK=1` to turn it off everywhere, CLI and server alike; that
switch turns off the price download too. In the server it runs _after_ the handshake, never
during it, so it cannot slow down a client starting up.
