#!/usr/bin/env node
import { ArgError, parseArgs, type ParsedArgs } from './args.js';
import { FieldError, exceedsThreshold, readField, renderField } from './field.js';
import { HELP_TEXT } from './commands/help.js';
import { VERSION } from '../version.js';
import { UsageService, type UsageQuery } from '../services/usage-service.js';
import type { PageRequest } from '../db/repositories/usage-repository.js';
import { checkForUpdate } from '../services/update-check.js';
import {
  formatBreakdown,
  formatBudget,
  formatClients,
  formatCounterfactual,
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
  if (args.clients !== undefined) query.clients = args.clients;
  if (args.models !== undefined) query.models = args.models;
  if (args.projects !== undefined) query.projectPaths = args.projects;
  return query;
}

/** The limit/offset/sort a list-shaped command was asked for. */
function pageFrom(args: ParsedArgs): PageRequest {
  const page: PageRequest = {};
  if (args.limit !== undefined) page.limit = args.limit;
  if (args.offset !== undefined) page.offset = args.offset;
  if (args.sort !== undefined) page.sort = args.sort;
  return page;
}

/**
 * Renders a command's result, and reports whether a threshold was breached.
 *
 * `--field` prints ONE value and nothing else, so a shell can consume it without
 * `jq`. `--fail-over` turns the same value into an exit code, which is the other
 * half of being usable from a scheduled job: a report nobody reads cannot page
 * anyone.
 *
 * @returns true when `--fail-over` was given and the threshold was exceeded.
 */
function emit(args: ParsedArgs, text: string, data: unknown): boolean {
  if (args.field !== undefined) {
    const value = readField(data, args.field);
    process.stdout.write(`${renderField(value, args.field)}\n`);
    if (args.failOver === undefined) return false;
    if (!exceedsThreshold(value, args.failOver, args.field)) return false;
    process.stderr.write(
      `ai-usage: ${args.field} is ${String(value)}, over the --fail-over threshold ` +
        `of ${args.failOver}.\n`,
    );
    return true;
  }
  process.stdout.write(args.json ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);
  return false;
}

