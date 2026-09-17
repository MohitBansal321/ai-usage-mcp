export const HELP_TEXT = `ai-usage -- local token usage and cost across coding agents

Usage: ai-usage <command> [options]

Commands:
  status                Collectors, data stores, database path, record counts, last sync
  sync                  Run the collectors and store what they find
  stats                 Totals for a period, split by client   (same numbers as the usage_summary MCP tool)
  models                Per-model tokens and cost              (same as model_usage)
  clients               Per-client tokens and cost             (same as client_usage)
  projects              Per-project tokens and cost            (same as project_usage)
  sessions              Recent sessions                        (same as recent_sessions)
  session <id>          One session in detail                  (same as session_usage)
  daily                 Per-day breakdown                      (same as daily_usage)
  counterfactual        These tokens on another model          (same as counterfactual_cost)
  verify                Re-read the source data and diff it against the local database
  version               Print the installed version
  help                  Show this text

Period options (default: all time):
  --today               Just today, local time
  --days N              Last N days, from local midnight
  --since <ISO>         Explicit start (inclusive)
  --until <ISO>         Explicit end (exclusive)
  --compare previous    stats only: also report the equal-length window before this one,
                        with the delta. Needs a bounded period; all time has no previous.
  --grain <g>           daily only: hour | day | hour-of-day (default day).
                        hour-of-day collapses every day onto one 24-slot local clock.

Scope options (repeatable, or comma-separated; each matches ANY value given):
  --client <name>       claude-code | opencode
  --model <id>          Restrict to these models      (--model a,b or --model a --model b)
  --project <path>      Restrict to these projects (their working directories)
  --target-models a,b   counterfactual only: models to price the selected tokens AGAINST.
                        Not a filter -- \`--model\` chooses which turns, this chooses the
                        rates. (\`--models\` is an accepted alias.)

List options (sessions, models, projects, clients):
  --limit N             Rows to return
  --offset N            Rows to skip, for paging. Output tells you the next offset.
  --sort <key>          tokens | reported-cost | estimated-cost | records | sessions | recent
                        Default: recent for sessions, tokens elsewhere. There is no plain
                        \`cost\`: reported and estimated cost are never summed, so ordering by
                        one sorts every row priced on the other basis as $0.
  --no-subagents        Exclude subagent/sidechain turns (included by default)
  --all-stores          Read every detected data store, not only the one the client itself uses
  --full                Ignore saved sync cursors and re-read everything
  --json                Emit JSON instead of text

Examples:
  ai-usage sync
  ai-usage stats --today
  ai-usage stats --days 7
  ai-usage models --days 30 --client claude-code
  ai-usage projects --days 30
  ai-usage stats --days 7 --compare previous
  ai-usage daily --days 7 --grain hour
  ai-usage daily --days 30 --grain hour-of-day
  ai-usage sessions --limit 5
  ai-usage sessions --sort estimated-cost --limit 5     # the costliest, not the latest
  ai-usage projects --sort estimated-cost --limit 10
  ai-usage sessions --limit 100 --offset 100            # page two
  ai-usage models --model claude-opus-5,claude-sonnet-5
  ai-usage counterfactual --today --target-models claude-sonnet-5,claude-haiku-4-5
  ai-usage counterfactual --model claude-opus-5 --target-models claude-sonnet-5
  ai-usage verify

Notes:
  \`status\` also checks npm for a newer version, at most once a day. It sends no
  data, gives up after 1.5s offline, and \`AI_USAGE_NO_UPDATE_CHECK=1\` disables it.

  Cost from OpenCode is what OpenCode reported. Cost for Claude Code is an
  API-equivalent estimate from a versioned pricing table, because Claude Code
  records no cost -- on a Pro/Max subscription your marginal cost per request is
  $0. The two are never added together.
`;
