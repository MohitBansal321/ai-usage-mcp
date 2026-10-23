import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

export type {
  UsageCollector,
  CollectOptions,
  CollectResult,
  CollectorAvailability,
  StoreInfo,
} from '../models/usage-record.js';

/** Epoch milliseconds -> ISO 8601 UTC. Returns undefined for junk input. */
export function msToIso(ms: unknown): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  const iso = d.toISOString();
  return Number.isNaN(d.getTime()) ? undefined : iso;
}

export function isWithin(iso: string, since?: Date, until?: Date): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  if (since && t < since.getTime()) return false;
  if (until && t >= until.getTime()) return false;
  return true;
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A file's bytes up to `sizeBytes`, or all of them when that is undefined.
 *
 * Transcripts and rollouts are appended to while we read them. A collector reads
 * a file only up to the size it listed, the size its cursor then records, so
 * `verify` can re-read exactly the bytes that were collected. Reading on to the
 * end put lines written between a sync and a verify on one side only, and
 * `verify` reported every session still running as a mismatch.
 */
export function readUpTo(path: string, sizeBytes: number | undefined): Readable {
  if (sizeBytes === undefined) return createReadStream(path);
  // A zero-length range is out of range for createReadStream.
  if (sizeBytes <= 0) return Readable.from([]);
  return createReadStream(path, { start: 0, end: sizeBytes - 1 });
}

/** The size each file had when a cursor recorded it as ingested, by path. */
export function ingestedSizes(files: Record<string, { sizeBytes: number }>): Map<string, number> {
  return new Map(Object.entries(files).map(([path, f]) => [path, f.sizeBytes]));
}
