import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMMUNITY_PRICING_URL,
  readCommunityPricing,
  writeCommunityPricing,
} from '../../src/pricing/index.js';
import { refreshCommunityPricing, startPricingWatch } from '../../src/services/pricing-refresh.js';
import { tempDir } from '../fixtures/build-fixtures.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T12:00:00.000Z');

const LIST = {
  'claude-opus-5-5': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 4e-6,
    output_cost_per_token: 2e-5,
    cache_read_input_token_cost: 2e-7,
    cache_creation_input_token_cost: 5e-6,
    cache_creation_input_token_cost_above_1hr: 8e-6,
  },
};

describe('refreshCommunityPricing', () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = tempDir('pricing-refresh-');
    cachePath = join(dir, 'pricing-community.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seed(fetchedAt: number, source = COMMUNITY_PRICING_URL): void {
    writeCommunityPricing(cachePath, {
      fetchedAt: new Date(fetchedAt).toISOString(),
      source,
      models: { old: { input: 1, output: 1, cache: { read: 0.1, write5m: 1.25, write1h: 2 } } },
    });
  }

  it('downloads, converts and caches the list', async () => {
    const download = vi.fn(async () => LIST);
    const result = await refreshCommunityPricing({ env: {}, now: NOW, cachePath, download });

    expect(result).toEqual({
      status: 'updated',
      fetchedAt: '2026-09-26T12:00:00.000Z',
      models: 1,
    });
    expect(download).toHaveBeenCalledWith(COMMUNITY_PRICING_URL);
    const cached = readCommunityPricing(cachePath);
    expect(cached?.source).toBe(COMMUNITY_PRICING_URL);
    expect(cached?.models['claude-opus-5-5']?.input).toBe(4);
  });

  it('does not download again within a day', async () => {
    seed(NOW - 23 * HOUR);
    const download = vi.fn(async () => LIST);
    const result = await refreshCommunityPricing({ env: {}, now: NOW, cachePath, download });

    expect(result.status).toBe('fresh');
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads again after a day, when forced, or when the source changed', async () => {
    const download = vi.fn(async () => LIST);

    seed(NOW - 25 * HOUR);
    expect((await refreshCommunityPricing({ env: {}, now: NOW, cachePath, download })).status).toBe(
      'updated',
    );

    seed(NOW - HOUR);
    const forced = await refreshCommunityPricing({
      env: {},
      now: NOW,
      cachePath,
      download,
      force: true,
    });
    expect(forced.status).toBe('updated');

    seed(NOW - HOUR, 'https://old-mirror.test/prices.json');
    const moved = await refreshCommunityPricing({ env: {}, now: NOW, cachePath, download });
    expect(moved.status).toBe('updated');
    expect(download).toHaveBeenCalledTimes(3);
  });

  it('honours AI_USAGE_PRICING_URL', async () => {
    const download = vi.fn(async () => LIST);
    const env = { AI_USAGE_PRICING_URL: 'http://127.0.0.1:1/prices.json' };
    await refreshCommunityPricing({ env, now: NOW, cachePath, download });
    expect(download).toHaveBeenCalledWith('http://127.0.0.1:1/prices.json');
    expect(readCommunityPricing(cachePath)?.source).toBe('http://127.0.0.1:1/prices.json');
  });

  it('never goes online when turned off', async () => {
    const download = vi.fn(async () => LIST);
    for (const env of [
      { AI_USAGE_NO_PRICING_REFRESH: '1' },
      { AI_USAGE_NO_UPDATE_CHECK: '1' },
      { CI: 'true' },
    ]) {
      const result = await refreshCommunityPricing({ env, now: NOW, cachePath, download });
      expect(result.status).toBe('disabled');
    }
    expect(download).not.toHaveBeenCalled();
  });

  it('keeps the cached list when the download fails', async () => {
    seed(NOW - 48 * HOUR);
    const before = readFileSync(cachePath, 'utf8');
    const result = await refreshCommunityPricing({
      env: {},
      now: NOW,
      cachePath,
      download: async () => {
        throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com');
      },
    });

    expect(result).toEqual({
      status: 'failed',
      reason: 'getaddrinfo ENOTFOUND raw.githubusercontent.com',
    });
    expect(readFileSync(cachePath, 'utf8')).toBe(before);
  });

  it('keeps the cached list when the download holds no usable prices', async () => {
    seed(NOW - 48 * HOUR);
    const before = readFileSync(cachePath, 'utf8');
    // A captive portal, an error page served as 200, or a format change upstream.
    const result = await refreshCommunityPricing({
      env: {},
      now: NOW,
      cachePath,
      download: async () => ({ message: 'rate limited' }),
    });

    expect(result.status).toBe('failed');
    expect(readFileSync(cachePath, 'utf8')).toBe(before);
  });
});

describe('startPricingWatch', () => {
  afterEach(() => vi.useRealTimers());

  it('refreshes at once, then on the interval, never two at a time', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const stop = startPricingWatch(refresh, 1000);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Still in flight: the next tick must not start a second download.
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('survives a refresh that throws', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {
      throw new Error('boom');
    });
    const stop = startPricingWatch(refresh, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });
});
