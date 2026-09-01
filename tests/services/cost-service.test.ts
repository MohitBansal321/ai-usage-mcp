import { describe, expect, it } from 'vitest';
import { CostService } from '../../src/services/cost-service.js';
import { anthropicPricing } from '../../src/pricing/index.js';

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
    const standard = service.estimate({ model: 'claude-opus-5', inputTokens: 1_000_000, outputTokens: 0, speed: 'standard' });
    const fast = service.estimate({ model: 'claude-opus-5', inputTokens: 1_000_000, outputTokens: 0, speed: 'fast' });
    expect(standard.estimatedCost).toBeCloseTo(5, 9);
    expect(fast.estimatedCost).toBeCloseTo(10, 9);
    expect(fast.note).toContain('fast-mode');
  });

  it('falls back to standard rates when a model has no fast-mode price', () => {
    const fast = service.estimate({ model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 0, speed: 'fast' });
    expect(fast.estimatedCost).toBeCloseTo(2, 9);
  });

  it('always labels estimates as API-equivalent and mentions the subscription case', () => {
    const label = service.estimatedCostLabel();
    expect(label).toContain('API-equivalent');
    expect(label).toContain('$0');
    expect(label).toContain(anthropicPricing.version);
  });

  it('rejects a malformed pricing override rather than silently using different prices', async () => {
    const { loadPricing } = await import('../../src/pricing/index.js');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'pricing-'));
    const file = join(dir, 'pricing.json');
    writeFileSync(file, JSON.stringify({ version: 'broken' }), 'utf8');
    process.env.AI_USAGE_PRICING_FILE = file;
    try {
      expect(() => loadPricing()).toThrow(/missing required fields/);
    } finally {
      delete process.env.AI_USAGE_PRICING_FILE;
    }
  });
});
