import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../pricing/index.js';

/** How long a registry answer is trusted before it is fetched again. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** A status report must not hang on a slow or unreachable registry. */
const TIMEOUT_MS = 1500;
const REGISTRY_URL = 'https://registry.npmjs.org/ai-usage-mcp/latest';
/**
 * Two tries, sharing one deadline. The registry answers this endpoint in tens of
 * milliseconds, so a second attempt costs nothing when the first one was a blip
 * -- and the deadline still caps the whole thing at `TIMEOUT_MS`.
 */
const ATTEMPTS = 2;

/**
 * How this build was launched. It decides what the fix actually is, which is not
 * the same command in each case: a global install stays pinned until someone
 * reinstalls it, an npx cache re-resolves on the next cold start, and a version
 * pinned in an MCP config is not fixable by any command at all.
 */
export type InstallKind = 'global' | 'npx' | 'local' | 'unknown';

export interface UpdateInfo {
  current: string;
  latest: string;
  /** False when the installed build is current, or ahead of the registry. */
  isOutdated: boolean;
  /** Absent when the caller did not care how the build was installed. */
  installKind?: InstallKind;
  /** One line on what `latest` adds, when that release published one. */
  highlight?: string;
}

/** What the registry says about the newest release. */
export interface LatestRelease {
  version: string;
  highlight?: string;
}

interface CacheFile {
  checkedAt: number;
  latest: string;
  highlight?: string;
}

/**
 * The longest highlight shown. It shares one line with the version and the
 * update command, in a notice that is supposed to be one line.
 */
const MAX_HIGHLIGHT = 160;
/** Line breaks, escape sequences and the rest: nothing a one-line notice should carry. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

export interface UpdateCheckOptions {
  current: string;
  /**
   * Injected in tests; defaults to the real registry lookup. A bare version
   * string is a release with no highlight.
   */
  fetchLatest?: () => Promise<LatestRelease | string | null>;
  cachePath?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests; defaults to detecting how this build was launched. */
  installKind?: InstallKind;
}

export type CachedUpdateOptions = Omit<UpdateCheckOptions, 'fetchLatest'>;

function updateCachePath(): string {
  return join(configDir(), 'update-check.json');
}

/** Both opt-outs, in one place: a check nobody will see should not run. */
function optedOut(env: NodeJS.ProcessEnv): boolean {
  return env.AI_USAGE_NO_UPDATE_CHECK === '1' || Boolean(env.CI);
}

function readCache(path: string, now: number): LatestRelease | null {
  try {
    const cache = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheFile>;
    if (typeof cache.latest !== 'string' || typeof cache.checkedAt !== 'number') return null;
    if (now - cache.checkedAt >= CACHE_TTL_MS) return null;
    // A cache written before highlights existed simply has none.
    const highlight = cleanHighlight(cache.highlight);
    return highlight ? { version: cache.latest, highlight } : { version: cache.latest };
  } catch {
    // No cache yet, or a corrupted one. Either way: fetch.
    return null;
  }
}

function writeCache(path: string, release: LatestRelease, now: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const cache: CacheFile = { checkedAt: now, latest: release.version };
    if (release.highlight) cache.highlight = release.highlight;
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // A read-only or unwritable config directory must not break `status`; the
    // only cost is that the next run checks the registry again.
  }
}

/**
 * The one function in this file that talks to the network.
 *
 * Exported for the tests: every other test in the suite injects `fetchLatest`,
 * which left this -- the only code path that runs in production -- unexercised.
 *
 * `accept: application/json` on purpose, and it is the whole bug fix. The
 * abbreviated `application/vnd.npm.install-v1+json` type is only defined for
 * the packument endpoint (`/<pkg>`); on `/<pkg>/latest` the registry answers
 * 406 with an empty body, which `!res.ok` then reported as "no update
 * available". How often it does that varies by edge and by day -- measured at
 * both 0% and 100% of requests hours apart from one machine -- so it reads as a
 * flake but can silently disable the notice outright, which is what it did for
 * every release from 0.4.0 on. It also buys nothing here: `/latest` is a single
 * ~3 KB manifest, where the abbreviated packument is ~9 KB.
 *
 * The retry below is deliberately not the fix -- two attempts against a 406
 * both fail. It only covers genuinely transient trouble.
 */
