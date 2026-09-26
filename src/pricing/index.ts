import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  CacheMultipliers,
  ModelPrice,
  PricingMode,
  PricingOverride,
  PricingTable,
} from './types.js';
import { builtinPricing, BUILTIN_PRICING_VERSION } from './tables/index.js';
import {
  communityPricingDisabledBy,
  communityPricingUrl,
  readCommunityPricing,
  withCommunityPricing,
} from './community.js';

export type {
  PricingTable,
  ModelPrice,
  CacheMultipliers,
  PricingOverride,
  PricingMode,
} from './types.js';
export { anthropicPricing, openaiPricing, providerTables, builtinPricing } from './tables/index.js';
export {
  COMMUNITY_PRICING_URL,
  communityPricingDisabledBy,
  communityPricingUrl,
  convertLiteLLMPrices,
  readCommunityPricing,
  withCommunityPricing,
  writeCommunityPricing,
  type CommunityPricing,
  type ConvertedList,
} from './community.js';

/**
 * Where a user can drop prices without waiting for a release.
 *
 * Two distinct jobs, and the second is the common one: correcting a built-in
 * price that has gone stale, and adding a provider the package does not ship at
 * all. Both are served by overlaying rather than replacing -- see
 * {@link loadPricing}. `ai-usage status` reports which file is in force.
 */
export function pricingOverridePath(): string {
  return process.env.AI_USAGE_PRICING_FILE ?? join(configDir(), 'pricing.json');
}

export function configDir(): string {
  if (process.env.AI_USAGE_HOME) return process.env.AI_USAGE_HOME;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'ai-usage-mcp') : join(homedir(), '.config', 'ai-usage-mcp');
}

/** Where the downloaded community price list is cached. See `./community.ts`. */
export function communityPricingPath(): string {
  return join(configDir(), 'pricing-community.json');
}

/** What the community price list contributed to the table in force, for `status`. */
export interface CommunityPricingState {
  /** The list's URL. */
  source: string;
  /** Why community prices are not in effect, when they are not. */
  disabledBy?: string;
  /** When the cached list was downloaded. Absent until the first refresh succeeds. */
  fetchedAt?: string;
  /** The models it priced: only those the built-in tables lack. */
  added: string[];
}

export interface LoadedPricing {
  table: PricingTable;
  /** Set when a user override file contributed to the table in force. */
  overridePath?: string;
  /** How the table was assembled. `builtin` when no override file exists. */
  mode: PricingMode;
  /** The built-in version an overlay sits on top of. Absent for other modes. */
  baseVersion?: string;
  /** Absent only when a caller handed a table over directly. */
  community?: CommunityPricingState;
}

class PricingOverrideError extends Error {}

