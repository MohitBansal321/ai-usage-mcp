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
      'title',
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
