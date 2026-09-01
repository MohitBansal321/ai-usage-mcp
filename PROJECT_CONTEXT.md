# ai-usage-mcp — Project Context

> Read this first. It is the single source of truth for **what we are building and why**.
> Written 2026-08-31. Facts marked **[verified]** were checked against a real machine on that
> date; facts marked **[assumed]** must be re-checked before you rely on them.

---

## 1. One-line goal

**A local-first MCP server that lets a coding agent answer: "How many tokens have I used,
from which client / model / session, and what did it cost?"**

The user installs it once into Claude Code and/or OpenCode, then asks in plain language:

```text
How many tokens have I used today?
Show my usage for this session.
Which model consumed the most tokens?
How much did Claude Code cost me today?
Show all usage from the last 7 days.
```

It must return **actual collected usage data — never fabricated estimates.**

## 2. Why this exists

Developers now run several coding agents side by side — Claude Code, OpenCode, Codex,
Cursor, Gemini CLI, Antigravity. Each burns tokens, each has its own cost model, and
**nobody has a single answer to "which one is costing me what, and for which work?"**

The long-term product is cost intelligence across agents ("Claude Code costs 1.8× more than
OpenCode for similar refactoring tasks"). But that product is worthless if the numbers are
wrong. So **V1 is only about collecting and reporting numbers that are provably correct.**

## 3. Phase 1 scope

```text
Install → Connect → Collect → Normalize → Query → Verify
```

Two collectors (OpenCode, Claude Code) → normalized schema → local SQLite → 5 MCP tools

- a small debug CLI. That is the entire milestone.

### Explicitly NOT in Phase 1

```text
web dashboard · login · cloud DB · user accounts · teams · billing
AI recommendations · cost optimization · model routing · provider switching
Codex/Cursor/Gemini/Antigravity collectors · Kubernetes · Redis · Kafka · SaaS backend
```

## 4. Architecture

```text
                    AI Usage MCP
                         │
              ┌──────────┴──────────┐
              │                     │
         MCP Interface         Usage Engine
              │                     │
              └──────────┬──────────┘
                         │
                   Data Collectors
                    /           \
          Claude Collector    OpenCode Collector
```

Data flow:

```text
Claude Code / OpenCode local data
        │
        ▼
   Collector (per client)
        │
        ▼
  Normalized UsageRecord
        │
        ▼
   Local SQLite DB
        │
        ▼
  Usage Service  ──┬──> MCP tools
                   └──> debug CLI
```

### The one architectural rule to enforce

**MCP must never know where the data came from.** MCP asks the usage service for usage.
The usage service owns the collectors. This is what lets Codex/Cursor/Gemini be added later
without touching the MCP layer.

Corollary: **business logic lives in services, not in MCP handlers.** The CLI and the MCP
tools are two thin frontends over the same service.

## 5. Verified ground truth — data sources

> **SUPERSEDED IN PART — read [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) first.**
>
> Phase 1 implementation re-verified every claim in this section against real data on
> 2026-08-31, as rule 7 of AGENTS.md requires. Several were wrong in ways that would have
> produced badly incorrect numbers. Corrections, each with the measurement behind it, live in
> `docs/DATA_SOURCES.md`. Summary of what changed:
>
> - **OpenCode's database is resolved via XDG, not a fixed path.** A sandboxed launcher
>   (VSCode snap) exports its own `XDG_DATA_HOME`, so this machine had two disjoint stores;
>   the documented path held 174 sessions while the live one held 276. Reading only the
>   documented path would have missed 60% of usage.
> - **The `session` rollup columns are not "the money table".** They are a cached aggregate
>   and were stale by 545,977 input tokens across 4 sessions. The `message` and `part` tables
>   agree byte-for-byte and are the truth. Collect at message grain.
> - **`opencode stats` disagrees with itself** — headline block reads the stale rollup, model
>   block reads message grain. There is no single "0% diff" target against it.
> - **`session.model` is JSON**, not a plain string: `{"id","providerID","variant"}`.
> - **Claude Code's transcript layout is not flat** — three path shapes, and a flat glob finds
>   only 47 of 196 files.
> - **`isSidechain` is never set** (0 of 21,574 lines); subagent turns are identified by path.
> - **`session_message` is empty**; per-message detail lives in `message.data`.
> - **Copying the 879MB database per sync is unnecessary** — a direct read-only open takes
>   ~15ms and returns identical numbers.
> - **`reasoning` is a sibling of `output` in OpenCode but a subset of it in Claude Code.**
>   Handling this generically double-counts reasoning tokens.
>
> The rest of this section remains accurate.

### 5.1 OpenCode **[verified 2026-08-31, opencode v1.18.25]**

Installed at `~/.nvm/versions/node/v22.20.0/bin/opencode`.

Relevant CLI commands:

```bash
opencode stats    # token usage + cost statistics
                  #   flags: --days N  --tools N  --models [N]  --project [path]
opencode export [sessionID]   # export session data as JSON
opencode session              # manage/list sessions
opencode db                   # database tools
opencode mcp                  # manage MCP servers (used for install)
```

**Do NOT parse `opencode stats` for collection.** It renders a box-drawing TUI table —
brittle and version-fragile. Use it as the **verification oracle** in tests instead.

**Collect from the SQLite DB directly (read-only):**

```text
~/.local/share/opencode/opencode.db          (+ -wal, -shm)
```

Tables: `__drizzle_migrations, project, message, part, session, todo, session_share,
control_account, account, account_state, event_sequence, event, workspace, session_message,
data_migration, migration, permission, sqlite_sequence, session_input,
session_context_epoch, credential, project_directory`

The `session` table already carries per-session totals — this is the money table:

```text
id, project_id, parent_id, slug, directory, title, version, share_url,
summary_additions, summary_deletions, summary_files, summary_diffs,
revert, permission, time_created, time_updated, time_compacting, time_archived,
workspace_id, path, agent,
model,
cost,
tokens_input,
tokens_output,
tokens_reasoning,
tokens_cache_read,
tokens_cache_write,
metadata
```

Other useful tables:

- `project`: `id, worktree, vcs, name, time_created, …` → maps sessions to a project path.
- `session_message`: `id, session_id, type, time_created, time_updated, data (JSON), seq`
  → **[assumed]** per-message model/token detail lives in `data`; verify before depending on it.
- `part`: `id, message_id, session_id, time_created, time_updated, data (JSON)`.

Open a **read-only copy** (`file:…?mode=ro`, and copy the `-wal`/`-shm` alongside) so a
running OpenCode is never disturbed.

Sample of real local data (for sanity-checking magnitudes):

```text
Sessions 276 · Messages 7,772 · Days 117
Total cost   $0.48
Input        76.1M
Output        2.4M
Cache read  386.0M
Cache write       0
```

Note how **cache read dwarfs everything else** — see §8.

### 5.2 Claude Code **[verified 2026-08-31]**

No CLI usage command is required. Session transcripts are JSONL on disk:

```text
~/.claude/projects/<slugified-project-path>/<sessionId>.jsonl
```

Local scale at time of writing: **195 files, 87 MB**. Plan for streaming, not `JSON.parse`
of whole files.

Top-level keys on an assistant line:

```text
cwd, effort, entrypoint, gitBranch, isSidechain, message, parentUuid,
requestId, sessionId, timestamp, type, userType, uuid, version
```

`message` keys:

```text
content, diagnostics, id, model, role, stop_details, stop_reason,
stop_sequence, type, usage
```

Real `message.usage` payload:

```json
{
  "input_tokens": 2,
  "cache_creation_input_tokens": 15312,
  "cache_read_input_tokens": 26970,
  "output_tokens": 522,
  "output_tokens_details": { "thinking_tokens": 398 },
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "cache_creation": {
    "ephemeral_1h_input_tokens": 15312,
    "ephemeral_5m_input_tokens": 0
  },
  "inference_geo": "not_available",
  "iterations": [
    {
      "input_tokens": 2,
      "output_tokens": 522,
      "cache_read_input_tokens": 26970,
      "cache_creation_input_tokens": 15312,
      "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 15312 },
      "type": "message"
    }
  ],
  "speed": "standard"
}
```

`message.model` is e.g. `claude-opus-5`. `version` is the Claude Code version — record it,
because the format can change between versions.

**Claude Code does not record cost.** See §7.

If a given installation/version exposes no usable usage data, the system must return:

```text
Usage unavailable for this installation/version.
```

…rather than inventing numbers.

## 6. Normalized schema

Both collectors converge on one shape. **Optional fields stay optional** — different clients
expose different things, and forcing a value means fabricating one.

```typescript
interface UsageRecord {
  id: string;
  client: 'claude-code' | 'opencode';
  provider: string;
  model: string;
  sessionId: string;
  projectPath?: string;
  timestamp: string;

  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;

  cost?: number; // exact, when the source reports it
  estimatedCost?: number; // computed from a pricing table
  costBasis: 'reported' | 'estimated' | 'unavailable';
  currency: 'USD';

  source: string; // e.g. 'opencode.db:session', 'claude-jsonl:v2.x'
}
```

Every value must be representable as **known / unknown / not available**.

Collectors are pluggable:

```typescript
interface UsageCollector {
  name: string;
  isAvailable(): Promise<boolean>;
  collect(options: CollectOptions): Promise<UsageRecord[]>;
}
```

## 7. Cost policy — read this before writing any cost code

- **OpenCode reports `cost` directly** → `costBasis: 'reported'`.
- **Claude Code reports no cost** → compute from a pricing table → `costBasis: 'estimated'`.
- Anyone on a **Claude Max/Pro subscription pays $0 marginal cost per request.** So the
  honest label for the Claude number is **"API-equivalent estimated cost"**, not "what you
  paid". Say so in the tool output and the README.
- The pricing table is versioned data, not code constants buried in a service. Cache-read
  and cache-write are priced differently from input — model that properly.
- Never blend reported and estimated cost into one unlabelled number.

The product lives or dies on the answer to _"are these numbers actually correct?"_ — so
never trade honesty for a prettier summary.

## 8. Known pitfalls (each of these will produce wrong numbers if ignored)

1. **Double counting on Claude Code.** `usage.iterations[]` is an array _inside_ a single
   `usage` object, and lines carry `requestId`. Naively summing every assistant line inflates
   totals. Dedupe on `requestId` + `message.id`; decide explicitly whether `iterations` are
   already included in the top-level totals (they appear to be) before summing them.
2. **Sidechain / subagent turns.** Claude Code lines carry `isSidechain`. Decide include or
   exclude, make it a documented flag, and be consistent between the CLI and MCP output.
3. **Cache tokens dominate.** 386M cache-read vs 76M input on real data. A single "total
   tokens" number is misleading — always break out input / output / cache-read / cache-write.
4. **Never parse `opencode stats` TUI output** for collection (§5.1).
5. **Live databases.** OpenCode may be running. Copy the DB + `-wal` + `-shm` and open
   read-only.
6. **Version drift.** Both formats are internal and unversioned in practice. Record the
   source client version on every record so bad data can be traced and re-synced.
7. **Incremental sync.** 87 MB of JSONL and growing — use `sync_state` cursors, do not
   re-scan everything on each call.

**How each was resolved in Phase 1** (measurements in `docs/DATA_SOURCES.md`):

1. Dedupe on `requestId` + `message.id` taking the **max** of each field — `output_tokens` is
   cumulative across the per-content-block lines. Naive summing inflated cache-read 2.24x.
   `iterations[]` confirmed already included in top-level totals; never summed.
2. Sidechain turns: `isSidechain` is unusable (never set). Classified by path instead.
   **Included by default** as real spend, `--no-subagents` excludes them, and every report
   states which way it went.
3. Token classes are always broken out; no blended total is ever displayed.
4. `opencode stats` is not parsed. It is also not a trustworthy oracle — see the §5 banner.
5. Live databases are opened with a direct read-only connection (~15ms), falling back to a
   `.db`+`-wal`+`-shm` snapshot copy only if that fails.
6. `source_version` is recorded on every record (OpenCode session version / Claude Code
   `version`).
7. Cursors implemented: OpenCode resumes from `max(message.time_updated)`; Claude Code skips
   transcripts whose size+mtime are unchanged. A time-filtered sync deliberately does not
   persist a cursor, or a later full sync would skip files and under-report.

## 9. Storage

**SQLite only.** No Postgres, no Redis, no Kafka, no cloud backend.

Reason: this data is sensitive — prompts, project names, code metadata, spending. It must
never leave the user's machine to compute a statistic.

```text
usage_records
  id, client, provider, model, session_id, project_path, timestamp,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, total_tokens,
  cost, estimated_cost, cost_basis, currency,
  source, source_version, created_at

sync_state
  source, last_sync_at, cursor
```

That is enough for Phase 1.

## 10. MCP tools — exactly five

| Tool              | Returns                                                     |
| ----------------- | ----------------------------------------------------------- |
| `usage_summary`   | totals for a period, split by client, tokens + cost         |
| `session_usage`   | one session: client, model, duration, token breakdown, cost |
| `model_usage`     | per-model tokens and cost                                   |
| `client_usage`    | per-client (Claude Code vs OpenCode) tokens and cost        |
| `recent_sessions` | recent sessions with project, client, tokens, cost          |

MCP **resources**, **prompts**, notifications and live usage come later. Do not add them now.

## 11. Debug CLI

Same service layer, different frontend. Makes development and support tractable:

```bash
ai-usage status     # collectors available? db path? record count? last sync per source
ai-usage sync       # run collectors
ai-usage stats      # same numbers the MCP will return  (--today, --days N)
ai-usage sessions   # recent sessions
```

`ai-usage stats --today` must produce exactly what `usage_summary` produces. If they ever
disagree, that is a bug in the layering.

## 12. Install experience (the thing users actually judge)

```bash
npm install -g ai-usage-mcp
```

**Claude Code** **[verified pattern]**:

```bash
claude mcp add --transport stdio ai-usage -- ai-usage-mcp
claude mcp list          # confirm
# then /mcp inside Claude Code to verify the connection
```

**OpenCode**:

```bash
opencode mcp add         # then configure the local server entry
```

OpenCode also supports declaring local MCP servers in its config with a command array.
Pin the README instructions to the OpenCode version you actually tested against.

## 13. Verification strategy

The test that matters:

```text
our MCP output   ⟷   opencode stats
                       expected difference: 0%
```

`opencode stats --days N --models` is the oracle for the OpenCode collector. For Claude Code
there is no oracle, so verify by independently re-aggregating the raw JSONL with a separate
script and diffing against the DB, and document any value the source does not expose.

## 14. Definition of Done — Phase 1

Do not start Phase 2 until every box is true:

- [x] MCP server starts successfully over stdio
- [x] Claude Code connects to it — `claude mcp add ai-usage -- ai-usage-mcp` (command verified)
- [x] OpenCode connects to it — local server entry in `opencode.jsonc` (format verified)
- [x] OpenCode collector works — 6,726 records from the live store
- [x] Claude Code collector works — 5,050 API requests from 195 transcripts
- [x] Records normalized into one schema
- [x] Stored locally in SQLite
- [x] `usage_summary` works
- [x] `session_usage` works
- [x] `model_usage` works
- [x] `client_usage` works
- [x] `recent_sessions` works
- [x] Token counts verified against source data — **exact, zero delta on every token class**,
      for both clients, against independent re-implementations (`ai-usage verify`). Note the
      target changed: `opencode stats` contradicts itself, so the comparison is against the
      source tables directly and against its message-grain model block, which matches exactly.
      Its stale headline block is reported as a labelled, explained delta.
- [x] Cost documented as exact vs estimated everywhere it appears
- [x] Missing data shown as unavailable, never fabricated
- [x] CLI debug commands work
- [x] Unit tests for both collectors — 20 collector tests
- [x] MCP integration tests — 9 server tests + 8 CLI/MCP parity tests (63 total)
- [x] README: Claude Code install
- [x] README: OpenCode install
- [x] README: troubleshooting
- [x] README: what data stays local
- [x] No API key and no conversation content ever leaves the machine — no network code in the
      package; only token counts, model ids, timestamps, session ids and project paths are read

## 15. Suggested project structure

```text
ai-usage-mcp/
├── src/
│   ├── mcp/
│   │   ├── server.ts
│   │   └── tools/
│   │       ├── usage-summary.ts
│   │       ├── session-usage.ts
│   │       ├── model-usage.ts
│   │       ├── client-usage.ts
│   │       └── recent-sessions.ts
│   ├── collectors/
│   │   ├── collector.ts
│   │   ├── opencode/collector.ts
│   │   └── claude-code/collector.ts
│   ├── services/
│   │   ├── usage-service.ts
│   │   ├── sync-service.ts
│   │   ├── cost-service.ts
│   │   └── aggregation-service.ts
│   ├── db/
│   │   ├── database.ts
│   │   ├── migrations/
│   │   └── repositories/
│   ├── models/usage-record.ts
│   ├── pricing/            # versioned pricing tables (data, not constants)
│   ├── cli/commands/
│   └── index.ts
├── tests/
│   ├── collectors/ services/ mcp/ fixtures/
├── package.json  tsconfig.json  README.md  LICENSE
```

TypeScript + Node.js, distributed via npm.

## 16. Roadmap beyond Phase 1

```text
PHASE 1  Claude Code + OpenCode → SQLite → 5 MCP tools → user verifies numbers
PHASE 2  Codex, Cursor, Gemini CLI, Antigravity collectors
         daily/weekly/monthly, per-project, model & cost comparison
PHASE 3  Cost intelligence — most expensive project/model, avg cost per task,
         "Claude Code costs 1.8× more than OpenCode for similar refactoring"
PHASE 4  Team / SaaS
```

Phase 2 begins only when real users confirm Phase 1's numbers match their actual usage.

## 17. Open decisions — resolved in Phase 1

- [x] **Final npm package name** — `ai-usage-mcp`, confirmed available on the registry
      (`ai-usage` is taken; `@nuvo/ai-usage-mcp` also free if a scope is preferred).
- [x] **Include or exclude Claude Code sidechain/subagent turns by default** — **include**.
      They are real spend, and OpenCode's own totals include child sessions, so including them
      keeps the two clients comparable. `--no-subagents` / `includeSubagents: false` excludes
      them, `session_usage` always shows the split, and every report states which way it went.
- [x] **How the OpenCode collector reads data** — directly from `opencode.db`, at **message
      grain**, with a direct read-only connection. Message grain is corroborated byte-for-byte
      by the independent `part` table, whereas the `session` rollup was stale. A native
      OpenCode plugin remains a Phase 2+ option.
- [x] **How far back the first sync goes** — **all history** by default. It costs ~2.5s on 87MB
      of transcripts plus a 900MB database, and truncating history by default would silently
      answer "how many tokens have I used" with a partial number. `--since` / `--days` narrow
      it explicitly.

Newly discovered and decided during implementation:

- [x] **Multiple data stores per client** — collect only the store the client itself resolves,
      but detect and report the others in `ai-usage status`. `--all-stores` merges them; since
      records are keyed by source record id, merging cannot double count.
- [x] **Our own database path ignores `XDG_DATA_HOME`** — respecting it would split our
      database the same way OpenCode's got split. `AI_USAGE_DB` / `AI_USAGE_HOME` override.
- [x] **Pricing overrides** — prices go stale, so a user-supplied
      `~/.config/ai-usage-mcp/pricing.json` can replace the built-in table. A malformed
      override is a hard error rather than a silent fallback.
