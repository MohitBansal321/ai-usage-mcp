# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Required reading before changing collectors or cost code

1. **[AGENTS.md](AGENTS.md)** — the project's non-negotiable rules and the correctness traps. Everything in it applies here; it is not duplicated below.
2. **[docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)** — the on-disk formats of Claude Code and OpenCode as _verified against real data_. It supersedes [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) §5 where they disagree. Both source formats are internal and unversioned, so this file is the only record of what was actually observed — never re-derive a format by guessing, and update this doc in the same change if your understanding of a format changes.
3. **[PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)** — product goal, Phase 1 scope, Definition of Done.

## Commands

```bash
npm run check          # typecheck + lint + format:check + build + test — exactly what CI runs
npm run build          # tsc -p tsconfig.build.json, then chmod the two bin entrypoints
npm run typecheck      # tsc over src AND tests (tsconfig.json is noEmit)
npm run lint           # type-aware eslint
npm run format         # prettier --write .
npm test               # vitest run
npm run test:coverage  # vitest run --coverage (thresholds are a regression floor)
```

**`npm run build` must run before `npm test`.** `tests/mcp/server.test.ts` and
`tests/mcp/parity.test.ts` spawn `dist/mcp/server.js` and `dist/cli/index.js` as child
processes and fail fast if `dist/` is missing or stale.

Running a subset:

```bash
npx vitest run tests/services/cost-service.test.ts     # one file
npx vitest run -t 'dedupe'                             # one test by name
npx vitest tests/collectors                            # watch a directory
```

Exercising the built binaries against your own real data:

```bash
node dist/cli/index.js status      # collectors, stores, schema version, pricing provenance
node dist/cli/index.js sync --full # ignore cursors and re-read everything
node dist/cli/index.js stats --today
node dist/cli/index.js verify      # MUST report a zero delta after any collector change
```

`ai-usage stats --today` must return byte-identical output to the `usage_summary` MCP tool
(asserted in `tests/mcp/parity.test.ts`). If they diverge, a frontend has grown its own
business logic.

## Architecture

The one rule: **MCP never knows where data comes from.**

```text
MCP tools (src/mcp/tools/*) ─┐
                             ├─> UsageService ─> collectors ─> Claude Code JSONL / OpenCode SQLite
debug CLI (src/cli/index.ts) ┘        │
                                      └─> our own SQLite (usage_records, sync_state)
```

`UsageService` ([src/services/usage-service.ts](src/services/usage-service.ts)) is the single
entry point for every frontend; it owns the DB handle, the collectors, and delegates to
`SyncService`, `AggregationService`, `CostService` and `VerifyService`. Both frontends are thin:
they parse arguments, call one service method, and render through the same
[formatter](src/services/formatter.ts). No business logic in a tool handler or a CLI case.

Data flow:

- **Collect** — each collector implements `UsageCollector` and returns `UsageRecord[]` plus an
  opaque, collector-owned resume `cursor`, `notes`, and `StoreInfo[]`. Discovery is separated
  from parsing: `collectors/*/stores.ts` and `collectors/claude-code/transcripts.ts` find the
  data; `collectors/*/collector.ts` reads it.
- **Normalize** — everything converges on `UsageRecord`
  ([src/models/usage-record.ts](src/models/usage-record.ts)). Optional fields stay optional: a
  value a source does not report is `undefined` and surfaces as _unavailable_, never as `0`.
  `id` is derived deterministically from source identifiers so re-sync is idempotent
  (`upsertMany`).
- **Store** — every SQLite handle comes from `openSqlite()` in
  [src/db/driver.ts](src/db/driver.ts), which prefers Node's built-in `node:sqlite` and falls
  back to the optional `better-sqlite3`. **No other module may import a SQLite driver
  directly** — that is what keeps the fallback honest, and `tests/db/driver.test.ts` asserts
  the two drivers agree on a file either one wrote. `node:sqlite` has no `.pragma()` or
  `.transaction()`, so the driver supplies both (transactions nest via savepoints, matching
  better-sqlite3).
- **Store** — `usage_records` + `sync_state`, via append-only migrations in
  [src/db/migrations/index.ts](src/db/migrations/index.ts) (add a new `{version, name, up}`
  entry; never edit an applied one). Our DB path is deliberately homedir-based, _not_
  XDG-based — a sandboxed launcher's private `XDG_DATA_HOME` is exactly how OpenCode's own
  history ended up split across two stores.
- **Aggregate and render** — `UsageRepository` does the SQL grouping,
  `AggregationService` shapes reports, `formatter.ts` produces the text both frontends print.

Cost: `costBasis` is always one of `reported` | `estimated` | `unavailable`, and `cost`
(reported) and `estimatedCost` (from a versioned pricing table) are never combined into one
figure. Pricing tables live in [src/pricing/tables/](src/pricing/tables/) and a user can
override them with a JSON file (`AI_USAGE_PRICING_FILE`, else `<config dir>/pricing.json`); a
malformed override throws rather than silently falling back.

MCP specifics:

- [src/mcp/server.ts](src/mcp/server.ts) wraps reads in a _freshness gate_ — a sync at most
  once per `AI_USAGE_FRESHNESS_MS` (default 30s), with concurrent callers sharing one in-flight
  sync. A failed sync never fails the read; it answers from what is stored and logs to stderr.
- **stdout is the JSON-RPC transport.** All diagnostics go to `process.stderr`.
- The update notice is attached as a _separate_ content block via `textResult()`
  ([src/mcp/tools/shared.ts](src/mcp/tools/shared.ts)), so `content[0]` stays byte-identical to
  what the CLI prints — which is what makes the parity assertion possible.
- Tools live one-per-file under [src/mcp/tools/](src/mcp/tools/) as `registerX(server, ctx)`
  functions sharing `periodShape` / `toQuery` from `shared.ts`; resources (`usage://today`,
  `usage://session/latest`, `usage://status`) and prompts are registered the same way.

## Conventions

- ESM with `module: NodeNext` — **relative imports must carry the `.js` extension**, including
  from `.ts` sources.
- `strict` plus `noUncheckedIndexedAccess`; indexed access returns `T | undefined`.
- Anything exported for consumers is re-exported from [src/index.ts](src/index.ts).
- Tests are fully isolated from the machine's real data by env vars, built with
  [tests/fixtures/build-fixtures.ts](tests/fixtures/build-fixtures.ts): `AI_USAGE_DB`,
  `AI_USAGE_OPENCODE_DB`, `AI_USAGE_CLAUDE_PROJECTS`, `AI_USAGE_HOME`,
  `AI_USAGE_FRESHNESS_MS`, `AI_USAGE_NO_UPDATE_CHECK`. Never let a test read the developer's
  own `~/.claude` or `opencode.db`.
- Coverage thresholds in [vitest.config.ts](vitest.config.ts) are calibrated to the current v8
  provider and understate real coverage: `src/cli/**`, `src/mcp/**` and `src/version.ts` are
  covered by subprocess-based integration tests that v8 cannot attribute. Recalibrate rather
  than chase the numbers.
- Release is tag-driven: `.github/workflows/release.yml` runs `npm run check`, verifies the tag
  matches `package.json`, publishes with provenance, and cuts a GitHub Release from the matching
  `CHANGELOG.md` section. See [docs/PUBLISHING.md](docs/PUBLISHING.md).
