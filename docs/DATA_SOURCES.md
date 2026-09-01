# Verified data sources

Ground truth for both Phase 1 collectors, established by inspecting real data on a live
machine on **2026-08-31** (OpenCode 1.18.25, Claude Code 2.1.209–2.1.251).

This file supersedes `PROJECT_CONTEXT.md` §5 where they disagree. Every correction below was
found by reading the actual bytes, and each one would have produced wrong numbers if the
original assumption had been trusted. Sections marked **[CORRECTION]** differ from the
original spec.

---

## 1. OpenCode

### 1.1 Where the database actually is — **[CORRECTION]**

The spec said `~/.local/share/opencode/opencode.db`. That is only the fallback.

OpenCode resolves its data directory through **XDG**, so the real path is:

```text
$XDG_DATA_HOME/opencode/opencode.db        # when XDG_DATA_HOME is set
~/.local/share/opencode/opencode.db        # otherwise
```

This matters far more than it sounds. A sandboxed launcher exports its own `XDG_DATA_HOME` —
the VSCode snap sets it to `~/snap/code/<revision>/.local/share` — so the same user ends up
with **two disjoint OpenCode histories**. On the development machine:

| Store                                                                     | Sessions | Messages | Input tokens | Overlap                  |
| ------------------------------------------------------------------------- | -------- | -------- | ------------ | ------------------------ |
| `~/snap/code/259/.local/share/opencode/opencode.db` (live, XDG_DATA_HOME) | 276      | 7,772    | 76,629,027   | —                        |
| `~/.local/share/opencode/opencode.db` (stale, XDG default)                | 174      | 5,149    | 31,199,511   | **0 shared session ids** |

Reading only the documented path would have missed 60% of the usage and silently reported it
as the total. `opencode stats` reports the snap store, confirming which one OpenCode uses.

Two further traps found while enumerating stores:

- `~/snap/<app>/current` is a **symlink** to the active revision, so the same database appears
  twice unless paths are canonicalised with `realpath`.
- An older snap revision (`snap/code/255`) held a **strict subset** — all 7,671 of its
  messages also existed in the live store, 0 unique. Extra stores must therefore be described
  as "possibly separate history, possibly a stale copy", never asserted to be separate.

Because records are keyed by source message id, merging stores (`--all-stores`) cannot double
count.

### 1.2 The grain to read — **[CORRECTION]**

The spec called the `session` table's rollup columns "the money table". They are a **cached
aggregate and can be stale.**

All three available grains, measured on the live store:

| Grain                       | Input      | Output    | Reasoning | Cache read  | Cost      |
| --------------------------- | ---------- | --------- | --------- | ----------- | --------- |
| `message` (assistant rows)  | 76,629,027 | 2,472,262 | 1,146,012 | 389,450,640 | $0.481085 |
| `part` (`step-finish` rows) | 76,629,027 | 2,472,262 | 1,146,012 | 389,450,640 | $0.481085 |
| `session` rollup columns    | 76,083,050 | 2,446,766 | 1,114,320 | 386,045,840 | $0.481085 |

`message` and `part` are two independently maintained tables and they agree **byte-for-byte**.
The `session` rollup is short by 545,977 input tokens across exactly 4 sessions — three of
which recorded `tokens_input = 0` despite having real messages, and one which recorded 103,724
against an actual 474,003.

**Therefore: collect at message grain.** It is corroborated, it does not lose the stale
tokens, and it is the only grain that attributes tokens to the right model when a session
switches models partway through.

### 1.3 `opencode stats` contradicts itself

Worth knowing before treating it as an oracle: its two blocks use different grains.

- The **OVERVIEW / COST & TOKENS** block reads the `session` rollup (76.1M input) — the stale one.
- The **MODEL USAGE** block reads message grain: its per-model message counts sum to exactly
  6,726, which is precisely the number of assistant messages, and its per-model token sums
  match message grain within display rounding.

So there is no single "0% diff vs `opencode stats`" target — the command does not agree with
itself. This tool matches its per-model block exactly (e.g. `deepseek-v4-flash-free`: 3,686
records, 16.3M input, 268.7M cache read) and documents the rollup delta via `ai-usage verify`.

