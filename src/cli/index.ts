#!/usr/bin/env node
import { ArgError, parseArgs, type ParsedArgs } from './args.js';
import { HELP_TEXT } from './commands/help.js';
import { VERSION } from '../version.js';
import { UsageService, type UsageQuery } from '../services/usage-service.js';
import { checkForUpdate } from '../services/update-check.js';
import {
  formatClients,
  formatDaily,
  formatModels,
  formatProjects,
  formatSessionDetail,
  formatSessions,
  formatStatus,
  formatSummary,
  formatSyncReport,
  formatVerify,
} from '../services/formatter.js';

function queryFrom(args: ParsedArgs): UsageQuery {
  const query: UsageQuery = { includeSubagents: args.includeSubagents };
  if (args.today) query.today = true;
  if (args.days !== undefined) query.days = args.days;
  if (args.since !== undefined) query.since = args.since;
  if (args.until !== undefined) query.until = args.until;
  if (args.client !== undefined) query.client = args.client;
  if (args.model !== undefined) query.model = args.model;
  if (args.project !== undefined) query.projectPath = args.project;
  return query;
}

function emit(args: ParsedArgs, text: string, data: unknown): void {
  process.stdout.write(args.json ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);
}

async function run(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(`${err.message}\nRun \`ai-usage help\` for usage.\n`);
      return 2;
    }
    throw err;
  }

  if (args.command === 'version' || args.command === '--version') {
    process.stdout.write(`ai-usage-mcp ${VERSION}\n`);
    return 0;
  }

  if (args.help || args.command === 'help') {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const service = UsageService.open();
  try {
    switch (args.command) {
      case 'status': {
        // The registry check runs alongside the local status work rather than
        // after it, so a slow network never adds to the command's wall time.
        const [status, update] = await Promise.all([
          service.status(),
          checkForUpdate({ current: VERSION }),
        ]);
        emit(args, formatStatus(status, update), {
          version: VERSION,
          ...status,
          ...(update ? { updateAvailable: update } : {}),
        });
        return 0;
      }

      case 'sync': {
        const report = await service.sync({
          ...(args.since ? { since: new Date(args.since) } : {}),
          ...(args.until ? { until: new Date(args.until) } : {}),
          ...(args.allStores ? { allStores: true } : {}),
          ...(args.full ? { full: true } : {}),
          ...(args.client ? { clients: [args.client] } : {}),
        });
        emit(args, formatSyncReport(report), report);
        return report.results.some((r) => !r.available && r.reason?.startsWith('Collection failed'))
          ? 1
          : 0;
      }

      case 'stats': {
        const report = service.summary(queryFrom(args));
        emit(args, formatSummary(report, service.costService), report);
        return 0;
      }

      case 'models': {
        const report = service.modelUsage(queryFrom(args), args.limit);
        emit(args, formatModels(report, service.costService), report);
        return 0;
      }

      case 'clients': {
        const report = service.clientUsage(queryFrom(args));
        emit(args, formatClients(report, service.costService), report);
        return 0;
      }

      case 'projects': {
        const report = service.projectUsage(queryFrom(args), args.limit);
        emit(args, formatProjects(report, service.costService), report);
        return 0;
      }

      case 'sessions': {
        const sessions = service.recentSessions(queryFrom(args), args.limit ?? 20);
        emit(args, formatSessions(sessions, service.costService), sessions);
        return 0;
      }

      case 'session': {
        const id = args.positionals[0];
        if (!id) {
          process.stderr.write('Usage: ai-usage session <session-id>\n');
          return 2;
        }
        const result = service.sessionUsage(id, args.includeSubagents);
        if (!result) {
          process.stderr.write(
            `No session matching "${id}". Try \`ai-usage sessions\` to list known sessions.\n`,
          );
          return 1;
        }
        if ('ambiguous' in result) {
          process.stderr.write(
            `"${id}" matches ${result.ambiguous.length} sessions:\n${result.ambiguous.map((s) => `  ${s}`).join('\n')}\n`,
          );
          return 1;
        }
        emit(args, formatSessionDetail(result, service.costService), result);
        return 0;
      }

      case 'daily': {
        const report = service.dailyUsage(queryFrom(args));
        emit(args, formatDaily(report), report);
        return 0;
      }

      case 'verify': {
        // Sync first, then compare only what existed at that moment: the clients
        // keep writing while we read, and a cutoff is the only way the diff can
        // be exactly zero rather than "a couple of requests behind".
        await service.sync({ ...(args.allStores ? { allStores: true } : {}) });
        const cutoff = new Date();
        const report = await service.verify({
          cutoff,
          ...(args.allStores ? { allStores: true } : {}),
        });
        emit(args, formatVerify(report), report);
        return report.allMatch ? 0 : 1;
      }

      default: {
        process.stderr.write(`Unknown command "${args.command}".\n\n${HELP_TEXT}`);
        return 2;
      }
    }
  } finally {
    service.close();
  }
}

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`ai-usage: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
