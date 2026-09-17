import {
  GROUP_AXES,
  MAX_GROUP_AXES,
  SORT_KEYS,
  TIME_GRAINS,
  type GroupAxis,
  type SortKey,
  type TimeGrain,
} from '../db/repositories/usage-repository.js';

export interface ParsedArgs {
  command: string;
  positionals: string[];
  today: boolean;
  days?: number;
  since?: string;
  until?: string;
  /** Scope filters. Repeatable, or comma-separated; each matches ANY value given. */
  clients?: ClientName[];
  models?: string[];
  projects?: string[];
  limit?: number;
  offset?: number;
  sort?: SortKey;
  grain?: TimeGrain;
  by?: GroupAxis[];
  compare: boolean;
  /** Target models for `counterfactual`. Repeatable, or comma-separated. */
  counterfactualModels?: string[];
  includeSubagents: boolean;
  allStores: boolean;
  full: boolean;
  json: boolean;
  help: boolean;
}

type ClientName = 'claude-code' | 'opencode';

export class ArgError extends Error {}

/**
 * Splits a repeatable, comma-separated flag.
 *
 * `--model a,b` used to be one literal id that matched nothing and reported an
 * empty period at exit 0 -- a typo rendered as a fact about the data. The plural
 * form already existed on `counterfactual --models`, which made the silent empty
 * result more surprising, not less.
 */
function toList(flag: string, raw: string): string[] {
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (values.length === 0) throw new ArgError(`${flag} requires at least one non-empty value.`);
  return values;
}

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

/**
 * `--sort cost` is refused on purpose.
 *
 * Reported and estimated cost are separate figures that must never be summed, so
 * "order by cost" has no single answer: ordering by one sorts every row priced
 * on the other basis as though it were $0. Guessing which the user meant is
 * exactly the wrong-number-that-looks-right this project exists to avoid.
 */
function toSortKey(raw: string): SortKey {
  if (SORT_KEYS.includes(raw as SortKey)) return raw as SortKey;
  if (raw === 'cost') {
    throw new ArgError(
      '--sort cost is ambiguous: reported and estimated cost are separate figures and are ' +
        'never summed, so ordering by one would sort every row priced on the other basis as ' +
        '$0. Use --sort reported-cost or --sort estimated-cost.',
    );
  }
  throw new ArgError(`--sort expects one of ${SORT_KEYS.join(', ')}, got "${raw}".`);
}

function toNonNegativeInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new ArgError(`${flag} expects a non-negative integer, got "${raw}".`);
  return n;
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
    compare: false,
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
        const values = toList('--client', requireNonEmpty('--client', rest.shift()));
        const clients: ClientName[] = values.map((value) => {
          if (value !== 'claude-code' && value !== 'opencode') {
            throw new ArgError(`--client expects "claude-code" or "opencode", got "${value}".`);
          }
          return value;
        });
        args.clients = [...(args.clients ?? []), ...clients];
        break;
      }
      case '--model':
        args.models = [
          ...(args.models ?? []),
          ...toList('--model', requireNonEmpty('--model', rest.shift())),
        ];
        break;
      case '--project':
        args.projects = [
          ...(args.projects ?? []),
          ...toList('--project', requireNonEmpty('--project', rest.shift())),
        ];
        break;
      // `--models` is kept as an alias: it predates `--target-models` and is in
      // the README. The two names exist because `--model` (scope) and `--models`
      // (targets) differ by one letter and mean entirely different things.
      case '--models':
      case '--target-models':
        args.counterfactualModels = [
          ...(args.counterfactualModels ?? []),
          ...toList(token, requireValue(token, rest.shift())),
        ];
        break;

      case '--limit':
        args.limit = toPositiveInt('--limit', requireValue('--limit', rest.shift()));
        break;
      case '--offset':
        args.offset = toNonNegativeInt('--offset', requireValue('--offset', rest.shift()));
        break;
      case '--sort':
        args.sort = toSortKey(requireValue('--sort', rest.shift()));
        break;
      case '--by': {
        const axes = toList('--by', requireNonEmpty('--by', rest.shift()));
        for (const axis of axes) {
          if (!GROUP_AXES.includes(axis as GroupAxis))
            throw new ArgError(`--by expects axes from ${GROUP_AXES.join(', ')}, got "${axis}".`);
        }
        if (new Set(axes).size !== axes.length)
          throw new ArgError(`--by axes must be distinct, got "${axes.join(',')}".`);
        if (axes.length > MAX_GROUP_AXES)
          throw new ArgError(
            `--by accepts at most ${MAX_GROUP_AXES} axes, got ${axes.length}. ` +
              `Crossing more than that is a question for the underlying records.`,
          );
        args.by = [...(args.by ?? []), ...(axes as GroupAxis[])];
        break;
      }
      case '--grain': {
        const value = requireValue('--grain', rest.shift());
        if (!TIME_GRAINS.includes(value as TimeGrain))
          throw new ArgError(`--grain expects one of ${TIME_GRAINS.join(', ')}, got "${value}".`);
        args.grain = value as TimeGrain;
        break;
      }
      case '--compare': {
        const value = requireValue('--compare', rest.shift());
        // Only `previous` for now, but it takes a value rather than being a bare
        // flag so `--compare 2026-08-01..2026-08-07` can be added without
        // changing the shape of what already works.
        if (value !== 'previous')
          throw new ArgError(`--compare expects "previous", got "${value}".`);
        args.compare = true;
        break;
      }
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
