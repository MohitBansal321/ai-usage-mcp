import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelPrice, PricingTable } from './types.js';

/**
 * Prices for models the built-in tables have not caught up with yet.
 *
 * A pricing table captured on one date cannot price a model released on the
 * next, and until now the only remedies were a release or a hand-written
 * override. Every Claude Code turn on a new model therefore reported its cost as
 * unavailable, for every user, until one of those happened.
 *
 * LiteLLM publishes a community-maintained price list that tracks releases
 * closely. This module turns the Anthropic first-party entries of that list into
 * {@link ModelPrice}s and caches them on disk; `src/services/pricing-refresh.ts`
 * is what downloads it. Two rules keep it honest:
 *
 *  - It only **fills gaps**. A model the built-in tables price keeps the
 *    built-in price, so a community entry can never change a number this
 *    package already vouches for.
 *  - A model is taken only if the list gives **every** rate the engine needs --
 *    input, output, cache read, and both cache-write TTLs. A missing rate is not
 *    inherited from a default, because the defaults are exactly what newer
 *    models break: Opus 5.5 reads cache at 0.05x its input rate, not 0.1x.
 */

/** LiteLLM's price list, as published in its repository. */
export const COMMUNITY_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** The URL in force: `AI_USAGE_PRICING_URL` points at a mirror, or at a test server. */
export function communityPricingUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.AI_USAGE_PRICING_URL || COMMUNITY_PRICING_URL;
}

/**
 * Why community prices are off, or undefined when they are on.
 *
 * `AI_USAGE_NO_UPDATE_CHECK=1` turns this off too. It was documented as turning
 * off the package's only network request, and somebody who set it for that
 * reason must not find a new request running after an upgrade. Off means off
 * entirely: a cached list is not read either, so the prices in force are exactly
 * the built-in tables plus any override -- reproducible, and what tests rely on.
 */
export function communityPricingDisabledBy(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.AI_USAGE_NO_PRICING_REFRESH === '1') return 'AI_USAGE_NO_PRICING_REFRESH=1';
  if (env.AI_USAGE_NO_UPDATE_CHECK === '1') return 'AI_USAGE_NO_UPDATE_CHECK=1';
  if (env.CI) return 'CI';
  return undefined;
}

/** The converted list, as cached on disk. */
export interface CommunityPricing {
  /** When the list was downloaded, ISO 8601. */
  fetchedAt: string;
  /** Where it was downloaded from. */
  source: string;
  models: Record<string, ModelPrice>;
}

