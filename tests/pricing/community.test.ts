import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  builtinPricing,
  communityPricingDisabledBy,
  communityPricingPath,
  convertLiteLLMPrices,
  loadPricing,
  readCommunityPricing,
  withCommunityPricing,
  writeCommunityPricing,
  type CommunityPricing,
} from '../../src/pricing/index.js';
import { tempDir } from '../fixtures/build-fixtures.js';

/** A LiteLLM entry at per-token rates, the way the list publishes them. */
function entry(perMillion: {
  input: number;
  output: number;
  read?: number;
  write5m?: number;
  write1h?: number;
}): Record<string, unknown> {
  const e: Record<string, unknown> = {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: perMillion.input / 1e6,
    output_cost_per_token: perMillion.output / 1e6,
  };
  if (perMillion.read !== undefined) e.cache_read_input_token_cost = perMillion.read / 1e6;
  if (perMillion.write5m !== undefined)
    e.cache_creation_input_token_cost = perMillion.write5m / 1e6;
  if (perMillion.write1h !== undefined)
    e.cache_creation_input_token_cost_above_1hr = perMillion.write1h / 1e6;
  return e;
}

// `claude-future-9` below stands for a model released after every built-in
// table was captured; Opus 5.5 itself is now in the built-in table.
const OPUS_5_5 = {
  ...entry({ input: 4, output: 20, read: 0.2, write5m: 5, write1h: 8 }),
  provider_specific_entry: { fast: 2 },
};

describe('convertLiteLLMPrices', () => {
  it('turns per-token rates into per-million rates and cache multipliers', () => {
    const { models } = convertLiteLLMPrices({ 'claude-opus-5-5': OPUS_5_5 });

    // 2e-7 * 1e6 is 0.19999999999999998 in binary; the published $0.20 must survive.
    expect(models['claude-opus-5-5']).toEqual({
      input: 4,
      output: 20,
      cache: { read: 0.05, write5m: 1.25, write1h: 2 },
      fast: { input: 8, output: 40 },
    });
  });

  it('ignores the data-residency multiplier, which no transcript records', () => {
    const { models } = convertLiteLLMPrices({
      'claude-sonnet-5': {
        ...entry({ input: 2, output: 10, read: 0.2, write5m: 2.5, write1h: 4 }),
        provider_specific_entry: { us: 1.1 },
      },
    });
    expect(models['claude-sonnet-5']?.fast).toBeUndefined();
  });

  it('refuses a model it cannot price completely, and says why', () => {
    const { models, skipped } = convertLiteLLMPrices({
      'claude-no-1h': entry({ input: 3, output: 15, read: 0.3, write5m: 3.75 }),
      'claude-sonnet-4-5': {
        ...entry({ input: 3, output: 15, read: 0.3, write5m: 3.75, write1h: 6 }),
        input_cost_per_token_above_200k_tokens: 6e-6,
      },
    });

    // A missing rate is not inherited from a default: the defaults are what
    // newer models break.
    expect(models).toEqual({});
    expect(skipped['claude-no-1h']).toContain('write1h');
    expect(skipped['claude-sonnet-4-5']).toContain('long-context');
  });

  it('takes only Anthropic first-party chat models', () => {
    const { models, skipped } = convertLiteLLMPrices({
      sample_spec: { litellm_provider: 'one of the providers' },
      'bedrock/claude-opus-5-5': { ...OPUS_5_5, litellm_provider: 'bedrock' },
      'anthropic/claude-opus-5-5': OPUS_5_5,
      'gpt-5': { ...OPUS_5_5, litellm_provider: 'openai' },
      'claude-embed': { ...OPUS_5_5, mode: 'embedding' },
      'claude-opus-5-5': OPUS_5_5,
    });
    expect(Object.keys(models)).toEqual(['claude-opus-5-5']);
    expect(skipped).toEqual({});
  });

  it('returns nothing for something that is not a price list', () => {
    expect(convertLiteLLMPrices(null).models).toEqual({});
    expect(convertLiteLLMPrices([1, 2]).models).toEqual({});
    expect(convertLiteLLMPrices('<html>').models).toEqual({});
  });
});

describe('withCommunityPricing', () => {
  const community: CommunityPricing = {
    fetchedAt: '2026-09-26T10:00:00.000Z',
    source: 'https://example.test/prices.json',
    models: {
      'claude-future-9': { input: 4, output: 20, cache: { read: 0.05, write5m: 1.25, write1h: 2 } },
      // Deliberately wrong: a community entry must never replace a built-in price.
      'claude-opus-5': { input: 999, output: 999, cache: { read: 1, write5m: 1, write1h: 1 } },
    },
  };

  it('fills only the models the base table lacks', () => {
    const { table, added } = withCommunityPricing(builtinPricing, community);

    expect(added).toEqual(['claude-future-9']);
    expect(table.models['claude-future-9']?.input).toBe(4);
    expect(table.models['claude-opus-5']).toEqual(builtinPricing.models['claude-opus-5']);
  });

  it('says so in the version and provenance every estimate cites', () => {
    const { table } = withCommunityPricing(builtinPricing, community);
    expect(table.version).toBe(`${builtinPricing.version}+litellm-2026-09-26`);
    expect(table.provenance).toContain("LiteLLM's community price list");
    expect(table.provenance).toContain('https://example.test/prices.json');
    expect(table.provenance).toContain(builtinPricing.provenance);
  });

  it('leaves the base table untouched when it already prices everything', () => {
    const onlyKnown = {
      ...community,
      models: { 'claude-opus-5': community.models['claude-opus-5']! },
    };
    const { table, added } = withCommunityPricing(builtinPricing, onlyKnown);
    expect(added).toEqual([]);
    expect(table).toBe(builtinPricing);
  });
});

