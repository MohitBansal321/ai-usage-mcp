import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { UsageService, UsageQuery } from '../../services/usage-service.js';
import type { PageRequest, SortKey } from '../../db/repositories/usage-repository.js';
import type { PageInfo } from '../../services/aggregation-service.js';
import { takeUpdateNotice } from '../notice.js';

/** Period + scope parameters shared by the period-based tools. */
export const periodShape = {
  days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Look back this many days, counted from local midnight. Omit for all time.'),
  today: z.boolean().optional().describe('Restrict to today, in local time.'),
  since: z.string().optional().describe('ISO 8601 start of the period (inclusive).'),
  until: z.string().optional().describe('ISO 8601 end of the period (exclusive).'),
  includeSubagents: z
    .boolean()
    .optional()
    .describe(
      'Include subagent/sidechain turns. Defaults to true, because they are real spend. ' +
        'Set false to see only main-thread turns.',
    ),
  projectPaths: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Restrict to any of these projects, given as the absolute working directories the turns ' +
        'ran in. Each must match exactly; use project_usage to see the available paths. ' +
        'A value matching no record anywhere is reported as such rather than returning an ' +
        'empty period.',
    ),
  models: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Restrict to any of these model ids, exactly as the client recorded them. ' +
        'Use model_usage to see the ids present.',
    ),
  /**
   * The pre-0.8.0 spelling, still honoured.
   *
   * Dropping it would not have failed loudly: an unknown argument is stripped
   * before the handler sees it, so a caller still passing `projectPath` would
   * have had its filter silently vanish and received the WHOLE database
   * presented as one project's usage. That is the one failure this project
   * cannot have, so the old spelling keeps working.
   */
  projectPath: z
    .string()
    .min(1)
    .optional()
    .describe('Deprecated spelling of projectPaths, for one project. Still honoured.'),
};

/**
 * Accepts a list, or the single string callers used before 0.8.0. The bare
 * string is the older shape and errors loudly rather than silently if dropped,
 * but there is no reason to break it when accepting both costs one union.
 */
export const clientEnum = z
  .union([z.enum(['claude-code', 'opencode']), z.array(z.enum(['claude-code', 'opencode']))])
  .optional()
  .describe('Restrict to any of these clients. A single client id is also accepted.');

/** Ordering and paging, shared by every list-shaped tool. */
export const pageShape = {
  limit: z.number().int().positive().max(500).optional().describe('Rows to return.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Rows to skip, for paging. Use the `nextOffset` from the previous result.'),
  sort: z
    .enum(['tokens', 'reported-cost', 'estimated-cost', 'records', 'sessions', 'recent'])
    .optional()
    .describe(
      'Row ordering, descending. There is deliberately no plain "cost": reported and ' +
        'estimated cost are separate figures that are never summed, so ordering by one sorts ' +
        'every row priced on the other basis as though it were $0. Pick the basis you mean; ' +
        'the result reports how many rows that ordering could not speak for.',
    ),
};

export type PageArgs = { limit?: number; offset?: number; sort?: SortKey };

export function toPageRequest(args: PageArgs): PageRequest {
  const page: PageRequest = {};
  if (args.limit !== undefined) page.limit = args.limit;
  if (args.offset !== undefined) page.offset = args.offset;
  if (args.sort !== undefined) page.sort = args.sort;
  return page;
}

/**
 * Display name plus the annotations that every tool in this server shares.
 *
 * Every tool only reads -- from the collectors' source files and from our own
 * SQLite -- so `readOnlyHint` lets a client stop prompting for confirmation on
 * each call. `openWorldHint: false` is the other half of that: the server makes
 * no network calls, so its domain of interaction is closed. `destructiveHint`
 * and `idempotentHint` are deliberately absent; the spec defines both as
 * meaningful only when `readOnlyHint` is false.
 *
 * The title is returned twice on purpose. `Tool.title` is the current field, but
 * the spec's display-name precedence is `title` -> `annotations.title` -> `name`,
 * so a client written against an earlier revision reads `annotations.title` and
 * would otherwise fall back to the snake_case tool name. Both come from this one
 * argument, so the two copies cannot drift apart.
 */
export function readOnlyTool(title: string): { title: string; annotations: ToolAnnotations } {
  return {
    title,
    annotations: { title, readOnlyHint: true, openWorldHint: false },
  };
}

export interface ToolContext {
  service: UsageService;
  /** Brings the local database up to date before a read. */
  ensureFresh(): Promise<void>;
}

type ClientArg = 'claude-code' | 'opencode';

export type PeriodArgs = {
  days?: number;
  today?: boolean;
  since?: string;
  until?: string;
  includeSubagents?: boolean;
  client?: ClientArg | ClientArg[];
  models?: string[];
  projectPaths?: string[];
  /** Pre-0.8.0 spelling of `projectPaths`. */
  projectPath?: string;
};

export function toQuery(args: PeriodArgs): UsageQuery {
  const query: UsageQuery = {};
  if (args.days !== undefined) query.days = args.days;
  if (args.today !== undefined) query.today = args.today;
  if (args.since !== undefined) query.since = args.since;
  if (args.until !== undefined) query.until = args.until;
  if (args.includeSubagents !== undefined) query.includeSubagents = args.includeSubagents;
  if (args.client !== undefined)
    query.clients = Array.isArray(args.client) ? args.client : [args.client];
  if (args.models !== undefined) query.models = args.models;
  // The old singular spelling still filters. Both given is not a conflict worth
  // an error: the plural is the current one, so it wins.
  if (args.projectPaths !== undefined) query.projectPaths = args.projectPaths;
  else if (args.projectPath !== undefined) query.projectPaths = [args.projectPath];
  return query;
}

/** The page envelope, mirrored into `structuredContent` beside the rows. */
export function pageStructured(info: PageInfo) {
  return {
    total: info.total,
    offset: info.offset,
    ...(info.limit !== undefined ? { limit: info.limit } : {}),
    hasMore: info.hasMore,
    ...(info.nextOffset !== undefined ? { nextOffset: info.nextOffset } : {}),
    sort: info.sort,
    rowsWithoutSortValue: info.rowsWithoutSortValue,
  };
}

/**
 * A tool result, plus the update notice if one is waiting.
 *
 * The notice is a *second* content block, never appended to the first: the data
 * block has to stay byte-identical to what the CLI prints for the same query
 * (`ai-usage stats --today` and `usage_summary` are asserted equal), and a
 * consumer reading `content[0]` should get usage, not server housekeeping. It is
 * mirrored into `structuredContent.serverNotice` for the same reason -- beside
 * the numbers, never mixed into them.
 */
export function textResult(text: string, structured?: Record<string, unknown>) {
  const notice = takeUpdateNotice();
  const content = [{ type: 'text' as const, text }];
  if (notice) content.push({ type: 'text' as const, text: notice });
  return {
    content,
    ...(structured
      ? { structuredContent: { ...structured, ...(notice ? { serverNotice: notice } : {}) } }
      : {}),
  };
}

export function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}
