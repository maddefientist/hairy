import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    channel_id  TEXT NOT NULL UNIQUE,
    channel_type TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    channel_id  TEXT NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content     TEXT NOT NULL,
    timestamp   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel_ts
    ON messages(channel_id, timestamp);

  CREATE TABLE IF NOT EXISTS tool_logs (
    id             TEXT PRIMARY KEY,
    trace_id       TEXT NOT NULL,
    channel_id     TEXT,
    tool_name      TEXT NOT NULL,
    args           TEXT NOT NULL,
    result_snippet TEXT,
    duration_ms    INTEGER,
    is_error       INTEGER NOT NULL DEFAULT 0,
    timestamp      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tool_logs_trace
    ON tool_logs(trace_id);

  CREATE TABLE IF NOT EXISTS initiative_runs (
    id        TEXT PRIMARY KEY,
    rule_id   TEXT NOT NULL,
    outcome   TEXT,
    timestamp INTEGER NOT NULL
  );
`;

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
}

export class AgentDatabase {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "agent.db"));
    this.db.exec(SCHEMA);
  }

  getOrCreateSession(channelId: string, channelType: string): string {
    const now = Date.now();
    const existing = this.db
      .prepare("SELECT id FROM sessions WHERE channel_id = ?")
      .get(channelId) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare("UPDATE sessions SET last_active_at = ? WHERE channel_id = ?")
        .run(now, channelId);
      return existing.id;
    }

    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO sessions (id, channel_id, channel_type, started_at, last_active_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, channelId, channelType, now, now);
    return id;
  }

  saveMessage(sessionId: string, channelId: string, role: "user" | "assistant", content: string): void {
    this.db
      .prepare(
        "INSERT INTO messages (id, session_id, channel_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), sessionId, channelId, role, content, Date.now());
  }

  getRecentMessages(channelId: string, limit = 20): StoredMessage[] {
    const rows = this.db
      .prepare(
        "SELECT role, content FROM messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?",
      )
      .all(channelId, limit) as Array<{ role: string; content: string }>;
    return (rows as StoredMessage[]).reverse();
  }

  logToolExecution(
    traceId: string,
    channelId: string | undefined,
    toolName: string,
    args: unknown,
    resultSnippet: string | undefined,
    durationMs: number,
    isError: boolean,
  ): void {
    this.db
      .prepare(
        "INSERT INTO tool_logs (id, trace_id, channel_id, tool_name, args, result_snippet, duration_ms, is_error, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        traceId,
        channelId ?? null,
        toolName,
        JSON.stringify(args),
        resultSnippet ? resultSnippet.slice(0, 500) : null,
        durationMs,
        isError ? 1 : 0,
        Date.now(),
      );
  }

  logInitiativeRun(ruleId: string, outcome: string | undefined): void {
    this.db
      .prepare("INSERT INTO initiative_runs (id, rule_id, outcome, timestamp) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), ruleId, outcome ?? null, Date.now());
  }

  close(): void {
    this.db.close();
  }
}