describe('the cached list', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir('community-cache-');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips', () => {
    const path = join(dir, 'nested', 'pricing-community.json');
    const pricing: CommunityPricing = {
      fetchedAt: '2026-09-26T10:00:00.000Z',
      source: 'https://example.test/prices.json',
      models: convertLiteLLMPrices({ 'claude-future-9': OPUS_5_5 }).models,
    };
    writeCommunityPricing(path, pricing);
    expect(readCommunityPricing(path)).toEqual(pricing);
  });

  it('is ignored rather than trusted when it is missing or corrupt', () => {
    const path = join(dir, 'pricing-community.json');
    expect(readCommunityPricing(path)).toBeUndefined();

    writeFileSync(path, '{ not json');
    expect(readCommunityPricing(path)).toBeUndefined();

    writeFileSync(path, JSON.stringify({ fetchedAt: 'yesterday', source: 'x', models: {} }));
    expect(readCommunityPricing(path)).toBeUndefined();
  });

  it('drops an entry that fails validation instead of half-using it', () => {
    const path = join(dir, 'pricing-community.json');
    writeFileSync(
      path,
      JSON.stringify({
        fetchedAt: '2026-09-26T10:00:00.000Z',
        source: 'https://example.test/prices.json',
        models: {
          good: { input: 1, output: 5, cache: { read: 0.1, write5m: 1.25, write1h: 2 } },
          noCache: { input: 1, output: 5 },
          negative: { input: -1, output: 5, cache: { read: 0.1, write5m: 1.25, write1h: 2 } },
        },
      }),
    );
    expect(Object.keys(readCommunityPricing(path)?.models ?? {})).toEqual(['good']);
  });
});

describe('communityPricingDisabledBy', () => {
  it('is on unless something turns it off', () => {
    expect(communityPricingDisabledBy({})).toBeUndefined();
    expect(communityPricingDisabledBy({ AI_USAGE_NO_PRICING_REFRESH: '0' })).toBeUndefined();
  });

  it('is off under its own switch, the older no-network switch, and CI', () => {
    expect(communityPricingDisabledBy({ AI_USAGE_NO_PRICING_REFRESH: '1' })).toBe(
      'AI_USAGE_NO_PRICING_REFRESH=1',
    );
    // Documented as turning off the package's only network request: somebody
    // who set it for that must not find a new one after upgrading.
    expect(communityPricingDisabledBy({ AI_USAGE_NO_UPDATE_CHECK: '1' })).toBe(
      'AI_USAGE_NO_UPDATE_CHECK=1',
    );
    expect(communityPricingDisabledBy({ CI: 'true' })).toBe('CI');
  });
});

describe('loadPricing with a cached community list', () => {
  const SWITCHES = [
    'AI_USAGE_HOME',
    'AI_USAGE_PRICING_FILE',
    'AI_USAGE_NO_PRICING_REFRESH',
    'AI_USAGE_NO_UPDATE_CHECK',
    'CI',
  ] as const;
  let saved: Partial<Record<(typeof SWITCHES)[number], string>>;
  let home: string;

  beforeEach(() => {
    saved = {};
    for (const key of SWITCHES) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    home = tempDir('community-load-');
    process.env.AI_USAGE_HOME = home;
    writeCommunityPricing(communityPricingPath(), {
      fetchedAt: '2026-09-26T10:00:00.000Z',
      source: 'https://example.test/prices.json',
      models: convertLiteLLMPrices({ 'claude-future-9': OPUS_5_5 }).models,
    });
  });

  afterEach(() => {
    for (const key of SWITCHES) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('prices a model the built-in tables do not know', () => {
    const loaded = loadPricing();
    expect(loaded.mode).toBe('builtin');
    expect(loaded.table.models['claude-future-9']?.input).toBe(4);
    expect(loaded.community).toEqual({
      source: expect.stringContaining('litellm') as unknown,
      fetchedAt: '2026-09-26T10:00:00.000Z',
      added: ['claude-future-9'],
    });
  });

  it('reads nothing when turned off, so the table is exactly the built-in one', () => {
    process.env.AI_USAGE_NO_PRICING_REFRESH = '1';
    const loaded = loadPricing();
    expect(loaded.table).toBe(builtinPricing);
    expect(loaded.community?.disabledBy).toBe('AI_USAGE_NO_PRICING_REFRESH=1');
    expect(loaded.community?.added).toEqual([]);
  });

  it('sits under a user overlay, which still wins', () => {
    writeFileSync(
      join(home, 'pricing.json'),
      JSON.stringify({ version: 'mine', models: { 'claude-future-9': { input: 7, output: 7 } } }),
    );
    const loaded = loadPricing();
    expect(loaded.mode).toBe('overlay');
    expect(loaded.table.models['claude-future-9']).toEqual({ input: 7, output: 7 });
    expect(loaded.baseVersion).toBe(`${builtinPricing.version}+litellm-2026-09-26`);
  });

  it('is discarded by a replacing override, along with the built-in table', () => {
    writeFileSync(
      join(home, 'pricing.json'),
      JSON.stringify({
        version: 'only-mine',
        replace: true,
        cacheMultipliers: { read: 0.1, write5m: 1.25, write1h: 2 },
        models: { 'my-model': { input: 1, output: 1 } },
      }),
    );
    const loaded = loadPricing();
    expect(Object.keys(loaded.table.models)).toEqual(['my-model']);
    expect(loaded.community?.disabledBy).toContain('"replace": true');
    expect(loaded.community?.added).toEqual([]);
  });
});
