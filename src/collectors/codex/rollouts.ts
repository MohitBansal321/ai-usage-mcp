import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import * as zlib from 'node:zlib';
import type { StoreInfo } from '../../models/usage-record.js';

export interface RolloutFile {
  path: string;
  /** The Codex home (`$CODEX_HOME`) the file was found under. */
  home: string;
  /** Under `archived_sessions/` rather than `sessions/`. */
  archived: boolean;
  /** `.jsonl.zst` -- see {@link canReadCompressedRollouts}. */
  compressed: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Where Codex CLI keeps its session rollouts.
 *
 * Verified layout (Codex CLI 0.114.0 and 0.162.0-alpha.17.2):
 *   <home>/sessions/YYYY/MM/DD/rollout-<local time>-<session id>.jsonl
 *
 * `<home>` is `$CODEX_HOME`, else `~/.codex`. Two more places are read without
 * having been seen populated, because the 0.162 binary names them:
 *   <home>/archived_sessions/...   -- where an archived session's file is moved
 *   rollout-*.jsonl.zst            -- a rollout Codex has compressed in place
 *
 * And, as with OpenCode, a sandboxed launcher splits the history: the Codex snap
 * keeps its own home at `~/snap/codex/<revision>/` (one session there on the
 * development machine, none of them in `~/.codex`). Those are reported as extra
 * stores rather than silently left out, and read with `--all-stores`.
 */
export function discoverCodexHomes(): StoreInfo[] {
  const stores: StoreInfo[] = [];
  const seen = new Set<string>();
  const add = (rawPath: string, detail: string) => {
    // ~/snap/<app>/current is a symlink to the active revision, so the same home
    // otherwise shows up twice.
    const path = canonical(rawPath);
    if (seen.has(path)) return;
    seen.add(path);
    stores.push({ path, primary: false, exists: existsSync(path), detail });
  };

  const override = process.env.AI_USAGE_CODEX_HOME;
  if (override) {
    // An explicit override is authoritative whether or not it exists, so a typo
    // in it is reported as a missing PRIMARY store rather than silently leaving
    // the collector with no primary at all.
    add(override, 'AI_USAGE_CODEX_HOME override');
    const overrideStore = stores[0];
    if (overrideStore) overrideStore.primary = true;
    return stores;
  }

  if (process.env.CODEX_HOME) add(process.env.CODEX_HOME, 'CODEX_HOME');
  add(join(homedir(), '.codex'), 'default (~/.codex)');
  for (const path of findSnapHomes()) add(path, 'snap sandbox CODEX_HOME');

  const firstExisting = stores.find((s) => s.exists);
  if (firstExisting) firstExisting.primary = true;
  return stores;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The Codex snap points `CODEX_HOME` at its per-revision user data directory,
 * so the home is `~/snap/codex/<revision>` itself (verified: `sessions/`,
 * `state_5.sqlite` and `auth.json` sit directly in it).
 */
function findSnapHomes(): string[] {
  const appDir = join(homedir(), 'snap', 'codex');
  let revisions: string[];
  try {
    revisions = readdirSync(appDir);
  } catch {
    return [];
  }
  return revisions
    .map((rev) => join(appDir, rev))
    .filter(
      (home) => existsSync(join(home, 'sessions')) || existsSync(join(home, 'archived_sessions')),
    )
    .sort();
}

/** Every rollout under a Codex home, active and archived, oldest path first. */
export function listRollouts(home: string): RolloutFile[] {
  const out: RolloutFile[] = [];
  for (const [dir, archived] of [
    ['sessions', false],
    ['archived_sessions', true],
  ] as const) {
    const walk = (current: string) => {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.startsWith('rollout-')) continue;
        const compressed = entry.name.endsWith('.jsonl.zst');
        if (!compressed && !entry.name.endsWith('.jsonl')) continue;
        let stat;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }
        out.push({
          path: full,
          home,
          archived,
          compressed,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    };
    walk(join(home, dir));
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Whether this Node can read a `.jsonl.zst` rollout. zstd arrived in `node:zlib`
 * in 22.15; the package supports 22.13, where such a file is skipped and said
 * to be, never read as empty.
 */
export function canReadCompressedRollouts(): boolean {
  return typeof (zlib as { createZstdDecompress?: unknown }).createZstdDecompress === 'function';
}

/** Lines of a rollout, decompressing it first when it is `.jsonl.zst`. */
export function readRolloutLines(file: RolloutFile): Interface {
  const raw = createReadStream(file.path);
  let input: NodeJS.ReadableStream & { setEncoding(e: BufferEncoding): unknown } = raw;
  if (file.compressed) {
    const decompress = zlib.createZstdDecompress();
    // `pipe` does not forward a read error, which would leave the reader waiting
    // for lines that never come.
    raw.on('error', (err) => decompress.destroy(err));
    input = raw.pipe(decompress);
  }
  input.setEncoding('utf8');
  return createInterface({ input, crlfDelay: Infinity });
}

/**
 * The session id in a rollout's file name: `rollout-<timestamp>-<uuid>.jsonl`.
 * It equalled `session_meta.payload.id` in both rollouts verified; it is used
 * only when a file has no `session_meta` line.
 */
export function sessionIdFromFileName(path: string): string | undefined {
  const match =
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i.exec(
      basename(path),
    );
  return match?.[1];
}

export function rolloutLabel(file: RolloutFile): string {
  return `${file.archived ? 'archived_sessions' : 'sessions'}/${basename(file.path)}`;
}
