import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from '../pricing/index.js';

/** How long a registry answer is trusted before it is fetched again. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** A status report must not hang on a slow or unreachable registry. */
const TIMEOUT_MS = 1500;
const REGISTRY_URL = 'https://registry.npmjs.org/ai-usage-mcp/latest';

export interface UpdateInfo {
  current: string;
  latest: string;
  /** False when the installed build is current, or ahead of the registry. */
  isOutdated: boolean;
}

interface CacheFile {
  checkedAt: number;
  latest: string;
}

export interface UpdateCheckOptions {
  current: string;
  /** Injected in tests; defaults to the real registry lookup. */
  fetchLatest?: () => Promise<string | null>;
  cachePath?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
}

function updateCachePath(): string {
  return join(configDir(), 'update-check.json');
}

function readCache(path: string, now: number): string | null {
  try {
    const cache = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheFile>;
    if (typeof cache.latest !== 'string' || typeof cache.checkedAt !== 'number') return null;
    return now - cache.checkedAt < CACHE_TTL_MS ? cache.latest : null;
  } catch {
    // No cache yet, or a corrupted one. Either way: fetch.
    return null;
  }
}

function writeCache(path: string, latest: string, now: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const cache: CacheFile = { checkedAt: now, latest };
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // A read-only or unwritable config directory must not break `status`; the
    // only cost is that the next run checks the registry again.
  }
}

async function fetchLatestFromRegistry(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Abbreviated metadata: a fraction of the full packument.
        accept: 'application/vnd.npm.install-v1+json',
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    // Offline, DNS failure, timeout, malformed JSON -- all the same answer.
    return null;
  }
}

/**
 * Compares `major.minor.patch`, treating a prerelease as below its own release
 * so a local `0.3.0-rc.1` is not reported as newer than published `0.3.0`.
 *
 * Hand-rolled on purpose: `semver` would be the package's only runtime
 * dependency added for a single comparison, and this project's install story
 * ("no toolchain, no surprises") is worth more than full range support.
 */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number, number] => {
    const [core = '', pre] = v.split('-', 2);
    const [major = 0, minor = 0, patch = 0] = core
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
    return [major, minor, patch, pre ? 0 : 1];
  };
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 4; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

/**
 * Reports whether a newer release is on the registry.
 *
 * Only ever called from `ai-usage status`. It is deliberately absent from the
 * MCP server: that process speaks JSON-RPC over stdout, and it is also
 * unnecessary there, because `npx -y ai-usage-mcp` re-resolves the version on
 * every cold start. Global CLI installs are the ones that go stale silently.
 *
 * Never throws and never blocks for longer than the timeout. Returns null when
 * the answer is unknown (offline, opted out) rather than guessing.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateInfo | null> {
  const env = options.env ?? process.env;
  if (env.AI_USAGE_NO_UPDATE_CHECK === '1' || env.CI) return null;

  const now = options.now ?? Date.now();
  const cachePath = options.cachePath ?? updateCachePath();

  let latest = readCache(cachePath, now);
  if (latest === null) {
    latest = await (options.fetchLatest ?? fetchLatestFromRegistry)();
    if (latest === null) return null;
    writeCache(cachePath, latest, now);
  }

  return { current: options.current, latest, isOutdated: isNewer(latest, options.current) };
}
