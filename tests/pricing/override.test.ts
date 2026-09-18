import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anthropicPricing,
  applyPricingOverride,
  builtinPricing,
  loadPricing,
  openaiPricing,
  parsePricingOverride,
} from '../../src/pricing/index.js';
import { composePricingTables, providerTables } from '../../src/pricing/tables/index.js';
import { CostService } from '../../src/services/cost-service.js';

function writeOverride(body: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'pricing-override-')), 'pricing.json');
  writeFileSync(file, JSON.stringify(body), 'utf8');
  process.env.AI_USAGE_PRICING_FILE = file;
  return file;
}

afterEach(() => {
  delete process.env.AI_USAGE_PRICING_FILE;
});

/**
 * The override used to REPLACE the built-in table, so the only mechanism for
 * adding a missing provider cost you every price you already had. These assert
 * the overlay behaviour that replaced it, and that the old behaviour is still
 * reachable when someone actually wants it.
 */
describe('pricing override: overlay', () => {
  it('adds a model without discarding the built-in prices', () => {
    writeOverride({
      version: 'mine-2026-09-16',
      models: { 'deepseek-v4-pro': { input: 0.66, output: 1.98 } },
    });
    const loaded = loadPricing();

    expect(loaded.mode).toBe('overlay');
    expect(loaded.baseVersion).toBe(builtinPricing.version);
    expect(loaded.table.version).toBe('mine-2026-09-16');
    // The whole point: the new model AND every built-in one.
    expect(loaded.table.models['deepseek-v4-pro']).toEqual({ input: 0.66, output: 1.98 });
    expect(loaded.table.models['claude-opus-5']).toEqual(anthropicPricing.models['claude-opus-5']);
    expect(loaded.table.models['gpt-5.6-sol']).toEqual(openaiPricing.models['gpt-5.6-sol']);
  });

  it('corrects a stale built-in price in place', () => {
    writeOverride({
      version: 'corrected',
      models: { 'claude-opus-5': { input: 6, output: 30 } },
    });
    const table = loadPricing().table;

    expect(table.models['claude-opus-5']).toEqual({ input: 6, output: 30 });
    // Everything else is untouched.
    expect(Object.keys(table.models).length).toBe(Object.keys(builtinPricing.models).length);
    expect(table.models['claude-sonnet-5']).toEqual(anthropicPricing.models['claude-sonnet-5']);
  });

  it('replaces a model wholesale rather than merging it field by field', () => {
    // claude-opus-5 ships with `fast` rates. An override that omits them means
    // "this model has no fast rates", not "keep the old ones" -- a half-inherited
    // price is a figure nobody could reason about.
    writeOverride({ version: 'no-fast', models: { 'claude-opus-5': { input: 1, output: 2 } } });
    expect(loadPricing().table.models['claude-opus-5']?.fast).toBeUndefined();
  });

  it('keeps the base provenance so an overlaid table still says what it sits on', () => {
    writeOverride({
      version: 'mine',
      provenance: 'my own rate card',
      models: { x: { input: 1, output: 2 } },
    });
    const provenance = loadPricing().table.provenance;
    expect(provenance).toContain('my own rate card');
    expect(provenance).toContain('Anthropic');
  });

  it('lets an overlay change the default cache multipliers', () => {
    writeOverride({
      version: 'cheap-cache',
      cacheMultipliers: { read: 0.02, write5m: 1, write1h: 1 },
      models: { 'my-model': { input: 10, output: 20 } },
    });
    const service = new CostService(loadPricing());
    const estimate = service.estimate({
      model: 'my-model',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(estimate.estimatedCost).toBeCloseTo(10 * 0.02, 9);
  });
});

/**
 * A named file that is not there used to load the built-in table and say nothing.
 *
 * That is the worst shape a pricing bug can take: every cost figure downstream
 * looks ordinary while being computed from rates the user believed they had
 * replaced, and a typo in the path is indistinguishable from the override
 * working. The default config path keeps falling back, because not having one is
 * the normal state rather than a request.
 */
describe('pricing override: a named file that is missing', () => {
  it('refuses to fall back when AI_USAGE_PRICING_FILE names a file that does not exist', () => {
    process.env.AI_USAGE_PRICING_FILE = join(
      mkdtempSync(join(tmpdir(), 'pricing-missing-')),
      'no-such-pricing.json',
    );
    expect(() => loadPricing()).toThrow(/does not exist/);
    expect(() => loadPricing()).toThrow(/AI_USAGE_PRICING_FILE/);
  });

  it('still falls back silently when no override was ever asked for', () => {
    delete process.env.AI_USAGE_PRICING_FILE;
    process.env.AI_USAGE_HOME = mkdtempSync(join(tmpdir(), 'pricing-no-config-'));
    try {
      const loaded = loadPricing();
      expect(loaded.mode).toBe('builtin');
      expect(loaded.table.version).toBe(builtinPricing.version);
    } finally {
      delete process.env.AI_USAGE_HOME;
    }
  });
});

describe('pricing override: replace', () => {
  it('discards the built-in table when asked explicitly', () => {
    writeOverride({
      version: 'only-mine',
      replace: true,
      cacheMultipliers: { read: 0.1, write5m: 1.25, write1h: 2 },
      models: { 'my-model': { input: 1, output: 2 } },
    });
    const loaded = loadPricing();

    expect(loaded.mode).toBe('replace');
    expect(loaded.baseVersion).toBeUndefined();
    expect(Object.keys(loaded.table.models)).toEqual(['my-model']);
    expect(loaded.table.models['claude-opus-5']).toBeUndefined();
  });

  it('refuses to replace without cache multipliers, since nothing is left to inherit', () => {
    writeOverride({ version: 'only-mine', replace: true, models: { m: { input: 1, output: 2 } } });
    expect(() => loadPricing()).toThrow(/cacheMultipliers.*required when replace is true/s);
  });
});

/**
 * A malformed override throws rather than falling back, so the error has to say
 * which field is wrong -- otherwise the strictness is just a wall.
 */
describe('pricing override: validation names the bad field', () => {
  const cases: [string, unknown, RegExp][] = [
    ['no version', { models: {} }, /version is required/],
    ['empty version', { version: '   ', models: {} }, /version is required/],
    ['no models', { version: 'v' }, /models is required/],
    [
      'model is not an object',
      { version: 'v', models: { m: 3 } },
      /models\["m"\] must be an object/,
    ],
    [
      'missing output rate',
      { version: 'v', models: { m: { input: 1 } } },
      /models\["m"\]\.output must be a number/,
    ],
    [
      'negative rate',
      { version: 'v', models: { m: { input: -1, output: 2 } } },
      /models\["m"\]\.input must be a number/,
    ],
    [
      'rate as a string -- the most likely hand-edit mistake',
      { version: 'v', models: { m: { input: '1', output: 2 } } },
      /models\["m"\]\.input must be a number/,
    ],
    [
      'bad per-model cache block',
      { version: 'v', models: { m: { input: 1, output: 2, cache: { read: 0.1 } } } },
      /models\["m"\]\.cache\.write5m must be a number/,
    ],
    [
      'bad fast rates',
      { version: 'v', models: { m: { input: 1, output: 2, fast: { input: 1 } } } },
      /models\["m"\]\.fast\.output must be a number/,
    ],
    [
      'bad top-level cache block',
      { version: 'v', models: {}, cacheMultipliers: 3 },
      /must be an object/,
    ],
    [
      'replace is not a boolean',
      { version: 'v', models: {}, replace: 'yes' },
      /replace must be true or false/,
    ],
  ];

  for (const [name, body, message] of cases) {
    it(name, () => {
      expect(() => parsePricingOverride('/tmp/p.json', body)).toThrow(message);
    });
  }

  it('names the file in every message, since the user has to go and edit it', () => {
    expect(() => parsePricingOverride('/etc/prices.json', { version: 'v' })).toThrow(
      /\/etc\/prices\.json/,
    );
  });

  it('still rejects a file that is not JSON at all', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pricing-override-')), 'pricing.json');
    writeFileSync(file, 'not json', 'utf8');
    process.env.AI_USAGE_PRICING_FILE = file;
    expect(() => loadPricing()).toThrow(/not valid JSON/);
  });
});

describe('per-model cache multipliers', () => {
  it('prices a model by its own cache rates, not the table default', () => {
    const service = new CostService({
      table: {
        version: 't',
        provenance: 'test',
        currency: 'USD',
        unit: 'per_million_tokens',
        cacheMultipliers: { read: 0.1, write5m: 1.25, write1h: 2 },
        models: {
          inherits: { input: 10, output: 20 },
          owns: { input: 10, output: 20, cache: { read: 0.02, write5m: 1, write1h: 1 } },
        },
      },
    });

    const args = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 };
    expect(service.estimate({ model: 'inherits', ...args }).estimatedCost).toBeCloseTo(1, 9);
    expect(service.estimate({ model: 'owns', ...args }).estimatedCost).toBeCloseTo(0.2, 9);
  });

  it('applies them to the 1-hour cache-write tier too', () => {
    const service = new CostService({ table: builtinPricing });
    const args = {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    };
    // Anthropic: 1-hour writes bill at 2x input.
    expect(service.estimate({ model: 'claude-sonnet-5', ...args }).estimatedCost).toBeCloseTo(
      2 * 2,
      9,
    );
    // OpenAI publishes ONE cache-write price and no 1-hour tier, so inheriting
    // Anthropic's 2x would overcharge it by 60%.
    expect(service.estimate({ model: 'gpt-5.6-terra', ...args }).estimatedCost).toBeCloseTo(
      2 * 1.25,
      9,
    );
  });
});

