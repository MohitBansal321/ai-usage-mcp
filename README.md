# ai-usage-mcp

[![npm version](https://img.shields.io/npm/v/ai-usage-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/ai-usage-mcp)
[![CI](https://github.com/MohitBansal321/ai-usage-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/MohitBansal321/ai-usage-mcp/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/ai-usage-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/ai-usage-mcp)
[![node](https://img.shields.io/node/v/ai-usage-mcp?logo=node.js&color=5fa04e)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/ai-usage-mcp?color=blue)](LICENSE)

A local-first MCP server that answers, from real data on your machine:

> How many tokens have I used, from which client, model and session — and what did it cost?

Phase 1 supports two coding agents: **Claude Code** and **OpenCode**. It reads the data those
clients already wrote to disk, normalises it into one schema, stores it in a local SQLite
database, and exposes five MCP tools plus a debug CLI.

**It never fabricates a number.** If a source does not record something, it is reported as
unavailable — not as zero.

---

## Install

Requires **Node.js 22 or newer**. No compiler or build tools needed — the only native
dependency ships prebuilt binaries for macOS, Linux (glibc and musl/Alpine) and Windows on
both x64 and arm64.

### Claude Code

Either register it directly, with no install step at all:

```bash
claude mcp add ai-usage -- npx -y ai-usage-mcp
```

…or install it globally first, which also gives you the `ai-usage` debug CLI on your PATH:

```bash
npm install -g ai-usage-mcp
claude mcp add ai-usage -- ai-usage-mcp
```

Then confirm:

```bash
claude mcp list          # should show ai-usage
```

and run `/mcp` inside Claude Code to check the connection is live.

Add `-s user` to `claude mcp add` to register it for every project instead of just the current
one.

### OpenCode

Interactive:

```bash
opencode mcp add ai-usage       # choose a local server, command: ai-usage-mcp
opencode mcp list               # confirm
```

Or declare it in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ai-usage": {
      "type": "local",
      "command": ["ai-usage-mcp"],
    },
  },
}
```

Use `"command": ["npx", "-y", "ai-usage-mcp"]` instead if you would rather not install
globally.

Verified against OpenCode **1.18.25** and Claude Code **2.1.251**.

### Just the CLI, without installing

```bash
npx -y -p ai-usage-mcp ai-usage stats --today
```

---

## Ask it things

Once connected, ask in plain language:

```text
How many tokens have I used today?
Show my usage for this session.
Which model consumed the most tokens?
How much did Claude Code cost me today?
Show all usage from the last 7 days.
```

## MCP tools

| Tool              | Returns                                                     |
| ----------------- | ----------------------------------------------------------- |
| `usage_summary`   | Totals for a period, split by client, tokens + cost         |
| `session_usage`   | One session: client, model, duration, token breakdown, cost |
| `model_usage`     | Per-model tokens and cost                                   |
| `client_usage`    | Per-client (Claude Code vs OpenCode) tokens and cost        |
| `recent_sessions` | Recent sessions with project, client, tokens, cost          |

## Debug CLI

Same service layer, different frontend — so the two can never disagree.

```bash
ai-usage status      # collectors, data stores, db path, record counts, last sync
ai-usage sync        # run the collectors
ai-usage stats       # totals   (--today, --days N, --since/--until)
ai-usage models      # per-model
ai-usage clients     # per-client
ai-usage sessions    # recent sessions
ai-usage session ID  # one session in detail
ai-usage daily       # per-day breakdown
ai-usage verify      # re-read the sources and diff them against the local database
```

Add `--json` to any command for machine-readable output.

`ai-usage stats --today` returns exactly what the `usage_summary` tool returns; a test in
`tests/mcp/parity.test.ts` asserts they are byte-identical.

---

## How cost is reported

Cost is **never** a single blended number. Every figure carries a basis:

| Basis         | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| `reported`    | The client told us the cost. OpenCode does this. Exact.               |
| `estimated`   | Computed from a versioned pricing table. Claude Code records no cost. |
| `unavailable` | We could not produce an honest number (e.g. no price for that model). |

**The Claude Code figure is an "API-equivalent estimated cost"** — what those tokens would
cost at Anthropic API list prices. If you are on a Claude Pro or Max subscription, your
marginal cost per request is **$0**, and this number is not what you paid. It is useful for
comparing workloads, not for reconciling a bill.

Reported and estimated costs are shown on separate lines and must not be added together.

Cache tokens are priced properly rather than lumped in with input:

- cache **read** bills at 0.1× the input rate
- cache **write** bills at 1.25× (5-minute TTL) or **2×** (1-hour TTL)

The two cache-write TTLs are tracked separately because both occur heavily in practice — on
the machine this was developed against, 18.0M of 27.2M cache-write tokens used the 1-hour
TTL, so averaging the rates would have understated cost substantially.

### Correcting prices yourself

The pricing table is versioned data (`src/pricing/tables/`), not constants buried in a
service. Prices change; to override without waiting for a release, drop a JSON file at:

```text
~/.config/ai-usage-mcp/pricing.json      # or $AI_USAGE_PRICING_FILE
```

It must contain `version`, `models`, and `cacheMultipliers.{read,write5m,write1h}`. A
malformed override raises an error rather than silently falling back — quietly using
different prices than you think are in effect would be worse than failing.

`ai-usage status` always shows which table is in force.

---

## Why token counts here are trustworthy

Both source formats are internal and undocumented, and both contain traps that produce
badly wrong numbers if taken at face value. What this tool does about them:

- **Claude Code writes one line per content block**, repeating the same `usage` object with a
  cumulative `output_tokens`. Summing those lines inflates every figure by ~2.4×. Records are
  deduplicated on `requestId` + `message.id`, taking the maximum of each field.
- **`usage.iterations[]` is already included in the top-level totals** and is never summed.
- **Subagent turns live in separate files** (`<session>/subagents/…`), not behind the
  `isSidechain` flag — which is never set in practice. They are classified by path.
- **`<synthetic>` is not a model** and is excluded.
- **OpenCode's `session` rollup columns can be stale.** They are a cached aggregate; on the
  development machine they had lost 545,977 input tokens across 4 sessions. This tool reads
  the `message` grain instead, which is corroborated byte-for-byte by the independent
  `part` table.
- **Reasoning tokens mean different things per client.** In Claude Code, thinking tokens are
  _inside_ `output_tokens`; in OpenCode, `reasoning` is a _sibling_ of `output`. Totals are
  computed per client accordingly, so reasoning is never double-counted.
- **Cache tokens dwarf everything else** (800M cache-read vs 24K input is a real ratio), so
  token classes are always broken out and never presented as one blended total.

Run `ai-usage verify` to check this yourself. It re-reads both sources with a _second,
independent implementation_ that shares no reduction code with the collectors, and diffs the
result against the database:

```text
== opencode ==
  MATCH    opencode.db message grain (what we collect)
  MATCH    opencode.db part/step-finish grain (independent corroboration)
  INFO     opencode.db session rollup grain (what `opencode stats` headline shows)
           delta:  input -545,977 ...

== claude-code ==
  MATCH    claude JSONL, deduped by stop_reason line (independent rule)
  INFO     claude JSONL, naive sum of every usage line (NOT used — shows the double count)
           delta:  cache-read 990,824,820 ...

RESULT: every client reconciles exactly against at least one independent read of its source.
```

`verify` syncs first and compares only activity before a shared cutoff — both clients append
to their stores while we read them, so without a cutoff the source always looks a few
requests ahead.

### Subagent turns

Included by default, because they are real spend. Every report says which way it went, and
`--no-subagents` / `includeSubagents: false` excludes them. `session_usage` always shows the
main/subagent split separately.

---

## What stays on your machine

**Everything.** There is no network code in this package.

- No telemetry, no analytics, no crash reporting, no phone-home.
- No cloud sync, no accounts, no API keys — the tool never calls an LLM API.
- **No conversation content is read into the database.** The collectors extract token counts,
  model ids, timestamps, session ids and project paths. Prompts, completions, tool inputs and
  file contents are skipped.
- Source data is opened **read-only**. A running OpenCode is never disturbed: the collector
  opens its database with a read-only connection, and falls back to a temporary snapshot copy
  (`.db` + `-wal` + `-shm`) only if that fails.
- Everything is stored in one local SQLite file:

```text
~/.local/share/ai-usage-mcp/usage.db          # override with AI_USAGE_DB
```

Delete that file to erase everything the tool knows.

> Note: the database path deliberately ignores `XDG_DATA_HOME`. A sandboxed launcher (the
> VSCode snap, for example) exports its own `XDG_DATA_HOME`, which is exactly how OpenCode's
> history ended up split across two databases on the development machine. The MCP server and
> the CLI must always agree on one file.

---

## Troubleshooting

### `ai-usage status` says a collector is unavailable

It prints the reason and every path it looked at. Point it at the right place:

| Variable                   | Purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `AI_USAGE_OPENCODE_DB`     | Path to `opencode.db`                                                   |
| `AI_USAGE_CLAUDE_PROJECTS` | Path to Claude Code's `projects/` directory                             |
| `AI_USAGE_DB`              | Where to keep our database                                              |
| `AI_USAGE_PRICING_FILE`    | Pricing override file                                                   |
| `AI_USAGE_FRESHNESS_MS`    | How long a sync stays fresh before a tool call re-syncs (default 30000) |

### Numbers look lower than `opencode stats`

Expected, and `opencode stats` is the one that's off. Its headline block reads OpenCode's
`session` rollup columns, which can be stale, while its own per-model block reads message
grain. The two halves of its output do not agree with each other. This tool matches the
message grain — the number corroborated by two independent tables. Run `ai-usage verify` to
see all three grains side by side.

### `ai-usage status` reports additional stores

You have more than one OpenCode database — usually because a sandboxed launcher exports its
own `XDG_DATA_HOME`. Only the store OpenCode itself resolves is collected by default. Each
extra store may be genuinely separate history or just a stale copy. Records are keyed by
source record id, so merging is safe:

```bash
ai-usage sync --all-stores
```

### Claude Code cost seems enormous

Read it as API-equivalent list price, not as money you spent — see the cost section above.
On a Pro/Max subscription the marginal cost per request is $0.

### A model shows cost as unavailable

That model is not in the pricing table. Add it via a pricing override file. The tool will not
guess a price.

### Totals changed after re-syncing

They should not. Records are keyed deterministically by source identifiers and upserted, so
re-syncing is idempotent — `ai-usage sync --full` re-reads everything and must leave totals
unchanged. A test asserts this. If it happens, please file an issue with `ai-usage verify`
output.

### Sync feels slow

Only the first sync reads everything (~2.5s for 87MB of transcripts plus a 900MB database on
the development machine). After that, unchanged transcripts are skipped by size + mtime and
OpenCode is read incrementally from a saved cursor. `--full` ignores the cursors.

---

## Development

```bash
npm install
npm run check          # typecheck, lint, format check, build, tests -- what CI runs
```

Individually:

```bash
npm run typecheck      # tsc, covering src and tests
npm run lint           # eslint (type-aware)
npm run format         # prettier --write
npm run build          # emit dist/
npm test               # 81 tests: collectors, services, formatter, MCP integration, parity
npm run test:coverage  # with coverage report
```

Architecture — the one rule that matters is that **MCP never knows where data comes from**:

```text
MCP tools ─┐
           ├─> UsageService ─> collectors ─> Claude Code JSONL / OpenCode SQLite
debug CLI ─┘        │
                    └─> local SQLite
```

Business logic lives in `src/services/`. The MCP handlers and the CLI commands are both thin
frontends over `UsageService`, and they render through the same formatter.

See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) for the verified on-disk formats of both
sources, including everything that had to be corrected by inspecting real data, and
[docs/PUBLISHING.md](docs/PUBLISHING.md) for the release process.

## Contributing

Issues and pull requests are welcome. Two expectations specific to this project:

1. **Never fabricate a number.** If a source does not record something, it must surface as
   unavailable, not as zero.
2. **If your change touches a collector, `ai-usage verify` must still report a zero delta**,
   and if it changes how an on-disk format is understood, update
   [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) in the same change. Both source formats are
   internal and unversioned, so that file is the only record of what was actually observed.

`npm run check` runs everything CI runs.

## Links

- [CHANGELOG.md](CHANGELOG.md) — release history
- [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) — verified on-disk formats, and the documented
  assumptions that proved wrong
- [docs/PUBLISHING.md](docs/PUBLISHING.md) — release process
- [SECURITY.md](SECURITY.md) — threat model and how to report a vulnerability

## License

MIT — see [LICENSE](LICENSE).
