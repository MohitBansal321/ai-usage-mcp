import { describe, expect, it } from 'vitest';
import type { AggregateRow, SessionRow } from '../../src/db/repositories/usage-repository.js';
import type { CostTotals } from '../../src/models/usage-record.js';
import { CostService } from '../../src/services/cost-service.js';
import { anthropicPricing } from '../../src/pricing/index.js';
import {
  compact,
  costLines,
  duration,
  formatClients,
  formatModels,
  formatSessionDetail,
  formatSessions,
  formatStatus,
  formatSummary,
  int,
  tokenLines,
  usd,
} from '../../src/services/formatter.js';

const costService = new CostService({ table: anthropicPricing });

function cost(overrides: Partial<CostTotals> = {}): CostTotals {
  return {
    reported: 0,
    reportedRecords: 0,
    estimated: 0,
    estimatedRecords: 0,
    unavailableRecords: 0,
    currency: 'USD',
    ...overrides,
  };
}

function row(overrides: Partial<AggregateRow> = {}): AggregateRow {
  return {
    records: 1,
    sessions: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: cost(),
    ...overrides,
  };
}

describe('number formatting', () => {
  it('renders exact integers with separators', () => {
    expect(int(76629027)).toBe('76,629,027');
    expect(int(0)).toBe('0');
  });

  it('compacts large magnitudes', () => {
    expect(compact(1234)).toBe('1.2K');
    expect(compact(76629027)).toBe('76.63M');
    expect(compact(1791664252)).toBe('1.79B');
  });

  it('shows sub-cent costs at full precision instead of rounding them to zero', () => {
    // A free-tier model can report a real but tiny cost; "$0.00" would read as
    // "no cost recorded", which is a different claim.
    expect(usd(0)).toBe('$0.00');
    expect(usd(0.000123)).toBe('$0.000123');
    expect(usd(12.5)).toBe('$12.50');
  });

  it('formats durations', () => {
    expect(duration(45)).toBe('45s');
    expect(duration(125)).toBe('2m 5s');
    expect(duration(7200)).toBe('2h 0m');
  });
});

describe('cost rendering', () => {
  it('keeps reported and estimated on separate lines and never sums them', () => {
    const lines = costLines(
      cost({ reported: 0.48, reportedRecords: 6726, estimated: 634.08, estimatedRecords: 5044 }),
      costService,
    );
    const text = lines.join('\n');
    expect(text).toContain('Cost (reported by client, exact): $0.48');
    expect(text).toContain('Cost (estimated, API-equivalent):  $634.08');
    // The blended figure must appear nowhere.
    expect(text).not.toContain('634.56');
  });

  it('labels every estimate as API-equivalent and names the pricing table', () => {
    const text = costLines(cost({ estimated: 10, estimatedRecords: 2 }), costService).join('\n');
    expect(text).toContain('API-equivalent');
    expect(text).toContain(anthropicPricing.version);
    expect(text).toContain('$0');
  });

  it('omits the estimate caveat when nothing was estimated', () => {
    const text = costLines(cost({ reported: 1, reportedRecords: 1 }), costService).join('\n');
    expect(text).not.toContain('API-equivalent');
  });

  it('reports unpriced records as unavailable rather than hiding them', () => {
    const text = costLines(cost({ unavailableRecords: 3 }), costService).join('\n');
    expect(text).toContain('Cost unavailable for 3 record(s)');
  });

  it('says so plainly when a period has no records at all', () => {
    expect(costLines(cost(), costService).join('\n')).toContain('no records in this period');
  });
});

describe('token rendering', () => {
  it('always breaks the token classes out', () => {
    const text = tokenLines(
      row({
        inputTokens: 24381,
        outputTokens: 6033231,
        cacheReadTokens: 800839432,
        cacheWriteTokens: 27164362,
        reasoningTokens: 1205961,
        totalTokens: 834061406,
      }),
    ).join('\n');
    for (const label of [
      'Input:',
      'Output:',
      'Cache read:',
      'Cache write:',
      'Reasoning:',
      'Total:',
    ]) {
      expect(text).toContain(label);
    }
    // Cache read dwarfs input by ~33,000x on real data; both must be visible.
    expect(text).toContain('24,381');
    expect(text).toContain('800,839,432');
  });
});

