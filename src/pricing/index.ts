import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PricingTable } from './types.js';
import { anthropicPricing } from './tables/anthropic-2026-06-24.js';

export type { PricingTable, ModelPrice, CacheMultipliers } from './types.js';

/**
 * Where a user can drop a corrected pricing table without waiting for a release.
 * Prices change; a stale table would silently produce wrong estimates, so this
 * override exists and `ai-usage status` reports whether it is in use.
 */
export function pricingOverridePath(): string {
  return process.env.AI_USAGE_PRICING_FILE ?? join(configDir(), 'pricing.json');
}

export function configDir(): string {
  if (process.env.AI_USAGE_HOME) return process.env.AI_USAGE_HOME;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'ai-usage-mcp') : join(homedir(), '.config', 'ai-usage-mcp');
}

export interface LoadedPricing {
  table: PricingTable;
  /** Set when a user override file replaced the built-in table. */
  overridePath?: string;
}

function isPricingTable(value: unknown): value is PricingTable {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Partial<PricingTable>;
  return (
    typeof t.version === 'string' &&
    typeof t.models === 'object' &&
    t.models !== null &&
    typeof t.cacheMultipliers === 'object' &&
    t.cacheMultipliers !== null &&
    typeof t.cacheMultipliers.read === 'number' &&
    typeof t.cacheMultipliers.write5m === 'number' &&
    typeof t.cacheMultipliers.write1h === 'number'
  );
}

/**
 * Loads the built-in table, or a user override if one is present and valid.
 * A malformed override throws rather than silently falling back -- quietly using
 * different prices than the user thinks are in effect would be worse.
 */
export function loadPricing(): LoadedPricing {
  const overridePath = pricingOverridePath();
  if (existsSync(overridePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(overridePath, 'utf8'));
    } catch (err) {
      throw new Error(
        `Pricing override at ${overridePath} is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!isPricingTable(parsed)) {
      throw new Error(
        `Pricing override at ${overridePath} is missing required fields ` +
          `(version, models, cacheMultipliers.{read,write5m,write1h}).`,
      );
    }
    return { table: parsed, overridePath };
  }
  return { table: anthropicPricing };
}

export { anthropicPricing };