describe('built-in table composition', () => {
  it('prices both Anthropic and OpenAI models out of the box', () => {
    const service = new CostService({ table: builtinPricing });
    expect(service.knowsModel('claude-opus-5')).toBe(true);
    expect(service.knowsModel('gpt-5.6-sol')).toBe(true);
    expect(service.knowsModel('nothing-here')).toBe(false);
  });

  it('joins every provider provenance so each capture date stays visible', () => {
    for (const table of providerTables) {
      expect(builtinPricing.provenance).toContain(table.provenance);
    }
  });

  it('refuses to compose two tables that price the same model', () => {
    const a = { ...anthropicPricing, version: 'a' };
    const b = { ...anthropicPricing, version: 'b' };
    expect(() => composePricingTables([a, b], 'x')).toThrow(/priced by both a and b/);
  });

  it('carries a table default onto its own models rather than the first table default', () => {
    const first = {
      ...anthropicPricing,
      version: 'first',
      cacheMultipliers: { read: 0.1, write5m: 1.25, write1h: 2 },
      models: { alpha: { input: 1, output: 1 } },
    };
    const second = {
      ...anthropicPricing,
      version: 'second',
      cacheMultipliers: { read: 0.5, write5m: 3, write1h: 3 },
      models: { beta: { input: 1, output: 1 } },
    };
    const composed = composePricingTables([first, second], 'x');

    expect(composed.models['alpha']?.cache).toBeUndefined();
    // Without this, `beta` would silently start billing at `first`'s rates.
    expect(composed.models['beta']?.cache).toEqual({ read: 0.5, write5m: 3, write1h: 3 });
  });
});

describe('applyPricingOverride', () => {
  it('is a pure function of a base table and an override', () => {
    const base = { ...anthropicPricing };
    const before = Object.keys(base.models).length;
    applyPricingOverride(base, { version: 'v', models: { extra: { input: 1, output: 2 } } }, '/p');
    expect(Object.keys(base.models).length).toBe(before);
  });
});
