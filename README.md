# ai-usage-mcp

<!-- mcp-name: io.github.MohitBansal321/ai-usage-mcp -->

[![npm version](https://img.shields.io/npm/v/ai-usage-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/ai-usage-mcp)
[![CI](https://github.com/MohitBansal321/ai-usage-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/MohitBansal321/ai-usage-mcp/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/ai-usage-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/ai-usage-mcp)
[![node](https://img.shields.io/node/v/ai-usage-mcp?logo=node.js&color=5fa04e)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/ai-usage-mcp?color=blue)](LICENSE)

**Ask your coding agent what it has cost you — and where the money went.** An MCP server that
answers from the data Claude Code, OpenCode and Codex CLI already wrote to your machine. Nothing is
uploaded, and there is no API key or account.

```text
> Where are my tokens going, and what should I change?
> Where did this session lose its prompt cache?
> Which of my projects is getting more expensive, day by day?
> What would last week have cost on Sonnet instead of Opus?
```

Three things it does that reading the transcripts cannot:

- **It keeps your history.** Claude Code deletes transcripts after 30 days
  (`cleanupPeriodDays`). Every turn is copied into a local SQLite database as it is seen, so
  last quarter is still there after the source files are gone —
  [and merges two machines into one total](docs/CLI.md#retention-and-merging-two-machines).
- **It finds where the cache broke.** Cache tokens are where the money is — 94.7% of all tokens
  on the development machine. `cache_health` finds the turns where a session lost its cached
  prefix and paid to re-write the whole context, names the likely cause (a model switch, idling
  past the 5-minute TTL, an edited `CLAUDE.md`) and prices the premium.
- **It proves its numbers.** Claude Code writes one JSONL line _per content block_, each
  repeating the same `usage` object, so summing lines inflates every figure 2–3×.
  `ai-usage verify` re-reads both sources with a _second, independent implementation_ that
  shares no reduction code with the collectors, and diffs the result against its own database.

```text
$ ai-usage verify

== claude-code ==
  MATCH    claude JSONL, deduped by stop_reason line (independent rule)
  INFO     claude JSONL, naive sum of every usage line (NOT used -- shows the double count)
           delta:  cache-read 990,824,820 ...

RESULT: every client reconciles exactly against at least one independent read of its source.
```

Also: **your Pro/Max plan limits** — the 5-hour and weekly percentages Claude Code reports,
kept by [a status line](docs/STATUS_LINE.md#plan-limits-and-the-status-line) and projected to the time you would
hit 100% — plus `counterfactual_cost` (these exact tokens at another model's rates), budgets
with run rate and forecast, project × day breakdowns, and CSV/JSON export. It supports
**Claude Code** and **OpenCode**, and exposes twelve MCP tools plus resources, prompts and a
debug CLI that prints the same text the tools return.

**It never fabricates a number.** If a source does not record something, it is reported as
unavailable — not as zero.

<details>
<summary><b>What the output looks like</b> (sample data)</summary>

```text
$ ai-usage stats --today
Usage summary -- today (local time)
Subagent/sidechain turns: INCLUDED (3 main + 1 subagent turns).

Records: 4   Sessions: 2

Tokens (all clients):
  Input:        1,871
  Output:       16,909 (16.9K)
  Cache read:   2,452,000 (2.45M)
  Cache write:  37,300 (37.3K)
  Reasoning:    2,600
  Total:        2,508,080 (2.51M)

  Cost (reported by client, exact): $0.41  [1 records]
  Cost (estimated, API-equivalent):  $1.50  [3 records]

By client:
  claude-code  --  3 records, 1 sessions
    Cache read:   2,238,000 (2.24M)
    Total:        2,280,001 (2.28M)
    Cost (estimated, API-equivalent):  $1.50  [3 records]

  opencode  --  1 records, 1 sessions
    Cache read:   214,000 (214.0K)
    Total:        228,079 (228.1K)
    Cost (reported by client, exact): $0.41  [1 records]
```

The two cost lines are never added together, and never will be — see
[How cost is reported](#how-cost-is-reported).

</details>

### Try it in one command

There's nothing to configure and no account to create. It reads what Claude Code and OpenCode
have already written to this machine:

```bash
npx -y -p ai-usage-mcp ai-usage report
```

The first run copies your history into a local database, which takes a few seconds. The report
gives a verdict for the last 7 days, says where the tokens went, and lists what to change. To
ask your agent questions like the ones above, [install it as an MCP server](#install).

### ai-usage or ccusage?

[ccusage](https://github.com/ryoppippi/ccusage) is the established tool, and a good one: it
covers far more agents, and its Claude Code token counts agree with this package's exactly —
every token class, every day, checked against ccusage 20.0.26 on the development machine for
21–25 September 2026. For a quick report across many agents, use it.

Use this one when you want what a report over the current transcripts cannot give: history that
outlives Claude Code's 30-day cleanup, cache breaks found and priced, counterfactual pricing,
budgets, cross-dimension breakdowns, reported and estimated cost kept apart, and token totals
proved against a second read by `verify`.

---

## Install

Requires **Node.js 22.13+**. No compiler, build tools or particular npm version needed:
storage uses Node's built-in `node:sqlite`, which is unflagged from 22.13.0 onward. There is
no mandatory native dependency.

<sub>`better-sqlite3` remains an <em>optional</em> fallback for hosts whose Node predates
that. It is never required — if it cannot be built, npm skips it and the server still runs.</sub>

### Claude Code

**As a plugin — recommended.** Run these two inside Claude Code:

```text
/plugin marketplace add MohitBansal321/ai-usage-mcp
/plugin install ai-usage@ai-usage-mcp
```

That wires up the MCP server _and_ installs the three prompts as real slash commands —
`/ai-usage:daily-review`, `/ai-usage:why-was-today-expensive`, `/ai-usage:project-cost` — which
most clients never surface from MCP prompts alone. If the install summary says
`Run /reload-plugins to activate.`, run that. The equivalent from your shell is
`claude plugin marketplace add MohitBansal321/ai-usage-mcp`.

<sub>The plugin declares `npx -y ai-usage-mcp` as its server, so the server itself still comes
from npm and re-resolves on each cold start. Updating the plugin and updating the server are
therefore independent — see <a href="#updating">Updating</a>.</sub>

**Or as a plain MCP server**, if you would rather not add a marketplace. Nothing to install
first — `npx` fetches it on demand:

```bash
claude mcp add ai-usage -s user -- npx -y ai-usage-mcp
```

On **native Windows** (not WSL), wrap it in `cmd /c` instead:

```bash
claude mcp add ai-usage -s user -- cmd /c npx -y ai-usage-mcp
```

<sub>Why: on Windows `npx` is `npx.cmd`, and the MCP TypeScript SDK spawns servers with
<code>shell: false</code>. Node cannot execute a <code>.cmd</code> file that way — its docs say
such files "can be invoked using <code>child_process.spawn()</code> with the shell option set …
or by spawning <code>cmd.exe</code> and passing the <code>.bat</code> or <code>.cmd</code> file
as an argument". <code>cmd /c</code> is that second form. This applies to every SDK-based
client below, not just Claude Code.</sub>

`-s user` makes it available in every project. Drop it to add the server to the current
project only. Then run `/mcp` inside Claude Code to confirm it connected.

<details>
<summary><b>No <code>claude</code> command? (VS Code / JetBrains extension users)</b></summary>

The extension reads the same configuration as the CLI, so you can add the server by editing a
file — no CLI needed. Pick whichever scope you want:

**For one project** — create `.mcp.json` in the project root:

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

Claude Code asks you to approve a project-scoped server the first time it loads it. This file
is safe to commit if you want your team to get it too.

**For all your projects** — add the same `mcpServers` block at the top level of
`~/.claude.json` (`%USERPROFILE%\.claude.json` on Windows):

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

That file already exists and holds other settings — add the `mcpServers` key alongside them
rather than replacing the file.

Then reload the window (**Developer: Reload Window** in VS Code) and run `/mcp`. Configuration
is read when a session starts, so an already-open session will not pick it up.

</details>

### OpenCode

```bash
opencode mcp add ai-usage       # choose a local server, command: ai-usage-mcp
```

Or add it to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "ai-usage": {
      "type": "local",
      "command": ["npx", "-y", "ai-usage-mcp"],
    },
  },
}
```

Confirm with `opencode mcp list`.

### Codex CLI

```bash
codex mcp add ai-usage -- npx -y ai-usage-mcp
```

Codex usage is read from `~/.codex/sessions` (or `$CODEX_HOME`). Codex records no cost, so its
cost is an API-equivalent estimate, or unavailable for a model the pricing table lacks. Support
is new and verified against two sessions so far; `ai-usage verify` checks it on yours.

### Other MCP clients

Cursor, Google Antigravity, Windsurf and Claude Desktop take the same `npx -y ai-usage-mcp`
block; only the config file differs. The client you ask from does not have to be one you
measure: ask from Cursor, and you still get your Claude Code numbers. Paths and details are in
[docs/INSTALL.md](docs/INSTALL.md#other-mcp-clients).

### The debug CLI

The MCP server needs no install. To also get the `ai-usage` CLI on your PATH:

```bash
npm install -g ai-usage-mcp
ai-usage status
```

Or run it without installing:

```bash
npx -y -p ai-usage-mcp ai-usage stats --today
```

> **Windows:** no longer needs a particular npm. The `node-gyp` failure that used to break
> this install came from the native `better-sqlite3` dependency, which is now optional and
> unused on Node 22.13+. If npm still reports a build failure for it, that message is a
> skipped optional dependency, not a failed install — `ai-usage status` will show
> `SQLite driver: node:sqlite` and everything works.

### Updating

`npx -y ai-usage-mcp` re-resolves the version on every cold start, so restarting your client
picks up a release. A global install is pinned: `npm install -g ai-usage-mcp@latest`.
`ai-usage status` and the MCP server both tell you when you are behind.
[docs/INSTALL.md](docs/INSTALL.md#updating) says what each kind of install needs, and describes
the one request the check makes.

### Compatibility

Both source formats are internal and unversioned, so a client update can change them. This is
what has been checked, and how:

| Client      | Last verified                                                     | Earlier verifications |
| ----------- | ----------------------------------------------------------------- | --------------------- |
| Claude Code | **2.1.308**, 2026-10-23                                           | 2.1.2xx, 2.1.251      |
| OpenCode    | **2.0.32**, 2026-10-23                                            | 1.18.25, 2.0.30       |
| Codex CLI   | **0.162.0-alpha.17.2** and **0.114.0**, 2026-10-23 (two sessions) |                       |
| Node.js     | 22.13+ and 24, in CI                                              |                       |
| OS          | Linux, macOS and Windows, in CI                                   |                       |

"Verified" means `ai-usage verify` matched every token class exactly against an independent
re-read of the client's own data (715 MB of Claude Code transcripts, a 251 MB `opencode.db`, and Codex's
session rollouts). Run
it when no session is mid-reply: a turn written while `verify` runs shows up as a small delta.
If a client update breaks collection, `ai-usage status` warns that the client keeps writing
but no new turns arrive.

## Ask it things

Once connected, ask in plain language:

```text
How many tokens have I used today?
Show my usage for this session.
Which model consumed the most tokens?
How much did Claude Code cost me today?
Show all usage from the last 7 days.
Which repository is my spend going to?
Break my last 7 days down day by day.
```

## MCP tools

| Tool                  | Returns                                                                    |
| --------------------- | -------------------------------------------------------------------------- |
| `usage_report`        | Start here: verdict, where usage went, heaviest sessions, what to change   |
| `usage_summary`       | Totals for a period, split by client, tokens + cost                        |
| `session_usage`       | One session: client, model, duration, token breakdown, cost                |
| `model_usage`         | Per-model tokens and cost                                                  |
| `client_usage`        | Per-client (Claude Code vs OpenCode) tokens and cost                       |
| `recent_sessions`     | Recent sessions with project, client, tokens, cost                         |
| `project_usage`       | Per-project tokens and cost, by the directory a turn ran in                |
| `daily_usage`         | Per-day tokens and cost, newest day first                                  |
| `usage_breakdown`     | Two or more dimensions at once -- project × day, model × day, client × day |
| `counterfactual_cost` | These tokens at another model's list rates, beside what they actually cost |
| `cache_health`        | One session's cache breaks: when the cached prefix was lost, why, and cost |
| `plan_usage`          | Pro/Max 5-hour and weekly limit usage, when each resets, and the pace      |

### Start here: `usage_report`

On a Pro, Max or Team plan the price is fixed, so "what did it cost" is the wrong question. The
useful one is how much of your limit went to real work. `usage_report` (or `ai-usage report`)
answers it for the last 7 days by default:

```text
Verdict: High waste -- a large share of this usage re-read or rebuilt old context.

Where it went (share of usage, weighted by API-equivalent price):
   37.1%  re-reading context above 100k tokens (1,021 turns; largest context 735.2K)
   10.2%  rebuilding a lost cache (12 times, 12 after an idle break)

What to change:
  1. Compact earlier. ... 5 session(s) grew past 200k tokens of context ...
  2. Don't resume a session that has gone cold. ...

Heaviest sessions:
   47.7%  Admission transfer tariff services and roles linking  [development, claude-code]
```

It measures two kinds of waste from token counts alone. **Context carry** exists because every
message re-sends the whole conversation, so a turn at 300k context re-reads 300k tokens to take
one step; the part above 100k is what compacting earlier would not have carried. **Cache
rebuilds** are turns where the cached prefix was lost and the whole context was re-written
(the same detection as `cache_health`). Sessions are named by the title the client gave them
and the git branch they ran on, or `no branch` when Claude Code recorded none (usually a
session started outside a git repo). Neither kind of waste is claimed as wholly avoidable, and the
shares are a guide to where usage went, not exact limit consumption: Anthropic does not publish
how subscription limits weight each token type.

### Plan limits, the status line and the context warning

Claude Code writes your Pro/Max 5-hour and weekly limits to no file, but it passes them to a
status line. With `ai-usage statusline` as yours, the limits are recorded, with the reset times
and when the current pace would reach 100%. Today's cost and the session's cache hit rate and
breaks are shown beside them, and `plan_usage` answers the same from inside a conversation.
`ai-usage hook` warns before a prompt when the session's context has grown expensive to
re-send. `ai-usage status` says whether each one is switched on. Setup and details are in
[docs/STATUS_LINE.md](docs/STATUS_LINE.md).

## Resources and prompts

Three resources can be pulled into a conversation with an `@` mention, instead of asking for a
tool call:

| Resource                 | Contents                                                       |
| ------------------------ | -------------------------------------------------------------- |
| `usage://today`          | Today's totals, split by client                                |
| `usage://session/latest` | The most recent session in detail                              |
| `usage://status`         | Which build is answering, its sources, and whether it is stale |

Three prompts appear as slash commands in a client that surfaces them:

| Prompt                    | Asks                                                |
| ------------------------- | --------------------------------------------------- |
| `daily-review`            | What did I spend today, and on what                 |
| `why-was-today-expensive` | Which model, session and project drove today's cost |
| `project-cost`            | What one project has cost over a period             |

Each prompt names the tools to call and carries the reported-vs-estimated cost rule with it,
so a paraphrased summary cannot quietly merge the two cost bases.

Most clients do **not** surface MCP prompts, which is why the [Claude Code
plugin](#claude-code) ships the same three as real slash commands
(`/ai-usage:daily-review` and friends). They are the same feature through two surfaces, and a
test asserts the two lists cannot drift apart.

## Debug CLI

Same service layer, different frontend — so the two can never disagree.

```bash
ai-usage report      # start here: verdict, where usage went, what to change (last 7 days)
ai-usage status      # collectors, data stores, db path, record counts, last sync, hooks on/off
ai-usage sync        # run the collectors
ai-usage stats       # totals   (--today, --days N, --since/--until)
ai-usage models      # per-model
ai-usage clients     # per-client
ai-usage projects    # per-project  (--limit N)
ai-usage sessions    # recent sessions
ai-usage session ID  # one session in detail
ai-usage daily       # per-day breakdown
ai-usage counterfactual  # these tokens on another model (--target-models a,b)
ai-usage verify      # re-read the sources and diff them against the local database
ai-usage hook        # Claude Code UserPromptSubmit hook: warns when context is large
```

Add `--json` to any command for machine-readable output.

More in [docs/CLI.md](docs/CLI.md):

- narrowing to several projects, models or clients
- CSV and JSON export
- keeping history after Claude Code's 30-day cleanup, and merging two machines
- cache economics
- budgets with run rate and forecast
- a single value and an exit code for scripts and alerts
- project × day breakdowns, trends, period comparisons, and paging

## How cost is reported

Cost is **never** a single blended number. Every figure carries a basis:

| Basis         | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| `reported`    | The client told us the cost. OpenCode does this. Exact.               |
| `estimated`   | Computed from a versioned pricing table. Claude Code records no cost. |
| `unavailable` | We could not produce an honest number (e.g. no price for that model). |

Alongside those, every report counts **records whose model has no pricing-table entry**, so
a model that is genuinely free is distinguishable from one nobody has priced. A client that
reports its own cost files a perfectly ordinary `$0` for an unpriced model, which otherwise
reads exactly like free:

```text
opencode  --  6,841 records, 280 sessions
  Cost (reported by client, exact): $0.48  [6,841 records]
  No estimate attempted for 6,813 record(s) -- no price in table builtin-2026-10-23 for
  that model: big-pickle, gpt-5.5, z-ai/glm-5.2 and 16 more. Any $0 above covers only what
  was reported, not those records.
```

In `--json` and in MCP `structuredContent` these are `cost.unpricedRecords` and
`cost.unpricedModels`. Both are **absent rather than `0`** when the caller supplied no list
of priced models: "not asked" is not the same as "none".

**The Claude Code figure is an "API-equivalent estimated cost"** — what those tokens would
cost at Anthropic API list prices. If you are on a Claude Pro or Max subscription, your
marginal cost per request is **$0**, and this number is not what you paid. It is useful for
comparing workloads, not for reconciling a bill.

Reported and estimated costs are shown on separate lines and must not be added together.

Cache tokens are priced properly rather than lumped in with input:

- cache **read** bills at 0.1× the input rate on most models, 0.05× on Opus 5.5 / Sonnet 5.5
  and 0.025× on Fable 5.1 / Mythos 5.1
- cache **write** bills at 1.25× (5-minute TTL) or **2×** (1-hour TTL)

The two cache-write TTLs are tracked separately because both occur heavily in practice — on
the machine this was developed against, 18.0M of 27.2M cache-write tokens used the 1-hour
TTL, so averaging the rates would have understated cost substantially.

Which models ship with prices, how a model released after this package is priced
automatically, and how to add or correct a price yourself are covered in
[docs/PRICING.md](docs/PRICING.md).

## Why token counts here are trustworthy

Both source formats are internal and undocumented, and both contain traps that produce
badly wrong numbers if taken at face value. What this tool does about them:

- **Claude Code writes one line per content block**, repeating the same `usage` object with a
  cumulative `output_tokens`. Summing those lines inflates every figure by 2.15×-3.05×
  depending on the token class ([measured](docs/DATA_SOURCES.md)). Records are
  deduplicated on `requestId` + `message.id`, taking the maximum of each field.
- **`usage.iterations[]` is already included in the top-level totals** and is never summed.
- **Subagent turns live in separate files** (`<session>/subagents/…`), not behind the
  `isSidechain` flag — which is never set in practice. They are classified by path.
- **`<synthetic>` is not a model** and is excluded.
- **OpenCode's `session` rollup columns can be stale.** They are a cached aggregate; on the
  development machine they had lost 545,977 input tokens across 4 sessions. This tool reads
  the `message` grain instead, which is corroborated byte-for-byte by the independent
  `part` table. OpenCode 2.x writes that grain to `session_message` instead (and no longer
  writes `part` rows), so newer turns have no second table to corroborate them.
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

It compares only sessions the source still holds. Both clients delete their own history --
Claude Code removes transcripts after `cleanupPeriodDays`, 30 days by default -- while the
local database keeps what it collected, so after a month the database legitimately holds more
than the source. Those sessions are listed on a separate `Retained, not compared` line instead
of being counted as a mismatch. Any source record missing from the database still fails the
check, because the source side is never narrowed.

### Subagent turns

Included by default, because they are real spend. Every report says which way it went, and
`--no-subagents` / `includeSubagents: false` excludes them. `session_usage` always shows the
main/subagent split separately.

---

## What stays on your machine

**Everything.** Your usage data never leaves the machine.

- No telemetry, no analytics, no crash reporting, no phone-home.
- No cloud sync, no accounts, no API keys — the tool never calls an LLM API.
- **Two outbound requests exist**, both plain GETs of public files that send no usage data and
  no identifiers, both at most once a day, and both disabled by `AI_USAGE_NO_UPDATE_CHECK=1`:
  - the **update check** asks the npm registry for the latest published version number
    (`ai-usage status`, and the MCP server in the background after its handshake);
  - the **price refresh** downloads LiteLLM's public price list, so models released after the
    built-in table are priced (`ai-usage sync`, and the MCP server in the background after its
    handshake). `AI_USAGE_NO_PRICING_REFRESH=1` turns off just this one.
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

[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) covers:

- a collector reported as unavailable
- numbers lower than `opencode stats`
- additional stores
- `/mcp` showing the server as failed
- `node-gyp` errors
- models with no estimate
- totals that changed after a re-sync
- a client that keeps writing while no new turns arrive

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
npm test               # collectors, services, formatter, MCP integration, parity, packaging
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

`npm run check` runs everything CI runs. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the
layout and the pull request checklist.

## Links

- [CHANGELOG.md](CHANGELOG.md) — release history
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, layout and how to send a change
- [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) — verified on-disk formats, and the documented
  assumptions that proved wrong
- [docs/PUBLISHING.md](docs/PUBLISHING.md) — release process
- [SECURITY.md](SECURITY.md) — threat model and how to report a vulnerability

## License

MIT — see [LICENSE](LICENSE).