export async function fetchLatestFromRegistry(): Promise<LatestRelease | null> {
  // One deadline for all attempts, so a retry can never double the wait.
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const res = await fetch(REGISTRY_URL, {
        signal: deadline,
        headers: { accept: 'application/json' },
      });
      if (res.ok) return parseLatestManifest(await res.json());
      // A 4xx/5xx may be this edge, this moment: worth one more try.
    } catch {
      // Offline, DNS failure, timeout, malformed JSON -- all the same answer.
    }
    if (deadline.aborted) break;
  }
  return null;
}

/**
 * The version, and the release's highlight when it carries one.
 *
 * `/latest` returns the published `package.json` whole, custom fields included,
 * so a release can say what it adds without a second request: a top-level
 * `releaseHighlight: { version, text }`. The `version` inside it must match the
 * release's own -- a highlight left over from an earlier release, because the
 * release commit forgot to replace it, is dropped rather than shown as news.
 */
export function parseLatestManifest(body: unknown): LatestRelease | null {
  if (typeof body !== 'object' || body === null) return null;
  const { version, releaseHighlight } = body as { version?: unknown; releaseHighlight?: unknown };
  if (typeof version !== 'string') return null;
  if (typeof releaseHighlight !== 'object' || releaseHighlight === null) return { version };
  const h = releaseHighlight as { version?: unknown; text?: unknown };
  const text = h.version === version ? cleanHighlight(h.text) : undefined;
  return text ? { version, highlight: text } : { version };
}

/**
 * One line of plain text, or nothing. It is read by a model before a person, so
 * control characters and line breaks are stripped -- a highlight cannot open a
 * second line that looks like it came from somewhere else.
 */