describe('report rendering', () => {
  const period = { label: 'all time' };

  it('states that a period is empty instead of printing zeros', () => {
    const text = formatSummary(
      {
        period,
        includeSubagents: true,
        overall: row({ records: 0, sessions: 0 }),
        byClient: [],
        turnKinds: { main: 0, subagent: 0 },
      },
      costService,
    );
    expect(text).toContain('No usage records for this period');
    expect(text).toContain('ai-usage sync');
  });

  it('declares whether subagent turns are included, either way', () => {
    const base = {
      period,
      overall: row({ records: 3 }),
      byClient: [],
      turnKinds: { main: 2, subagent: 1 },
    };
    expect(formatSummary({ ...base, includeSubagents: true }, costService)).toContain(
      'Subagent/sidechain turns: INCLUDED',
    );
    expect(formatSummary({ ...base, includeSubagents: false }, costService)).toContain(
      'Subagent/sidechain turns: EXCLUDED',
    );
  });

  it('warns in client_usage that the two cost figures are not comparable', () => {
    const text = formatClients(
      {
        period,
        includeSubagents: true,
        clients: [
          { key: 'opencode', ...row({ cost: cost({ reported: 0.48, reportedRecords: 10 }) }) },
          { key: 'claude-code', ...row({ cost: cost({ estimated: 600, estimatedRecords: 10 }) }) },
        ],
        overall: row(),
      },
      costService,
    );
    expect(text).toContain('must not be added');
  });

  it('renders per-model rows highest-first with their own cost basis', () => {
    const text = formatModels(
      {
        period,
        includeSubagents: true,
        models: [
          {
            key: 'claude-opus-5',
            ...row({ totalTokens: 500, cost: cost({ estimated: 5, estimatedRecords: 1 }) }),
          },
          {
            key: 'big-pickle',
            ...row({ totalTokens: 100, cost: cost({ reported: 0, reportedRecords: 1 }) }),
          },
        ],
        overall: row({ totalTokens: 600 }),
      },
      costService,
    );
    expect(text.indexOf('claude-opus-5')).toBeLessThan(text.indexOf('big-pickle'));
    expect(text).toContain('Total across 2 model(s)');
  });

  it('tells the user to sync when no sessions are stored', () => {
    expect(formatSessions([], costService)).toContain('ai-usage sync');
  });

  function session(overrides: Partial<SessionRow> = {}): SessionRow {
    return {
      ...row(),
      sessionId: 'sess-1',
      client: 'claude-code',
      models: ['claude-opus-5'],
      startedAt: '2026-08-30T10:00:00.000Z',
      endedAt: '2026-08-30T10:30:00.000Z',
      durationSeconds: 1800,
      mainRecords: 2,
      subagentRecords: 1,
      ...overrides,
    };
  }

  it('shows the main/subagent split in a session detail', () => {
    const text = formatSessionDetail(
      {
        session: session({ totalTokens: 300 }),
        models: [],
        main: row({ totalTokens: 200 }),
        subagent: row({ totalTokens: 100 }),
      },
      costService,
    );
    expect(text).toContain('Main-thread turns only:');
    expect(text).toContain('Subagent turns only:');
    expect(text).toContain('2 main, 1 subagent');
  });

  it('omits the split when a session has no subagent turns', () => {
    const text = formatSessionDetail(
      {
        session: session({ subagentRecords: 0, mainRecords: 2 }),
        models: [],
        main: row(),
        subagent: row(),
      },
      costService,
    );
    expect(text).not.toContain('Subagent turns only:');
  });

  it('reports an unknown project and unknown models honestly', () => {
    const text = formatSessions([session({ models: [] })], costService);
    expect(text).toContain('(unknown)');
  });
});

describe('formatStatus', () => {
  const status = {
    databasePath: '/tmp/ai-usage.db',
    schemaVersion: 3,
    sqliteDriver: 'node:sqlite' as const,
    totalRecords: 12,
    collectors: [],
    pricing: { version: '2026-06-24', provenance: 'built-in' },
    syncState: [],
  };

  it('points at the update command when a newer release exists', () => {
    const text = formatStatus(status, { current: '0.1.0', latest: '0.2.0', isOutdated: true });
    expect(text).toContain('Version:        0.1.0');
    expect(text).toContain('Update available: 0.1.0 installed, 0.2.0 latest');
    expect(text).toContain('npm i -g ai-usage-mcp@latest');
  });

  it('stays quiet when the install is current, or when the check found nothing', () => {
    const current = formatStatus(status, { current: '0.2.0', latest: '0.2.0', isOutdated: false });
    expect(current).not.toContain('Update available');
    expect(formatStatus(status, null)).not.toContain('Update available');
  });
});
