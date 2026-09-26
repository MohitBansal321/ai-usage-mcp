import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { communityPricingPath, writeCommunityPricing } from '../../src/pricing/index.js';
import { UsageService } from '../../src/services/usage-service.js';
import {
  assistantLine,
  buildClaudeProjects,
  buildOpenCodeDb,
  tempDir,
} from '../fixtures/build-fixtures.js';

/** A model no built-in table prices -- the situation a new release puts every user in. */
const NEW_MODEL = 'claude-future-9';

const NEW_MODEL_PRICE = {
  input: 4,
  output: 20,
  cache: { read: 0.05, write5m: 1.25, write1h: 2 },
  fast: { input: 8, output: 40 },
};

/**
 * By hand, per million tokens:
 *   standard turn: 1,000 in x $4 + 2,000 out x $20 + 1,000,000 cache-read x $0.20
 *                  + 10,000 5m-write x $5 + 20,000 1h-write x $8
 *                = 0.004 + 0.04 + 0.2 + 0.05 + 0.16 = 0.454
 *   fast turn:     100 in x $8 + 100 out x $40 = 0.0008 + 0.004 = 0.0048
 */
const EXPECTED_NEW_MODEL_COST = 0.4588;

const SWITCHES = ['AI_USAGE_NO_PRICING_REFRESH', 'AI_USAGE_NO_UPDATE_CHECK', 'CI'] as const;