export interface ConvertedList {
  models: Record<string, ModelPrice>;
  /** Anthropic entries that were not taken, with the reason. */
  skipped: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Twelve significant digits: enough to keep every published rate exact, few
 * enough to drop the binary noise of `2e-7 * 1e6 = 0.19999999999999998`.
 */
function tidy(n: number): number {
  return Number(n.toPrecision(12));
}

/** One LiteLLM entry as a {@link ModelPrice}, or the reason it cannot be one. */
function convertEntry(entry: Record<string, unknown>): ModelPrice | string {
  // A long-context tier (Sonnet 4.5 bills more above 200K input tokens) is a
  // price this table cannot express. Pricing every turn at the base rate would
  // understate exactly the expensive ones, so the model is left unpriced.
  if (Object.keys(entry).some((key) => /_above_\d+k_tokens/.test(key))) {
    return 'has a long-context price tier, which the pricing table cannot express';
  }

  const fields = {
    input: entry.input_cost_per_token,
    output: entry.output_cost_per_token,
    read: entry.cache_read_input_token_cost,
    write5m: entry.cache_creation_input_token_cost,
    write1h: entry.cache_creation_input_token_cost_above_1hr,
  };
  const missing = Object.entries(fields)
    .filter(([, v]) => !isRate(v))
    .map(([k]) => k);
  if (missing.length) return `no usable ${missing.join(', ')} rate`;

  const perMillion = (v: unknown) => tidy((v as number) * 1_000_000);
  const input = perMillion(fields.input);
  const output = perMillion(fields.output);
  // The cache rates are stored as multiples of the input rate, which is how the
  // engine applies them -- including to fast-mode input.
  if (input === 0) return 'input rate is 0, so cache rates cannot be expressed as multiples of it';

  const price: ModelPrice = {
    input,
    output,
    cache: {
      read: tidy(perMillion(fields.read) / input),
      write5m: tidy(perMillion(fields.write5m) / input),
      write1h: tidy(perMillion(fields.write1h) / input),
    },
  };

  // Fast mode, as a multiplier of the standard rates (2 for Opus 5 and 5.5,
  // matching the built-in table). The `us` key beside it is data-residency
  // pricing, which no transcript records, so it is not modelled.
  const specific = entry.provider_specific_entry;
  if (isRecord(specific) && isRate(specific.fast) && specific.fast > 0) {
    price.fast = { input: tidy(input * specific.fast), output: tidy(output * specific.fast) };
  }
  return price;
}

/**
 * The Anthropic first-party chat models in a LiteLLM price list.
 *
 * Partner platforms (Bedrock, Vertex) carry their own prices under prefixed keys
 * and are not taken, matching the built-in table's scope.
 */
export function convertLiteLLMPrices(raw: unknown): ConvertedList {
  const out: ConvertedList = { models: {}, skipped: {} };
  if (!isRecord(raw)) return out;
  for (const [model, entry] of Object.entries(raw)) {
    if (!isRecord(entry) || entry.litellm_provider !== 'anthropic') continue;
    if (entry.mode !== 'chat' || !model.startsWith('claude-') || model.includes('/')) continue;
    const price = convertEntry(entry);
    if (typeof price === 'string') out.skipped[model] = price;
    else out.models[model] = price;
  }
  return out;
}

function isPrice(value: unknown): value is ModelPrice {
  if (!isRecord(value) || !isRate(value.input) || !isRate(value.output)) return false;
  const { cache, fast } = value;
  if (!isRecord(cache) || !isRate(cache.read) || !isRate(cache.write5m) || !isRate(cache.write1h))
    return false;
  return fast === undefined || (isRecord(fast) && isRate(fast.input) && isRate(fast.output));
}

/**
 * The cached list, or undefined when there is none or it cannot be trusted.
 *
 * Never throws. Unlike a user's override -- where a typo must stop the tool --
 * this file is ours: a corrupt copy just means the next refresh replaces it.
 * An entry that fails validation is dropped rather than half-used.
 */
export function readCommunityPricing(path: string): CommunityPricing | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || !isRecord(raw.models)) return undefined;
  if (typeof raw.fetchedAt !== 'string' || Number.isNaN(Date.parse(raw.fetchedAt)))
    return undefined;
  if (typeof raw.source !== 'string') return undefined;

  const models: Record<string, ModelPrice> = {};
  for (const [model, price] of Object.entries(raw.models)) {
    if (isPrice(price)) models[model] = price;
  }
  return { fetchedAt: raw.fetchedAt, source: raw.source, models };
}

/**
 * Writes the cache through a temporary file, so a CLI starting while the server
 * refreshes reads the old list or the new one, never half of one.
 */
export function writeCommunityPricing(path: string, pricing: CommunityPricing): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(pricing, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  try {
    renameSync(tmp, path);
  } catch {
    // Windows refuses to replace a file another process has open. Writing in
    // place is still better than keeping a stale list.
    writeFileSync(path, body);
    rmSync(tmp, { force: true });
  }
}

/**
 * Adds the community models a base table lacks.
 *
 * Returns the base table itself, untouched, when there is nothing to add, so a
 * list that merely agrees with the built-in tables changes no version string.
 */
export function withCommunityPricing(
  base: PricingTable,
  community: CommunityPricing,
): { table: PricingTable; added: string[] } {
  const added = Object.keys(community.models)
    .filter((model) => !Object.hasOwn(base.models, model))
    .sort();
  if (added.length === 0) return { table: base, added };

  const models = { ...base.models };
  // Every community price carries its own `cache`, so none of them silently
  // inherits the base table's defaults.
  for (const model of added) models[model] = community.models[model]!;
  const day = community.fetchedAt.slice(0, 10);
  return {
    table: {
      ...base,
      version: `${base.version}+litellm-${day}`,
      provenance:
        `${base.provenance}; plus ${added.length} model(s) the built-in tables lack, from ` +
        `LiteLLM's community price list (${community.source}), fetched ${day}`,
      models,
    },
    added,
  };
}
