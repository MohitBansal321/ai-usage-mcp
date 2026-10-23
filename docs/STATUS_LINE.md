# Plan limits, the status line and the context warning

## Plan limits and the status line

On a Pro or Max plan, the number that decides your day is how much of the 5-hour and weekly
limits is left, and Claude Code writes it to no file. It does pass it to a configured
**status line**, so ai-usage can be yours:

```bash
npm install -g ai-usage-mcp
```

Then add this to `~/.claude/settings.json` (keep the keys already there):

```json
{
  "statusLine": { "type": "command", "command": "ai-usage statusline" }
}
```

It renders like this (sample data):

```text
5h 23.5% ↻14:20 · wk 41% ↻Thu 09:00 · today $38.10 API-eq · cache 96% 2 breaks +$1.10 API-eq
```

Each segment: the 5-hour and weekly limits as Claude Code reported them, with the reset time
(yellow past 70%, red past 90%, and a red `100% by 13:55` when the current pace runs out before
the reset); today's API-equivalent cost across clients; and the prompt-cache hit rate and
breaks for the session on screen. It keeps the database fresh itself (an incremental sync, at
most every 30 seconds), and an unreadable payload or a failed sync never blanks the line.
`--no-color` or `NO_COLOR=1` drops the colour.

<sub>A global install keeps it fast: a status line runs on every assistant message, and
`npx -y -p ai-usage-mcp ai-usage statusline` also works but adds about half a second to each
run, and several seconds on a cold npm cache.</sub>

Every reading is kept, so `plan_usage` (or `ai-usage limits`) can answer "how close am I, and
will I run out before it resets?" from inside a conversation (sample data):

```text
5-hour window
  Used:        62%     last read Mon, Oct 12 13:05
  Resets:      Mon, Oct 12 14:20
  Pace:        +24.0%/hour, averaged over 6 readings from Mon, Oct 12 11:35 to 13:05
               -> 100% at Mon, Oct 12 14:40, after the reset -- on pace to stay under.
  This machine's Claude Code turns since Mon, Oct 12 09:20:
    ...
```

The percentages are Claude Code's own, never re-derived from tokens — Anthropic does not
publish the limits as token counts, so any conversion would be made up. Until a reading
arrives they are reported as **unavailable, not 0%**, and after a reset with no new reading,
as unknown. The limits are shared by everything on your account (claude.ai, the desktop app,
other machines); the token figures beside them cover only this machine's Claude Code turns.
An API key has no such limits, and its payload carries none.

## Get warned before context gets expensive

Every message re-sends the whole conversation, so a session at 400k tokens of context re-reads
400k tokens to answer "ok, thanks". `ai-usage report` finds that waste afterwards (the
"re-reading context above 100k tokens" line in [`usage_report`](../README.md#start-here-usage_report)).
Claude Code's own auto-compact only fires when the window is almost full, which is far too
late to save anything. This warns while it is happening.

Add both entries to `~/.claude/settings.json` (keep the keys already there):

```json
{
  "statusLine": { "type": "command", "command": "ai-usage statusline" },
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "ai-usage hook", "timeout": 10 }] }
    ]
  }
}
```

**The status line** gains a last segment, the size of the context the next message will
re-read:

```text
... · cache 96% · ctx 77k        green: under 150k
... · cache 96% · ctx 180k       yellow: 150k or more, worth watching
... · cache 96% · ctx 260k · compact now      red: 250k or more
```

**The hook** runs before each prompt. Below 250k it prints nothing. At or above it, it tells
Claude the size and that every turn re-sends all of it, and asks Claude to briefly suggest
`/compact` (or `/clear`, for an unrelated task) before starting the new work, and shows you
a one-line `systemMessage` saying the same. It never blocks or edits your prompt: it always
exits 0, so even a broken setting cannot eat what you typed.

**Changing the limits.** Both commands take `--ctx-warn` and `--ctx-limit`, as `150k`, `1.5m`
or a plain count, and read `AI_USAGE_CTX_WARN` and `AI_USAGE_CTX_LIMIT` when no flag is given.
A flag overrides the environment, which overrides the defaults of 150k and 250k:

```json
{ "type": "command", "command": "ai-usage hook --ctx-limit 200k", "timeout": 10 }
```

Use the same limits on both entries, or the line and the hook will disagree about when to
compact. `--no-color` or `NO_COLOR=1` drops the status line's colour.

**Not sure what is switched on?** `ai-usage status` reads `~/.claude/settings.json` and
reports each integration as `on` or `not found`, with the entry to add for whichever is
missing:

```text
Claude Code integrations (/home/you/.claude/settings.json):
  Status line:  on -- plan limits, today's cost, cache and context size
  Prompt hook:  not found -- asks Claude to suggest /compact when context is large
  To turn on what is missing, add to that file (keep the keys already there):
    "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "ai-usage hook", "timeout": 10 }] }] }
  Both run the `ai-usage` command, so it must be on your PATH: npm i -g ai-usage-mcp
  An entry in a project's .claude/settings.json is not checked.
```

**What it measures.** The size is the last real assistant turn in the session's transcript:
fresh input plus cache reads plus cache writes, the same input side that `usage_report` counts
as context carry. Subagent and placeholder turns are skipped. Right after `/compact` no turn
has measured the new, smaller context yet, so the segment is **left out until the next reply**
rather than showing the old size. It is left out too when the transcript cannot be read.

**What it does not do.** It warns; it never compacts or clears anything by itself. It reads
only the last few hundred kilobytes of one transcript, takes the token counts from it, and
stores nothing. The hook opens no database and syncs nothing, so it adds only a few tens of
milliseconds to a prompt.

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

`cache_health` finds the turns in a session where the prompt cache stopped working: cache
writes spike **and** cache reads fall below half of what the previous turn had cached, so the
whole context was re-written at cache-write prices. A write spike alone -- reading one large
file -- is not a break, because the existing prefix was still read back. Each break names a
likely cause (a model or speed switch, idling past the 5-minute cache TTL, or an early-context
change such as an edited `CLAUDE.md`) and its write premium, priced from the same versioned
table as every other estimate. Main and subagent turns keep separate caches, so subagents are
excluded by default and baselined separately when `includeSubagents` is set.
