import { openSqlite } from '../../src/db/driver.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempDir(prefix = 'ai-usage-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Minimal stand-in for OpenCode's schema -- only the columns the collector reads. */
export function buildOpenCodeDb(
  dir: string,
  options: {
    sessions: {
      id: string;
      parentId?: string | null;
      title?: string;
      directory?: string;
      version?: string;
      projectId?: string;
      tokensInput?: number;
      tokensOutput?: number;
      tokensReasoning?: number;
      tokensCacheRead?: number;
      tokensCacheWrite?: number;
      cost?: number;
    }[];
    messages: {
      id: string;
      sessionId: string;
      timeCreated: number;
      timeUpdated?: number;
      data: Record<string, unknown>;
    }[];
    parts?: { id: string; messageId: string; sessionId: string; data: Record<string, unknown> }[];
    projects?: { id: string; worktree: string }[];
    /**
     * OpenCode 2.x: turns live in `session_message` (the role is its `type`, the
     * payload nests the model) and sessions in `session_v2`. Both tables are only
     * created when given, so a legacy fixture stays exactly what it was.
     */
    sessionsV2?: {
      id: string;
      parentId?: string | null;
      title?: string;
      directory?: string;
      version?: string;
      projectId?: string;
      tokensInput?: number;
      cost?: number;
    }[];
    sessionMessages?: {
      id: string;
      sessionId: string;
      type?: string;
      timeCreated: number;
      timeUpdated?: number;
      data: Record<string, unknown>;
    }[];
    /** Drop the frozen legacy tables, as a database that has fully moved on would. */
    withoutLegacyMessages?: boolean;
  },
): string {
  const path = join(dir, 'opencode.db');
  const db = openSqlite(path);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT, directory TEXT,
      title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER,
      model TEXT, cost REAL DEFAULT 0, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
      tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL
    );
  `);

  const projects = options.projects ?? [{ id: 'proj-1', worktree: '/work/project-one' }];
  const insertProject = db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)');
  for (const p of projects) insertProject.run(p.id, p.worktree);

  const insertSession = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
                          time_created, time_updated, model, cost, tokens_input, tokens_output,
                          tokens_reasoning, tokens_cache_read, tokens_cache_write)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const s of options.sessions) {
    insertSession.run(
      s.id,
      s.projectId ?? projects[0]!.id,
      s.parentId ?? null,
      'slug',
      s.directory ?? '/work/project-one',
      s.title ?? 'title',
      s.version ?? '1.18.25',
      1_700_000_000_000,
      1_700_000_000_000,
      JSON.stringify({ id: 'model-x', providerID: 'prov' }),
      s.cost ?? 0,
      s.tokensInput ?? 0,
      s.tokensOutput ?? 0,
      s.tokensReasoning ?? 0,
      s.tokensCacheRead ?? 0,
      s.tokensCacheWrite ?? 0,
    );
  }

  const insertMessage = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)',
  );
  for (const m of options.messages) {
    insertMessage.run(
      m.id,
      m.sessionId,
      m.timeCreated,
      m.timeUpdated ?? m.timeCreated,
      JSON.stringify(m.data),
    );
  }

  const insertPart = db.prepare(
    'INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)',
  );
  for (const p of options.parts ?? []) {
    insertPart.run(p.id, p.messageId, p.sessionId, JSON.stringify(p.data));
  }

  if (options.sessionsV2 || options.sessionMessages) {
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT,
        title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER,
        model TEXT, cost REAL DEFAULT 0, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
        tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
    `);
    const insertV2 = db.prepare(
      `INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version,
                               time_created, time_updated, cost, tokens_input)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const s of options.sessionsV2 ?? []) {
      insertV2.run(
        s.id,
        s.projectId ?? projects[0]!.id,
        s.parentId ?? null,
        'slug',
        s.directory ?? '/work/project-one',
        s.title ?? 'title',
        s.version ?? '2.0.30',
        1_700_000_000_000,
        1_700_000_000_000,
        s.cost ?? 0,
        s.tokensInput ?? 0,
      );
    }
    const insertSessionMessage = db.prepare(
      `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
       VALUES (?,?,?,?,?,?,?)`,
    );
    let seq = 0;
    for (const m of options.sessionMessages ?? []) {
      insertSessionMessage.run(
        m.id,
        m.sessionId,
        m.type ?? 'assistant',
        ++seq,
        m.timeCreated,
        m.timeUpdated ?? m.timeCreated,
        JSON.stringify(m.data),
      );
    }
  }
  if (options.withoutLegacyMessages) db.exec('DROP TABLE message; DROP TABLE part;');

  db.close();
  return path;
}

export interface ClaudeLine {
  type?: string;
  uuid?: string;
  requestId?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  aiTitle?: string;
  message?: Record<string, unknown>;
}

/** Writes a Claude Code projects/ tree with main and subagent transcripts. */
export function buildClaudeProjects(
  dir: string,
  projects: {
    slug: string;
    sessions: {
      sessionId: string;
      lines: ClaudeLine[];
      subagents?: { name: string; lines: ClaudeLine[] }[];
      workflowAgents?: { workflow: string; name: string; lines: ClaudeLine[] }[];
      journalLines?: ClaudeLine[];
    }[];
  }[],
): string {
  const root = join(dir, 'projects');
  mkdirSync(root, { recursive: true });

  for (const project of projects) {
    const projectDir = join(root, project.slug);
    mkdirSync(projectDir, { recursive: true });
    for (const session of project.sessions) {
      writeFileSync(
        join(projectDir, `${session.sessionId}.jsonl`),
        session.lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
        'utf8',
      );

      if (session.subagents?.length || session.workflowAgents?.length || session.journalLines) {
        const subagentDir = join(projectDir, session.sessionId, 'subagents');
        mkdirSync(subagentDir, { recursive: true });
        for (const agent of session.subagents ?? []) {
          writeFileSync(
            join(subagentDir, `${agent.name}.jsonl`),
            agent.lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
            'utf8',
          );
        }
        for (const agent of session.workflowAgents ?? []) {
          const wfDir = join(subagentDir, 'workflows', agent.workflow);
          mkdirSync(wfDir, { recursive: true });
          writeFileSync(
            join(wfDir, `${agent.name}.jsonl`),
            agent.lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
            'utf8',
          );
        }
        if (session.journalLines) {
          const wfDir = join(subagentDir, 'workflows', 'wf_journal');
          mkdirSync(wfDir, { recursive: true });
          writeFileSync(
            join(wfDir, 'journal.jsonl'),
            session.journalLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
            'utf8',
          );
        }
      }
    }
  }
  return root;
}

/** One assistant line as Claude Code actually writes it. */
export function assistantLine(options: {
  requestId?: string;
  messageId?: string;
  sessionId?: string;
  timestamp?: string;
  model?: string;
  cwd?: string;
  version?: string;
  stopReason?: string | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  thinking?: number;
  speed?: string;
  blockType?: string;
  includeIterations?: boolean;
}): ClaudeLine {
  const cw5 = options.cacheWrite5m ?? 0;
  const cw1 = options.cacheWrite1h ?? 0;
  const usage: Record<string, unknown> = {
    input_tokens: options.input ?? 0,
    output_tokens: options.output ?? 0,
    cache_read_input_tokens: options.cacheRead ?? 0,
    cache_creation_input_tokens: cw5 + cw1,
    cache_creation: {
      ephemeral_5m_input_tokens: cw5,
      ephemeral_1h_input_tokens: cw1,
    },
    output_tokens_details: { thinking_tokens: options.thinking ?? 0 },
    service_tier: 'standard',
    speed: options.speed ?? 'standard',
  };
  if (options.includeIterations !== false) {
    // Mirrors the real shape: iterations repeat what the top level already reports.
    usage.iterations = [
      {
        type: 'message',
        input_tokens: options.input ?? 0,
        output_tokens: options.output ?? 0,
        cache_read_input_tokens: options.cacheRead ?? 0,
        cache_creation_input_tokens: cw5 + cw1,
      },
    ];
  }
  return {
    type: 'assistant',
    uuid: `uuid-${options.requestId ?? 'x'}-${options.output ?? 0}`,
    requestId: options.requestId,
    sessionId: options.sessionId ?? 'sess-1',
    timestamp: options.timestamp ?? '2026-08-30T10:00:00.000Z',
    cwd: options.cwd ?? '/work/project-one',
    version: options.version ?? '2.1.247',
    message: {
      id: options.messageId ?? 'msg-1',
      role: 'assistant',
      model: options.model ?? 'claude-opus-5',
      stop_reason: options.stopReason ?? null,
      content: [{ type: options.blockType ?? 'text' }],
      usage,
    },
  };
}

/** One Codex rollout line: `{ timestamp, type, payload }`. */
export interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

/**
 * Writes a Codex home: `<home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, or
 * under `archived_sessions/` for an archived one. A raw string in `lines` is
 * written verbatim, which is how a malformed line gets in.
 */
export function buildCodexHome(
  dir: string,
  sessions: {
    sessionId: string;
    lines: (CodexLine | string)[];
    archived?: boolean;
    day?: string;
  }[],
): string {
  const home = join(dir, 'codex-home');
  mkdirSync(home, { recursive: true });
  for (const session of sessions) {
    const day = session.day ?? '2026/10/22';
    const folder = session.archived
      ? join(home, 'archived_sessions')
      : join(home, 'sessions', ...day.split('/'));
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, codexRolloutName(session.sessionId, day)),
      session.lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
      'utf8',
    );
  }
  return home;
}

