# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/MohitBansal321/ai-usage-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MohitBansal321/ai-usage-mcp/releases/tag/v0.1.0
