/**
 * Reading one value out of a report, for scripting.
 *
 * `stats --today --json` returns a whole nested object, so extracting a single
 * number needed `jq` or a Node one-liner -- and there was no exit-code signal to
 * branch on at all, which is what a scheduled job or an alert actually needs.
 */

export class FieldError extends Error {}

/**
 * Resolves a dotted path, with numeric segments indexing arrays.
 *
 * A path that does not exist is an ERROR, not an empty string. A threshold check
 * against a silently-missing field would pass forever, which is the worst
 * possible failure mode for an alert: it looks like everything is fine.
 */
export function readField(data: unknown, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  if (segments.length === 0) throw new FieldError('--field requires a non-empty path.');

  let current: unknown = data;
  const walked: string[] = [];
  for (const segment of segments) {
    walked.push(segment);
    if (current === null || current === undefined) {
      throw new FieldError(
        `--field "${path}" cannot be read: "${walked.slice(0, -1).join('.') || '(root)'}" is ` +
          `${current === null ? 'null' : 'absent'}.`,
      );
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new FieldError(
          `--field "${path}": "${segment}" is not a valid index into an array of ` +
            `${current.length} item(s) at "${walked.slice(0, -1).join('.')}".`,
        );
      }
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') {
      throw new FieldError(
        `--field "${path}": "${walked.slice(0, -1).join('.')}" is a ${typeof current}, ` +
          `so it has no "${segment}".`,
      );
    }
    const record = current as Record<string, unknown>;
    if (!(segment in record)) {
      const available = Object.keys(record).slice(0, 12).join(', ');
      throw new FieldError(
        `--field "${path}": no "${segment}" at "${walked.slice(0, -1).join('.') || '(root)'}". ` +
          `Available: ${available}${Object.keys(record).length > 12 ? ', ...' : ''}.`,
      );
    }
    current = record[segment];
  }
  return current;
}

/** Renders a scalar for a shell to consume: one value, no quotes, no formatting. */
export function renderField(value: unknown, path: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null || value === undefined) {
    throw new FieldError(
      `--field "${path}" is ${value === null ? 'null' : 'undefined'}. A value the source did ` +
        `not report is not 0, so nothing is printed rather than a number that would be wrong.`,
    );
  }
  const shape = Array.isArray(value) ? `an array of ${value.length} item(s)` : typeof value;
  throw new FieldError(
    `--field "${path}" is ${shape}, not a single value. ` +
      `Use --json for structured output, or name a leaf field.`,
  );
}

/**
 * Whether a threshold was breached.
 *
 * Deliberately requires an explicit `--field`, and there is no default.
 *
 * "Fail if cost exceeded $25" has no single answer in this tool: reported and
 * estimated cost are separate figures that are never summed, so a default would
 * silently pick one and ignore every record priced the other way. The caller
 * names the figure, which also means the check reads as what it is --
 * `--field cost.estimated --fail-over 25`.
 */
export function exceedsThreshold(value: unknown, threshold: number, path: string): boolean {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new FieldError(
      `--fail-over needs a number, but --field "${path}" is ${JSON.stringify(value)}.`,
    );
  }
  return numeric > threshold;
}
