export interface HairyMessage {
  id: string;
  channelId: string;
  channelType: "telegram" | "whatsapp" | "webhook" | "cli";
  senderId: string;
  senderName: string;
  content: MessageContent;
  timestamp: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface MessageContent {
  text?: string;
  images?: MediaAttachment[];
  audio?: MediaAttachment[];
  video?: MediaAttachment[];
  documents?: DocumentAttachment[];
}

export interface MediaAttachment {
  url?: string;
  path?: string;
  buffer?: Buffer;
  mimeType: string;
  caption?: string;
}

export interface DocumentAttachment {
  path: string;
  fileName: string;
  mimeType: string;
}

export interface AgentResponse {
  text: string;
  attachments?: MediaAttachment[];
  silent?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolCallRecord {
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
  durationMs: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { input: number; output: number; total: number };
}

export interface RunResult {
  traceId: string;
  response: AgentResponse;
  stopReason: string;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  durationMs: number;
}

export interface ScheduledTask {
  id: string;
  prompt: string;
  scheduleType: "cron" | "interval" | "once";
  scheduleValue: string;
  status: "active" | "paused" | "completed";
  nextRun: string | null;
  lastRun: string | null;
  silent: boolean;
  createdAt: string;
}

export type TaskPriority = "urgent" | "user" | "task" | "background";

export interface QueueItem {
  id: string;
  kind: "message" | "scheduled-task";
  payload: HairyMessage | ScheduledTask;
  enqueuedAt: string;
}

export interface QueueState {
  urgent: QueueItem[];
  user: QueueItem[];
  task: QueueItem[];
  background: QueueItem[];
}
