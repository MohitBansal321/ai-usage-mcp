# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.0] - 2026-09-26

A Claude model released after the pricing table was captured used to report every Claude Code
turn on it as cost _unavailable_ -- for every user, until a release caught up, and even then
only for turns collected afterwards. Claude Opus 5.5 did exactly that from the day it shipped.

### Added

- **New models are priced automatically.** The MCP server (in the background, after its
  handshake) and `ai-usage sync` download LiteLLM's community price list at most once a day
  and use it for the Anthropic models the built-in table lacks. It only fills gaps -- a
  built-in price is never replaced -- and takes a model only when it gives every rate the
  engine needs (input, output, cache read, both cache-write TTLs); a long-context price tier
  it cannot express leaves the model unpriced. Estimates it contributes cite a table version
  such as `builtin-2026-09-26+litellm-2026-10-02`, and `ai-usage status` gains a `Community:`
  line naming what it priced, when the list was fetched, or why it is off. It is the package's
  second documented network request: one GET of a public file, no usage data, no identifier.
  `AI_USAGE_NO_PRICING_REFRESH=1` turns it off, as does the existing
  `AI_USAGE_NO_UPDATE_CHECK=1`, so nobody who set that to stay offline gains a request by
  upgrading. `AI_USAGE_PRICING_URL` points it at a mirror.
- **Claude Opus 5.5, Claude Fable 5.1 and Claude Mythos 5.1 are in the built-in table**
  (`anthropic-2026-09-26`, every earlier Anthropic rate re-checked and unchanged), each with
  its own cache-read discount -- 0.05x for Opus 5.5, 0.025x for Fable 5.1 and Mythos 5.1.
  Inheriting the table's 0.1x default would have overstated their cache reads, which are most
  of a Claude Code session's tokens, by 2-4x.

### Fixed

- **Records stored before a price existed are priced once one does.** Estimates are computed
  when a record is collected, and incremental sync never re-reads an old record, so a model
  that gained a price -- from a release, an override, or now the community list -- stayed
  unpriced for every turn already stored, leaving sessions half priced until a
  `sync --full`. Every sync now prices the `unavailable` Claude Code records the table can
  price, with exactly the number a full re-sync would write. Only `unavailable` records
  change: a cost a client reported itself, and an existing estimate, are never touched.
- **The packaging test passes on Windows when node lives under a path with a space.** It
  handed the smoke script an unquoted `C:\Program Files\nodejs\node.exe ...` to run through a
  shell.
- **The README no longer says the MCP server makes no network calls.** The update check has
  run in the server's background since 0.4.0; the privacy section now lists both requests.

## [0.9.0] - 2026-09-18

Three places where this tool accepted something it could not honour and answered anyway. Each
one returned a confident, ordinary-looking result to a caller that had asked for something
else -- the failure this codebase is otherwise organised around preventing.

### Fixed

- **A comparison that cannot be made is refused rather than omitted.** `--compare previous`
  (and `compare: "previous"`) on a period with no fixed length -- all time, or an open-ended
  `--since`/`--until` on its own -- used to return an ordinary summary with the comparison
  quietly missing from it. The caller asked what changed and got a report that reads as
  "nothing changed" rather than "I never checked". It now names the period it could not
  compare and exits 2 from the CLI. The refusal to _invent_ a window is unchanged; only the
  silence is gone. The MCP description also no longer claims `since` alone is comparable, which
  it never was: an open window's length depends on when the clock is read.

- **The MCP tools reject an argument they do not declare.** Tool schemas were built from raw
  Zod shapes, which strip unknown keys, so `{ period: "today" }` -- a plausible guess at the
  argument name -- was accepted and answered with all-time totals under an "all time" heading.
  A caller that mistyped one argument got a confident answer to a question it had not asked,
  which is the same failure the pre-0.8.0 spellings exist to prevent. All nine tools now
  advertise `additionalProperties: false` and reject the unknown key by name. Every declared
  spelling, including the deprecated `projectPath`, keeps working.

- **A pricing override file that does not exist is an error, not a silent fallback.** Setting
  `AI_USAGE_PRICING_FILE` to a path that is not there loaded the built-in table and said
  nothing, so a typo in the path was indistinguishable from the override working -- every cost
  figure downstream looked ordinary while being computed from the rates the user believed they
  had replaced. The default `<config dir>/pricing.json` still falls back silently, because not
  having one is the normal state rather than a request.

## [0.8.0] - 2026-09-17

### Added

