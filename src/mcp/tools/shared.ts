import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { UsageService, UsageQuery } from '../../services/usage-service.js';
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
  projectPath: z
    .string()
    .optional()
    .describe(
      'Restrict to one project, given as the absolute working directory the turns ran in. ' +
        'Must match exactly; use project_usage to see the available paths.',
    ),
};

export const clientEnum = z
  .enum(['claude-code', 'opencode'])
  .optional()
  .describe('Restrict to a single client.');

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

export type PeriodArgs = {
  days?: number;
  today?: boolean;
  since?: string;
  until?: string;
  includeSubagents?: boolean;
  client?: 'claude-code' | 'opencode';
  model?: string;
  projectPath?: string;
};

export function toQuery(args: PeriodArgs): UsageQuery {
  const query: UsageQuery = {};
  if (args.days !== undefined) query.days = args.days;
  if (args.today !== undefined) query.today = args.today;
  if (args.since !== undefined) query.since = args.since;
  if (args.until !== undefined) query.until = args.until;
  if (args.includeSubagents !== undefined) query.includeSubagents = args.includeSubagents;
  if (args.client !== undefined) query.client = args.client;
  if (args.model !== undefined) query.model = args.model;
  if (args.projectPath !== undefined) query.projectPath = args.projectPath;
  return query;
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
