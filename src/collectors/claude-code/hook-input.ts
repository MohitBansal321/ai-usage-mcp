/**
 * The JSON Claude Code writes to a hook command's stdin. Only `transcript_path`
 * is read, and like every field of these internal, unversioned payloads it may be
 * absent: a hook that cannot read its input must do nothing, never fail.
 * See docs/DATA_SOURCES.md §2.12.
 *
 * Plain parsing rather than zod, unlike `statusline.ts`: this runs on every
 * prompt, and importing zod alone costs about 30ms of a ~60ms budget.
 */

/** The session's transcript path, or undefined for anything unreadable. Never throws. */
export function parseHookTranscriptPath(raw: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(raw);
    if (typeof payload !== 'object' || payload === null) return undefined;
    const path = (payload as Record<string, unknown>).transcript_path;
    return typeof path === 'string' && path !== '' ? path : undefined;
  } catch {
    return undefined;
  }
}
