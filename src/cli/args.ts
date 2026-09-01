export interface ParsedArgs {
  command: string;
  positionals: string[];
  today: boolean;
  days?: number;
  since?: string;
  until?: string;
  client?: 'claude-code' | 'opencode';
  model?: string;
  limit?: number;
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

function toPositiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new ArgError(`${flag} expects a positive integer, got "${raw}".`);
  return n;
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
        args.since = requireValue('--since', rest.shift());
        break;
      case '--until':
        args.until = requireValue('--until', rest.shift());
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
        args.model = requireValue('--model', rest.shift());
        break;
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

  return args;
}
