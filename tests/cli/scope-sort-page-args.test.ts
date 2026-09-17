import { describe, expect, it } from 'vitest';
import { ArgError, parseArgs } from '../../src/cli/args.js';

/**
 * The flag boundary, which is where a scope filter has to be rejected if it
 * would silently stop filtering. `--model a,b` used to parse as ONE literal id,
 * match nothing, and report an empty period at exit 0 -- a typo rendered as a
 * fact about the data.
 */
describe('scope flags accept several values', () => {
  it('splits a comma-separated list', () => {
    expect(parseArgs(['models', '--model', 'claude-opus-5,claude-sonnet-5']).models).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
  });

  it('accumulates a repeated flag', () => {
    expect(
      parseArgs(['models', '--model', 'claude-opus-5', '--model', 'claude-sonnet-5']).models,
    ).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('treats a repeated flag and a comma list identically', () => {
    expect(parseArgs(['projects', '--project', '/a', '--project', '/b']).projects).toEqual(
      parseArgs(['projects', '--project', '/a,/b']).projects,
    );
  });

  it('trims whitespace around values, which a shell makes easy to introduce', () => {
    expect(parseArgs(['models', '--model', ' a , b ']).models).toEqual(['a', 'b']);
  });

  it('accepts several clients, and still rejects an unknown one', () => {
    expect(parseArgs(['stats', '--client', 'opencode,claude-code']).clients).toEqual([
      'opencode',
      'claude-code',
    ]);
    expect(() => parseArgs(['stats', '--client', 'opencode,nope'])).toThrow(ArgError);
  });

  it('still refuses a value that would silently stop filtering', () => {
    expect(() => parseArgs(['models', '--model', ''])).toThrow(/non-empty/);
    expect(() => parseArgs(['models', '--model', ',,,'])).toThrow(/at least one non-empty/);
    expect(() => parseArgs(['projects', '--project', ' '])).toThrow(/non-empty/);
  });
});

describe('--sort', () => {
  it('accepts every documented key', () => {
    for (const key of [
      'tokens',
      'reported-cost',
      'estimated-cost',
      'records',
      'sessions',
      'recent',
    ])
      expect(parseArgs(['sessions', '--sort', key]).sort).toBe(key);
  });

  it('refuses a bare `cost`, and says which two to pick from', () => {
    // Reported and estimated cost are never summed, so "order by cost" has no
    // single answer: ordering by one sorts every row priced on the other basis
    // as $0. Guessing is the wrong-number-that-looks-right this project avoids.
    let message = '';
    try {
      parseArgs(['sessions', '--sort', 'cost']);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('ambiguous');
    expect(message).toContain('--sort reported-cost');
    expect(message).toContain('--sort estimated-cost');
  });

  it('refuses an unknown key rather than falling back to a default', () => {
    expect(() => parseArgs(['sessions', '--sort', 'price'])).toThrow(/--sort expects one of/);
  });
});

describe('--offset', () => {
  it('accepts zero, which --limit does not', () => {
    expect(parseArgs(['sessions', '--offset', '0']).offset).toBe(0);
    expect(() => parseArgs(['sessions', '--limit', '0'])).toThrow(/positive integer/);
  });

  it('rejects a negative or fractional offset', () => {
    expect(() => parseArgs(['sessions', '--offset', '-1'])).toThrow(/non-negative integer/);
    expect(() => parseArgs(['sessions', '--offset', '1.5'])).toThrow(/non-negative integer/);
  });
});

describe('counterfactual targets are named apart from the scope filter', () => {
  it('keeps --models working, since it predates --target-models', () => {
    expect(parseArgs(['counterfactual', '--models', 'a,b']).counterfactualModels).toEqual([
      'a',
      'b',
    ]);
  });

  it('accepts --target-models as the clearer name', () => {
    expect(parseArgs(['counterfactual', '--target-models', 'a,b']).counterfactualModels).toEqual([
      'a',
      'b',
    ]);
  });

  it('keeps --model (scope) and --target-models (rates) apart', () => {
    // "What would my Opus turns have cost on Sonnet" needs both at once, so one
    // flag could never have served both.
    const args = parseArgs([
      'counterfactual',
      '--model',
      'claude-opus-5',
      '--target-models',
      'claude-sonnet-5',
    ]);
    expect(args.models).toEqual(['claude-opus-5']);
    expect(args.counterfactualModels).toEqual(['claude-sonnet-5']);
  });
});

describe('--grain', () => {
  it('accepts every documented grain', () => {
    for (const grain of ['hour', 'day', 'hour-of-day'])
      expect(parseArgs(['daily', '--grain', grain]).grain).toBe(grain);
  });

  it('rejects an unknown grain rather than falling back to day', () => {
    expect(() => parseArgs(['daily', '--grain', 'week'])).toThrow(/--grain expects one of/);
  });
});

describe('--compare', () => {
  it('accepts `previous`', () => {
    expect(parseArgs(['stats', '--days', '7', '--compare', 'previous']).compare).toBe(true);
  });

  it('is false unless asked for', () => {
    expect(parseArgs(['stats']).compare).toBe(false);
  });

  it('takes a value, so a window can be named later without changing what works', () => {
    expect(() => parseArgs(['stats', '--compare'])).toThrow(/requires a value/);
    expect(() => parseArgs(['stats', '--compare', 'last-week'])).toThrow(/expects "previous"/);
  });
});
