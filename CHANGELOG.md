# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MohitBansal321/ai-usage-mcp/releases/tag/v0.1.0