One more display detail: `Days 117` in the OVERVIEW is the **span** between first and last
session, not the number of active days (which was 41).

### 1.4 Schema details that matter

`session.model` is **JSON, not a plain string** — **[CORRECTION]**:

```json
{ "id": "deepseek-v4-flash-free", "providerID": "opencode", "variant": "max" }
```

Some sessions have `model = NULL`; those turns are reported as `(unknown)`, never guessed.

Per-message detail lives in `message.data` (the spec marked this **[assumed]**; it is now
verified, and `session_message` is a **different, empty table** — 0 rows):

```json
{
  "role": "assistant",
  "cost": 0,
  "modelID": "…",
  "providerID": "…",
  "agent": "build",
  "variant": "max",
  "path": { "cwd": "…", "root": "…" },
  "time": { "created": 1781765382824, "completed": 1781765386318 },
  "tokens": {
    "total": 63055,
    "input": 640,
    "output": 79,
    "reasoning": 0,
    "cache": { "write": 0, "read": 62336 }
  }
}
```

- Timestamps are **epoch milliseconds**.
- `tokens.total === input + output + reasoning + cache.read`, so **`reasoning` is a sibling of
  `output`, not a subset of it**. This is the opposite of Claude Code and must be handled per
  client or reasoning tokens get double-counted.
- Cost is reported per message; a `0` from a free model is a real zero (`costBasis: reported`).
- Subagent turns are **child sessions**: `session.parent_id IS NOT NULL`. On the live store,
  129 of 174 sessions in one store were children.

### 1.5 Opening a live database — **[CORRECTION]**

The spec required copying the `.db` plus `-wal`/`-shm` before reading. That works, but the
live database is **879 MB**, making a copy-per-sync unacceptable.

A **direct read-only connection opens in ~15ms** and returns numbers identical to the copy
approach (verified against all four combinations of copy/no-copy and readonly/read-write). A
read-only connection cannot mutate the file, so a running OpenCode is not disturbed.

The collector therefore opens read-only directly and falls back to the snapshot copy
(`.db` + `-wal` + `-shm`) only if that fails.

---

## 2. Claude Code

### 2.1 Layout is not flat — **[CORRECTION]**

The spec described `~/.claude/projects/<slug>/<sessionId>.jsonl`. That is one of three shapes,
and it accounts for only a quarter of the files. Actual layout, all 196 files on the
development machine:

```text
<root>/<slug>/<sessionId>.jsonl                                   47 files  -> main turns
<root>/<slug>/<sessionId>/subagents/agent-<id>.jsonl              74 files  -> subagent turns
<root>/<slug>/<sessionId>/subagents/workflows/<wf>/agent-*.jsonl  74 files  -> subagent turns
<root>/<slug>/<sessionId>/subagents/workflows/<wf>/journal.jsonl   1 file   -> NOT usage, skip
```

A flat glob finds 47 of 196 files. Discovery must recurse.

