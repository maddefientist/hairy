import type { HairyMessage, RunResult } from "@hairy/core";

export interface SemanticRecord {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface SearchResult extends SemanticRecord {
  score: number;
}

/**
 * Pluggable memory backend.
 *
 * Implementations:
 *  - `LocalMemoryBackend`  — JSON file + keyword scoring (zero deps, default)
 *  - `HiveMemoryBackend`   — Hari-Hive semantic memory service (optional)
 *  - bring your own: ChromaDB, Qdrant, Pinecone, etc.
 */
export interface MemoryBackend {
  readonly name: string;

  /** Store content with optional tags. Returns a record ID. */
  store(content: string, tags?: string[]): Promise<string>;

  /** Semantic search. Returns up to `topK` results ranked by relevance. */
  search(query: string, topK?: number): Promise<SearchResult[]>;

  /** Optional: signal relevance feedback on a previous result. */
  feedback?(id: string, signal: "useful" | "noted" | "wrong"): Promise<void>;
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