export function codexRolloutName(sessionId: string, day = '2026/10/22'): string {
  return `rollout-${day.replace(/\//g, '-')}T23-59-10-${sessionId}.jsonl`;
}

/** The first line of every rollout, as Codex 0.162 writes it (identity fields included). */
export function codexSessionMeta(
  options: {
    sessionId?: string;
    cwd?: string;
    cliVersion?: string;
    provider?: string;
    branch?: string;
  } = {},
): CodexLine {
  const id = options.sessionId ?? CODEX_SESSION;
  return {
    timestamp: '2026-10-22T18:29:11.992Z',
    type: 'session_meta',
    payload: {
      creator_user_id: 'user-must-never-be-stored',
      creator_account_id: 'account-must-never-be-stored',
      session_id: id,
      id,
      timestamp: '2026-10-22T18:29:10.533Z',
      cwd: options.cwd ?? '/work/codex-project',
      originator: 'codex_vscode',
      cli_version: options.cliVersion ?? '0.162.0-alpha.17.2',
      source: 'vscode',
      thread_source: 'user',
      model_provider: options.provider ?? 'openai',
      base_instructions: { text: 'instructions that must never be stored' },
      git: {
        commit_hash: 'b94b5b389270d73de44bc8096469f61ac90e2d9d',
        branch: options.branch ?? 'main',
        repository_url: 'https://example.invalid/repo.git',
      },
    },
  };
}

