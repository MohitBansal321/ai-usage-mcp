import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openSqlite } from '../../src/db/driver.js';
import { UsageService } from '../../src/services/usage-service.js';
import { buildOpenCodeDb, tempDir } from '../fixtures/build-fixtures.js';

const tokens = (input: number) => ({
  input,
  output: 10,
  reasoning: 2,
  cache: { read: input * 10, write: 0 },
});

/**
 * An OpenCode 2.x database straddling the switch: older turns in `message` (with
 * their `part` rows), the same turns mirrored into `session_message`, and newer
 * turns only in `session_message`. Reading only `message` silently drops the newer
 * ones, which is what happened before this was supported.
 */
describe('OpenCode 2.x database (session_message / session_v2)', () => {
  let dir: string;
  let dbPath: string;
  let service: UsageService;
  const now = Date.now();

  beforeEach(() => {
    dir = tempDir('verify-oc-v2-');
    const claude = join(dir, 'claude-projects');
    mkdirSync(claude);
    process.env.AI_USAGE_CLAUDE_PROJECTS = claude;

    const legacy = { role: 'assistant', modelID: 'm', providerID: 'p', cost: 0.25 };
    dbPath = buildOpenCodeDb(dir, {
      sessions: [{ id: 'ses-1' }],
      messages: [
        {
          id: 'old-1',
          sessionId: 'ses-1',
          timeCreated: now - 5000,
          data: { ...legacy, tokens: tokens(100), time: { created: now - 5000 } },
        },
      ],
      parts: [
        {
          id: 'part-1',
          messageId: 'old-1',
          sessionId: 'ses-1',
          data: { type: 'step-finish', tokens: tokens(100), cost: 0.25 },
        },
      ],
      sessionsV2: [{ id: 'ses-1' }, { id: 'ses-2', directory: '/work/v2-only' }],
      sessionMessages: [
        {
          id: 'old-1',
          sessionId: 'ses-1',
          timeCreated: now - 5000,
          data: {
            model: { id: 'm', providerID: 'p' },
            cost: 0.25,
            tokens: tokens(100),
            time: { created: now - 5000 },
          },
        },
        {
          id: 'new-1',
          sessionId: 'ses-2',
          timeCreated: now - 3000,
          data: {
            model: { id: 'm', providerID: 'p' },
            cost: 0.5,
            tokens: tokens(200),
            time: { created: now - 3000 },
          },
        },
      ],
    });
    process.env.AI_USAGE_OPENCODE_DB = dbPath;
    service = UsageService.open({ dbPath: join(dir, 'usage.db') });
  });

  afterEach(() => {
    service.close();
    delete process.env.AI_USAGE_OPENCODE_DB;
    delete process.env.AI_USAGE_CLAUDE_PROJECTS;
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts turns that only exist in session_message, once', async () => {
    await service.sync();
    const { overall } = service.summary({ clients: ['opencode'] });
    expect(overall.records).toBe(2);
    expect(overall.inputTokens).toBe(300);
  });

  it('picks up turns OpenCode writes after an earlier sync', async () => {
    await service.sync();

    const db = openSqlite(dbPath);
    db.prepare(
      `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      'new-2',
      'ses-2',
      'assistant',
      99,
      now - 1000,
      now - 1000,
      JSON.stringify({
        model: { id: 'm', providerID: 'p' },
        cost: 0,
        tokens: tokens(50),
        time: { created: now - 1000 },
      }),
    );
    db.close();

    await service.sync();
    const { overall } = service.summary({ clients: ['opencode'] });
    expect(overall.records).toBe(3);
    expect(overall.inputTokens).toBe(350);
  });

  it('reconciles against an independent read of both tables with a zero delta', async () => {
    await service.sync();
    const report = await service.verify({ cutoff: new Date(now + 60_000) });
    const opencode = report.clients.find((c) => c.client === 'opencode')!;
    expect(opencode.available).toBe(true);
    for (const grain of opencode.grains.filter((g) => g.gating !== false)) {
      expect(grain.matches, grain.label).toBe(true);
    }
    expect(opencode.ours.records).toBe(2);
    expect(report.allMatch).toBe(true);
  });

  it('fails verify if session_message turns were never collected', async () => {
    // Guard against the check going vacuous: with the newer turn missing from our
    // database, the independent read must disagree.
    await service.sync();
    const ours = openSqlite(join(dir, 'usage.db'));
    ours.prepare("DELETE FROM usage_records WHERE id = 'opencode:msg:new-1'").run();
    ours.close();

    const report = await service.verify({ cutoff: new Date(now + 60_000) });
    expect(report.allMatch).toBe(false);
  });
});
