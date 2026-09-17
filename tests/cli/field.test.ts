import { describe, expect, it } from 'vitest';
import { FieldError, exceedsThreshold, readField, renderField } from '../../src/cli/field.js';
import { ArgError, parseArgs } from '../../src/cli/args.js';

const report = {
  period: { label: 'today' },
  overall: {
    records: 52,
    totalTokens: 14_187_806,
    cost: { reported: 0, reportedRecords: 0, estimated: 11.27, estimatedRecords: 52 },
  },
  byClient: [{ key: 'claude-code', records: 52 }],
};

describe('readField', () => {
  it('reads a nested value by dotted path', () => {
    expect(readField(report, 'overall.cost.estimated')).toBe(11.27);
    expect(readField(report, 'overall.records')).toBe(52);
    expect(readField(report, 'period.label')).toBe('today');
  });

  it('indexes into an array with a numeric segment', () => {
    expect(readField(report, 'byClient.0.key')).toBe('claude-code');
  });

  it('errors on a path that does not exist, and says what is available', () => {
    // Silently returning empty would make a threshold check pass forever, which
    // is the worst failure an alert can have: it looks like everything is fine.
    let message = '';
    try {
      readField(report, 'cost.estimated');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('no "cost"');
    expect(message).toContain('overall');
  });

  it('errors on an out-of-range or non-numeric array index', () => {
    expect(() => readField(report, 'byClient.9.key')).toThrow(/not a valid index/);
    expect(() => readField(report, 'byClient.name')).toThrow(/not a valid index/);
  });

  it('errors when a path walks into a scalar', () => {
    expect(() => readField(report, 'overall.records.deeper')).toThrow(/is a number/);
  });

  it('rejects an empty path', () => {
    expect(() => readField(report, '.')).toThrow(FieldError);
  });
});

describe('renderField', () => {
  it('prints a bare scalar, with no quotes or formatting', () => {
    expect(renderField(11.27, 'x')).toBe('11.27');
    expect(renderField(0, 'x')).toBe('0');
    expect(renderField('claude-code', 'x')).toBe('claude-code');
    expect(renderField(false, 'x')).toBe('false');
  });

  it('refuses an object or array rather than printing [object Object]', () => {
    expect(() => renderField({ a: 1 }, 'overall')).toThrow(/not a single value/);
    expect(() => renderField([1, 2], 'byClient')).toThrow(/not a single value/);
  });

  it('refuses an absent value rather than printing 0', () => {
    // A value the source did not report is not zero, and a script that read it
    // as zero would act on a number nobody produced.
    expect(() => renderField(undefined, 'cost.unpricedRecords')).toThrow(/not report/);
    expect(() => renderField(null, 'x')).toThrow(/null/);
  });
});

describe('exceedsThreshold', () => {
  it('is strictly greater, so a value exactly at the threshold passes', () => {
    expect(exceedsThreshold(25.01, 25, 'x')).toBe(true);
    expect(exceedsThreshold(25, 25, 'x')).toBe(false);
    expect(exceedsThreshold(0, 25, 'x')).toBe(false);
  });

  it('refuses to compare something that is not a number', () => {
    expect(() => exceedsThreshold('claude-code', 25, 'x')).toThrow(/needs a number/);
  });
});

describe('--fail-over requires --field', () => {
  it('refuses a threshold with nothing to threshold', () => {
    // There is deliberately no default field: reported and estimated cost are
    // never summed, so "fail if cost exceeds $25" has no single answer, and
    // guessing one would ignore every record priced the other way.
    let message = '';
    try {
      parseArgs(['stats', '--today', '--fail-over', '25']);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('requires --field');
    expect(message).toContain('never summed');
  });

  it('accepts the two together', () => {
    const args = parseArgs([
      'stats',
      '--today',
      '--field',
      'overall.cost.estimated',
      '--fail-over',
      '25',
    ]);
    expect(args.field).toBe('overall.cost.estimated');
    expect(args.failOver).toBe(25);
  });

  it('allows --field on its own, for reading a value without a check', () => {
    expect(parseArgs(['stats', '--field', 'overall.records']).failOver).toBeUndefined();
  });

  it('rejects a non-numeric threshold', () => {
    expect(() => parseArgs(['stats', '--field', 'x', '--fail-over', 'lots'])).toThrow(ArgError);
  });

  it('accepts a fractional threshold, since money is not an integer', () => {
    expect(parseArgs(['stats', '--field', 'x', '--fail-over', '0.5']).failOver).toBe(0.5);
  });
});