export const CODEX_SESSION = '01a164df-caf6-71a1-9848-a881fc6c5127';

export function codexTurnContext(options: {
  model?: string;
  cwd?: string;
  turnId?: string;
  timestamp?: string;
}): CodexLine {
  const payload: Record<string, unknown> = {
    turn_id: options.turnId ?? 'turn-1',
    cwd: options.cwd ?? '/work/codex-project',
    approval_policy: 'on-request',
  };
  if (options.model) payload.model = options.model;
  return {
    timestamp: options.timestamp ?? '2026-10-22T18:29:12.481Z',
    type: 'turn_context',
    payload,
  };
}

/** OpenAI-style usage: `total_tokens` is input + output; cached and reasoning are inside them. */
export function codexUsage(u: {
  input: number;
  cached?: number;
  cacheWrite?: number;
  output: number;
  reasoning?: number;
  total?: number;
}): Record<string, number> {
  return {
    input_tokens: u.input,
    cached_input_tokens: u.cached ?? 0,
    cache_write_input_tokens: u.cacheWrite ?? 0,
    output_tokens: u.output,
    reasoning_output_tokens: u.reasoning ?? 0,
    total_tokens: u.total ?? u.input + u.output,
  };
}

export function codexTokenCount(options: {
  timestamp: string;
  total?: Record<string, number>;
  last?: Record<string, number>;
  /** `info: null` -- a rate-limit-only event. */
  noInfo?: boolean;
}): CodexLine {
  return {
    timestamp: options.timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: options.noInfo
        ? null
        : {
            total_token_usage: options.total,
            last_token_usage: options.last,
            model_context_window: 258400,
          },
      rate_limits: { limit_id: 'codex', primary: { used_percent: 0, window_minutes: 43200 } },
    },
  };
}

export function codexTokenUsageRecord(options: {
  timestamp: string;
  sessionId?: string;
  responseId: string;
  usage: Record<string, number>;
  thread: Record<string, number>;
}): CodexLine {
  const id = options.sessionId ?? CODEX_SESSION;
  return {
    timestamp: options.timestamp,
    type: 'token_usage_record',
    payload: {
      thread_id: id,
      turn_id: 'turn-1',
      session_id: id,
      response_id: options.responseId,
      usage: options.usage,
      turn_token_usage: options.thread,
      thread_token_usage: options.thread,
    },
  };
}

/**
 * The real 0.162.0-alpha.17.2 session's four requests, numbers exactly as
 * written: each one is a `token_usage_record` followed by a `token_count`
 * carrying the same usage.
 */
export function codexRealSessionLines(sessionId = CODEX_SESSION): CodexLine[] {
  const requests = [
    { at: '2026-10-22T18:29:15.282Z', input: 14986, cached: 11264, output: 131 },
    { at: '2026-10-22T18:29:17.240Z', input: 15157, cached: 14848, output: 62 },
    { at: '2026-10-22T18:29:18.828Z', input: 15816, cached: 11264, output: 78 },
    { at: '2026-10-22T18:29:21.592Z', input: 19800, cached: 15616, output: 182 },
  ];
  const lines: CodexLine[] = [
    codexSessionMeta({ sessionId }),
    codexTurnContext({ model: 'gpt-6-luna' }),
  ];
  const running = { input: 0, cached: 0, output: 0 };
  requests.forEach((r, i) => {
    running.input += r.input;
    running.cached += r.cached;
    running.output += r.output;
    const last = codexUsage(r);
    const total = codexUsage(running);
    lines.push(
      codexTokenUsageRecord({
        timestamp: r.at,
        sessionId,
        responseId: `resp_${i + 1}`,
        usage: last,
        thread: total,
      }),
      codexTokenCount({ timestamp: r.at, total, last }),
    );
  });
  return lines;
}
