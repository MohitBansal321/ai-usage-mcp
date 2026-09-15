export interface ParsedArgs {
  command: string;
  positionals: string[];
  today: boolean;
  days?: number;
  since?: string;
  until?: string;
  client?: 'claude-code' | 'opencode';
  model?: string;
  project?: string;
  limit?: number;
  /** Target models for `counterfactual`. Repeatable, or comma-separated. */
  models?: string[];
  includeSubagents: boolean;
  allStores: boolean;
  full: boolean;
  json: boolean;
  help: boolean;
}

export class ArgError extends Error {}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new ArgError(`${flag} requires a value.`);
  return value;
}

/**
 * Rejects a filter that would silently stop filtering.
 *
 * An empty `--model ""` is falsy, so it used to be dropped on the way to the
 * query and the command answered with the *unfiltered* totals -- the whole
 * database, presented as though the filter had applied. That is the one failure
 * mode this project cannot have: a wrong number that looks like a right one.
 * `--models ""` already refused; these now agree with it.
 */
function requireNonEmpty(flag: string, value: string | undefined): string {
  const v = requireValue(flag, value);
  if (v.trim() === '') throw new ArgError(`${flag} requires a non-empty value.`);
  return v;
}

function toPositiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new ArgError(`${flag} expects a positive integer, got "${raw}".`);
  return n;
}

/**
 * Rejects a date the parser cannot read, rather than carrying it inwards.
 *
 * `new Date('nonsense')` is not an error, it is an Invalid Date -- and it stays
 * quiet until something calls `.toISOString()` on it, which is where the period
 * is resolved, several layers in. That surfaced a raw `RangeError: Invalid time
 * value` stack trace and exit 1, where every other bad flag here gives one clean
 * line and exit 2. The value is checked at the boundary it enters through.
 */
function toTimestamp(flag: string, raw: string): string {
  if (Number.isNaN(new Date(raw).getTime()))
    throw new ArgError(
      `${flag} expects an ISO 8601 date or date-time, got "${raw}". Example: ${flag} 2026-09-01.`,
    );
  return raw;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'help',
    positionals: [],
    today: false,
    includeSubagents: true,
    allStores: false,
    full: false,
    json: false,
    help: false,
  };

  const rest = [...argv];
  const first = rest[0];
  if (first && !first.startsWith('-')) {
    args.command = first;
    rest.shift();
  }

  while (rest.length > 0) {
    const token = rest.shift() as string;
    switch (token) {
      case '--today':
        args.today = true;
        break;
      case '--days':
        args.days = toPositiveInt('--days', requireValue('--days', rest.shift()));
        break;
      case '--since':
        args.since = toTimestamp('--since', requireValue('--since', rest.shift()));
        break;
      case '--until':
        args.until = toTimestamp('--until', requireValue('--until', rest.shift()));
        break;
      case '--client': {
        const value = requireValue('--client', rest.shift());
        if (value !== 'claude-code' && value !== 'opencode') {
          throw new ArgError(`--client expects "claude-code" or "opencode", got "${value}".`);
        }
        args.client = value;
        break;
      }
      case '--model':
        args.model = requireNonEmpty('--model', rest.shift());
        break;
      case '--project':
        args.project = requireNonEmpty('--project', rest.shift());
        break;
      case '--models': {
        const raw = requireValue('--models', rest.shift());
        const names = raw
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean);
        if (names.length === 0) throw new ArgError('--models requires at least one model name.');
        args.models = [...(args.models ?? []), ...names];
        break;
      }

      case '--limit':
        args.limit = toPositiveInt('--limit', requireValue('--limit', rest.shift()));
        break;
      case '--no-subagents':
        args.includeSubagents = false;
        break;
      case '--all-stores':
        args.allStores = true;
        break;
      case '--full':
        args.full = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.command = 'version';
        break;
      default:
        if (token.startsWith('-')) throw new ArgError(`Unknown option "${token}".`);
        args.positionals.push(token);
    }
  }

  // Checked here rather than per-flag, because the ordering is only knowable
  // once both bounds have been seen, whichever order they were typed in.
  if (args.since && args.until && new Date(args.since) >= new Date(args.until))
    throw new ArgError(
      `--since must be before --until, got --since "${args.since}" and --until "${args.until}".`,
    );

  return args;
}
