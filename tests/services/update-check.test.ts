import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate, isNewer } from '../../src/services/update-check.js';

function cachePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ai-usage-update-')), 'update-check.json');
}

/** Every test injects the registry answer: the suite must never touch the network. */
function stub(latest: string | null) {
  return vi.fn(() => Promise.resolve(latest));
}

const noEnv = {} as NodeJS.ProcessEnv;

describe('isNewer', () => {
  it('compares numerically, not lexicographically', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
  });

  it('is false for the same version, and for a build ahead of the registry', () => {
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
  });

  it('sorts a prerelease below its own release', () => {
    expect(isNewer('0.3.0', '0.3.0-rc.1')).toBe(true);
    expect(isNewer('0.3.0-rc.1', '0.3.0')).toBe(false);
    expect(isNewer('0.3.0-rc.1', '0.2.0')).toBe(true);
  });

  it('treats an unparseable version as zeroes rather than throwing', () => {
    expect(isNewer('0.2.0', 'not-a-version')).toBe(true);
    expect(isNewer('', '')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('reports an available update and caches the answer', async () => {
    const path = cachePath();
    const fetchLatest = stub('0.2.0');

    const info = await checkForUpdate({
      current: '0.1.0',
      fetchLatest,
      cachePath: path,
      env: noEnv,
    });

    expect(info).toEqual({ current: '0.1.0', latest: '0.2.0', isOutdated: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ latest: '0.2.0' });
  });

  it('reports up to date without claiming an update', async () => {
    const info = await checkForUpdate({
      current: '0.2.0',
      fetchLatest: stub('0.2.0'),
      cachePath: cachePath(),
      env: noEnv,
    });

    expect(info).toEqual({ current: '0.2.0', latest: '0.2.0', isOutdated: false });
  });

  it('returns null when the registry cannot be reached, and caches nothing', async () => {
    const path = cachePath();

    const info = await checkForUpdate({
      current: '0.1.0',
      fetchLatest: stub(null),
      cachePath: path,
      env: noEnv,
    });

    expect(info).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('serves a fresh cache without going to the registry', async () => {
    const path = cachePath();
    const now = Date.parse('2026-09-01T12:00:00Z');
    writeFileSync(path, JSON.stringify({ checkedAt: now - 60_000, latest: '0.2.0' }));
    const fetchLatest = stub('0.9.9');

    const info = await checkForUpdate({
      current: '0.1.0',
      fetchLatest,
      cachePath: path,
      now,
      env: noEnv,
    });

    expect(info?.latest).toBe('0.2.0');
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it('refetches once the cache is older than a day', async () => {
    const path = cachePath();
    const now = Date.parse('2026-09-01T12:00:00Z');
    writeFileSync(path, JSON.stringify({ checkedAt: now - 25 * 60 * 60 * 1000, latest: '0.1.0' }));
    const fetchLatest = stub('0.2.0');

    const info = await checkForUpdate({
      current: '0.1.0',
      fetchLatest,
      cachePath: path,
      now,
      env: noEnv,
    });

    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(info?.latest).toBe('0.2.0');
  });

  it('refetches when the cache file is corrupt', async () => {
    const path = cachePath();
    writeFileSync(path, '{ not json');
    const fetchLatest = stub('0.2.0');

    const info = await checkForUpdate({
      current: '0.1.0',
      fetchLatest,
      cachePath: path,
      env: noEnv,
    });

    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(info?.isOutdated).toBe(true);
  });

  it('does nothing when opted out, or in CI', async () => {
    const fetchLatest = stub('0.2.0');
    const opts = { current: '0.1.0', fetchLatest, cachePath: cachePath() };

    expect(await checkForUpdate({ ...opts, env: { AI_USAGE_NO_UPDATE_CHECK: '1' } })).toBeNull();
    expect(await checkForUpdate({ ...opts, env: { CI: 'true' } })).toBeNull();
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it('still answers when the cache cannot be written', async () => {
    // A cache path nested inside a regular file: mkdir fails on every platform,
    // and the failure must stay invisible to the caller.
    const file = join(mkdtempSync(join(tmpdir(), 'ai-usage-update-')), 'a-file');
    writeFileSync(file, 'not a directory');

    const info = await checkForUpdate({
      current: '0.1.0',
      fetchLatest: stub('0.2.0'),
      cachePath: join(file, 'update-check.json'),
      env: noEnv,
    });

    expect(info).toEqual({ current: '0.1.0', latest: '0.2.0', isOutdated: true });
  });
});
