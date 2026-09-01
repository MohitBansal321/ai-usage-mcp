import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import type { StoreInfo, TurnKind } from '../../models/usage-record.js';

export interface TranscriptFile {
  path: string;
  /** Root the file was discovered under. */
  root: string;
  /** Project directory slug, e.g. `-home-user-my-project`. */
  projectSlug: string;
  turnKind: TurnKind;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Where Claude Code keeps session transcripts.
 *
 * Layout on disk is NOT flat. Verified shapes:
 *   <root>/<projectSlug>/<sessionId>.jsonl                                  -> main turns
 *   <root>/<projectSlug>/<sessionId>/subagents/agent-<id>.jsonl             -> subagent turns
 *   <root>/<projectSlug>/<sessionId>/subagents/workflows/<wf>/agent-*.jsonl -> subagent turns
 *   <root>/<projectSlug>/<sessionId>/subagents/workflows/<wf>/journal.jsonl -> not usage, skipped
 *
 * Only the first shape sits directly under the project directory, so a single-level glob
 * finds just 47 of the 196 files on the machine this was verified against. Discovery must
 * recurse.
 */
export function discoverClaudeRoots(): StoreInfo[] {
  const stores: StoreInfo[] = [];
  const seen = new Set<string>();
  const add = (path: string, detail: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const exists = existsSync(path);
    stores.push({ path, primary: false, exists, detail });
  };

  const override = process.env.AI_USAGE_CLAUDE_PROJECTS;
  if (override) {
    // An explicit override is authoritative whether or not it exists, so a typo
    // in it is reported as a missing PRIMARY store rather than silently leaving
    // the collector with no primary at all.
    add(override, 'AI_USAGE_CLAUDE_PROJECTS override');
    const overrideStore = stores[0];
    if (overrideStore) overrideStore.primary = true;
    return stores;
  } else {
    if (process.env.CLAUDE_CONFIG_DIR) {
      add(join(process.env.CLAUDE_CONFIG_DIR, 'projects'), 'CLAUDE_CONFIG_DIR');
    }
    add(join(homedir(), '.claude', 'projects'), 'default (~/.claude)');
    add(join(homedir(), '.config', 'claude', 'projects'), 'alternate (~/.config/claude)');
  }

  const firstExisting = stores.find((s) => s.exists);
  if (firstExisting) firstExisting.primary = true;
  return stores;
}

/** Recursively finds every transcript under a root, classifying main vs subagent. */
export function listTranscripts(root: string): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  if (!existsSync(root)) return out;

  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      // `journal.jsonl` is workflow bookkeeping, not a transcript.
      if (entry.name === 'journal.jsonl') continue;

      const rel = relative(root, full);
      const segments = rel.split(sep);
      const projectSlug = segments[0] ?? '(unknown)';
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      out.push({
        path: full,
        root,
        projectSlug,
        // Subagent transcripts live under a `subagents/` directory. The
        // `isSidechain` flag on the lines themselves is never set in practice
        // (0 of 21,574 lines on the machine this was verified against), so the
        // path is the only reliable signal.
        turnKind: segments.includes('subagents') ? 'subagent' : 'main',
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  };

  walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Recovers the real project directory from Claude Code's slugged directory name.
 *
 * The slug replaces every path separator AND every literal dash with '-', so
 * `-home-me-Videos-ai-usage` is ambiguous: it could be `/home/me/Videos/ai/usage`
 * or `/home/me/Videos/ai-usage`. Rather than guess, we walk the filesystem and
 * let it disambiguate -- at each level we try the longest run of tokens that
 * actually exists on disk.
 *
 * Returns undefined when nothing matches (a project since moved or deleted), in
 * which case the caller falls back to the `cwd` recorded on the transcript lines.
 */
const slugCache = new Map<string, string | undefined>();

export function resolveProjectSlug(slug: string): string | undefined {
  if (slugCache.has(slug)) return slugCache.get(slug);
  const resolved = resolveSlugUncached(slug);
  slugCache.set(slug, resolved);
  return resolved;
}

function resolveSlugUncached(slug: string): string | undefined {
  if (!slug.startsWith('-')) return undefined;
  const tokens = slug.slice(1).split('-').filter(Boolean);
  if (tokens.length === 0) return undefined;

  const walk = (base: string, index: number): string | undefined => {
    if (index >= tokens.length) return base;
    // Longest match first: a directory named `ai-usage` must win over `ai`.
    for (let take = tokens.length - index; take >= 1; take--) {
      const segment = tokens.slice(index, index + take).join('-');
      const candidate = `${base}/${segment}`;
      let isDir = false;
      try {
        isDir = statSync(candidate).isDirectory();
      } catch {
        // Unreadable or missing: fall through and try the next token grouping.
      }
      if (!isDir) continue;
      const result = walk(candidate, index + take);
      if (result) return result;
    }
    return undefined;
  };

  return walk('', 0);
}

/**
 * Last-resort reading of a slug with no filesystem help: every dash becomes a
 * separator. Wrong whenever a real directory name contains a dash, so it is only
 * used when the project directory no longer exists and no `cwd` was recorded.
 */
export function unslugProjectPath(slug: string): string | undefined {
  if (!slug || !slug.startsWith('-')) return undefined;
  return slug.replace(/-/g, '/');
}

export function transcriptLabel(file: TranscriptFile): string {
  return `${file.projectSlug}/${basename(file.path)}`;
}
