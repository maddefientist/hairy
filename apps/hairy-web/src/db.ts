import { DatabaseSync } from "node:sqlite";

export interface DbSession {
  id: string;
  channel_id: string;
  channel_type: string;
  started_at: number;
  last_active_at: number;
}

export interface DbMessage {
  id: string;
  session_id: string;
  channel_id: string;
  role: string;
  content: string;
  timestamp: number;
}

export interface DbToolLog {
  id: string;
  trace_id: string;
  channel_id: string | null;
  tool_name: string;
  args: string;
  result_snippet: string | null;
  duration_ms: number | null;
  is_error: number;
  timestamp: number;
}

export interface DbInitiativeRun {
  id: string;
  rule_id: string;
  outcome: string | null;
  timestamp: number;
}

export class WebDatabase {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, { open: true });
  }

  getSessionCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number };
    return row.c;
  }

  getMessageCountToday(): number {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM messages WHERE timestamp >= ?")
      .get(dayStart.getTime()) as { c: number };
    return row.c;
  }

  getToolCallCountToday(): number {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM tool_logs WHERE timestamp >= ?")
      .get(dayStart.getTime()) as { c: number };
    return row.c;
  }

  getErrorCountToday(): number {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM tool_logs WHERE timestamp >= ? AND is_error = 1")
      .get(dayStart.getTime()) as { c: number };
    return row.c;
  }

  getRecentMessages(limit = 10): DbMessage[] {
    return this.db
      .prepare("SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as unknown as DbMessage[];
  }

  getSessions(limit = 20): DbSession[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY last_active_at DESC LIMIT ?")
      .all(limit) as unknown as DbSession[];
  }

  getMessagesByChannel(channelId: string, limit = 50): DbMessage[] {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE channel_id = ? ORDER BY timestamp ASC LIMIT ?",
      )
      .all(channelId, limit) as unknown as DbMessage[];
  }

  getToolLogs(opts: { toolName?: string; errorsOnly?: boolean; limit?: number } = {}): DbToolLog[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.toolName) {
      conditions.push("tool_name = ?");
      params.push(opts.toolName);
    }
    if (opts.errorsOnly) {
      conditions.push("is_error = 1");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;
    params.push(limit);

    return this.db
      .prepare(`SELECT * FROM tool_logs ${where} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params) as unknown as DbToolLog[];
  }

  getDistinctToolNames(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT tool_name FROM tool_logs ORDER BY tool_name")
      .all() as unknown as Array<{ tool_name: string }>;
    return rows.map((r) => r.tool_name);
  }

  getInitiativeRuns(limit = 30): DbInitiativeRun[] {
    return this.db
      .prepare("SELECT * FROM initiative_runs ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as unknown as DbInitiativeRun[];
  }

  getAvgToolDuration(): number {
    const row = this.db
      .prepare("SELECT AVG(duration_ms) as avg FROM tool_logs WHERE duration_ms IS NOT NULL")
      .get() as { avg: number | null };
    return Math.round(row.avg ?? 0);
  }
}
