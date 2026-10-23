# Verified data sources

Ground truth for both Phase 1 collectors, established by inspecting real data on a live
machine on **2026-08-31** (OpenCode 1.18.25, Claude Code 2.1.209–2.1.251). OpenCode **2.x**
changed where turns are stored; §1.6 records that, verified on 2.0.30 on **2026-10-16**.

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

**Therefore: collect at message grain** (on OpenCode 2.x that grain lives in
`session_message`, §1.6). It is corroborated, it does not lose the stale
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
verified. On OpenCode 1.x `session_message` is a **different, empty table** — 0 rows; from
OpenCode 2.x it is where turns are written instead, see §1.6):

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
- `session.title` is always set (288 of 288 sessions, verified 2026-09-28), but a session
  OpenCode has not titled yet carries the placeholder `New session - <ISO timestamp>` (21 of
  288). That is not a title and is not stored. Subagent child sessions have real titles, such
  as `Find SEOHead usage across pages (@explore subagent)`. Titles change without their
  messages changing, so they are read from the whole (small) `session` table on every sync
  rather than through the message cursor.
- OpenCode records **no git branch** anywhere (not in `session`, `message.data` or
  `session.metadata`), so branch is unavailable for OpenCode, never guessed.

### 1.5 Opening a live database — **[CORRECTION]**

The spec required copying the `.db` plus `-wal`/`-shm` before reading. That works, but the
live database is **879 MB**, making a copy-per-sync unacceptable.

A **direct read-only connection opens in ~15ms** and returns numbers identical to the copy
approach (verified against all four combinations of copy/no-copy and readonly/read-write). A
read-only connection cannot mutate the file, so a running OpenCode is not disturbed.

The collector therefore opens read-only directly and falls back to the snapshot copy
(`.db` + `-wal` + `-shm`) only if that fails.

### 1.6 OpenCode 2.x moved turns to `session_message` — **[CORRECTION, verified 2026-10-16]**