function fail(path: string, detail: string): never {
  throw new PricingOverrideError(`Pricing override at ${path} is invalid: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCacheMultipliers(
  path: string,
  where: string,
  value: unknown,
): CacheMultipliers | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail(path, `${where} must be an object.`);
  const out = {} as CacheMultipliers;
  for (const key of ['read', 'write5m', 'write1h'] as const) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
      fail(path, `${where}.${key} must be a number >= 0 (multiple of the input rate).`);
    out[key] = n;
  }
  return out;
}

function readModelPrice(path: string, model: string, value: unknown): ModelPrice {
  if (!isRecord(value)) fail(path, `models["${model}"] must be an object.`);
  const rate = (key: 'input' | 'output'): number => {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
      fail(path, `models["${model}"].${key} must be a number >= 0 (USD per 1,000,000 tokens).`);
    return n;
  };
  const price: ModelPrice = { input: rate('input'), output: rate('output') };

  if (value.fast !== undefined) {
    if (!isRecord(value.fast)) fail(path, `models["${model}"].fast must be an object.`);
    const fast = value.fast;
    for (const key of ['input', 'output'] as const) {
      const n = fast[key];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
        fail(path, `models["${model}"].fast.${key} must be a number >= 0.`);
    }
    price.fast = { input: fast.input as number, output: fast.output as number };
  }

  const cache = readCacheMultipliers(path, `models["${model}"].cache`, value.cache);
  if (cache) price.cache = cache;
  return price;
}

/** Parses and validates an override file. Never guesses at a missing field. */
export function parsePricingOverride(path: string, raw: unknown): PricingOverride {
  if (!isRecord(raw)) fail(path, 'the file must contain a JSON object.');
  if (typeof raw.version !== 'string' || raw.version.trim() === '')
    fail(path, 'version is required and must be a non-empty string naming your table.');
  if (!isRecord(raw.models))
    fail(path, 'models is required and must be an object keyed by model id.');
  if (raw.replace !== undefined && typeof raw.replace !== 'boolean')
    fail(path, 'replace must be true or false.');

  const models: Record<string, ModelPrice> = {};
  for (const [model, value] of Object.entries(raw.models)) {
    models[model] = readModelPrice(path, model, value);
  }

  const override: PricingOverride = { version: raw.version, models };
  if (typeof raw.provenance === 'string') override.provenance = raw.provenance;
  if (raw.replace === true) override.replace = true;

  const cacheMultipliers = readCacheMultipliers(path, 'cacheMultipliers', raw.cacheMultipliers);
  if (cacheMultipliers) override.cacheMultipliers = cacheMultipliers;

  // Replacing discards the built-in defaults, so there is nothing left to
  // inherit and the file has to say what cache rates apply.
  if (override.replace && !cacheMultipliers)
    fail(
      path,
      'cacheMultipliers.{read,write5m,write1h} is required when replace is true, ' +
        'because there is no built-in table left to inherit it from.',
    );

  return override;
}

/** Applies an override onto the built-in table, or replaces it outright. */
export function applyPricingOverride(
  base: PricingTable,
  override: PricingOverride,
  path: string,
): LoadedPricing {
  if (override.replace) {
    return {
      table: {
        version: override.version,
        provenance: override.provenance ?? `User-supplied pricing table from ${path}`,
        currency: 'USD',
        unit: 'per_million_tokens',
        cacheMultipliers: override.cacheMultipliers as CacheMultipliers,
        models: override.models,
      },
      overridePath: path,
      mode: 'replace',
    };
  }

  // Per-model overlay: an entry replaces that model's price entirely rather than
  // merging field by field. A half-overridden price (new input rate, inherited
  // output rate) is the kind of figure nobody could reason about.
  const models = { ...base.models, ...override.models };
  const provenance = override.provenance
    ? `${override.provenance} (overlaid on: ${base.provenance})`
    : `User overlay from ${path} (overlaid on: ${base.provenance})`;

  return {
    table: {
      version: override.version,
      provenance,
      currency: 'USD',
      unit: 'per_million_tokens',
      cacheMultipliers: override.cacheMultipliers ?? base.cacheMultipliers,
      models,
    },
    overridePath: path,
    mode: 'overlay',
    baseVersion: base.version,
  };
}

/**
 * Loads the built-in table, plus a user override if one is present and valid.
 *
 * The override is an **overlay** by default: its models are merged over the
 * built-in ones by model id. It used to replace the table wholesale, which meant
 * adding a single missing provider cost you every Anthropic price you had -- so
 * the mechanism that existed for adding a model made the tool report less.
 * `"replace": true` still does the old thing for anyone who wants it.
 *
 * A malformed override throws rather than silently falling back: quietly using
 * different prices than the user thinks are in effect would be worse.
 *
 * Underneath the override sit the community prices (see `./community.ts`),
 * filling only the models the built-in tables lack. An override still wins over
 * them, and a `"replace": true` override discards them along with the built-in
 * table, since starting from nothing is what it asks for.
 */
export function loadPricing(): LoadedPricing {
  const community: CommunityPricingState = { source: communityPricingUrl(), added: [] };
  let base = builtinPricing;
  const disabledBy = communityPricingDisabledBy();
  if (disabledBy) {
    community.disabledBy = disabledBy;
  } else {
    const cached = readCommunityPricing(communityPricingPath());
    if (cached) {
      const merged = withCommunityPricing(builtinPricing, cached);
      base = merged.table;
      community.fetchedAt = cached.fetchedAt;
      community.added = merged.added;
    }
  }

  const loaded = loadOverride(base);
  if (loaded.mode === 'replace' && !disabledBy) {
    community.disabledBy = 'a pricing override with "replace": true';
    community.added = [];
  }
  return { ...loaded, community };
}

function loadOverride(base: PricingTable): LoadedPricing {
  const overridePath = pricingOverridePath();
  if (!existsSync(overridePath)) {
    // Naming a file that is not there is a mistake worth stopping for. Falling
    // back to built-in prices would answer with a *different* table than the one
    // asked for, and every cost figure downstream would look ordinary while
    // being computed from rates the user thought they had replaced -- a typo in
    // the path is indistinguishable from the override working. The default
    // config path is the one that is allowed to be absent, because not having it
    // is the normal state rather than a request.
    if (process.env.AI_USAGE_PRICING_FILE) {
      throw new PricingOverrideError(
        `Pricing override at ${overridePath} does not exist (named by AI_USAGE_PRICING_FILE). ` +
          'Create it, correct the path, or unset the variable to use built-in pricing.',
      );
    }
    return { table: base, mode: 'builtin' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(overridePath, 'utf8'));
  } catch (err) {
    throw new Error(`Pricing override at ${overridePath} is not valid JSON`, { cause: err });
  }
  return applyPricingOverride(base, parsePricingOverride(overridePath, parsed), overridePath);
}

export { BUILTIN_PRICING_VERSION };