- **`ai-usage prune --before <date>` and `ai-usage vacuum`**, so the database does not grow
  forever. Pruning is a command rather than a policy on purpose: a retention setting that
  silently deleted last quarter on some future run is a worse tool than one that never
  deletes, because the data is gone and nothing asked. Anyone who wants a policy can put this
  in a cron.

  **Dry run by default.** The only irreversible operation in this package reports what it
  would remove and changes nothing until told twice with `--yes`. `--before` is exclusive like
  every other bound here, so `--before 2026-01-01` removes 2025 and keeps New Year's Day -- an
  off-by-one in the one irreversible command is not worth a tidier boundary. Scope filters
  apply, so a prune cannot be broader than the report that justified it.

  `vacuum` measures the database's whole footprint -- the file plus its `-wal` and `-shm`
  companions. This package always opens in WAL mode, where freshly written data lives in the
  `-wal` until a checkpoint folds it back: a 1.8MB database shows a 4KB `.db`, so measuring
  only that reported reclaiming nothing while most of the bytes sat next door. It now
  checkpoints and truncates the WAL, and the figure matches what `du` says.
  ([#59](https://github.com/MohitBansal321/ai-usage-mcp/issues/59))

- **`ai-usage import <file.jsonl>`**, merging an export from another machine, so "I work on a
  laptop and a desktop -- what is my total spend?" is answerable. As the issue anticipated,
  this fell out of the existing design: record ids are derived deterministically from source
  identifiers, so the same turn imported twice, or collected on both machines, upserts to one
  row rather than double counting. The output says how many rows were updated in place rather
  than added, so that is visible rather than assumed.

  A row that does not fully parse is rejected with its line number, and the command exits
  non-zero. Importing a half-valid row would write a turn with invented zeroes, and a merged
  database that quietly under-counts is worse than a failed import.
  ([#59](https://github.com/MohitBansal321/ai-usage-mcp/issues/59))

- **Cache hit rate and reads-per-write on `stats` and `clients`**, plus a break-even derived
  from the pricing table's own multipliers. Cache tokens are where the money is -- cache-read
  is 94.7% of all tokens on the development machine, and for Claude Code it outweighs plain
  input by roughly 33,000x -- and every report printed the raw counts and stopped there, so a
  user could see that cache dominates without being able to tell whether it was paying for
  itself.

  Break-even is computed, not hardcoded: a 5-minute write costs 1.25x input (0.25x extra) and
  each read saves 0.9x, so 0.25 / 0.9 = 0.28 reads per write, and 1.11 for the 1-hour tier.
  Change the multipliers, or use a provider whose cache discount differs, and the threshold
  moves with them.

  A hit rate is **absent rather than 0%** when there was no cache traffic at all -- those are
  different statements, and reporting the second as the first would be inventing a
  measurement. A genuine 0% (writes that were never read) is reported, because it is the worst
  case for the write premium and exactly what a user would want to see.
  ([#65](https://github.com/MohitBansal321/ai-usage-mcp/issues/65))

- **A no-cache scenario in `counterfactual` / `counterfactual_cost`**: what the same tokens
  would have cost with every cache token billed at the plain input rate, per model. On the
  development machine, caching saved an estimated 83.6% on Opus over 30 days.

  This is the one scenario in the tool permitted to state a **saving**, and deliberately so. A
  model counterfactual cannot, because the same task on a different model takes a different
  number of turns with a different context on each. Here the token counts genuinely are
  invariant: cache-read tokens ARE the context re-sent each turn, so without a cache they
  would have been sent as ordinary input one for one, and the cache-write premium would simply
  not have been paid. The assumption that remains -- that a cacheless run would have made the
  same requests -- prints with the numbers rather than living in a doc. A negative saving is
  reported as such rather than clamped to zero: burning the write premium on sessions too
  short to reuse it is precisely what this exists to show.
  ([#65](https://github.com/MohitBansal321/ai-usage-mcp/issues/65))

- **`ai-usage budget --amount N --basis reported|estimated [--period month|week]`**: spend
  against a target, with the run rate and where the period lands. Nothing in the tool surface
  accepted a budget number, so extrapolating month-end spend meant reading the active days out
  of `daily` and picking a denominator by hand.

  **Two projections, never one.** Calendar-day pace assumes the rest of the period looks like
  the period so far, weekends included; active-day pace assumes every remaining day is a
  working one. On the development machine those come to $919.65 and $1,264.65 for the same
  month. Picking one would be making that modelling choice silently on the user's behalf; the
  gap between them is the size of the assumption, and it is now the visible thing.

  **`--basis` is required and has no default**, which is the issue's own prior question
  answered the same way `--fail-over` answers it: the caller names the figure. Reported and
  estimated cost are never summed, so a budget with no stated basis is a budget against
  nothing in particular -- and the right answer differs for a subscriber, whose marginal cost
  per request is $0 and for whom the estimate is a shadow price. The output says so every time,
  and says the opposite thing for the reported basis, where Claude Code's usage is absent
  entirely. A `$0` spend caused by nothing being measured on that basis is called out rather
  than read as comfortably under budget.

  **Exit 1 on a fact, not on a forecast**: the command fails when spend _already_ exceeds the
  target, never on a projection -- failing a nightly job on a forecast would page somebody
  about arithmetic rather than about spend. Thresholding a projection stays available on
  purpose, by composing with `--field`.

  Calendar periods only, because a projection needs a period end to aim at and a rolling
  window has not got one. Elapsed time counts in partial days: a projection made at noon on the
  6th that pretends five whole days have passed overstates the rate by a tenth.
  ([#55](https://github.com/MohitBansal321/ai-usage-mcp/issues/55))

- **`ai-usage export`**: one row per stored turn, as CSV (default) or JSON Lines, honouring
  every period and scope filter. "Local-first, your data is yours" was the promise, and every
  output was a nested aggregate that no spreadsheet or CSV loader consumes; the only route to
  the underlying rows was `sqlite3 usage.db '.mode csv' 'SELECT * FROM usage_records'`, which
  bypasses the product entirely and depends on a schema the docs explicitly call internal and
  unversioned.

  The column set is a stable, documented contract rather than `SELECT *`, so the table can gain
  a column without breaking every downstream sheet. `cost` and `estimated_cost` are separate
  columns carrying `cost_basis` alongside -- one `cost` column would force a choice between
  blending two incomparable figures and dropping one. A value the source did not report is an
  empty cell, never `0` and never `null`: a figure nobody produced must not arrive in a
  spreadsheet as a number that gets summed with the real ones. Rows stream to stdout, and a
  truncated export says so on stderr so stdout stays pipeable.
  ([#56](https://github.com/MohitBansal321/ai-usage-mcp/issues/56))

- **`--field <path>` and `--fail-over <amount>`**, making the CLI usable from a scheduled job.
  `--field` prints one value and nothing else, so a shell needs no `jq`; `--fail-over` turns
  that value into an exit code -- 1 when strictly greater, 0 otherwise, 2 for any usage error.
  stdout still carries the value, so a script can branch and capture in one run.

  Two deliberate refusals. `--fail-over` **requires** `--field`: there is no default, because
  reported and estimated cost are separate figures that are never summed, so "fail if cost
  exceeded $25" has no single answer and a default would silently ignore every record priced
  the other way. And an unknown field is **exit 2, never exit 0** -- a threshold check against a
  silently-missing field passes forever, which is the worst failure an alert can have, because
  it looks like everything is fine. The error names the fields that do exist at that level.
  ([#60](https://github.com/MohitBansal321/ai-usage-mcp/issues/60))

- **`ai-usage breakdown --by <axes>` and the `usage_breakdown` MCP tool**: totals cut by two or
  three dimensions at once -- `project x day`, `model x day`, `client x model` -- as one tidy
  row set. Axes: `client`, `model`, `provider`, `project`, `session`, `day`, `hour`,
  `hour-of-day`.

  Every metric was single-axis, so "which of my projects is getting more expensive" could not
  be asked: `projects` reports a project's total over 60 days with no indication whether that
  is accelerating or one old burst, and `daily --project X` gives a single series for a path
  you must already know. Answering it meant enumerating projects, issuing one call each, and
  joining client-side -- an N+1 that is not feasible as a tool call from an agent loop at all.

  The time axes use the same expressions `daily_usage` does, so the two cannot disagree about
  what a day is. Combinations with no activity are absent rather than returned as zero rows: a
  project x day grid is mostly empty and filling it would bury the rows that matter. A `--` in
  a cost column means no record in that row is priced on that basis -- deliberately not `$0`,
  which is a different claim. `--sort`, `--limit` and `--offset` behave as on any other list,
  with every axis joining the tie-break so paging cannot drop or repeat a cell.
  ([#54](https://github.com/MohitBansal321/ai-usage-mcp/issues/54))

- **`daily` shows every bucket, including the empty ones.** It printed only the days that _had_
  data -- ten rows for a thirty-day window -- with nothing to say the other twenty existed.
  That made a trend actively misleading rather than merely incomplete: the gaps were
  invisible, so an ordinary day rendered immediately beside one three weeks earlier and looked
  like a spike next to it.

  A zero row is not a fabricated number; it says out loud what the absence of a row already
  meant. Each carries `zeroFilled: true` in JSON and MCP output, so a constructed zero stays
  distinguishable from an observed one. Filling is bounded at 5,000 buckets and says so when
  the bound bites, rather than quietly returning a partial series.
  ([#53](https://github.com/MohitBansal321/ai-usage-mcp/issues/53))

- **`stats --compare previous`**, reporting the equal-length window immediately before and the
  delta, with the matching `compare` MCP argument. Every report described one window in
  absolutes, so "am I trending up?" meant re-running with a second hand-computed date pair and
  diffing mentally.

  Three rules it keeps. The two cost bases are deltaed **separately and never summed**, for the
  same reason they are reported separately. There is **no percentage change from zero** --
  `$0 -> $5` is a new thing happening, not a rise of 100%, so the ratio is omitted rather than
  invented. And the previous window is **aligned to the same local midnights the period uses**,
  so `--days 7` compares against the seven whole days before rather than "the 156 hours
  before"; the latter is what subtracting an open window's elapsed length gives, and it moves
  every time the clock is read. Resolving it in `resolvePeriod` rather than deriving it later
  is what makes it a pure function of the request -- and is what let the CLI/MCP parity test
  cover it at all, since the two run in separate processes.

  "All time" has no window before it, so `--compare` is refused there rather than answered.
  ([#53](https://github.com/MohitBansal321/ai-usage-mcp/issues/53))

- **`daily --grain hour | day | hour-of-day`**, with the matching MCP argument. `hour-of-day`
  collapses every day in the period onto one 24-slot local clock, which is the grain that
  answers "when during the day do I burn tokens" -- on the development machine, entirely
  between 10:00 and 18:00, peaking at noon, with nothing in the evening. Timestamps were
  already stored to the millisecond and day buckets already computed in local time, so both
  the data and the timezone handling were in place.
  ([#58](https://github.com/MohitBansal321/ai-usage-mcp/issues/58))

- **Rank by cost.** `sessions`, `models`, `projects` and `clients` take `--sort`
  (`tokens` | `reported-cost` | `estimated-cost` | `records` | `sessions` | `recent`), with the
  matching MCP argument. The data was always there -- only the ordering was missing, and its
  absence was worse than neutral: `sessions` was strictly recency-ordered, so the `--limit` a
  caller would naturally reach for actively _hid_ the answer. On the development machine the
  costliest session is $373.05 and sits 300-odd rows down a recency-ordered list whose first
  two entries are $7.62 and $3.44.

  There is deliberately **no plain `--sort cost`**. Reported and estimated cost are separate
  figures that are never summed, so ordering by one sorts every row priced on the other basis
  as though it were $0. The flag refuses the ambiguous form and names the two to choose from,
  and whichever is chosen the output reports how many rows that ordering could not speak for
  (`rowsWithoutSortValue`).
  ([#52](https://github.com/MohitBansal321/ai-usage-mcp/issues/52))

- **Multi-valued scope filters.** `--client`, `--model` and `--project` are repeatable and
  comma-separated, each matching any of the values given; different scopes still combine with
  AND. `--model a,b` previously parsed as one literal id, matched nothing, and reported an
  empty period at exit 0 -- a typo rendered as a fact about the data.

  An **empty list now matches nothing rather than nothing-at-all-being-filtered**, which is
  the same rule `--model ""` already followed.

  A scope value present nowhere in the database is called out explicitly, because a typo and a
  quiet week were otherwise indistinguishable. The check runs against the whole database, not
  the period, so a project that merely had no activity this week is not reported as unknown.
  ([#57](https://github.com/MohitBansal321/ai-usage-mcp/issues/57))

- **Paging, with a completeness signal.** The same four commands take `--offset`, and every
  list-shaped result now carries `total`, `offset`, `limit`, `hasMore`, `nextOffset` and
  `sort`. A caller passing `--limit` previously had no way to know what it had not seen, which
  made "the top 5" indistinguishable from "all 5 there are". Every ordering carries a
  deterministic tie-break, so paging cannot drop or repeat a row when two rows compare equal.
  ([#61](https://github.com/MohitBansal321/ai-usage-mcp/issues/61))

- **Prices for models this package does not ship.** The pricing override
  (`$AI_USAGE_PRICING_FILE`, else `<config dir>/pricing.json`) is now **overlaid** onto the
  built-in table rather than replacing it, keyed by model id. Adding one missing provider
  used to cost you every Anthropic price you had -- the mechanism that existed for adding a
  model made the tool report less. `"replace": true` still does the old thing for anyone who
  wants it, and now requires a complete `cacheMultipliers`, since there is no base left to
  inherit one from. ([#63](https://github.com/MohitBansal321/ai-usage-mcp/issues/63))

- **Per-model cache multipliers** (`models.<id>.cache`). Not a theoretical knob: OpenAI
  publishes a single cache-write price with no 1-hour tier, so pricing its writes at
  Anthropic's 2x would overcharge them by 60%, and DeepSeek's cache-hit rate is 0.02x its
  input rate rather than 0.1x. Without this a second provider could be added to the table
  only by being priced wrongly. ([#63](https://github.com/MohitBansal321/ai-usage-mcp/issues/63))

- **An OpenAI pricing table** (`openai-2026-09-16`: gpt-6-astra, gpt-5.6-sol / terra / luna /
  cyber), so the package ships an estimate path that is not Anthropic-only. Built-in tables
  are now one file per provider, each keeping its own capture date, composed into the single
  table the engine consults; two tables pricing the same model id is an error rather than a
  silent pick. These are the Standard-tier, short-context rates -- OpenAI's long-context,
  Batch, Flex and Fast-mode rates are not modelled, because nothing in a stored record says
  which applied, so a long-context turn is understated rather than guessed at. Providers whose
  published pricing the table cannot express exactly (DeepSeek bills different rates at peak
  and off-peak hours) are deliberately not shipped.
  ([#62](https://github.com/MohitBansal321/ai-usage-mcp/issues/62))

- **The pricing override format is documented**, with its units. `input` and `output` are USD
  per 1,000,000 tokens; the three `cache*` values are multipliers of that model's input rate,
  not prices. Required versus optional fields, what `fast` is and when it applies, and the
  wholesale-not-field-by-field merge rule are all written down, and a malformed file now names
  the offending field: `models["x"].output must be a number >= 0 (USD per 1,000,000 tokens)`.
  ([#64](https://github.com/MohitBansal321/ai-usage-mcp/issues/64))

### Changed

- **Every pre-0.8.0 MCP argument spelling still works.** The singular `projectPath`, a bare
  string `client`, and `counterfactual_cost`'s `models` are all still honoured, because
  dropping them would not have failed loudly: an argument a tool does not declare is stripped
  before the handler sees it, so a caller still passing `projectPath` would have had its filter
  silently vanish and received the whole database presented as one project's usage. The
  shipped `project-cost` prompt was one such caller. `counterfactual_cost` was worse -- `models`
  meant "price against these" before and "include only these turns" after, so the same call
  kept succeeding while answering a different question. Both are covered by
  `tests/mcp/back-compat.test.ts`.

- **`counterfactual`'s target models are named apart from the scope filter.** `--target-models`
  on the CLI (`--models` still works), `targetModels` in MCP (`models` still works there too,
  keeping its pre-0.8.0 meaning of "price against these"; model scope-filtering on that one
  tool is `filterModels`). One says which turns to include
  and the other which rates to price them at; with `--model` now accepting a list, a single
  `models` meaning both depending on the tool would have been exactly the ambiguity this
  release set out to remove. The two are usable together:
  `ai-usage counterfactual --model claude-opus-5 --target-models claude-sonnet-5`.

- `UsageFilter`'s scope fields are now lists: `clients`, `models`, `projectPaths`. The
  singular `client`/`model`/`projectPath` are gone rather than kept as aliases -- two ways to
  express one filter, only one of which the query consults, is how a filter silently stops
  filtering.

### Fixed

- **A reported cost of `$0` no longer looks the same as a price nobody has.** OpenCode reports
  its own cost, so a model absent from the pricing table filed an ordinary
  `{reported: 0, reportedRecords: 1936, unavailableRecords: 0}` -- which asserts, in this
  tool's own vocabulary, that nothing is missing, while the _estimate_ was missing and had
  never been attempted. A genuinely free model and an unpriced paid one rendered identically.

  Every aggregate now carries `cost.unpricedRecords` and `cost.unpricedModels`, and the
  reports say so in words, naming the models the way `counterfactual_cost` already did. On the
  development machine that is 6,813 of 6,841 OpenCode records across 19 models, behind a
  reported figure of $0.48.

  Both fields are **absent rather than `0`** when a caller supplied no list of priced models:
  "not asked" is not the same as "none", which is the same rule the rest of this codebase
  applies to every value a source does not report.
  ([#66](https://github.com/MohitBansal321/ai-usage-mcp/issues/66))

- **Packaging test runs identically on Windows.** `npm pack --json` replaces `tar tzf`, and `shell: true` lets `npm.cmd` resolve correctly on Windows runners. ([#75](https://github.com/MohitBansal321/ai-usage-mcp/pull/75))

## [0.7.0] - 2026-09-10

The first release that answers a question rather than reporting a total: whether a cheaper model would have cost less for the work you already did. It also carries the schema change that made that answerable -- see 0.6.0 for the `usage.speed` note, which shipped there and is what this builds on.

### Added

- **`counterfactual_cost` — what these tokens would have cost on another model**, alongside
  what they actually cost, as an MCP tool and as `ai-usage counterfactual`. On the development
  machine: $929.72 of Claude Code usage, where the same tokens priced at Sonnet 5's rates come
  to $389.41 and at Haiku 4.5's to $194.70.

  Re-pricing turned out to need more than the token counts. It groups by `client`, `model` and
  `speed`, because each one changes the arithmetic: `speed` decides whether the premium
  fast-mode rates applied, and `client` decides whether reasoning tokens are already inside
  `output_tokens` (Claude Code) or a sibling of them (OpenCode). Pricing `output_tokens` alone
  would have billed nothing for OpenCode's reasoning; adding them for Claude Code would have
  billed twice. `billableOutputTokens()` and `REASONING_PLACEMENT` put that rule in one place,
  so a third client cannot be added without confronting it. A mixed period is priced per group
  rather than at one blended rate.

  It is presented as **a counterfactual, not a saving**, and that caveat is part of the output
  rather than a line in this file: the same task on a different model generally takes a
  different number of turns carrying a different context on each, and nothing on disk can say
  what that number would have been. The actual figure keeps its own basis, the model that
  really ran is marked in the list rather than subtracted from it, and a requested model with
  no price is omitted and named instead of guessed at.

## [0.6.0] - 2026-09-10

No figure this release reports differs from 0.5.1 -- nothing about how usage is counted has
changed. This is about installation and discovery: the package could only be found by people
who already knew to look for an MCP server, three of its features were invisible to almost
everyone who had installed it, and the install instructions covered two clients out of seven.

It does carry the database's first schema change since 1.0. The migration is additive, runs
automatically the next time anything opens the database, and rewrites no rows -- see the
`usage.speed` note under Fixed.

### Added

- **A Claude Code plugin.** `/plugin marketplace add MohitBansal321/ai-usage-mcp` then
  `/plugin install ai-usage@ai-usage-mcp` replaces the `claude mcp add` invocation, and — more
  to the point — installs the three prompts as real slash commands
  (`/ai-usage:daily-review`, `/ai-usage:why-was-today-expensive`, `/ai-usage:project-cost`).
  Those prompts have shipped since 0.2.0 and most clients never surface MCP prompts at all, so
  for most users the feature existed without being reachable. The repository has also been
  tagged `claude-code-plugin` since the beginning while shipping no manifest.

  The prompts and the commands are one feature through two surfaces, and
  `tests/plugin/manifest.test.ts` asserts the two lists are identical, so a fourth prompt
  cannot be added without its command. It also asserts each command carries the
  reported-vs-estimated cost rule, since a paraphrasing model must not merge the two bases just
  because the rule lived only in the MCP prompt.

  The plugin declares `npx -y ai-usage-mcp` as its server rather than bundling one, so the
  server still comes from npm and re-resolves on a cold start. Nothing about the npm tarball
  changed: `files` excludes `.claude-plugin/` and `commands/`.

- `plugin.json` now carries a third copy of the version, so the release workflow and
  `npm run check` both assert it against `package.json`. Setting a plugin version pins the
  plugin, which means a stale value silently stops installed users from receiving updates —
  the failure mode is invisible, so it is asserted rather than left to a checklist.

- **Install instructions for Cursor, Google Antigravity, Windsurf, Claude Desktop, Codex and
  GitHub Copilot CLI.** Only Claude Code and OpenCode were documented, which conflated the
  client you _ask from_ with the client you _measure_ — someone working in Cursor still wants to
  know what their Claude Code sessions cost, and the answer was always the same server with a
  different config path. Every path was verified rather than written from memory, which caught
  two things a guess would have got wrong: Codex takes a `[mcp_servers.<name>]` table in
  `~/.codex/config.toml` (TOML, and there is a `codex mcp add`), not the JSON file this was
  originally planned around; and Copilot CLI's top-level key in `~/.copilot/mcp-config.json` is
  `servers`, not the `mcpServers` every other client here uses. Claude Desktop's Linux config
  path is deliberately absent — the Linux build is in beta and Anthropic publishes no path for
  it, so the instructions point at the **Edit Config** button instead of guessing. The
  Antigravity and Copilot CLI paths came off installed copies of those apps, since neither
  vendor publishes one.
- **The native-Windows `cmd /c` form of every install command.** `npx` is `npx.cmd` on Windows
  and the MCP TypeScript SDK spawns servers with `shell: false`; Node cannot execute a `.cmd`
  that way, and its own docs give "spawn `cmd.exe` and pass the file as an argument" as the
  remedy. This is a property of the shared client transport, so it applies to every SDK-based
  client rather than to Claude Code specifically — the note says so where a Windows user will
  actually be standing when it fails.

### Changed

- **The README leads with the reason to distrust your current numbers** instead of with "a
  local-first MCP server". Summing Claude Code's per-content-block usage lines inflated every
  figure by 2.15×-3.05× on the development machine, and cache-read outweighed input by roughly
  33,000× — both already measured in `docs/DATA_SOURCES.md`, neither previously visible above
  the fold. A `verify` excerpt and a sample of `stats --today` now appear near the top, since
  the entire output of this tool is a table of numbers and the README showed none of it. The
  cost-basis and privacy sections moved down, not out.

### Fixed

- **`usage.speed` is now stored alongside the tokens it priced.** Claude Code records a speed
  per request and `fast` bills at premium rates — double the standard input and output rates on
  Opus 5 and Opus 4.8. It was read at collection time, used for that request's estimate, and
  then dropped, so the tokens survived but the rate that applied to them did not.

  Today's stored figures are correct, because they were priced while `speed` was still in hand:
  `CostService.estimate()` is called from exactly one place, the collector, and nothing
  re-prices a stored row yet. The loss was latent rather than active. But anything that
  re-prices — a counterfactual across models, a corrected pricing table — would have silently
  applied standard rates to a fast-mode turn and under-reported it, with no way to detect that
  from the database.

  Schema 2 adds a nullable `speed` column. **Rows collected before this release stay `NULL`
  until you re-sync**, and `ai-usage sync --full` will fill them in; they are deliberately not
  backfilled to `'standard'`, because a row whose source never mentioned speed is not the same
  as one that said `standard`. All three states occur in practice: on the development machine,
  5,884 Claude Code records report `standard`, 37 report nothing at all, and every one of the
  6,841 OpenCode records is `NULL` because OpenCode does not record speed.

  Your existing `usage.db` upgrades in place — `ALTER TABLE ADD COLUMN` on an empty column
  rewrites no rows — and `ai-usage verify` still reconciles both clients exactly against an
  independent read of their sources.

## [0.5.1] - 2026-09-03

Nothing about how usage is counted has changed. This release fixes the feature that was
supposed to tell you a release like this one exists.

The update notice has never worked. It shipped in 0.4.0 and has been silent in every release
since, so no MCP user has ever been told their install was stale — which is the awkward part
of shipping the fix: the people who most need it are the ones who will not hear about it. The
design was fine; a single wrong header meant the registry lookup underneath it always failed,
and a failed lookup is indistinguishable from "you are up to date".

### Fixed

- **The update notice never reached anyone.** The registry lookup asked `/ai-usage-mcp/latest`
  for the abbreviated `application/vnd.npm.install-v1+json` metadata type, which is only
  defined for the packument endpoint. On `/latest` the registry answers `406` with an empty
  body, and `if (!res.ok) return null` reported that as "no update available" — so both
  notice channels stayed silent and the cache under the config directory was never even
  created. How often the 406 comes back varies by edge and by day (measured at both 0% and
  100% of requests, hours apart on one machine), which is why it survived review. It now asks
  for `application/json`: the same ~3 KB manifest, against a content type the endpoint
  actually serves. Affects every release since 0.4.0, where the notice was introduced.
- The lookup now retries once inside the existing 1500 ms budget, sharing one deadline across
  both attempts so a retry cannot double the wait. This is not what fixes the above — two
  attempts against a 406 both fail — it covers genuinely transient failures, which a
  once-per-process check would otherwise turn into silence for the life of a long-running
  MCP server.
- `fetchLatestFromRegistry` is now covered by tests. Every existing test injected the
  registry answer through `fetchLatest`, so the one code path that runs in production was
  the only one nothing exercised — which is why the above went unnoticed.

## [0.5.0] - 2026-09-03

Nothing about how usage is counted has changed. This release is about the two ways the project
was failing people before it got to count anything: it would not install on a common Windows
setup, and it could not be found.

The install failure was the worst of the two, because of _where_ it failed. `better-sqlite3` is
a native addon, and npm 10 on Windows ignores its `gypfile: false` and compiles from source
anyway, which dies without Visual Studio Build Tools. That happened inside `npx`, so the user
never reached the troubleshooting section that explained the fix.

### Changed

- **Storage uses Node's built-in `node:sqlite`, and nothing needs compiling.** `better-sqlite3`
  is now an `optionalDependencies` fallback, so a failed native build is a warning npm carries
  on from rather than an install that stops. Confirmed on the configuration that used to fail:
  Windows with npm 10.9.8 now installs cleanly and runs on the built-in driver.
- **`engines.node` is `>=22.13.0`**, up from `>=22.0.0`. That is the release where `node:sqlite`
  came out from behind `--experimental-sqlite` and where `StatementSync.prototype.iterate()`
  landed -- the same release, so it is one boundary rather than two. Below it the native module
  would be mandatory again, which would defeat the point. Node 22.0-22.12 are no longer
  supported; every later 22.x, and 24.x, are.
- **`engines.npm` is gone.** It only ever existed to force an npm that avoided the node-gyp
  bug. CI no longer upgrades the runner's npm either, which turns an npm 10 Windows install
  into a standing regression test instead of a configuration the project stepped around.
- Every SQLite handle now comes from `openSqlite()` in `src/db/driver.ts`, and no other module
  may import a driver directly. `node:sqlite` has no `.pragma()` or `.transaction()`, so the
  driver supplies both, nesting transactions via savepoints the way better-sqlite3 does.

  Your existing `usage.db` is untouched and needs no migration -- the file format belongs to
  SQLite, not to the binding. `ai-usage verify` reports a zero delta through either driver,
  with byte-identical figures.

### Added

- **The package can be listed in the official MCP registry**, which is what feeds PulseMCP,
  Glama, mcp.so and similar directories. Adds `mcpName`, a root `server.json` validated
  against the registry's current schema, and a `registry` job that publishes on a tag using
  GitHub OIDC -- no secret involved. This is the first release whose npm tarball carries
  `mcpName`, which is what the registry reads to verify ownership; 0.4.1's predates it.
- **All seven tools declare themselves read-only**, so a client can stop asking permission on
  every call. `readOnlyHint: true` plus `openWorldHint: false`, the latter because the server
  makes no network calls at all. The existing human-readable titles are now also sent as
  `annotations.title`, since the spec's display-name precedence is
  `title` -> `annotations.title` -> `name` and a client written against an earlier revision
  would otherwise show the snake_case tool name.
- `ai-usage status` reports which SQLite driver produced the numbers, and
  `AI_USAGE_SQLITE_DRIVER` forces one -- which is how the fallback stays tested on a Node that
  does not need it.

### Fixed

- Install no longer fails with `node-gyp rebuild` errors on Windows with npm 10. The README
  and troubleshooting notes about it are reworded to apply to the optional fallback rather
  than deleted, because the fallback still exists. (#27)

## [0.4.1] - 2026-09-02

No behaviour change for anyone running this. A path heuristic could not be exercised on the
platform half of it exists for.

### Fixed

- `detectInstallKind` classifies the same on every host. `fileURLToPath` is platform-specific
  about what it accepts -- on Windows a POSIX-style `file:///home/...` has no drive letter, so
  it throws and the fallback answered `unknown`. Real installs were never affected, because
  `import.meta.url` on Windows is `file:///C:/...`, which parses fine; what broke was the test
  suite on a Windows runner, which left the `%APPDATA%/npm/node_modules` branch -- the one that
  exists _for_ Windows -- unassertable there. It now falls back to the URL's own decoded
  pathname and normalises a literal backslash as well as `path.sep`, and the suite asserts the
  Windows-shaped forms alongside the POSIX ones on every runner. (#21)

## [0.4.0] - 2026-09-01

0.3.0 taught a stale install to say so, in the CLI. This says it where the people who never
open a terminal will actually see it: inside the MCP session itself.

### Added

- **The MCP server now says when its build is out of date.** 0.3.0 put that notice in
  `ai-usage status` only, reasoning that npx re-resolves its version on a cold start -- which
  left every global install, and every version pinned in an MCP config, exactly as uninformed
  as before, because most people who run the server never run the CLI. It is now said once per
  process, through whichever channel comes first: a line appended to the `instructions`
  returned at handshake time when the cached answer already knows, otherwise a one-off note on
  the next tool result. Never both, and never again on a later call.
- The notice names the fix that matches how the build was launched -- global install, npx
  cache, project dependency, source checkout -- detected from `import.meta.url` rather than
  `process.argv[1]`, which names the symlinked bin for a global install and makes it look like
  a bare script. The npx line also states the case no command fixes: a version pinned in an
  MCP config has to be changed there.
- `usage://status` resource -- the report `ai-usage status` prints, update state included, for
  a user who would rather ask than wait to be told.
- `ai-usage status` prints the install-appropriate update command as well, instead of always
  suggesting the global one.

### Changed

- The update check now runs in the MCP server too, in the background _after_ the JSON-RPC
  handshake -- never during it, and never on a tool response path, so it cannot delay a client
  starting up or an answer coming back. Same once-a-day cache, same 1.5s abandon, same
  opt-outs: `AI_USAGE_NO_UPDATE_CHECK=1` and `CI` cover both frontends. The `instructions`
  path reads the cache synchronously and never fetches, because a fetch there would add its
  timeout to every handshake.
- A tool result carrying a notice returns it as a _second_ content block, with
  `structuredContent.serverNotice` beside the numbers rather than mixed into them. The data
  block stays byte-identical to what the CLI prints for the same query, which is what keeps
  `ai-usage stats --today` and `usage_summary` provably equal.

## [0.3.0] - 2026-09-01

A stale install can now tell you it is stale. Nothing in the package had ever said so, which
is how a machine ended up two releases behind while reporting itself healthy.

### Added

- **`ai-usage status` tells you when a newer version is published.** A global install is pinned
  at whatever version it was installed at, and nothing said so: a machine here was still on
  0.1.0 after 0.2.0 shipped -- no `project_usage`, no `daily_usage`, no resources or prompts, no
  local-time day fix -- while the client reported the server as healthy. `status` now prints the
  installed version and, when the registry has a newer one, the command to update.
- The `--json` form of `status` carries `version` and an `updateAvailable` object, so the extra
  line cannot break a script that parses the output.

### Changed

- The README no longer claims the package contains no network code, because it now contains
  exactly one call. The update check asks the npm registry for a version number and sends
  nothing else: no usage data, no identifiers. It runs at most once a day (cached in
  `<config dir>/update-check.json`), gives up after 1.5s, is skipped when `CI` is set, is
  disabled by `AI_USAGE_NO_UPDATE_CHECK=1`, and never runs in the MCP server -- that process
  speaks JSON-RPC over stdout, and npx installs already re-resolve their version on every cold
  start. Version comparison is hand-rolled rather than pulling in `semver`, so the dependency
  count is unchanged.

## [0.2.0] - 2026-09-01

The MCP surface grows past period summaries. Usage can now be sliced by project, asked for
day by day, pulled into a conversation as a resource or a slash command, and read one turn at
a time. One correctness fix rides along: per-day buckets were UTC while the period filter was
local, so evening turns east of Greenwich landed on the wrong day.

### Fixed

- **Per-day totals were bucketed in UTC while the period filter used local midnight.** A turn made
  late in the evening was filed under the previous day for every user east of Greenwich, so
  `--today` could select rows that the daily breakdown then reported under yesterday. On the
  development machine (UTC+5:30) this misplaced 376 of 12,014 records. Bucketing now uses the OS
  timezone database, which also stays correct across DST changes where a fixed offset would not.

### Added

- **Per-project usage.** A `project_usage` MCP tool and an `ai-usage projects` CLI command report
  tokens and cost grouped by the working directory a turn ran in, answering "which repository is
  my spend going to" across both clients at once. Turns whose project could not be resolved are
  grouped as `(unknown)` rather than dropped.
- A `--project` CLI flag and a `projectPath` parameter on every period-based MCP tool, so any
  existing report can be narrowed to one project.
- **A `daily_usage` MCP tool.** The per-day breakdown was CLI-only; the agent can now ask for it
  directly. `ai-usage daily` and the tool render through one formatter, so they cannot drift.
- `dailyUsage()` now returns a report with a period label and overall totals, matching the shape
  of every other report rather than a bare array of rows.
- **MCP resources and prompts.** `usage://today` and `usage://session/latest` can be pulled into a
  conversation with an `@` mention, and three prompts appear as slash commands (`daily-review`,
  `why-was-today-expensive`, `project-cost`). Each prompt names the tools to call and carries the
  reported-vs-estimated rule with it, so a paraphrased summary cannot quietly merge the two cost
  buckets. Deliberately not built on sampling, roots or resource subscriptions: the first two were
  deprecated in the 2026-07-28 spec, and none of the three is documented as supported by Claude
  Code.
- **A row-level read path.** `UsageRepository.turns()` returns individual turns, oldest first and
  always bounded (200 by default, capped at 5,000), with `countTurns()` for paging. Every other
  read collapses rows, which left per-turn questions -- how context grew across a session, what a
  single turn cost -- unanswerable.
- `cacheWrite5mTokens` and `cacheWrite1hTokens` on aggregate rows. Both columns have been written
  since the first release and never read back, so no period could be re-priced: the two TTLs bill
  at 1.25x and 2x of the input rate.
- The first direct tests for `UsageRepository`, previously only exercised through `UsageService`.
- The README documents the two new tools, the resources and the prompts, and the `--project`
  flag.

## [0.1.2] - 2026-09-01

Packaging and release plumbing. No runtime change: `src` is untouched since 0.1.1.

### Added

- The release workflow now creates the GitHub Release itself, with notes taken from this
  file's section for the tagged version, and skips it if one already exists. Previously it
  published to npm and stopped there, so the Releases page kept showing an older version as
  Latest while npm had already moved on.

### Changed

- Source maps are no longer emitted into `dist`. The published tarball never carried the
  `.ts` sources they point at, so every one of them was dead weight: 101 files and 302 KB
  become 69 files and 198 KB. `sourceMap` stays on in `tsconfig.json` for local work; only
  the build config turns it off.

## [0.1.1] - 2026-09-01

Mostly a metadata and tooling release. It exists because npm metadata is immutable per
version, and 0.1.0 was published without the fields that link the package back to its source:
the package page showed no repository, no Issues link and no verified-source badge. Two small
collector fixes ride along; everything else in `src` is Prettier reflow.

### Added

- Continuous integration: typecheck, lint, format check, and the full test suite on Node 22
  and 24 across Ubuntu, macOS and Windows. A packaging job installs the packed tarball
  globally and drives the MCP server over stdio, and rejects a tarball containing sources,
  tests or database files.
- Release workflow publishing with [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
  guarded by a tag/`package.json` version match and a skip if the version is already on the
  registry.
- ESLint (type-aware) and Prettier, wired into `npm run check`.
- Coverage reporting with a regression floor.
- `exports` map and `sideEffects: false`.
- Formatter test suite covering the cost-honesty invariants: reported and estimated figures
  are never summed, estimates always carry the API-equivalent label, unpriced records are
  reported as unavailable, and every token class is broken out.
- `repository`, `homepage`, `bugs` and `author` metadata, absent from the published 0.1.0
  tarball. Without `repository` the npm page shows no link to the source, no Issues link
  and no verified-source badge, and npm cannot resolve the README's relative links.
- `engines.npm` (`>=11`), so npm warns at install time rather than failing mid-build on
  Windows.

### Changed

- **An `AI_USAGE_CLAUDE_PROJECTS` override is now authoritative.** Previously the override was
  added to the store list but only marked primary if the path existed, so a typo left the
  collector with no primary store and no complaint. The override is now always the primary,
  which surfaces a bad path as a missing primary store in `ai-usage status`.
- A malformed `pricing.json` override now chains the underlying parse error as `cause` rather
  than interpolating it into the message, so the reason survives without a two-line message.

- **Install docs rewritten around the simplest path.** The Claude Code instructions now lead
  with `npx -y ai-usage-mcp`, which needs no global install, and document the config-file route
  for people who use the VS Code or JetBrains extension and have no `claude` command:
  `.mcp.json` in a project root, or an `mcpServers` block in `~/.claude.json`. Neither needs a
  CLI. Previously the README assumed `claude` was on PATH, which turned a one-line install into
  a hunt for the extension's bundled binary.
- Troubleshooting entries for `claude: command not found` and for `/mcp` showing the server as
  failed (editors launched without the shell's PATH, common with Snap and Flatpak builds).

- **`engines.npm` now requires 11 or newer.** CI found that npm 10 on Windows ignores
  `better-sqlite3`'s `gypfile: false` and runs `node-gyp rebuild` despite a working prebuilt
  binary being bundled, failing without Visual Studio Build Tools and Python. The prebuild
  itself is fine there — installing with `--ignore-scripts` on Windows + Node 22 loads and
  runs it — so this is an npm-version behaviour. macOS and Linux are unaffected on npm 10 and
  11 alike. Documented in the README with the one-line fix, and CI raises npm to 11 on every
  matrix leg.

- Upgraded `@types/better-sqlite3` to 9.x to match the 13.x runtime dependency (v13 ships no
  types of its own).
- Upgraded vitest and `@vitest/coverage-v8` to 4.x together. The v8 provider changed how it
  accounts statements and branches between 2.x and 4.x, so the coverage thresholds were
  recalibrated — no source changed.
- Dependabot groups `vitest` with `@vitest/*`, because `@vitest/coverage-v8` peer-depends on
  an exact `vitest` version and bumping either alone yields an uninstallable lockfile. Major
  bumps of `@types/node` are ignored: it tracks the minimum supported runtime
  (`engines.node >= 22`), not the newest release.

## [0.1.0] - 2026-09-01

First release. Phase 1: two collectors, one normalized schema, local SQLite, five MCP tools
and a debug CLI. Nothing leaves the machine.

### Added

- **Claude Code collector.** Reads JSONL session transcripts. Deduplicates on
  `requestId` + `message.id` taking the maximum of each field, because Claude Code writes one
  line per content block with a cumulative `output_tokens` — summing naively inflates
  cache-read tokens by 2.24x. Classifies subagent turns by path, excludes `<synthetic>` model
  lines, and splits cache writes by TTL.
- **OpenCode collector.** Reads `opencode.db` at message grain over a read-only connection.
  Resolves the database through XDG, and detects and reports additional stores rather than
  silently reading one.
- **Five MCP tools**: `usage_summary`, `session_usage`, `model_usage`, `client_usage`,
  `recent_sessions`.
- **Debug CLI** (`ai-usage`) over the same service layer: `status`, `sync`, `stats`, `models`,
  `clients`, `sessions`, `session`, `daily`, `verify`, `version`.
- **`ai-usage verify`.** Re-derives usage from both sources using a second implementation that
  shares no reduction code with the collectors, and diffs it against the local database.
- **Cost policy.** Every figure carries a basis of `reported`, `estimated` or `unavailable`.
  Reported and estimated costs are never summed. Cache reads bill at 0.1x input; cache writes
  at 1.25x (5-minute TTL) or 2x (1-hour TTL), priced separately.
- **Versioned pricing tables** as data, with a user override at
  `~/.config/ai-usage-mcp/pricing.json`. A malformed override fails loudly rather than
  silently falling back.
- **Incremental sync.** OpenCode resumes from a `message.time_updated` cursor; Claude Code
  skips transcripts whose size and mtime are unchanged. Re-syncing is idempotent.
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) documenting both on-disk formats as verified
  against real data, including the seven documented assumptions that turned out to be wrong.

[Unreleased]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MohitBansal321/ai-usage-mcp/releases/tag/v0.1.0