/** Exit 1 on a breached threshold, 0 otherwise -- the value a script branches on. */
const THRESHOLD_EXIT = 1;

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
        return emit(args, formatStatus(status, update), {
          version: VERSION,
          ...status,
          ...(update ? { updateAvailable: update } : {}),
        })
          ? THRESHOLD_EXIT
          : 0;
      }

      case 'sync': {
        const report = await service.sync({
          ...(args.since ? { since: new Date(args.since) } : {}),
          ...(args.until ? { until: new Date(args.until) } : {}),
          ...(args.allStores ? { allStores: true } : {}),
          ...(args.full ? { full: true } : {}),
          ...(args.clients ? { clients: args.clients } : {}),
        });
        emit(args, formatSyncReport(report), report);
        return report.results.some((r) => !r.available && r.reason?.startsWith('Collection failed'))
          ? 1
          : 0;
      }

      case 'stats': {
        const report = service.summary(queryFrom(args), { compare: args.compare });
        return emit(args, formatSummary(report, service.costService), report) ? THRESHOLD_EXIT : 0;
      }

      case 'models': {
        const report = service.modelUsage(queryFrom(args), pageFrom(args));
        return emit(args, formatModels(report, service.costService), report) ? THRESHOLD_EXIT : 0;
      }

      case 'clients': {
        const report = service.clientUsage(queryFrom(args), pageFrom(args));
        return emit(args, formatClients(report, service.costService), report) ? THRESHOLD_EXIT : 0;
      }

      case 'projects': {
        const report = service.projectUsage(queryFrom(args), pageFrom(args));
        return emit(args, formatProjects(report, service.costService), report) ? THRESHOLD_EXIT : 0;
      }

      case 'sessions': {
        const page = service.recentSessions(queryFrom(args), pageFrom(args));
        return emit(args, formatSessions(page, service.costService), page) ? THRESHOLD_EXIT : 0;
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
        return emit(args, formatSessionDetail(result, service.costService), result)
          ? THRESHOLD_EXIT
          : 0;
      }

      case 'budget': {
        if (args.amount === undefined) {
          process.stderr.write(
            'Usage: ai-usage budget --amount <n> --basis reported|estimated [--period month|week]\n',
          );
          return 2;
        }
        if (args.basis === undefined) {
          // No default, for the same reason --fail-over has none: reported and
          // estimated cost are separate figures that are never summed, so a
          // budget with no stated basis is a budget against nothing in
          // particular -- and the right answer differs for a subscriber.
          process.stderr.write(
            'budget requires --basis reported|estimated.\n' +
              '  reported  = what a client actually charged. Claude Code reports no cost, so\n' +
              '              its usage is NOT counted on this basis.\n' +
              '  estimated = API-equivalent list price. On a Pro/Max subscription your marginal\n' +
              '              cost per request is $0, so this is a shadow price, not a bill.\n' +
              'There is no default: the two are never summed, so one must be chosen.\n',
          );
          return 2;
        }
        const report = service.budget({
          amount: args.amount,
          basis: args.basis,
          period: args.budgetPeriod ?? 'month',
          query: queryFrom(args),
        });
        const breached = emit(args, formatBudget(report), report);
        // Exit 1 on a fact (spend already over), never on a forecast: a
        // projection is a claim about the future, and failing a nightly job on
        // one would page somebody about arithmetic rather than about spend.
        // `--fail-over` remains available for thresholding a projection on purpose.
        if (breached) return THRESHOLD_EXIT;
        return report.overBudget ? THRESHOLD_EXIT : 0;
      }

      case 'export': {
        // Streamed, not buffered: a record-level export of a busy database is
        // hundreds of thousands of rows, and building one string would hold the
        // whole export in memory only to hand it to a pipe a line at a time.
        const { filter } = service.exportFilter(queryFrom(args));
        const result = service.exportRecords(filter, (line) => process.stdout.write(`${line}\n`), {
          ...(args.format ? { format: args.format } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        if (result.rows < result.total) {
          process.stderr.write(
            `ai-usage: exported ${result.rows} of ${result.total} matching record(s) ` +
              `(--limit ${args.limit}). Drop --limit to export them all.\n`,
          );
        }
        return 0;
      }

      case 'breakdown': {
        if (!args.by?.length) {
          process.stderr.write(
            'Usage: ai-usage breakdown --by <axis>[,<axis>]\n' +
              'Example: ai-usage breakdown --by project,day --days 30\n',
          );
          return 2;
        }
        const report = service.breakdown(args.by, queryFrom(args), pageFrom(args));
        return emit(args, formatBreakdown(report), report) ? THRESHOLD_EXIT : 0;
      }

      case 'daily': {
        const report = service.dailyUsage(queryFrom(args), args.grain);
        return emit(args, formatDaily(report), report) ? THRESHOLD_EXIT : 0;
      }

      case 'counterfactual': {
        const report = service.counterfactualCost(queryFrom(args), args.counterfactualModels);
        return emit(args, formatCounterfactual(report, service.costService), report)
          ? THRESHOLD_EXIT
          : 0;
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
  } catch (err) {
    // A bad --field is a usage error, like any other bad flag: one clean line
    // and exit 2, not a stack trace. Getting this wrong matters more here than
    // elsewhere, because the caller is a script reading the exit code.
    if (err instanceof FieldError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  } finally {
    service.close();
  }
}

/**
 * The exit code is *set*, never forced with `process.exit()`.
 *
 * A hard exit tears the process down while libuv handles are still closing. On
 * Windows that is not merely untidy: once the update check has opened a TLS
 * connection to the registry, `process.exit()` trips an assertion inside libuv
 * itself --
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
 *
 * -- which aborts the process with code 127 *after* the report has already been
 * printed in full. The output is correct and the exit status says catastrophic
 * failure, so anything scripting this command sees a hard failure roughly once a
 * day: the registry answer is cached for 24h, so it is the first run after that
 * cache expires that pays. `AI_USAGE_NO_UPDATE_CHECK=1` avoided it only by
 * skipping the fetch entirely.
 *
 * Setting `exitCode` and letting the loop drain is both correct and measurably
 * faster here, because nothing is left half-closed on the way out.
 */
run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`ai-usage: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  });
