import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StoreInfo } from '../../models/usage-record.js';

const DB_NAME = 'opencode.db';

/**
 * OpenCode stores its database under the XDG data directory. That single fact is
 * the most important thing in this file: a sandboxed launcher (the VSCode snap,
 * for one) exports its own XDG_DATA_HOME, so the *same user* can end up with two
 * completely disjoint OpenCode histories. On the machine this was developed
 * against, `~/.local/share/opencode` held 174 sessions while the snap's
 * XDG_DATA_HOME held the 276 sessions `opencode stats` actually reports.
 *
 * So we resolve the store the way OpenCode itself does (primary), and we also
 * *report* every other store we can find, rather than silently reading one and
 * pretending it is all the data.
 */
export function discoverOpenCodeStores(): StoreInfo[] {
  const seen = new Set<string>();
  const stores: StoreInfo[] = [];

  const add = (rawPath: string, primary: boolean, detail?: string) => {
    // Canonicalise before de-duping: ~/snap/<app>/current is a symlink to the
    // active revision, so the same database otherwise shows up twice.
    const path = canonical(rawPath);
    if (seen.has(path)) return;
    seen.add(path);
    const exists = existsSync(path);
    const info: StoreInfo = { path, primary, exists };
    if (detail) info.detail = detail;
    if (exists) {
      try {
        const s = statSync(path);
        info.detail = `${detail ? detail + ', ' : ''}${formatBytes(s.size)}, modified ${s.mtime.toISOString()}`;
      } catch {
        /* keep the plain detail */
      }
    }
    stores.push(info);
  };

  // 1. Explicit override always wins and is always primary.
  const override = process.env.AI_USAGE_OPENCODE_DB;
  if (override) {
    add(override, true, 'AI_USAGE_OPENCODE_DB override');
    return stores.filter((s) => s.exists || s.primary);
  }

  // 2. What OpenCode itself resolves, in its own order.
  const xdg = process.env.XDG_DATA_HOME;
  const candidates: { path: string; detail: string }[] = [];
  if (xdg) candidates.push({ path: join(xdg, 'opencode', DB_NAME), detail: 'XDG_DATA_HOME' });
  candidates.push({
    path: join(homedir(), '.local', 'share', 'opencode', DB_NAME),
    detail: 'XDG default (~/.local/share)',
  });

  let primaryChosen = false;
  for (const c of candidates) {
    const isPrimary = !primaryChosen && existsSync(c.path);
    if (isPrimary) primaryChosen = true;
    add(c.path, isPrimary, c.detail);
  }

  // 3. Snap sandboxes are a known source of split stores; surface them so the
  //    user is told their data is divided instead of quietly losing half of it.
  for (const path of findSnapStores()) {
    const isPrimary = !primaryChosen;
    if (isPrimary) primaryChosen = true;
    add(path, isPrimary, 'snap sandbox XDG_DATA_HOME');
  }

  return stores;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function findSnapStores(): string[] {
  const out: string[] = [];
  const snapRoot = join(homedir(), 'snap');
  if (!existsSync(snapRoot)) return out;
  let apps: string[];
  try {
    apps = readdirSync(snapRoot);
  } catch {
    return out;
  }
  for (const app of apps) {
    const appDir = join(snapRoot, app);
    let revisions: string[];
    try {
      revisions = readdirSync(appDir);
    } catch {
      continue;
    }
    for (const rev of revisions) {
      const candidate = join(appDir, rev, '.local', 'share', 'opencode', DB_NAME);
      if (existsSync(candidate)) out.push(candidate);
    }
  }
  return out;
}

export function primaryStore(stores: StoreInfo[]): StoreInfo | undefined {
  return stores.find((s) => s.primary && s.exists) ?? stores.find((s) => s.exists);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
