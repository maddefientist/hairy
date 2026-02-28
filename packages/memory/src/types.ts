import type { HairyMessage, RunResult } from "@hairy/core";

export interface SemanticRecord {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface Reflection {
  id: string;
  runTraceId: string;
  summary: string;
  learnedPatterns: string[];
  createdAt: string;
}

export interface MemoryEvent {
  type: "run" | "tool" | "message" | "reflection";
  timestamp: string;
  payload: Record<string, unknown>;
}

export type ConversationEntry =
  | HairyMessage
  | { role: "assistant"; text: string; timestamp: string };

export interface ReflectionInput {
  runResult: RunResult;
  userMessage?: HairyMessage;
}