describe('pricing stored rows the table has since learned', () => {
  let dir: string;
  let dbPath: string;
  let service: UsageService;
  let saved: Partial<Record<string, string>>;

  beforeEach(async () => {
    saved = {};
    for (const key of [...SWITCHES, 'AI_USAGE_HOME']) saved[key] = process.env[key];
    dir = tempDir('reprice-');
    dbPath = join(dir, 'usage.db');
    const now = Date.now();
    process.env.AI_USAGE_HOME = join(dir, 'config');

    // OpenCode reported its own cost for a turn on the same model. No pricing
    // table may overwrite that.
    process.env.AI_USAGE_OPENCODE_DB = buildOpenCodeDb(dir, {
      sessions: [{ id: 'oc-1', parentId: null }],
      messages: [
        {
          id: 'oc-m1',
          sessionId: 'oc-1',
          timeCreated: now - 5000,
          data: {
            role: 'assistant',
            cost: 0.5,
            modelID: NEW_MODEL,
            providerID: 'anthropic',
            tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now - 5000 },
            path: { root: '/work/project-one' },
          },
        },
      ],
    });
    process.env.AI_USAGE_CLAUDE_PROJECTS = buildClaudeProjects(dir, [
      {
        slug: '-work-project-one',
        sessions: [
          {
            sessionId: 'cc-1',
            lines: [
              assistantLine({
                sessionId: 'cc-1',
                requestId: 'r1',
                messageId: 'm1',
                model: NEW_MODEL,
                input: 1000,
                output: 2000,
                cacheRead: 1_000_000,
                cacheWrite5m: 10_000,
                cacheWrite1h: 20_000,
                timestamp: new Date(now - 3000).toISOString(),
                stopReason: 'end_turn',
              }),
              assistantLine({
                sessionId: 'cc-1',
                requestId: 'r2',
                messageId: 'm2',
                model: NEW_MODEL,
                input: 100,
                output: 100,
                speed: 'fast',
                timestamp: new Date(now - 2000).toISOString(),
                stopReason: 'end_turn',
              }),
              assistantLine({
                sessionId: 'cc-1',
                requestId: 'r3',
                messageId: 'm3',
                model: 'claude-sonnet-5',
                input: 10,
                output: 10,
                timestamp: new Date(now - 1000).toISOString(),
                stopReason: 'end_turn',
              }),
            ],
          },
        ],
      },
    ]);

    // Collected while nothing priced the new model: the state every user's
    // database is in when a model ships before the pricing table does.
    process.env.AI_USAGE_NO_PRICING_REFRESH = '1';
    service = UsageService.open({ dbPath });
    await service.sync();
  });

  afterEach(() => {
    service.close();
    delete process.env.AI_USAGE_OPENCODE_DB;
    delete process.env.AI_USAGE_CLAUDE_PROJECTS;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Turns the community list on, with a cached copy that prices the new model. */
  function learnNewModel(): void {
    for (const key of SWITCHES) delete process.env[key];
    writeCommunityPricing(communityPricingPath(), {
      fetchedAt: new Date().toISOString(),
      source: 'https://example.test/prices.json',
      models: { [NEW_MODEL]: NEW_MODEL_PRICE },
    });
  }

  const claudeCost = (s: UsageService) =>
    s.summary({ models: [NEW_MODEL], clients: ['claude-code'] }).overall.cost;

  it('starts out unpriced, not zero', () => {
    const cost = claudeCost(service);
    expect(cost.unavailableRecords).toBe(2);
    expect(cost.estimatedRecords).toBe(0);
  });

  it('prices them as soon as the table in force learns the model', () => {
    learnNewModel();
    expect(service.reloadPricing()).toEqual({ models: [NEW_MODEL], records: 2 });

    const cost = claudeCost(service);
    expect(cost.unavailableRecords).toBe(0);
    expect(cost.estimatedRecords).toBe(2);
    expect(cost.estimated).toBeCloseTo(EXPECTED_NEW_MODEL_COST, 10);
  });

  it('writes exactly what a full re-sync would', async () => {
    learnNewModel();
    service.reloadPricing();
    const repriced = service.summary().overall.cost;

    await service.sync({ full: true });
    const resynced = service.summary().overall.cost;
    expect(resynced.estimated).toBeCloseTo(repriced.estimated, 12);
    expect(resynced.estimatedRecords).toBe(repriced.estimatedRecords);
    expect(resynced.unavailableRecords).toBe(repriced.unavailableRecords);
  });

  it('never touches a cost the client reported itself', () => {
    learnNewModel();
    service.reloadPricing();
    const opencode = service.summary({ models: [NEW_MODEL], clients: ['opencode'] }).overall.cost;
    expect(opencode.reported).toBeCloseTo(0.5, 10);
    expect(opencode.reportedRecords).toBe(1);
    expect(opencode.estimatedRecords).toBe(0);
  });

  it('happens on the first sync after an upgrade, without a full re-sync', async () => {
    // A new process that already knows the model -- a release, an override, or
    // a list cached by another process. Incremental sync reads no old rows.
    service.close();
    learnNewModel();
    service = UsageService.open({ dbPath });

    const report = await service.sync();
    expect(report.repriced).toEqual({ models: [NEW_MODEL], records: 2 });
    expect(claudeCost(service).estimated).toBeCloseTo(EXPECTED_NEW_MODEL_COST, 10);

    // And only once: nothing is left to price.
    expect((await service.sync()).repriced).toBeUndefined();
  });

  it('applies a downloaded list in the same call', async () => {
    for (const key of SWITCHES) delete process.env[key];
    const refresh = await service.refreshPricing({
      download: async () => ({
        [NEW_MODEL]: {
          litellm_provider: 'anthropic',
          mode: 'chat',
          input_cost_per_token: 4e-6,
          output_cost_per_token: 2e-5,
          cache_read_input_token_cost: 2e-7,
          cache_creation_input_token_cost: 5e-6,
          cache_creation_input_token_cost_above_1hr: 8e-6,
          provider_specific_entry: { fast: 2 },
        },
      }),
    });

    expect(refresh).toMatchObject({
      status: 'updated',
      models: 1,
      repriced: { models: [NEW_MODEL], records: 2 },
    });
    expect(claudeCost(service).estimated).toBeCloseTo(EXPECTED_NEW_MODEL_COST, 10);
    expect(service.costService.pricingVersion).toMatch(/\+litellm-\d{4}-\d{2}-\d{2}$/);

    const status = await service.status();
    expect(status.pricing.community?.added).toEqual([NEW_MODEL]);
  });

  it('leaves everything as it was when the download fails', async () => {
    for (const key of SWITCHES) delete process.env[key];
    const version = service.costService.pricingVersion;
    const refresh = await service.refreshPricing({
      download: async () => {
        throw new Error('offline');
      },
    });

    expect(refresh).toEqual({ status: 'failed', reason: 'offline' });
    expect(service.costService.pricingVersion).toBe(version);
    expect(claudeCost(service).unavailableRecords).toBe(2);
  });
});
