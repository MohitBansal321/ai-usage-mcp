# Troubleshooting

## `ai-usage status` says a collector is unavailable

It prints the reason and every path it looked at. Point it at the right place:

| Variable                      | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `AI_USAGE_OPENCODE_DB`        | Path to `opencode.db`                                                   |
| `AI_USAGE_CLAUDE_PROJECTS`    | Path to Claude Code's `projects/` directory                             |
| `AI_USAGE_CODEX_HOME`         | Path to the Codex CLI home (the directory holding `sessions/`)          |
| `AI_USAGE_DB`                 | Where to keep our database                                              |
| `AI_USAGE_HOME`               | Relocates both the database and the config dir in one go                |
| `AI_USAGE_PRICING_FILE`       | Pricing override file                                                   |
| `AI_USAGE_FRESHNESS_MS`       | How long a sync stays fresh before a tool call re-syncs (default 30000) |
| `AI_USAGE_NO_UPDATE_CHECK`    | Set to `1` to turn off both network requests (update check and prices)  |
| `AI_USAGE_NO_PRICING_REFRESH` | Set to `1` to stop downloading prices for models the tables lack        |
| `AI_USAGE_PRICING_URL`        | Where to download the community price list from (a mirror)              |
| `AI_USAGE_SQLITE_DRIVER`      | Force `node:sqlite` or `better-sqlite3`; unset picks the best available |

## `ai-usage status` warns that a client wrote after its newest turn

Neither client versions its on-disk format, so a client update can start writing turns
somewhere this package does not read yet. OpenCode 2.x did exactly that, and its usage simply
stopped appearing. `status` now compares when each client last wrote to its data with the
newest turn collected from it. If a sync after that write still found nothing within six hours
of it, `status` prints a warning.

Opening a client without sending a prompt also writes to its data, so the warning asks you to
check rather than claiming turns are missing. If you did use the client in that time, update
ai-usage. If the warning stays, [open an issue](https://github.com/MohitBansal321/ai-usage-mcp/issues)
with the client's version.

## Numbers look lower than `opencode stats`

Expected, and `opencode stats` is the one that's off. Its headline block reads OpenCode's
`session` rollup columns, which can be stale, while its own per-model block reads message
grain. The two halves of its output do not agree with each other. This tool matches the
message grain — the number corroborated by two independent tables. Run `ai-usage verify` to
see all three grains side by side.

## `ai-usage status` reports additional stores

You have more than one OpenCode database — usually because a sandboxed launcher exports its
own `XDG_DATA_HOME`. Only the store OpenCode itself resolves is collected by default. Each
extra store may be genuinely separate history or just a stale copy. Records are keyed by
source record id, so merging is safe:

```bash
ai-usage sync --all-stores
```

## Claude Code cost seems enormous

Read it as API-equivalent list price, not as money you spent — see the cost section above.
On a Pro/Max subscription the marginal cost per request is $0; what you are spending is your
plan limits, which [`ai-usage limits`](STATUS_LINE.md#plan-limits-and-the-status-line) reports.

## `claude: command not found`

You do not need the CLI. Claude Code's extensions read the same configuration files, so you can
register the server by creating `.mcp.json` in your project root, or by adding an `mcpServers`
block to `~/.claude.json` — see the collapsed section under [Install](../README.md#claude-code). If you do
want the CLI, `npm install -g @anthropic-ai/claude-code` provides it.

## `/mcp` shows ai-usage as failed

The server is spawned by Claude Code, so it has to be resolvable from the environment Claude
Code runs in. `npx -y ai-usage-mcp` is the most portable form and is what the instructions
above use.

If it still fails, your editor was probably launched without your shell's PATH (common with
Snap or Flatpak builds on Linux, and with launching from a desktop icon on macOS). Point the
config at absolute paths to bypass PATH lookup entirely:

```json
{
  "mcpServers": {
    "ai-usage": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/lib/node_modules/ai-usage-mcp/dist/mcp/server.js"]
    }
  }
}
```

Get both paths with `command -v node` and `npm root -g` after `npm install -g ai-usage-mcp`.
This pins the Node version, so prefer the `npx` form unless you need it.

## `node-gyp rebuild` errors during install

On Node 22.13+ this no longer fails the install. `better-sqlite3` is an **optional**
dependency, so npm reports the build failure and carries on; storage falls back to Node's
built-in `node:sqlite`. Confirm with:

```bash
ai-usage status        # expect: SQLite driver: node:sqlite
```

If that line instead reads `better-sqlite3`, your Node is older than 22.13.0 and the native
module is genuinely required — upgrade Node, which is the simplest fix. Historically this bit
Windows on npm 10, which ignores `better-sqlite3`'s `gypfile: false` flag and compiles from
source even though a usable prebuilt binary is bundled; `npm install -g npm@11` fixed that,
and remains the fix if you are pinned to an older Node and need the fallback to build.

## A model shows cost as unavailable, or "no estimate attempted"

That model is not in the pricing table. A new Claude model is normally picked up within a day
from the [community price list](PRICING.md#new-models-are-priced-automatically) -- the `Community:` line
of `ai-usage status` says whether it is on, when the list was last downloaded, and what it
priced. If it is off, or the list does not have the model yet, add it via a [pricing override
file](PRICING.md#adding-or-correcting-prices-yourself). Either way, records already stored are priced
on the next sync. The tool will not guess a price.

`ai-usage models --json` lists the model ids exactly as your clients recorded them, which are
the keys your override file needs.

## Totals changed after re-syncing

They should not. Records are keyed deterministically by source identifiers and upserted, so
re-syncing is idempotent — `ai-usage sync --full` re-reads everything and must leave totals
unchanged. A test asserts this. If it happens, please file an issue with `ai-usage verify`
output.

## Sync feels slow

Only the first sync reads everything (~2.5s for 87MB of transcripts plus a 900MB database on
the development machine). After that, unchanged transcripts are skipped by size + mtime and
OpenCode is read incrementally from a saved cursor. `--full` ignores the cursors.
