import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armUpdateNotice,
  resetUpdateNotice,
  startUpdateWatch,
  takeUpdateNotice,
} from '../../src/mcp/notice.js';
import { textResult } from '../../src/mcp/tools/shared.js';

const outdated = {
  current: '0.2.0',
  latest: '0.3.0',
  isOutdated: true,
  installKind: 'global' as const,
};

describe('MCP update notice', () => {
  beforeEach(() => {
    resetUpdateNotice();
    // The notice also goes to stderr; the test output does not need it.
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetUpdateNotice();
  });

  it('is delivered exactly once, however many tools are called', () => {
    armUpdateNotice(outdated);

    const first = takeUpdateNotice();
    expect(first).toContain('0.3.0 is the latest release');
    expect(takeUpdateNotice()).toBeNull();
    expect(takeUpdateNotice()).toBeNull();
  });

  it('does not arm for a current install, or for an unknown answer', () => {
    armUpdateNotice({ current: '0.3.0', latest: '0.3.0', isOutdated: false });
    expect(takeUpdateNotice()).toBeNull();

    armUpdateNotice(null);
    expect(takeUpdateNotice()).toBeNull();
  });

  it('does not repeat what the handshake already said', () => {
    // A second arming, after one notice has been delivered, is silent: the
    // background check must not re-announce what `instructions` carried.
    armUpdateNotice(outdated);
    expect(takeUpdateNotice()).not.toBeNull();

    armUpdateNotice(outdated);
    expect(takeUpdateNotice()).toBeNull();
  });

  it('says it on stderr as well, for a bug report to point at', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    armUpdateNotice(outdated);

    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]?.[0])).toContain('ai-usage-mcp 0.2.0 is running');
  });

  it('survives a failed check without arming anything', async () => {
    await startUpdateWatch(() => Promise.reject(new Error('offline')), '0.2.0');
    expect(takeUpdateNotice()).toBeNull();
  });

  it('arms from the background check when it finds a newer release', async () => {
    await startUpdateWatch(() => Promise.resolve(outdated), '0.2.0');
    expect(takeUpdateNotice()).toContain('0.3.0');
  });
});

describe('textResult', () => {
  beforeEach(() => {
    resetUpdateNotice();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetUpdateNotice();
  });

  it('carries no extra block when there is nothing to say', () => {
    const result = textResult('Usage summary\n...', { totals: { totalTokens: 5 } });

    expect(result.content).toHaveLength(1);
    expect(result.structuredContent).toEqual({ totals: { totalTokens: 5 } });
  });

  it('keeps the data block byte-identical and puts the notice beside it', () => {
    armUpdateNotice(outdated);
    const data = 'Usage summary\n...';
    const result = textResult(data, { totals: { totalTokens: 5 } });

    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.text).toBe(data);
    expect(result.content[1]!.text).toContain('Server notice');
    // Beside the numbers, never mixed into them.
    expect(result.structuredContent).toMatchObject({
      totals: { totalTokens: 5 },
      serverNotice: expect.stringContaining('0.3.0'),
    });
  });

  it('only decorates the first result, so the next call is clean', () => {
    armUpdateNotice(outdated);
    expect(textResult('first').content).toHaveLength(2);
    expect(textResult('second').content).toHaveLength(1);
  });

  it('adds no structuredContent to a tool that returns none', () => {
    armUpdateNotice(outdated);
    const result = textResult('text only');

    expect(result.content).toHaveLength(2);
    expect(result.structuredContent).toBeUndefined();
  });
});
