import { z } from 'zod';

/**
 * The JSON Claude Code writes to a configured status-line command's stdin.
 *
 * This is the one place the plan-limit percentages exist: no file Claude Code
 * keeps on disk records how much of the 5-hour or weekly limit is used. Only
 * the fields read here are modelled, and EVERY one is optional -- `rate_limits`
 * is absent for API-key users and before the first response of a session, and
 * the payload is internal and unversioned like the transcripts. See
 * docs/DATA_SOURCES.md §2.11.
 */

/** The two rolling windows a Pro or Max plan is limited by. */
export type PlanLimitWindow = 'five_hour' | 'seven_day';

export const PLAN_LIMIT_WINDOWS: PlanLimitWindow[] = ['five_hour', 'seven_day'];

/** How long each window runs, so its start can be put at `resets_at` minus this. */
export const WINDOW_MS: Record<PlanLimitWindow, number> = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
};

export interface PlanLimitReading {
  window: PlanLimitWindow;
  /** 0 to 100, exactly as Claude Code reported it. */
  usedPercent: number;
  /** ISO 8601, UTC. */
  resetsAt: string;
}

export interface StatusLineInput {
  sessionId?: string;
  /** Claude Code's version, kept beside each reading so odd data can be traced. */
  version?: string;
  /** Empty when the payload carried none -- an API-key user, or no response yet. */
  readings: PlanLimitReading[];
}

const windowSchema = z.object({
  used_percentage: z.number().min(0).max(100),
  resets_at: z.number().positive(),
});

const payload = z.object({
  session_id: z.string().min(1).optional().catch(undefined),
  version: z.string().min(1).optional().catch(undefined),
  rate_limits: z
    .object({
      // `.catch` per window: one malformed window must not throw away the other.
      five_hour: windowSchema.optional().catch(undefined),
      seven_day: windowSchema.optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

/**
 * Reads the status-line payload. Never throws: a status line that errors shows
 * nothing at all, so anything unreadable is treated as "no data", and a value
 * outside its documented range is dropped rather than stored.
 */
export function parseStatusLineInput(raw: string): StatusLineInput {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { readings: [] };
  }
  const parsed = payload.safeParse(json);
  if (!parsed.success) return { readings: [] };

  const input: StatusLineInput = { readings: [] };
  if (parsed.data.session_id) input.sessionId = parsed.data.session_id;
  if (parsed.data.version) input.version = parsed.data.version;
  for (const name of PLAN_LIMIT_WINDOWS) {
    const w = parsed.data.rate_limits?.[name];
    if (!w) continue;
    // `resets_at` is Unix epoch SECONDS. A value in milliseconds would land
    // tens of thousands of years out, which no reset is.
    const resetsAt = new Date(w.resets_at * 1000);
    if (Number.isNaN(resetsAt.getTime()) || resetsAt.getUTCFullYear() > 9999) continue;
    input.readings.push({
      window: name,
      usedPercent: w.used_percentage,
      resetsAt: resetsAt.toISOString(),
    });
  }
  return input;
}
