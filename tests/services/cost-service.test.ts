import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostService } from '../../src/services/cost-service.js';
import { anthropicPricing, loadPricing } from '../../src/pricing/index.js';

const service = new CostService({ table: anthropicPricing });

describe('CostService', () => {
  it('prices input and output at the table rate', () => {
    const estimate = service.estimate({
      model: 'claude-opus-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(estimate.costBasis).toBe('estimated');
    expect(estimate.estimatedCost).toBeCloseTo(5 + 25, 9);
  });

  it('prices cache reads at 0.1x the input rate', () => {
    const estimate = service.estimate({
      model: 'claude-opus-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 10_000_000,
    });
    // 10M cache-read tokens at $5/M * 0.1 = $5
    expect(estimate.estimatedCost).toBeCloseTo(5, 9);
  });

  it('prices the two cache-write TTLs differently', () => {
    const fiveMinute = service.estimate({
      model: 'claude-opus-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 0,
    });
    const oneHour = service.estimate({
      model: 'claude-opus-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 1_000_000,
    });
    expect(fiveMinute.estimatedCost).toBeCloseTo(5 * 1.25, 9);
    expect(oneHour.estimatedCost).toBeCloseTo(5 * 2, 9);
    // Averaging the two TTLs would understate 1-hour writes by 37.5%.
    expect(oneHour.estimatedCost!).toBeGreaterThan(fiveMinute.estimatedCost!);
  });

  it('prices cache-write tokens with no TTL breakdown at the 5-minute rate and says so', () => {
    const estimate = service.estimate({
      model: 'claude-opus-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    });
    expect(estimate.estimatedCost).toBeCloseTo(5 * 1.25, 9);
    expect(estimate.note).toContain('no TTL breakdown');
  });

  it('never double-charges reasoning tokens, which live inside output', () => {
    const withoutReasoningField = service.estimate({
      model: 'claude-opus-5',
      inputTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(withoutReasoningField.estimatedCost).toBeCloseTo(25, 9);
  });

  it('returns unavailable for an unknown model instead of guessing', () => {
    const estimate = service.estimate({
      model: 'claude-does-not-exist',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(estimate.costBasis).toBe('unavailable');
    expect(estimate.estimatedCost).toBeUndefined();
    expect(estimate.note).toContain('No price for model');
  });

  it('uses premium rates when the request ran in fast mode', () => {
    const standard = service.estimate({
      model: 'claude-opus-5',
      inputTokens: 1_000_000,
      outputTokens: 0,
      speed: 'standard',
    });
    const fast = service.estimate({
      model: 'claude-opus-5',
      inputTokens: 1_000_000,
      outputTokens: 0,
      speed: 'fast',
    });
    expect(standard.estimatedCost).toBeCloseTo(5, 9);
    expect(fast.estimatedCost).toBeCloseTo(10, 9);
    expect(fast.note).toContain('fast-mode');
  });

  it('falls back to standard rates when a model has no fast-mode price', () => {
    const fast = service.estimate({
      model: 'claude-sonnet-5',
      inputTokens: 1_000_000,
      outputTokens: 0,
      speed: 'fast',
    });
    expect(fast.estimatedCost).toBeCloseTo(2, 9);
  });

  it('prices Sonnet 5.5 cache reads at 0.05x, not the 0.1x default', () => {
    const estimate = service.estimate({
      model: 'claude-sonnet-5-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 10_000_000,
    });
    // 10M at $2/M * 0.05 = $1 ($0.10/MTok on Anthropic's pricing page).
    expect(estimate.estimatedCost).toBeCloseTo(1, 9);
  });

  describe('a model priced by prompt length (Haiku 5.5)', () => {
    // 1M of each token class, so every rate shows up in the total.
    const tokens = {
      model: 'claude-haiku-5-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 2_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    };
    // input + output + read 0.1x + write5m 1.25x + write1h 2x, per $1 of input rate.
    const total = (input: number, output: number) =>
      input + output + input * 0.1 + input * 1.25 + input * 2;

    it('uses the short-prompt card at exactly the threshold', () => {
      const estimate = service.estimate({ ...tokens, promptTokens: 100_000 });
      expect(estimate.estimatedCost).toBeCloseTo(total(0.1, 0.5), 9);
      expect(estimate.note ?? '').not.toContain('long-context');
    });

    it('uses the long-prompt card for every rate, cache included, above it', () => {
      const estimate = service.estimate({ ...tokens, promptTokens: 100_001 });
      expect(estimate.estimatedCost).toBeCloseTo(total(0.5, 2.5), 9);
      expect(estimate.note).toContain('over 100,000 tokens');
    });

    it('will not guess a card when the prompt length is not given', () => {
      const estimate = service.estimate(tokens);
      expect(estimate.costBasis).toBe('unavailable');
      expect(estimate.estimatedCost).toBeUndefined();
      expect(estimate.note).toContain('priced by prompt length');
    });

    it('lists its threshold for callers that price aggregates', () => {
      expect(service.longContextThresholds()).toEqual([100_000]);
    });
  });

  it('always labels estimates as API-equivalent and mentions the subscription case', () => {
    const label = service.estimatedCostLabel();
    expect(label).toContain('API-equivalent');
    expect(label).toContain('$0');
    expect(label).toContain(anthropicPricing.version);
  });

  it('rejects a malformed pricing override rather than silently using different prices', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pricing-'));
    const file = join(dir, 'pricing.json');
    writeFileSync(file, JSON.stringify({ version: 'broken' }), 'utf8');
    process.env.AI_USAGE_PRICING_FILE = file;
    try {
      expect(() => loadPricing()).toThrow(/models is required/);
    } finally {
      delete process.env.AI_USAGE_PRICING_FILE;
    }
  });
});