function cleanHighlight(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const line = text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  return line.length > MAX_HIGHLIGHT ? `${line.slice(0, MAX_HIGHLIGHT - 3).trimEnd()}...` : line;
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
 * Classifies an install from the path this module was loaded from.
 *
 * Read from `import.meta.url`, never `process.argv[1]`: a global install is
 * reached through a symlinked bin, and argv[1] can name the link rather than the
 * file, which makes a global install look like a bare script.
 *
 * A heuristic, and treated as one -- every branch still names a real fix, and
 * `unknown` says both of the likely ones rather than guessing between them.
 */
export function detectInstallKind(moduleUrl: string): InstallKind {
  const p = normalisedPath(moduleUrl);
  if (p.includes('/_npx/')) return 'npx';
  // The npm prefix on POSIX (`<prefix>/lib/node_modules`) and on Windows
  // (`%APPDATA%/npm/node_modules`). A project dependency has neither.
  if (p.includes('/lib/node_modules/') || p.includes('/npm/node_modules/')) return 'global';
  if (p.includes('/node_modules/ai-usage-mcp/')) return 'local';
  return 'unknown';
}

/**
 * The module path as forward slashes, for matching only.
 *
 * `fileURLToPath` is tried first because it is correct, but it is
 * platform-specific: on Windows it rejects a POSIX-style `file:///home/...`
 * outright. This is a string heuristic over a path we never open, so the URL's
 * own pathname is a fine fallback and keeps the classification the same whatever
 * host it runs on.
 */
function normalisedPath(moduleUrl: string): string {
  let path = moduleUrl;
  if (moduleUrl.startsWith('file:')) {
    try {
      path = fileURLToPath(moduleUrl);
    } catch {
      try {
        path = decodeURIComponent(new URL(moduleUrl).pathname);
      } catch {
        path = moduleUrl;
      }
    }
  }
  return path.split(sep).join('/').split('\\').join('/');
}

let detected: InstallKind | undefined;

/** Memoised: the answer cannot change while the process is alive. */
export function installKind(): InstallKind {
  detected ??= detectInstallKind(import.meta.url);
  return detected;
}

/**
 * What to actually do about a stale install, given how it was installed.
 *
 * An undefined kind means the caller did not detect one; the global command is
 * the right default, because a global install is the one that goes stale.
 */
export function updateCommand(kind?: InstallKind): string {
  switch (kind) {
    case 'npx':
      return 'restart the MCP server -- npx re-resolves the version on a cold start. If the version is pinned in your MCP config, change it there.';
    case 'local':
      return 'npm i ai-usage-mcp@latest';
    case 'unknown':
      return 'npm i -g ai-usage-mcp@latest, or `git pull && npm run build` in a source checkout';
    default:
      return 'npm i -g ai-usage-mcp@latest';
  }
}

/**
 * One line, for a channel that gets exactly one line.
 *
 * Deliberately a statement of fact and not an instruction: this text is read by
 * a model before it reaches a person, and a server that tells the model what to
 * say is doing prompt injection against its own users.
 */
export function formatUpdateNotice(info: UpdateInfo): string {
  const news = info.highlight ? ` (new: ${info.highlight})` : '';
  return (
    `[ai-usage] Server notice: ai-usage-mcp ${info.current} is running; ` +
    `${info.latest} is the latest release${news}. To update: ${updateCommand(info.installKind)}`
  );
}

function toUpdateInfo(current: string, latest: LatestRelease, kind: InstallKind): UpdateInfo {
  const info: UpdateInfo = {
    current,
    latest: latest.version,
    isOutdated: isNewer(latest.version, current),
    installKind: kind,
  };
  // News about a release the user already has is not news.
  if (info.isOutdated && latest.highlight) info.highlight = latest.highlight;
  return info;
}

/**
 * Reports whether a newer release is on the registry.
 *
 * Never throws and never blocks for longer than the timeout. Returns null when
 * the answer is unknown (offline, opted out) rather than guessing.
 *
 * The MCP server calls this too, but only in the background once the JSON-RPC
 * handshake is done -- see `src/mcp/notice.ts`. It is the one outbound request
 * this package makes: a GET for a version string, carrying no usage data and no
 * identifier, disabled by `AI_USAGE_NO_UPDATE_CHECK=1`.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateInfo | null> {
  const env = options.env ?? process.env;
  if (optedOut(env)) return null;

  const now = options.now ?? Date.now();
  const cachePath = options.cachePath ?? updateCachePath();
  const kind = options.installKind ?? installKind();

  let latest = readCache(cachePath, now);
  if (latest === null) {
    const fetched = await (options.fetchLatest ?? fetchLatestFromRegistry)();
    if (fetched === null) return null;
    latest = typeof fetched === 'string' ? { version: fetched } : fetched;
    writeCache(cachePath, latest, now);
  }

  return toUpdateInfo(options.current, latest, kind);
}

/**
 * The same answer, from the cache only: synchronous, and it never touches the
 * network.
 *
 * This exists for the two places that cannot afford a fetch. The MCP server's
 * `instructions` are built before the transport is connected, so a fetch there
 * would add its timeout to every client's handshake; a resource read should
 * answer at once. Returns null until some earlier run has populated the cache,
 * which is the honest answer -- an unknown is not the same as up to date.
 */
export function readCachedUpdate(options: CachedUpdateOptions): UpdateInfo | null {
  const env = options.env ?? process.env;
  if (optedOut(env)) return null;

  const now = options.now ?? Date.now();
  const latest = readCache(options.cachePath ?? updateCachePath(), now);
  if (latest === null) return null;

  return toUpdateInfo(options.current, latest, options.installKind ?? installKind());
}
