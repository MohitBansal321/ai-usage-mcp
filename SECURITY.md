# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/MohitBansal321/ai-usage-mcp/security/advisories/new)
rather than opening a public issue.

Please include what an attacker could achieve, and the steps to reproduce it. You can expect
an initial response within a week.

## Threat model

This is a local-first tool with a deliberately small attack surface, and that is the main
security property worth protecting:

- **No network code.** The package makes no outbound requests: no telemetry, no analytics, no
  crash reporting, no cloud sync. It never calls an LLM API and handles no API keys.
- **No conversation content is read.** The collectors extract token counts, model ids,
  timestamps, session ids and project paths. Prompts, completions, tool inputs and file
  contents are skipped, so they never reach the database.
- **Source data is opened read-only.** A running OpenCode is never disturbed.
- **All state is one local SQLite file**, by default
  `~/.local/share/ai-usage-mcp/usage.db`. Deleting it erases everything the tool knows.

A change that introduces an outbound request, or that stores conversation content, should be
treated as a security-relevant change and called out explicitly in review.

## What is in scope

- Reading or transmitting data beyond the token metadata described above.
- Writing to, corrupting, or locking a source client's database.
- Path traversal or command injection through project paths, session ids or transcript
  contents, which are all attacker-influenceable if someone can write to the source
  directories.
- SQL injection through any collected value.

## What is not in scope

- Cost figures being inaccurate because a pricing table is out of date. Prices change; use a
  [pricing override](README.md#correcting-prices-yourself). Cost is always labelled with its
  basis, and an unknown model reports `unavailable` rather than a guess.
- The database being readable by other processes running as the same user. It carries the
  same trust boundary as the source data it is derived from.

## Supported versions

Only the latest published version receives fixes while the project is pre-1.0.
