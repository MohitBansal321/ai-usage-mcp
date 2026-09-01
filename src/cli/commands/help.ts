export const HELP_TEXT = `ai-usage -- local token usage and cost across coding agents

Usage: ai-usage <command> [options]

Commands:
  status                Collectors, data stores, database path, record counts, last sync
  sync                  Run the collectors and store what they find
  stats                 Totals for a period, split by client   (same numbers as the usage_summary MCP tool)
  models                Per-model tokens and cost              (same as model_usage)
  clients               Per-client tokens and cost             (same as client_usage)
  sessions              Recent sessions                        (same as recent_sessions)
  session <id>          One session in detail                  (same as session_usage)
  daily                 Per-day breakdown
  verify                Re-read the source data and diff it against the local database
  version               Print the installed version
  help                  Show this text

Period options (default: all time):
  --today               Just today, local time
  --days N              Last N days, from local midnight
  --since <ISO>         Explicit start (inclusive)
  --until <ISO>         Explicit end (exclusive)

Scope options:
  --client <name>       claude-code | opencode
  --model <id>          Restrict to one model
  --limit N             Row limit (sessions, models)
  --no-subagents        Exclude subagent/sidechain turns (included by default)
  --all-stores          Read every detected data store, not only the one the client itself uses
  --full                Ignore saved sync cursors and re-read everything
  --json                Emit JSON instead of text

Examples:
  ai-usage sync
  ai-usage stats --today
  ai-usage stats --days 7
  ai-usage models --days 30 --client claude-code
  ai-usage sessions --limit 5
  ai-usage verify

Notes:
  Cost from OpenCode is what OpenCode reported. Cost for Claude Code is an
  API-equivalent estimate from a versioned pricing table, because Claude Code
  records no cost -- on a Pro/Max subscription your marginal cost per request is
  $0. The two are never added together.
`;
