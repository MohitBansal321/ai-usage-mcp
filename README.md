# ai-usage-mcp

<!-- mcp-name: io.github.MohitBansal321/ai-usage-mcp -->

[![npm version](https://img.shields.io/npm/v/ai-usage-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/ai-usage-mcp)
[![CI](https://github.com/MohitBansal321/ai-usage-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/MohitBansal321/ai-usage-mcp/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/ai-usage-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/ai-usage-mcp)
[![node](https://img.shields.io/node/v/ai-usage-mcp?logo=node.js&color=5fa04e)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/ai-usage-mcp?color=blue)](LICENSE)

**Whatever is telling you what your coding agent costs is probably inflating it.** Claude Code
writes one JSONL line _per content block_, and every line repeats the same `usage` object with a
cumulative `output_tokens`. Summing those lines — the obvious thing to do, and what naive tools
do — inflated every figure by **2.15× to 3.05×** on the development machine: 1.79B cache-read
tokens claimed where the truth was 800M.

Cache tokens are also where the money actually is. Cache-read outweighed input by roughly
**33,000×** (800,839,432 vs 24,381), so any tool that blends token classes into a single "total"
has told you nothing you can act on.

This one reads the same files, deduplicates on `requestId` + `message.id`, and then **proves
it**: `ai-usage verify` re-reads both sources with a _second, independent implementation_ that
shares no reduction code with the collectors, and diffs the result against its own database.

```text
$ ai-usage verify

== claude-code ==
  MATCH    claude JSONL, deduped by stop_reason line (independent rule)
  INFO     claude JSONL, naive sum of every usage line (NOT used -- shows the double count)
           delta:  cache-read 990,824,820 ...

RESULT: every client reconciles exactly against at least one independent read of its source.
```

So the question it answers, from real data on your machine:

> How many tokens have I used, from which client, model and session — and what did it cost?

Phase 1 supports two coding agents: **Claude Code** and **OpenCode**. It reads the data those
clients already wrote to disk, normalises it into one schema, stores it in a local SQLite
database, and exposes seven MCP tools -- plus resources, prompts and a debug CLI.

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

### Other MCP clients

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
[Claude Code](#claude-code) for why.

<sub>Provenance, 2026-09-08: Cursor, Windsurf, Codex and Claude Desktop paths are from each
vendor's own documentation. The Antigravity and Copilot CLI paths and key names were read off
installed copies of those apps on Linux, since neither publishes the path — including Copilot
CLI's `servers` key, which differs from every other client here.</sub>

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

Verified against Claude Code **2.1.251** and OpenCode **1.18.25**.

### Updating

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
```

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
models -- see [New models are priced automatically](#new-models-are-priced-automatically)): a
version lookup against the npm registry, at most once a day, cached in
`<config dir>/update-check.json`, skipped when `CI` is set, and silently abandoned after 1.5s
if you are offline. It sends no usage data and no identifier -- just a GET for a version
string. Set `AI_USAGE_NO_UPDATE_CHECK=1` to turn it off everywhere, CLI and server alike; that
switch turns off the price download too. In the server it runs _after_ the handshake, never
during it, so it cannot slow down a client starting up.

---

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
| `usage_summary`       | Totals for a period, split by client, tokens + cost                        |
| `session_usage`       | One session: client, model, duration, token breakdown, cost                |
| `model_usage`         | Per-model tokens and cost                                                  |
| `client_usage`        | Per-client (Claude Code vs OpenCode) tokens and cost                       |
| `recent_sessions`     | Recent sessions with project, client, tokens, cost                         |
| `project_usage`       | Per-project tokens and cost, by the directory a turn ran in                |
| `daily_usage`         | Per-day tokens and cost, newest day first                                  |
| `counterfactual_cost` | These tokens at another model's list rates, beside what they actually cost |

Every period-based tool takes `projectPaths` (a list) to narrow the report to one or more projects. The pre-0.8.0 singular `projectPath` is still accepted.

An argument a tool does not declare is **rejected by name**, not ignored. Before 0.9.0,
`{ "period": "today" }` was silently stripped and answered with all-time totals; every tool now
advertises `additionalProperties: false`.

`counterfactual_cost` answers "would a cheaper model have cost less for this?" — it re-prices
the exact token counts that were recorded, grouped by client, model **and** speed so the
fast-mode premium and the two clients' different reasoning-token conventions are both handled.
It is a **counterfactual, not a saving**: the same task on a different model generally takes a
different number of turns carrying a different context on each, and nothing on disk can say
what that would have been. The caveat ships with the numbers.

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
ai-usage status      # collectors, data stores, db path, record counts, last sync
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
```

Add `--json` to any command for machine-readable output.

### Narrowing to several projects, models or clients

`--client`, `--model` and `--project` are **repeatable and comma-separated**, and each matches
_any_ of the values given:

```bash
ai-usage models   --model claude-opus-5,claude-sonnet-5
ai-usage daily    --project /work/api --project /work/web    # same as a comma list
ai-usage stats    --client opencode
```

Different scopes combine with **AND**: `--model claude-opus-5 --project /work/api` is Opus
turns _in that project_.

A value that matches no record anywhere in the database is called out rather than answered
with an empty report, because a typo and a quiet week otherwise look identical:

```text
WARNING: no record anywhere in this database has model "claude-opus". An empty result below
is that, not a quiet period. Run `ai-usage models` to see the ids actually present.
```

Note that `--model` (which turns to include) and `--target-models` (which rates to price them
at, on `counterfactual` only) are different things, and usable together:
`ai-usage counterfactual --model claude-opus-5 --target-models claude-sonnet-5` asks what the
Opus turns would have cost on Sonnet.

### Getting the data out

```bash
ai-usage export --days 30 > usage.csv        # one row per stored turn
ai-usage export --format jsonl               # JSON Lines
ai-usage export --project /work/api --model claude-opus-5
```

Every scope and period filter applies. The column set is a **stable, documented contract** —
deliberately not `SELECT *`, so the table can grow a column without breaking every downstream
spreadsheet, and no column can silently change meaning:

```text
id, timestamp, client, provider, model, session_id, project_path, turn_kind, speed,
input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
cache_write_1h_tokens, reasoning_tokens, total_tokens, cost_basis, cost, estimated_cost, currency
```

`cost` and `estimated_cost` are **separate columns** carrying `cost_basis` alongside, for the
same reason every report keeps them apart. A value the source did not report is an **empty
cell**, never `0` and never `null` — a figure nobody produced must not arrive in a spreadsheet
as a number that gets summed with the real ones.

Rows stream to stdout rather than being built in memory, so exporting a large database costs
one row at a time. A `--limit`ed export says on **stderr** how many rows it left behind, which
keeps stdout pipeable.

(Previously the only route to the records was `sqlite3 usage.db '.mode csv' 'SELECT * FROM
usage_records'`, which bypasses the product and depends on a schema the docs explicitly call
internal and unversioned.)

### Retention and merging two machines

The database grows forever unless you tell it not to. Pruning is a **command, not a policy** —
a retention setting that silently deleted last quarter on some future run is a worse tool than
one that never deletes, because the data is gone and nothing asked. Put it in a cron if you
want a policy:

```bash
ai-usage prune --before 2026-01-01          # DRY RUN: says what would go, deletes nothing
ai-usage prune --before 2026-01-01 --yes    # actually delete
ai-usage vacuum                             # reclaim the disk
```

`--before` is **exclusive**, like every other bound here: `--before 2026-01-01` removes 2025
and keeps New Year's Day. Scope filters apply, so a prune cannot be broader than the report
that justified it. `vacuum` measures the database's **whole footprint** — the `.db` plus its
`-wal` and `-shm` companions — because this package always opens in WAL mode, where freshly
written data lives in the `-wal` until a checkpoint folds it back. Measuring only the `.db`
would report reclaiming nothing while most of the bytes sat next door.

**Two machines, one total:**

```bash
# on the laptop
ai-usage export --format jsonl > laptop.jsonl

# on the desktop
ai-usage import laptop.jsonl
```

Merging is **idempotent**. Record ids are derived deterministically from source identifiers, so
the same turn — imported twice, or collected on both machines — upserts to one row rather than
double counting. The output says how many rows were updated in place rather than added, so you
can see that happening.

A row that does not fully parse is **rejected with its line number** and the import exits
non-zero. Importing a half-valid row would write a turn with invented zeroes, and a merged
database that quietly under-counts is worse than a failed import.

### Cache economics

Cache tokens are where the money is — on the development machine cache-read is **94.7% of all
tokens**, and for Claude Code it outweighs plain input by roughly 33,000×. Raw counts alone
cannot say whether that cache is paying for itself, so `stats` and `clients` derive the figures
that can:

```text
claude-code  --  8,486 records, 86 sessions
  Cache hit rate:    97.12%
  Reads per write:   33.7  (1 write : 33.7 reads)
                     Break-even is 0.28 reads per 5-minute write and 1.11 per 1-hour write,
                     so this cache is paying for itself.
```

Break-even is derived from the pricing table's own multipliers, not hardcoded: a 5-minute write
costs `1.25×` input, so `0.25×` extra, and each read saves `0.9×` — hence `0.25 / 0.9 = 0.28`
reads per write. Change the multipliers (or use a provider whose cache discount differs) and
the threshold moves with them.

A hit rate is **absent, not `0%`**, when there was no cache traffic at all — those are different
statements. A genuine 0% (writes that were never read) _is_ reported, because it is the worst
case for the write premium and exactly what you would want to see.

`counterfactual` adds what the same tokens would have cost with **no caching at all**:

```text
Those same tokens with NO prompt caching at all:
  claude-opus-5       $5252.61  vs     $861.31 actually estimated  ->  cache saved $4391.29 (83.6%)
  claude-sonnet-5      $117.37  vs      $22.20 actually estimated  ->  cache saved $95.17 (81.1%)
```

This is the one scenario in the tool permitted to state a **saving**, and the reason is worth
knowing. A model counterfactual cannot: the same task on a different model takes a different
number of turns with a different context on each. Here the token counts genuinely are
invariant — cache-read tokens _are_ the context re-sent each turn, so without a cache they
would have been sent as ordinary input one for one, and the write premium would simply not
have been paid. The remaining assumption (that a cacheless run would have made the same
requests) prints with the numbers.

A negative saving is reported as such rather than clamped: burning the write premium on
sessions too short to reuse it is precisely what this is for.

### Budget, run rate and forecast

```bash
ai-usage budget --amount 500 --basis estimated            # this calendar month
ai-usage budget --amount 20  --basis reported --period week
```

```text
Budget -- September 2026 (local), estimated cost basis

  Budget:             $500.00
  Spent so far:       $505.86   101.2% of budget
  OVER BY:              $5.86
  Elapsed:       16.5 of 30 days   55.0% of period

Run rate and projection to period end:
  Per calendar day       $30.65/day  ->      $919.65   OVER by $419.65
                     (over 16.5 elapsed calendar days)
  Per active day         $42.15/day  ->     $1264.65   OVER by $764.65
                     (over 12 day(s) with any recorded activity)
```

**Two projections, never one.** Extrapolating month-end spend by hand meant picking a
denominator — calendar days or active days — and on a machine used on weekdays only those
differ by more than 2×. Showing one would be making that modelling choice silently on your
behalf; the gap between them _is_ the size of the assumption.

**`--basis` is required, with no default.** Reported and estimated cost are never summed, so a
budget with no stated basis is a budget against nothing in particular:

- `reported` — what a client actually charged. **Claude Code reports no cost at all**, so its
  usage is not counted on this basis.
- `estimated` — API-equivalent list price. On a Claude Pro/Max subscription your marginal cost
  per request is **$0**, so this is a shadow price for comparing workloads, not a bill. The
  figure to watch on a subscription is usage against your plan limits, which this tool cannot
  see. The output says so every time.

**Calendar periods only** (`month`, `week`). A projection needs a period end to aim at, which a
rolling window has not got.

**Exit 1 on a fact, not on a forecast.** `budget` exits 1 when spend _already_ exceeds the
target. It does not fail on a projection — that would page somebody about arithmetic rather
than about spend. To threshold a projection deliberately, compose with `--field`:

```bash
ai-usage budget --amount 500 --basis estimated \
  --field projections.perActiveDay.projected --fail-over 500
```

### Using it in a script or an alert

```bash
ai-usage stats --today --field overall.cost.estimated
# 18.067632500000002

ai-usage stats --today --field overall.cost.estimated --fail-over 25 || notify "over budget"
```

`--field` prints **one value and nothing else** — no header, no label, no JSON — so a shell can
read it without `jq`. `--fail-over` turns that same value into an **exit code**: `1` when it is
strictly greater than the threshold, `0` otherwise. stdout still carries the value, so a script
can branch _and_ capture it in one run.

| Exit | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | Fine — including a value exactly at the threshold                               |
| `1`  | Threshold exceeded                                                              |
| `2`  | Bad usage: unknown field, `--fail-over` with no `--field`, any other flag error |

Two deliberate refusals:

- **`--fail-over` requires `--field`.** There is no default, because reported and estimated
  cost are separate figures that are never summed — "fail if cost exceeds $25" has no single
  answer, and a default would silently ignore every record priced the other way.
- **An unknown field is exit 2, never exit 0.** A threshold check against a silently-missing
  field would pass forever, which is the worst failure an alert can have: it looks like
  everything is fine. The error names the fields that _do_ exist at that level.

### Crossing two dimensions

`projects` gives a total with no trend; `daily --project X` gives one series. Answering
"which of my projects is getting more expensive" therefore meant enumerating projects, issuing
one call per path, and joining the results — an N+1 that is not feasible as a single tool call
at all. `breakdown` crosses the axes in one query:

```bash
ai-usage breakdown --by project,day --days 30
ai-usage breakdown --by model,day --days 7 --sort estimated-cost
ai-usage breakdown --by client,model,hour-of-day
```

```text
project                                day         turns  total tokens  reported  estimated
-------------------------------------  ----------  -----  ------------  --------  ---------
/home/you/centralized_backend          2026-09-16    230    20,040,546        --     $22.23
/home/you/centralized_backend          2026-09-15    161    19,803,069        --     $18.58
/home/you/Videos/ai-usage              2026-09-17     82    24,592,585        --     $18.07
```

Axes: `client`, `model`, `provider`, `project`, `session`, `day`, `hour`, `hour-of-day` — up to
three, each at most once. Time axes bucket in local time, identically to `daily`.

Two things it deliberately does not do. Combinations with **no activity are absent** rather
than returned as zero rows: a project × day grid is mostly empty and filling it would bury the
rows that matter. And a `--` in a cost column means **no record in that row is priced on that
basis** — it is not `$0`, which would be a different claim.

`--sort`, `--limit` and `--offset` work here as on any other list.

### Reading a trend

`daily` shows **every** bucket in the window, including the ones with no activity:

```text
2026-09-17      52 turns  total 14,187,806 (14.19M)  (estimated $11.27)
2026-09-16     333 turns  total 33,849,492 (33.85M)  (estimated $33.56)
2026-09-15     161 turns  total 19,803,069 (19.80M)  (estimated $18.58)
2026-09-14       0 turns  total 0   --
2026-09-13       0 turns  total 0   --
2026-09-12       0 turns  total 0   --
2026-09-11     123 turns  total 12,157,650 (12.16M)  (estimated $10.89)
```

Rows marked `--` had no recorded activity. They used to be omitted, which made a trend
_actively_ misleading rather than merely incomplete: the gaps were invisible, so the 11th
rendered immediately below the 15th and any eye reading down the column saw a continuous
series that did not exist. A zero row is not a fabricated number — it says what the absence of
a row already meant. In JSON each carries `zeroFilled: true`, so a consumer can tell a
constructed zero from an observed one.

`--grain` changes the bucket:

```bash
ai-usage daily --days 7  --grain hour          # a finer timeline
ai-usage daily --days 30 --grain hour-of-day   # every day on one 24-hour clock
```

`hour-of-day` is the one that answers _when_ you burn tokens, as opposed to _how much_:

```text
10:00     185 turns  total 43,016,467 (43.02M)   (estimated $42.61)
11:00     526 turns  total 113,820,907 (113.82M) (estimated $99.95)
12:00   1,413 turns  total 280,913,509 (280.91M) (estimated $213.99)
...
19:00       0 turns  total 0   --
```

All buckets are local time, matching the period filter, and `localtime` reads the OS timezone
database so they stay correct across DST.

### Comparing two periods

`stats --compare previous` reports the equal-length window immediately before, and the delta:

```bash
ai-usage stats --days 7 --compare previous
ai-usage stats --today  --compare previous     # vs yesterday
```

```text
Compared with the 7 days before that
  (2026-09-03T18:30:00.000Z -> 2026-09-10T18:30:00.000Z)

  Records:                      -847   -55.9%
  Total tokens:         -201,112,497   -71.5%
  Cost (estimated):         -$160.06   -68.3%
  Cost (reported):             $0.00   n/a, previous was zero
```

Three rules it keeps:

- **The two cost bases are deltaed separately and never summed**, for the same reason they are
  reported separately.
- **There is no percentage change from zero.** `$0 → $5` is a new thing happening, not a rise
  of 100%, so the percentage is reported as `n/a` rather than invented.
- **The previous window is aligned to the same local midnights the period uses.** `--days 7`
  compares against the seven whole days before, not "the 156 hours before" — which is what
  subtracting an open window's elapsed length gives, and which changes every time you run it.

`--compare` needs a period of fixed length: `--days`, `--today`, or `--since` **and**
`--until` together. An open-ended period — all time, or `--since` or `--until` on its own — has
no equally long window before it, so the comparison is refused (exit 2) rather than silently
left out of an otherwise ordinary report.

### Ordering and paging a list

`sessions`, `models`, `projects` and `clients` accept `--sort`, `--limit` and `--offset`:

```bash
ai-usage sessions --sort estimated-cost --limit 5     # the costliest, not the latest
ai-usage projects --sort estimated-cost
ai-usage sessions --limit 100 --offset 100            # page two
```

| `--sort`         | Orders by                                           |
| ---------------- | --------------------------------------------------- |
| `tokens`         | Total tokens (default everywhere except `sessions`) |
| `estimated-cost` | Estimated cost                                      |
| `reported-cost`  | Reported cost                                       |
| `records`        | Turn count                                          |
| `sessions`       | Distinct sessions                                   |
| `recent`         | Most recent activity (default for `sessions`)       |

**There is deliberately no plain `--sort cost`.** Reported and estimated cost are separate
figures that are never summed, so ordering by one sorts every row priced on the _other_ basis
as though it were `$0`. The flag refuses the ambiguous form and names the two to pick from,
and whichever you pick, the output says how many rows it could not speak for:

```text
Showing 5 of 366 sessions (offset 0), sorted by estimated-cost.
More available: re-run with --offset 5 for the next page.
NOTE: 280 of those sessions carry no estimated cost at all, so they sort as $0. They are not
cheap -- they are priced on the other basis, or not priced at all.
```

That footer is why `--limit` is now safe to pass: it says what you did _not_ see. Before, the
most expensive session was visible only if it also happened to be recent, and `--limit` made
it less likely to be.

In `--json` and MCP `structuredContent` this is a `page` object carrying `total`, `offset`,
`hasMore`, `nextOffset`, `sort` and `rowsWithoutSortValue` — enough to walk a list to the end
and know when you are done.

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

Alongside those, every report counts **records whose model has no pricing-table entry**, so
a model that is genuinely free is distinguishable from one nobody has priced. A client that
reports its own cost files a perfectly ordinary `$0` for an unpriced model, which otherwise
reads exactly like free:

```text
opencode  --  6,841 records, 280 sessions
  Cost (reported by client, exact): $0.48  [6,841 records]
  No estimate attempted for 6,813 record(s) -- no price in table builtin-2026-09-26 for
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

- cache **read** bills at 0.1× the input rate on most models, 0.05× on Opus 5.5 and 0.025× on
  Fable 5.1 / Mythos 5.1
- cache **write** bills at 1.25× (5-minute TTL) or **2×** (1-hour TTL)

The two cache-write TTLs are tracked separately because both occur heavily in practice — on
the machine this was developed against, 18.0M of 27.2M cache-write tokens used the 1-hour
TTL, so averaging the rates would have understated cost substantially.

### Which models ship with prices

Pricing is versioned data (`src/pricing/tables/`), one file per provider, each keeping its
own capture date:

| Table                  | Models                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `anthropic-2026-09-26` | Fable 5.1 / 5, Mythos 5.1 / 5, Opus 5.5 / 5 / 4.8 / 4.7 / 4.6, Sonnet 5 / 4.6, Haiku 4.5 |
| `openai-2026-09-16`    | gpt-6-astra, gpt-5.6-sol / terra / luna / cyber                                          |

They are composed into one table, reported by `ai-usage status` as `builtin-<date>` with
every provider's provenance behind it. Two tables may not price the same model id — that
raises an error at build time rather than silently applying one vendor's rates to another's
tokens.

A Claude model released after that capture date is normally priced within a day anyway --
see the next section. Anything that neither covers has no estimate, and the reports say so
explicitly rather than showing `$0`. Add it yourself with an override.

### New models are priced automatically

A pricing table captured on one date cannot price a model released on the next, so every
Claude Code turn on a new model used to report its cost as unavailable until a release caught
up. Now the MCP server downloads [LiteLLM's community price
list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) in
the background, at most once a day, and uses it for the Claude models the built-in table does
not have yet:

- **It only fills gaps.** A model the built-in table prices keeps the built-in price; the
  community list never changes a number this package ships.
- **It takes a model only if every rate is there** -- input, output, cache read, both
  cache-write TTLs. A missing rate is not borrowed from a default, because newer models are
  exactly where the defaults go wrong (Opus 5.5 reads cache at 0.05×, not 0.1×). A model
  with a long-context price tier, which the table cannot express, is left unpriced.
- **It is labelled.** Estimates it contributes to cite a table version like
  `builtin-2026-09-26+litellm-2026-10-02`, and `ai-usage status` lists the models it priced:

  ```text
  Pricing table:  builtin-2026-09-26+litellm-2026-10-02  (Anthropic first-party ...; plus 1 model(s) ...)
    Community:     1 model(s) the built-in tables lack, from LiteLLM's price list fetched 2026-10-02: claude-opus-6
  ```

- **Earlier turns are priced too.** Records stored as unavailable before a price existed are
  priced as soon as one does -- from the community list, a release, or your own override --
  on the next sync, with no `sync --full` needed. Only `unavailable` records change; a cost a
  client reported itself is never touched.

It is one plain GET of a public ~3 MB file, carrying no usage data and no identifier. The
converted prices are cached in `<config dir>/pricing-community.json`; a failed download keeps
the previous copy. The CLI's `ai-usage sync` refreshes it as well. Turn it off with
`AI_USAGE_NO_PRICING_REFRESH=1` (or `AI_USAGE_NO_UPDATE_CHECK=1`, which turns off both network
requests); prices are then exactly the built-in tables plus your override.
`AI_USAGE_PRICING_URL` points it at a mirror.

The OpenAI numbers are the **Standard tier, short context** rates. OpenAI also publishes
long-context, Batch, Flex and Fast-mode rates, and nothing in a stored record says which
applied — so a long-context turn is _understated_ rather than guessed at. Providers whose
published pricing this table cannot express exactly (DeepSeek, for instance, bills different
rates at peak and off-peak hours) are deliberately not shipped; supply them yourself, with
whichever rate is true for you.

### Adding or correcting prices yourself

Drop a JSON file at:

```text
~/.config/ai-usage-mcp/pricing.json      # or $AI_USAGE_PRICING_FILE
```

It is **overlaid onto the built-in table**, keyed by model id — so adding one model keeps
every built-in price. (Before 0.8.0 it replaced the table wholesale, which meant the only
way to add a missing provider was to lose every price you already had.)

```jsonc
{
  // Required. Names YOUR table; this is the string reports will cite.
  "version": "my-prices-2026-09-16",

  // Optional. Shown by `ai-usage status`, with the built-in provenance appended.
  "provenance": "DeepSeek off-peak list pricing, captured 2026-09-16",

  // Optional. The default cache rates for models that do not carry their own.
  // Omit to inherit the built-in defaults (read 0.1, write5m 1.25, write1h 2.0).
  "cacheMultipliers": { "read": 0.1, "write5m": 1.25, "write1h": 2.0 },

  // Required. Keyed by the model id EXACTLY as your client records it --
  // `ai-usage models` lists the ids actually present in your database.
  "models": {
    "deepseek-v4-pro": {
      "input": 0.66, // USD per 1,000,000 input tokens
      "output": 1.98, // USD per 1,000,000 output tokens

      // Optional: premium rates, applied when the source recorded `speed: "fast"`.
      // Only Claude Code records a speed at all.
      "fast": { "input": 1.32, "output": 3.96 },

      // Optional: cache rates for THIS model, when the provider's differ from the
      // table default. DeepSeek's cache-hit rate is 0.02x its input rate, not 0.1x.
      "cache": { "read": 0.0333, "write5m": 1.0, "write1h": 1.0 },
    },
  },
}
```

**Units.** `input` and `output` are USD **per 1,000,000 tokens** — the same unit every
provider's pricing page publishes, so you can copy the number straight across. The three
`cache*` values are **multipliers of that model's input rate**, not prices: `read: 0.1`
means a cache read costs a tenth of an input token. If your provider publishes an absolute
cached-input price, divide it by the input price to get the multiplier.

**What is required.** `version` and `models`; within each model, `input` and `output`.
Everything else is optional. `currency` and `unit` are ignored if present — USD per million
tokens is the only supported combination, and accepting a value that does nothing would be
worse than ignoring it.

**Replacing rather than overlaying.** Set `"replace": true` to discard the built-in table
entirely. That form additionally _requires_ `cacheMultipliers.{read,write5m,write1h}`,
because there is no built-in default left to inherit.

An override entry replaces that model's price **wholesale**, not field by field: if the
built-in entry has `fast` rates and yours does not, the model has no fast rates. A
half-inherited price is a figure nobody could reason about.

A malformed override **raises an error naming the offending field** rather than silently
falling back — quietly using different prices than you think are in effect would be worse
than failing:

```text
Pricing override at /home/you/.config/ai-usage-mcp/pricing.json is invalid:
models["deepseek-v4-pro"].output must be a number >= 0 (USD per 1,000,000 tokens).
```

For the same reason, an `AI_USAGE_PRICING_FILE` that points at a file which does not exist is
an error, not a fallback to built-in prices — otherwise a typo in the path would look exactly
like the override working. Only the default `~/.config/ai-usage-mcp/pricing.json` may be
absent, because not having one is the normal case.

`ai-usage status` always shows which table is in force, and whether it is built-in, an
overlay, or a full replacement.

---

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

### `ai-usage status` says a collector is unavailable

It prints the reason and every path it looked at. Point it at the right place:

| Variable                      | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `AI_USAGE_OPENCODE_DB`        | Path to `opencode.db`                                                   |
| `AI_USAGE_CLAUDE_PROJECTS`    | Path to Claude Code's `projects/` directory                             |
| `AI_USAGE_DB`                 | Where to keep our database                                              |
| `AI_USAGE_HOME`               | Relocates both the database and the config dir in one go                |
| `AI_USAGE_PRICING_FILE`       | Pricing override file                                                   |
| `AI_USAGE_FRESHNESS_MS`       | How long a sync stays fresh before a tool call re-syncs (default 30000) |
| `AI_USAGE_NO_UPDATE_CHECK`    | Set to `1` to turn off both network requests (update check and prices)  |
| `AI_USAGE_NO_PRICING_REFRESH` | Set to `1` to stop downloading prices for models the tables lack        |
| `AI_USAGE_PRICING_URL`        | Where to download the community price list from (a mirror)              |
| `AI_USAGE_SQLITE_DRIVER`      | Force `node:sqlite` or `better-sqlite3`; unset picks the best available |

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

### `claude: command not found`

You do not need the CLI. Claude Code's extensions read the same configuration files, so you can
register the server by creating `.mcp.json` in your project root, or by adding an `mcpServers`
block to `~/.claude.json` — see the collapsed section under [Install](#claude-code). If you do
want the CLI, `npm install -g @anthropic-ai/claude-code` provides it.

### `/mcp` shows ai-usage as failed

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

### `node-gyp rebuild` errors during install

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

### A model shows cost as unavailable, or "no estimate attempted"

That model is not in the pricing table. A new Claude model is normally picked up within a day
from the [community price list](#new-models-are-priced-automatically) -- the `Community:` line
of `ai-usage status` says whether it is on, when the list was last downloaded, and what it
priced. If it is off, or the list does not have the model yet, add it via a [pricing override
file](#adding-or-correcting-prices-yourself). Either way, records already stored are priced
on the next sync. The tool will not guess a price.

`ai-usage models --json` lists the model ids exactly as your clients recorded them, which are
the keys your override file needs.

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
