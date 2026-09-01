# AGENTS.md — ai-usage-mcp

**Read [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) first, then
[PROJECT_CONTEXT.md](PROJECT_CONTEXT.md).** `DATA_SOURCES.md` holds the on-disk formats as
actually verified against real data, and supersedes PROJECT_CONTEXT.md §5 where they disagree
(several original claims were wrong in ways that produce badly incorrect numbers).
PROJECT_CONTEXT.md holds the product goal, Phase 1 scope, and Definition of Done. Do not
re-derive these formats by guessing.

## What this project is

A local-first MCP server that reports **real** token usage and cost across coding agents
(Phase 1: Claude Code + OpenCode). Local SQLite, five MCP tools, a debug CLI. Nothing leaves
the machine.

## Non-negotiable rules

1. **Never fabricate a number.** If a source does not expose a value, report it as
   unavailable. Every cost carries a `costBasis` of `reported`, `estimated`, or `unavailable`.
2. **MCP must not know where data comes from.** MCP → usage service → collectors. Business
   logic lives in `services/`, never in an MCP tool handler.
3. **Nothing leaves the machine.** No telemetry, no cloud sync, no API keys, no conversation
   content. SQLite only — no Postgres, Redis, or Kafka.
4. **Do not parse `opencode stats` output to collect data.** It is a box-drawing TUI table.
   Read the database instead — resolved via `$XDG_DATA_HOME/opencode` before
   `~/.local/share/opencode`, because a sandboxed launcher splits these into two stores.
   `opencode stats` is also **not a reliable oracle**: its headline block reads a stale
   `session` rollup while its model block reads message grain, so it disagrees with itself.
   Verify against the `message` and `part` tables, which corroborate each other exactly.
5. **Open live databases read-only.** Prefer a direct read-only connection (~15ms even at
   879MB); fall back to copying `.db` + `-wal` + `-shm` only if that fails. Never copy a
   ~1GB file on every sync.
6. **Stay inside Phase 1 scope.** No dashboard, login, accounts, routing, optimization, or
   extra client collectors until the Definition of Done is fully green.
7. **Re-verify before trusting.** Both source formats are internal and unversioned. If
   something does not match PROJECT_CONTEXT.md §5, inspect the real files and update the doc
   in the same change.

## Correctness traps

Claude Code: dedupe on `requestId` + `message.id` taking the **max** of each field —
`output_tokens` is cumulative across the one-line-per-content-block writes, and naive summing
inflates cache-read by 2.24x. `usage.iterations[]` is already inside the top-level totals;
never sum it. `isSidechain` is **never set** — classify subagent turns by path
(`.../subagents/...`). `<synthetic>` is not a model. Split cache writes by TTL (1.25x vs 2x).
Reasoning tokens are **inside** `output_tokens` for Claude Code but **beside** `output` for
OpenCode — handling that generically double-counts. Cache-read dwarfs input (800M vs 24K), so
always break token classes out and never show one blended total.

Run `ai-usage verify` after any collector change: it re-derives both sources with a second,
independent implementation and must report a zero delta.

## Commands

```bash
npm run build
npm test
ai-usage status | sync | stats | sessions      # debug CLI, same service layer as MCP
```

`ai-usage stats --today` must return exactly what the `usage_summary` MCP tool returns.
If they disagree, the layering is broken.
