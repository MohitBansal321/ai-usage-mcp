import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkForUpdate,
  detectInstallKind,
  formatUpdateNotice,
  isNewer,
  readCachedUpdate,
  updateCommand,
} from '../../src/services/update-check.js';

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
      installKind: 'global',
    });

    expect(info).toEqual({
      current: '0.1.0',
      latest: '0.2.0',
      isOutdated: true,
      installKind: 'global',
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ latest: '0.2.0' });
  });

  it('reports up to date without claiming an update', async () => {
    const info = await checkForUpdate({
      current: '0.2.0',
      fetchLatest: stub('0.2.0'),
      cachePath: cachePath(),
      env: noEnv,
      installKind: 'global',
    });

    expect(info).toEqual({
      current: '0.2.0',
      latest: '0.2.0',
      isOutdated: false,
      installKind: 'global',
    });
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
      installKind: 'global',
    });

    expect(info).toEqual({
      current: '0.1.0',
      latest: '0.2.0',
      isOutdated: true,
      installKind: 'global',
    });
  });
});

describe('detectInstallKind', () => {
  it('recognises an npx cache, which re-resolves on a cold start', () => {
    expect(
      detectInstallKind(
        'file:///home/u/.npm/_npx/2f3a/node_modules/ai-usage-mcp/dist/mcp/server.js',
      ),
    ).toBe('npx');
  });

  it('recognises a global install on both npm prefixes', () => {
    expect(detectInstallKind('file:///usr/lib/node_modules/ai-usage-mcp/dist/mcp/server.js')).toBe(
      'global',
    );
    expect(
      detectInstallKind(
        'file:///home/u/.nvm/versions/node/v22.11.0/lib/node_modules/ai-usage-mcp/dist/mcp/server.js',
      ),
    ).toBe('global');
    expect(
      detectInstallKind(
        'file:///C:/Users/u/AppData/Roaming/npm/node_modules/ai-usage-mcp/dist/x.js',
      ),
    ).toBe('global');
  });

  it('recognises a project dependency, whose fix is not the global command', () => {
    expect(detectInstallKind('file:///work/app/node_modules/ai-usage-mcp/dist/mcp/server.js')).toBe(
      'local',
    );
  });

  it('says unknown for a source checkout, and for an unparseable url', () => {
    expect(detectInstallKind('file:///work/ai-usage/dist/mcp/server.js')).toBe('unknown');
    expect(detectInstallKind('not a url at all')).toBe('unknown');
  });

  it('classifies the same on every host, including Windows-shaped paths', () => {
    // `fileURLToPath` rejects a POSIX file URL on Windows and a bare Windows
    // path elsewhere. This is a string heuristic over a path nothing opens, so
    // the answer must not depend on which runner asks.
    expect(
      detectInstallKind('file:///C:/Users/u/AppData/Local/npm-cache/_npx/2f3a/node_modules/x.js'),
    ).toBe('npx');
    expect(
      detectInstallKind(
        'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\ai-usage-mcp\\dist\\x.js',
      ),
    ).toBe('global');
    expect(
      detectInstallKind('file:///C:/work/app/node_modules/ai-usage-mcp/dist/mcp/server.js'),
    ).toBe('local');
  });
});

describe('updateCommand', () => {
  it('gives each install the fix that actually works for it', () => {
    expect(updateCommand('global')).toBe('npm i -g ai-usage-mcp@latest');
    expect(updateCommand('local')).toBe('npm i ai-usage-mcp@latest');
    expect(updateCommand('npx')).toContain('restart the MCP server');
    // The one case no command fixes: it has to be said out loud.
    expect(updateCommand('npx')).toContain('pinned in your MCP config');
    expect(updateCommand('unknown')).toContain('git pull');
  });

  it('falls back to the global command, which is the install that goes stale', () => {
    expect(updateCommand()).toBe('npm i -g ai-usage-mcp@latest');
  });
});

describe('formatUpdateNotice', () => {
  it('states both versions and the fix, on one line', () => {
    const notice = formatUpdateNotice({
      current: '0.2.0',
      latest: '0.3.0',
      isOutdated: true,
      installKind: 'global',
    });

    expect(notice).toContain('0.2.0 is running');
    expect(notice).toContain('0.3.0 is the latest release');
    expect(notice).toContain('npm i -g ai-usage-mcp@latest');
    expect(notice.split('\n')).toHaveLength(1);
  });

  it('does not instruct the model that will read it', () => {
    const notice = formatUpdateNotice({ current: '0.2.0', latest: '0.3.0', isOutdated: true });
    expect(notice.toLowerCase()).not.toContain('tell the user');
    expect(notice.toLowerCase()).not.toContain('you must');
  });
});

describe('readCachedUpdate', () => {
  it('answers from a fresh cache without any network access', () => {
    const path = cachePath();
    const now = Date.parse('2026-09-01T12:00:00Z');
    writeFileSync(path, JSON.stringify({ checkedAt: now - 60_000, latest: '0.3.0' }));

    expect(
      readCachedUpdate({
        current: '0.2.0',
        cachePath: path,
        now,
        env: noEnv,
        installKind: 'global',
      }),
    ).toEqual({ current: '0.2.0', latest: '0.3.0', isOutdated: true, installKind: 'global' });
  });

  it('returns null when nothing is cached, rather than implying up to date', () => {
    expect(readCachedUpdate({ current: '0.2.0', cachePath: cachePath(), env: noEnv })).toBeNull();
  });

  it('returns null on a cache older than a day', () => {
    const path = cachePath();
    const now = Date.parse('2026-09-01T12:00:00Z');
    writeFileSync(path, JSON.stringify({ checkedAt: now - 25 * 60 * 60 * 1000, latest: '0.3.0' }));

    expect(readCachedUpdate({ current: '0.2.0', cachePath: path, now, env: noEnv })).toBeNull();
  });

  it('stays silent when opted out, or in CI', () => {
    const path = cachePath();
    writeFileSync(path, JSON.stringify({ checkedAt: Date.now(), latest: '9.9.9' }));

    expect(
      readCachedUpdate({
        current: '0.2.0',
        cachePath: path,
        env: { AI_USAGE_NO_UPDATE_CHECK: '1' },
      }),
    ).toBeNull();
    expect(readCachedUpdate({ current: '0.2.0', cachePath: path, env: { CI: 'true' } })).toBeNull();
  });
});
