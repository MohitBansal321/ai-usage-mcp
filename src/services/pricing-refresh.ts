import {
  communityPricingDisabledBy,
  communityPricingPath,
  communityPricingUrl,
  convertLiteLLMPrices,
  readCommunityPricing,
  writeCommunityPricing,
} from '../pricing/index.js';

/** How long a downloaded price list is trusted before it is fetched again. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
/**
 * The list is ~3 MB, so this is far longer than the update check's 1.5s. It
 * never runs on a path anybody waits for: the MCP server refreshes in the
 * background, and the CLI's `sync` refreshes alongside its own work.
 */
const TIMEOUT_MS = 20_000;
/** How often a long-running server looks again. Cheap: a fresh cache is one small file read. */
const WATCH_INTERVAL_MS = 60 * 60 * 1000;

export type PricingRefreshResult =
  | { status: 'disabled'; reason: string }
  | { status: 'fresh'; fetchedAt: string }
  | { status: 'updated'; fetchedAt: string; models: number }
  | { status: 'failed'; reason: string };

export interface PricingRefreshOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  cachePath?: string;
  /** Injected in tests; defaults to downloading the list. */
  download?: (url: string) => Promise<unknown>;
  /** Ignore the cache's age. */
  force?: boolean;
}

/**
 * The second of the package's two network requests (the first is the update
 * check): a GET for LiteLLM's public price list. It sends no usage data and no
 * identifier.
 */
export async function downloadPriceList(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/**
 * Downloads the community price list if the cached copy is more than a day old.
 *
 * Never throws. A failure leaves the cached copy -- and so the prices in force
 * -- exactly as they were: an old list is still correct for every model it
 * covers, and a list that downloads but yields no usable prices is treated as a
 * failure rather than allowed to replace one that did.
 */
export async function refreshCommunityPricing(
  options: PricingRefreshOptions = {},
): Promise<PricingRefreshResult> {
  const env = options.env ?? process.env;
  const disabledBy = communityPricingDisabledBy(env);
  if (disabledBy) return { status: 'disabled', reason: disabledBy };

  const now = options.now ?? Date.now();
  const cachePath = options.cachePath ?? communityPricingPath();
  const url = communityPricingUrl(env);

  const cached = readCommunityPricing(cachePath);
  if (
    !options.force &&
    cached?.source === url &&
    now - Date.parse(cached.fetchedAt) < REFRESH_AFTER_MS
  ) {
    return { status: 'fresh', fetchedAt: cached.fetchedAt };
  }

  let raw: unknown;
  try {
    raw = await (options.download ?? downloadPriceList)(url);
  } catch (err) {
    return { status: 'failed', reason: (err as Error).message };
  }

  const { models } = convertLiteLLMPrices(raw);
  const count = Object.keys(models).length;
  if (count === 0) {
    return { status: 'failed', reason: `no usable Anthropic prices in the list at ${url}` };
  }

  const fetchedAt = new Date(now).toISOString();
  try {
    writeCommunityPricing(cachePath, { fetchedAt, source: url, models });
  } catch (err) {
    return { status: 'failed', reason: `could not cache it: ${(err as Error).message}` };
  }
  return { status: 'updated', fetchedAt, models: count };
}

/**
 * Keeps a long-running process's prices current: refreshes now, then looks
 * again every hour. The refresh itself decides whether a download is due, so
 * most looks cost one small file read.
 *
 * The timer is unref'd, so it never keeps a process alive on its own.
 */
export function startPricingWatch(
  refresh: () => Promise<unknown>,
  intervalMs: number = WATCH_INTERVAL_MS,
): () => void {
  let inFlight = false;
  const look = () => {
    if (inFlight) return;
    inFlight = true;
    refresh()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };
  look();
  const timer = setInterval(look, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
