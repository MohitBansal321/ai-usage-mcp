import { z } from 'zod';
import type { UsageService, UsageQuery } from '../../services/usage-service.js';

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

export function textResult(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}
