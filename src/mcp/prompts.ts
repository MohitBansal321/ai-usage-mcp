import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Prompts surface in Claude Code as slash commands (`/ai-usage:daily-review`).
 * They carry no data themselves -- each one asks the agent to call the tools in
 * a particular order and hold to the cost-reporting rules while summarising, so
 * a user does not have to remember either.
 */
const HONESTY =
  'Never add the reported and estimated cost figures together: reported cost is what a client ' +
  'actually charged, while the estimated figure is an API-equivalent list price for a client ' +
  'that records no cost. Report anything unavailable as unavailable rather than as zero.';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'daily-review',
    {
      title: 'Review usage for a period',
      description:
        'Summarise usage over a period: totals, which client and model dominated, and how it ' +
        'compares with the days around it.',
      argsSchema: {
        days: z
          .string()
          .optional()
          .describe('How many days back to review. Defaults to 7 if omitted.'),
      },
    },
    ({ days }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Review my coding-agent usage for the last ${days ?? '7'} days.\n\n` +
              'Call usage_summary for the period, then daily_usage to see the shape of it, then ' +
              'client_usage and model_usage to see where it went. Tell me the total, which day ' +
              'was heaviest, and which client and model dominated.\n\n' +
              `${HONESTY}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'why-was-today-expensive',
    {
      title: 'Explain today’s spend',
      description: 'Diagnose what actually drove cost today, rather than only reporting the total.',
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Work out what drove my coding-agent cost today, and be specific about the cause.\n\n' +
              'Call usage_summary with today=true, then model_usage and project_usage for today, ' +
              'then recent_sessions. Look especially at the token breakdown: cache reads are ' +
              'usually the largest class by far, and a long-running session re-reads its whole ' +
              'context on every turn, so cost can be driven by context size rather than by how ' +
              'much work was asked for. Say which sessions and projects dominated and why.\n\n' +
              `${HONESTY}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'project-cost',
    {
      title: 'Cost for one project',
      description: 'Break down usage and cost for a single project or repository.',
      argsSchema: {
        project: z
          .string()
          .optional()
          .describe('Absolute path of the project. Omit to compare every project.'),
      },
    },
    ({ project }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: project
              ? `How much has the project at ${project} cost me?\n\n` +
                `Call project_usage to confirm the exact path, then usage_summary, model_usage ` +
                `and recent_sessions with projectPath set to it. Report tokens by class and the ` +
                `cost.\n\n${HONESTY}`
              : 'Compare what each of my projects has cost.\n\n' +
                'Call project_usage, then look at the top few with recent_sessions to explain ' +
                `what drove the largest one.\n\n${HONESTY}`,
          },
        },
      ],
    }),
  );
}
