# Contributing

Issues and pull requests are welcome. This is a small project with one idea at its centre, so
most of what follows is about protecting that idea.

## The idea

`ai-usage-mcp` reports **real** token usage and cost from data your coding agents already wrote
to your machine. It never fabricates a number, and nothing leaves the machine. Two things
follow from that, and a change that breaks either will not be merged:

1. **Never invent a value.** If a source does not record something, it surfaces as
   _unavailable_, never as `0`. Cost is `reported`, `estimated` or `unavailable`, and reported
   and estimated cost are never added into one figure.
2. **No new network code, no conversation content.** The only outbound requests are the two
   documented in [AGENTS.md](AGENTS.md) (a version check and a public price list), both
   skippable. Prompts, completions and tool output are never read or stored. See
   [SECURITY.md](SECURITY.md).

[AGENTS.md](AGENTS.md) lists the full rules and the correctness traps (for example, how Claude
Code's streamed lines must be deduplicated, and why reasoning tokens are counted differently
for each client). Read it before changing a collector or anything cost-related.

## Getting set up

You need **Node.js 22.13 or newer**. There is no compiler or native toolchain to install.

```bash
git clone https://github.com/MohitBansal321/ai-usage-mcp.git
cd ai-usage-mcp
npm ci
npm run check      # typecheck, lint, format, build and tests: exactly what CI runs
```

Useful commands:

```bash
npm run build      # must run before `npm test`: some tests spawn dist/ as a child process
npm test           # vitest
npx vitest run tests/collectors/opencode.test.ts    # one file
npx vitest run -t 'dedupe'                          # one test by name
npm run format     # prettier --write
```

To try your change against your own real data:

```bash
node dist/cli/index.js status
node dist/cli/index.js sync --full
node dist/cli/index.js verify      # must report a zero delta after any collector change
```

Tests never touch your real `~/.claude` or OpenCode database. They are isolated with the
`AI_USAGE_*` environment variables, using the fixture builders in
[tests/fixtures/build-fixtures.ts](tests/fixtures/build-fixtures.ts). Keep it that way.

## How the code is laid out

The one rule: **MCP never knows where data comes from.**

```text
MCP tools ─┐
           ├─> UsageService ─> collectors ─> Claude Code JSONL / OpenCode SQLite
debug CLI ─┘        └─> our own SQLite
```

Both frontends are thin: they parse arguments, call one service method and render through the
shared formatter. No business logic in a tool handler or a CLI case. `ai-usage stats --today`
must print exactly what the `usage_summary` MCP tool returns, and a test asserts it.
[CLAUDE.md](CLAUDE.md) has the architecture in more detail.

A few places that need care:

- **Adding or changing an MCP tool.** The tool list is written down in more than one place:
  the `registerX` calls, `tests/mcp/server.test.ts` and `.github/scripts/mcp-smoke.mjs`. Update
  all of them; `npm run check` fails if they drift. Every input schema must be a
  `z.strictObject(...)`.
- **Changing the database.** Add a new migration in `src/db/migrations/index.ts`. Never edit
  one that has already shipped.
- **Reading SQLite.** Always go through `openSqlite()` in `src/db/driver.ts`. No other module
  may import a SQLite driver.
- **Prices.** The built-in tables live in `src/pricing/tables/`, dated and versioned, and a
  user can override them with a JSON file. Prices a built-in table lacks are filled from a
  public price list, and never replace a built-in price.
- **Relative imports** need the `.js` extension, even from `.ts` files.

## Changing how a collector reads data

Claude Code's and OpenCode's on-disk formats are internal and unversioned, and they change
under us. [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) is the only record of what has actually
been observed, so:

- Look at real data before you change how a format is read. Do not guess.
- If your understanding of a format changes, update `docs/DATA_SOURCES.md` **in the same pull
  request**.
- `ai-usage verify` re-reads the sources with a second, independent implementation and must
  still report a zero delta. If you change a collector, change the verifier's reading to match.
- Add a fixture test that reproduces the format you are handling.

If a client changed its format and numbers stopped adding up, that is the most useful kind of
report you can send. See [Reporting a bug](#reporting-a-bug).

## Reporting a bug

Open a [bug report](https://github.com/MohitBansal321/ai-usage-mcp/issues/new?template=bug_report.yml).
It asks for `ai-usage status` and, if numbers look wrong, `ai-usage verify`: those two outputs
usually identify the problem immediately. Please also say **which version of Claude Code or
OpenCode** wrote the data, since format changes between their versions are the usual cause.

**Do not paste prompts, code or file contents from your sessions.** This tool never reads them
and an issue does not need them.

For a security problem, use a
[private security advisory](https://github.com/MohitBansal321/ai-usage-mcp/security/advisories/new)
instead of a public issue.

## Suggesting a feature

Open a [feature request](https://github.com/MohitBansal321/ai-usage-mcp/issues/new?template=feature_request.yml)
before writing a large change, so we can agree it fits. Ideas that need a number the data
sources do not record, or that would send data off the machine, are out of scope.

## Pull requests

1. Branch from `main`.
2. Make the change, with tests. A bug fix should come with a test that fails without it.
3. Run `npm run check`. CI runs the same thing on Linux, macOS and Windows, on Node 22 and 24.
4. Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for anything a user
   would notice, written for a user rather than for a reviewer.
5. Open the pull request and fill in the checklist. Link the issue with `Fixes #123` so it
   closes on merge.

Commit messages: a short imperative summary line, then a body that explains **why**, not just
what. Releases are cut by the maintainer from a tag; see
[docs/PUBLISHING.md](docs/PUBLISHING.md) if you are curious how.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
