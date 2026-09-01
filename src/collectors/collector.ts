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
