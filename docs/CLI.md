# The CLI in depth

## Narrowing to several projects, models or clients

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

## Getting the data out

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

## Retention and merging two machines

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

## Cache economics

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

## Budget, run rate and forecast

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
  figure to watch on a subscription is usage against your plan limits — see
  [the status line](STATUS_LINE.md#plan-limits-and-the-status-line). The output says so every time.

**Calendar periods only** (`month`, `week`). A projection needs a period end to aim at, which a
rolling window has not got.

**Exit 1 on a fact, not on a forecast.** `budget` exits 1 when spend _already_ exceeds the
target. It does not fail on a projection — that would page somebody about arithmetic rather
than about spend. To threshold a projection deliberately, compose with `--field`:

```bash
ai-usage budget --amount 500 --basis estimated \
  --field projections.perActiveDay.projected --fail-over 500
```

## Using it in a script or an alert

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

## Crossing two dimensions

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

## Reading a trend

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

## Comparing two periods

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

## Ordering and paging a list

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