Root resolution: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`.

### 2.2 Subagent detection — **[CORRECTION]**

`isSidechain` was set on **0 of 21,574 lines**. It cannot be used to identify subagent turns.

Subagent turns are identified by **path**: anything under a `subagents/` directory. Subagent
transcripts carry the **parent's** `sessionId`, so session-level attribution works naturally
and a session's main/subagent split is recoverable.

### 2.3 The dedupe rule — the single most important thing here

Claude Code writes **one line per content block** (thinking, tool_use, text). Every line of
one request repeats the same `usage` object, except `output_tokens`, which is **cumulative**
and reaches its final value on the line carrying a non-null `stop_reason`:

```text
req_011Ce… | msg_011Ce…  thinking  input=2  output=5    cache_read=0  cache_write=19748  stop=null
req_011Ce… | msg_011Ce…  tool_use  input=2  output=350  cache_read=0  cache_write=19748  stop=tool_use
```

Measured impact of getting this wrong — naive summing versus correct dedupe, all-time:

|             | Naive sum of every usage line | Deduped (correct) | Inflation |
| ----------- | ----------------------------- | ----------------- | --------- |
| Input       | 73,345                        | 24,381            | 3.0×      |
| Output      | 12,996,611                    | 6,033,231         | 2.15×     |
| Cache read  | 1,791,664,252                 | 800,839,432       | 2.24×     |
| Cache write | 82,790,630                    | 27,164,362        | 3.05×     |

**Rule: group by `requestId` + `message.id`, then take the MAX of each field.**

Why max rather than "the last line" or "the `stop_reason` line":

- `input`, `cache_read`, `cache_creation` are identical across a group, so max is a no-op.
- `output_tokens` is cumulative, so max picks the final value.
- Max agreed with the `stop_reason` line in **4,886 of 4,889** groups. The 3 exceptions were
  **replayed lines carrying all-zero usage**, where "the last line" would have thrown the
  request's tokens away and max is correct.
- 2,770 duplicate groups had byte-identical usage across lines; 1,077 grew monotonically.
- 14 of 11,860 usage lines carried **no `requestId`**; keying those on the line's own `uuid`
  keeps them distinct instead of merging them into one bogus request.

### 2.4 `usage.iterations[]` is already included

Confirmed: the sum of `iterations[].input_tokens` equalled the top-level `input_tokens` in
**8,257 of 8,262** groups; the 5 exceptions were empty arrays. **Never sum iterations.**

### 2.5 `<synthetic>` is not a model

`message.model` was `<synthetic>` on 144 lines (error/placeholder turns). Excluded from both
records and pricing.

Real models seen: `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`.

### 2.6 Cache-write TTLs must be split

`usage.cache_creation` breaks cache writes into two TTLs, and both are used heavily:

```json
"cache_creation": { "ephemeral_5m_input_tokens": 9129398, "ephemeral_1h_input_tokens": 18034964 }
```

The split accounted for the declared `cache_creation_input_tokens` in 11,868 of 11,871 rows
(0 unsplit tokens overall). Since 5-minute writes bill at 1.25× input and 1-hour writes at
**2×**, and two thirds of the volume is 1-hour, pricing them at a single blended rate
understates cost materially. Any unsplit remainder is priced at the 5-minute rate and flagged.

### 2.7 Reasoning tokens are inside output

`usage.output_tokens_details.thinking_tokens` is a **detail of** `output_tokens`. It is
reported separately but **not added** to the total and **not priced separately** — doing
either would double-charge. (OpenCode is the opposite; see §1.4.)

### 2.8 Other fields

- `usage.speed` (`standard` / `fast`) — fast mode bills at premium rates on Opus 5 / 4.8, so
  it is carried through to pricing.
- `version` is the Claude Code version; recorded per record so bad data can be traced.
- Claude Code records **no cost**, so every Claude figure is `costBasis: estimated`.
- Cache dominance is extreme and real: 800M cache-read against 24K input.

### 2.9 Project path resolution — **[CORRECTION]**

Neither obvious source is reliable on its own:

- The `cwd` field is exact per line but **drifts within a session** (it follows the agent, and
  can end up pointing at a scratch directory).
- The directory slug (`-home-me-Videos-ai-usage`) is stable but **ambiguous**: it replaces both
  path separators and literal dashes with `-`, so it could mean `/home/me/Videos/ai/usage` or
  `/home/me/Videos/ai-usage`.

Resolution: **walk the filesystem**, taking the longest run of tokens that exists as a
directory at each level. This correctly recovers `ai-usage` and `js-refresh`. Falls back to
`cwd`, then to a naive un-slug, and reports `(unknown)` if all fail.

---

## 3. Re-verifying

`ai-usage verify` re-derives everything from source with a **second implementation that shares
no reduction code with the collectors** — for Claude Code it deliberately uses a different
rule (prefer the `stop_reason` line) so that agreement means two readings of the same bytes
agree, not that one function agrees with itself.

It syncs first, then compares only activity before a shared cutoff: both clients append to
their stores continuously, so without a cutoff the source is always a few requests ahead and
the diff could never be zero.

Current result on the development machine: **exact match, zero delta on every token class,
for both clients.**