Verified against OpenCode **2.0.30**. From 2.x, new turns are no longer written to `message`
(or `part`), and new sessions no longer to `session`. The old tables stay in the database,
**frozen at the moment of the upgrade**, so a collector that only reads them reports a clean
sync, a plausible total and a newest record that never advances. This is exactly how a user's
usage silently stopped on the day they upgraded (issue #105).

| Legacy (≤ 1.x)                     | 2.x                                             |
| ---------------------------------- | ----------------------------------------------- |
| `message` (+ `part`)               | `session_message` (`part` is no longer written) |
| `session`                          | `session_v2` (same columns we use, plus more)   |
| `message.data.role`                | `session_message.type` (`assistant`, `user`, …) |
| `data.modelID` / `data.providerID` | `data.model.{id, providerID}`                   |

`session_message.type` is not only `assistant`: the live store also holds `user`, `system`,
`compaction`, `idle`, `model-switched` and `synthetic` rows. Only `assistant` rows carry usage.

An assistant row's `data`:

```json
{
  "time": { "created": 1792141540889, "streamed": 1792141551882, "completed": 1792141551894 },
  "agent": "build",
  "model": { "id": "…", "providerID": "openrouter", "variant": "high" },
  "content": [ { "type": "reasoning", … }, { "type": "text", … } ],
  "finish": "stop",
  "cost": 0,
  "tokens": { "input": 709, "output": 89, "reasoning": 40, "cache": { "read": 148480, "write": 0 } }
}
```

What was verified on a database that straddles the switch (5,906 turns present in both tables):

- **Same id, same numbers.** `session_message.id` equals `message.id`, and all 5,906 overlapping
  turns matched on input, output, reasoning, cache read, cost, model and `time.created`. Our
  record id (`opencode:msg:<id>`) therefore dedupes across the two tables with no extra logic.
- **Same token semantics.** `reasoning` is still a sibling of `output`.
- **No `part` rows for new turns.** `part` stops at the same moment as `message`, so the
  part-grain corroboration in `verify` only covers the older history. Turns that exist only in
  `session_message` enter that grain from the same payload; the message grain is still read by
  separate code.
- **`tokens` can be absent** on an assistant row (5 of 6,337 here). That is no usage, not zero.
- **No `path.root` in the payload**, so the project comes from the session's `directory`
  (then the project's `worktree`) rather than from the turn.
- Some sessions exist only in `session_v2` (6 of 203 here), so turns must not be inner-joined
  to the legacy `session` table or they are dropped.

The collector therefore reads whichever of `message` / `session_message` and `session` /
`session_v2` are present, keeps one resume cursor per table (`message.time_updated` and
`session_message.time_updated`), takes session facts from `session_v2` before `session`, and
prefers the `message` reading when a turn is in both so it keeps the project it was first
attributed to. A turn that straddles the switch is never counted twice.

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

### 2.10 Session titles and git branch

Verified 2026-09-28 against 85 transcripts (Claude Code 2.1.2xx):

- **Titles** are separate lines, not fields on a message:
  `{"type":"ai-title","aiTitle":"<one-line title>","sessionId":"…"}`. Claude Code rewrites
  the title as the session goes on -- between 0 and 125 `ai-title` lines per transcript on the
  development machine -- so **the last one wins**. 5 of 85 transcripts had none; those sessions
  are shown by id. The title is Claude Code's own summary of the session, so it is stored
  locally for display only and left out of `export`.
- **`gitBranch`** is a top-level field on ordinary transcript lines, including subagent
  transcripts (1,516 of 2,089 lines in the largest transcript; the rest are metadata lines). It
  can change mid-session, so it is stored per turn, as recorded.
- **`HEAD` does not mean a detached checkout** (corrected 2026-10-23; this doc used to say it
  did). Claude Code writes `HEAD` whenever it cannot name a branch, and it reads the branch of
  the directory the session was **started** in, not the line's `cwd`. On the development
  machine, all 98 sessions started in a directory that is not a git repo carry only `HEAD`,
  including lines whose `cwd` had moved into a subdirectory that is a repo on `main`. A repo
  created mid-way shows the switch: in one project every line is `HEAD` until the repo's
  initial commit (2026-10-14 11:07Z) and `main` after it. A genuine detached checkout also
  writes `HEAD`, and the stored value cannot tell the cases apart, so it is displayed as
  `no branch`. It was 82,309 of about 110,000 branch-bearing lines on that machine.
- Transcripts deleted by `cleanupPeriodDays` cannot be re-read, so turns collected before this
  was stored keep no branch: on the development machine 6,338 of 10,948 Claude Code turns have
  one.

### 2.11 Plan-limit usage: the status-line payload — **[NOT YET VERIFIED AGAINST REAL BYTES]**

Unlike every other section here, this one is taken from Claude Code's documentation
(<https://code.claude.com/docs/en/statusline>, read 2026-10-12), not from captured data: the
development machine had no status line configured. Re-verify it against a real payload the
first time one is available, and update this section.

No file Claude Code keeps on disk records how much of a Pro/Max plan's limits is used. A
configured `statusLine` command receives a JSON object on **stdin** each time it runs (on each
new assistant message, after `/compact`, on permission- or vim-mode changes, every
`refreshInterval` seconds if set, and when a reported `resets_at` passes), debounced at 300ms.
A run still in flight when the next one triggers is cancelled. The fields read
(`src/collectors/claude-code/statusline.ts`):

- `rate_limits.five_hour` and `rate_limits.seven_day`, each `{ used_percentage, resets_at }`.
  `used_percentage` is **0–100**; `resets_at` is **Unix epoch seconds**. Documented as present
  only for claude.ai Pro and Max subscribers (or behind a gateway with spend limits), and only
  after the first API response — so it is absent for an API-key user and at the start of a
  session, and absent means **unavailable**, never 0%.
- `rate_limits.spend_limit` (gateway spend limits) also exists and is **not read**.
- `session_id` (the same id the transcripts carry) and `version` (Claude Code's).

Every field is treated as optional, a value outside its documented range is dropped rather than
stored, and one malformed window does not discard the other. Each reading is stored in
`plan_limit_readings` only when it differs from the last one for its window; a repeat moves
that row's `last_seen_at` instead. The payload carries no timestamp, so `observed_at` is when
ai-usage received it.

The window start is taken as `resets_at` minus 5 hours or 7 days. The documentation calls both
"rolling" windows and does not say how the reset instant moves, so readings within 5 minutes of
the same reset are treated as one window.

### 2.12 Context size: the live gauge — **[verified 2026-10-16]**

Verified against all 242 transcripts under `~/.claude/projects` (Claude Code 2.1.2xx–2.1.281,
37,578 assistant lines carrying `usage`). The reader is
`src/collectors/claude-code/context-size.ts`; the hook payload is parsed in `hook-input.ts`.

How many tokens the next message will re-read is the **input side of the last real main-chain
assistant turn**: `message.usage.input_tokens + cache_read_input_tokens +
cache_creation_input_tokens`. All three fields were present on every one of the 37,578 lines.
`output_tokens` is not part of it. This is a gauge of the moment: it is read from the file on
demand and never stored.

Which entries are not the real context:

- **Sidechain turns.** `isSidechain` is now written on every line: `false` on all 32,749
  assistant lines of main transcripts, `true` on all 4,880 under `subagents/`. **This
  contradicts §2.2**, which found it set on 0 of 21,574 lines in older versions. The collector
  still classifies by path, which is right for both. The context reader, which is handed one
  main transcript, skips `isSidechain === true` as well.
- **`<synthetic>` turns**: 36 lines, every one with all-zero usage.
- **All-zero usage** on any line (36 of 37,578, all of them the synthetic ones) is a
  placeholder or replay (§2.3), not an empty context.

Compaction writes a boundary line, not an assistant turn:

```json
{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","isMeta":false,
 "compactMetadata":{"trigger":"manual","preTokens":84380,"postTokens":10079,"durationMs":42074, ...},
 "sessionId":"…","timestamp":"…"}
```

(14 boundaries in the 242 transcripts; `trigger` was `manual` in the one examined.) **No new
assistant turn follows it until the next reply**, so the last usage still describes the
PRE-compact context: in the transcript examined, the last turn before the boundary read
82,888 tokens (2 + 81,217 + 1,669) against `preTokens` of 84,380 and `postTokens` of 10,079.
3 of the 242 transcripts ended on a boundary with no later assistant usage. A boundary after
the last usage therefore means the size is **unknown**, not the old number.
`compactMetadata.postTokens` is the size right after the compact, but it is an estimate of the
summary and not what a turn measured, so it is not used.

Transcripts are large (55 MB at the largest), so the reader looks at the **tail only**: 256 KB
first, growing ×4 until a decisive line is found or the whole file has been read. The first line
of a window that starts mid-file is cut and is discarded.

The hook payload (`UserPromptSubmit`) and the status-line payload (§2.11) both carry
`transcript_path`, the absolute path of the session's main transcript. Like the rest of that
payload it is taken from Claude Code's documentation, not from captured bytes, and it is
optional: without it the size is unknown.

### 2.13 User settings: is the status line or hook on? — **[verified 2026-10-16]**

`ai-usage status` reads Claude Code's user settings file to say whether `ai-usage statusline`
and `ai-usage hook` are configured, because updating the package cannot add those entries. The
file is the first `settings.json` that exists in `$CLAUDE_CONFIG_DIR`, `~/.claude`, then
`~/.config/claude`, the same candidates as transcript discovery. Observed shape:

```json
{
  "statusLine": { "type": "command", "command": "node .../ctx-watch.mjs statusline" },
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "..." }] }],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node .../ctx-watch.mjs hook", "timeout": 10 }] }
    ]
  }
}
```

- `statusLine` is one object, and `command` is a shell command string.
- `hooks` is keyed by event. Each event holds an array of matcher groups, and each group holds
  `hooks[]` of `{ type, command, timeout? }`. The `UserPromptSubmit` groups observed had no
  `matcher` key.
- Only the hook under `UserPromptSubmit` counts. The same command under another event never
  runs before a prompt.

Claude Code also merges a project's `.claude/settings.json` and `.claude/settings.local.json`.
Those are not read, so an entry there is reported as "not found" in the user file and never as
"not installed". A file that does not parse is reported as unreadable, never as having no
entries.

---

## 3. Re-verifying

`ai-usage verify` re-derives everything from source with a **second implementation that shares
no reduction code with the collectors** — for Claude Code it deliberately uses a different
rule (prefer the `stop_reason` line) so that agreement means two readings of the same bytes
agree, not that one function agrees with itself.

It syncs first, then compares only activity before a shared cutoff: both clients append to
their stores continuously, so without a cutoff the source is always a few requests ahead and
the diff could never be zero.

It compares only sessions the source still holds. Both clients delete their own history --
Claude Code removes transcripts after `cleanupPeriodDays`, 30 days by default -- while the
local database keeps what it collected, so after a month the database legitimately holds more
than the source. Those sessions are listed on a separate `Retained, not compared` line instead
of being counted as a mismatch. Any source record missing from the database still fails the
check, because the source side is never narrowed.

Current result on the development machine: **exact match, zero delta on every token class,
for both clients.**
