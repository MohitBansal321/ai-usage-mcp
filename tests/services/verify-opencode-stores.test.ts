import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { UsageService } from '../../src/services/usage-service.js';
import { buildOpenCodeDb, tempDir } from '../fixtures/build-fixtures.js';

function turn(id: string, sessionId: string, input: number, created: number) {
  const tokens = { input, output: 10, reasoning: 2, cache: { read: input * 10, write: 0 } };
  return {
    message: {
      id,
      sessionId,
      timeCreated: created,
      data: { role: 'assistant', cost: 0, tokens, time: { created }, path: { root: '/work' } },
    },
    part: { id: `part-${id}`, messageId: id, sessionId, data: { type: 'step-finish', tokens } },
  };
}

/**
 * On the development machine `~/snap/code/268` and `~/snap/code/271` held
 * identical copies of one sandbox's `opencode.db`. The collector keys records by
 * message id, so `--all-stores` stored that history once, while verify summed
 * every store and reported the database short by exactly one copy.
 */
describe('verify --all-stores: OpenCode history held in more than one store', () => {
  let dir: string;
  let service: UsageService;
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG: process.env.XDG_DATA_HOME,
  };
  const now = Date.now();

  beforeEach(() => {
    dir = tempDir('verify-oc-stores-');
    const home = join(dir, 'home');
    const store = (path: string, turns: ReturnType<typeof turn>[], sessions: string[]) => {
      const built = buildOpenCodeDb(join(dir, `build-${sessions.join('-')}`), {
        sessions: sessions.map((id) => ({ id, tokensInput: 1 })),
        messages: turns.map((t) => t.message),
        parts: turns.map((t) => t.part),
      });
      mkdirSync(join(path, '..'), { recursive: true });
      copyFileSync(built, path);
    };
    mkdirSync(join(dir, 'build-p'), { recursive: true });
    mkdirSync(join(dir, 'build-s'), { recursive: true });
    store(
      join(home, '.local/share/opencode/opencode.db'),
      [turn('p1', 'p', 100, now - 5000)],
      ['p'],
    );
    const snapTurns = [turn('s1', 's', 200, now - 4000), turn('s2', 's', 300, now - 3000)];
    store(join(home, 'snap/code/268/.local/share/opencode/opencode.db'), snapTurns, ['s']);
    // A second snap revision: the same database, byte for byte.
    mkdirSync(join(home, 'snap/code/271/.local/share/opencode'), { recursive: true });
    copyFileSync(
      join(home, 'snap/code/268/.local/share/opencode/opencode.db'),
      join(home, 'snap/code/271/.local/share/opencode/opencode.db'),
    );

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_DATA_HOME;
    delete process.env.AI_USAGE_OPENCODE_DB;
    process.env.AI_USAGE_CLAUDE_PROJECTS = join(dir, 'absent-projects');
    service = UsageService.open({ dbPath: join(dir, 'usage.db') });
  });

  afterEach(() => {
    service.close();
    for (const [key, value] of [
      ['HOME', saved.HOME],
      ['USERPROFILE', saved.USERPROFILE],
      ['XDG_DATA_HOME', saved.XDG],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.AI_USAGE_CLAUDE_PROJECTS;
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts a message held by two stores once, as the collector does', async () => {
    await service.sync({ allStores: true });
    const report = await service.verify({ allStores: true, cutoff: new Date(now + 60_000) });
    const opencode = report.clients.find((c) => c.client === 'opencode')!;
    expect(opencode.ours.records).toBe(3);
    expect(opencode.ours.inputTokens).toBe(600);
    const [message, part, rollup] = opencode.grains;
    expect(message!.matches, message!.label).toBe(true);
    expect(part!.matches, part!.label).toBe(true);
    expect(message!.snapshot.inputTokens).toBe(600);
    // The rollup counts each session once too: one row for `p`, one for `s`.
    expect(rollup!.snapshot.records).toBe(2);
  });
});
