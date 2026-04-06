import type { HairyClawMessage, RunResult } from "@hairyclaw/core";

// ── Typed Memory Taxonomy ──────────────────────────────────────────────
// Mirrors hari-hive backend MemoryType enum (M3 commit 887a1e3).
// All usage is opt-in — omitting memory_type preserves existing behavior.

export const MEMORY_TYPES = [
  "fact",
  "decision",
  "preference",
  "skill",
  "reference",
  "correction",
  "session_summary",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

// ── Verification metadata ──────────────────────────────────────────────
// Returned by backends that support typed memory (e.g. Hive with TYPED_MEMORY_ENABLED).

export interface VerificationMeta {
  /** When the item was last confirmed accurate */
  lastVerifiedAt?: string;
  /** Computed staleness from age, recall frequency, feedback signals */
  stalenessScore?: number;
  /** Origin of the extraction (e.g. "session-extract", "operator-taught") */
  extractionSource?: string;
}

// ── Core Records ───────────────────────────────────────────────────────

export interface SemanticRecord {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  /** Typed memory classification (optional, backends that don't support it omit this) */
  memoryType?: MemoryType;
  /** Verification metadata (optional, only populated by backends that track it) */
  verification?: VerificationMeta;
}

export interface SearchResult extends SemanticRecord {
  score: number;
}

// ── Store / Search Options ─────────────────────────────────────────────

export interface StoreOptions {
  /** Classify the knowledge item by type */
  memoryType?: MemoryType;
  /** Provenance: where this knowledge was extracted from */
  extractionSource?: string;
}

export interface SearchOptions {
  /** Filter results to a specific memory type */
  memoryType?: MemoryType;
  /** Exclude items with staleness_score above this threshold */
  maxStaleness?: number;
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
  store(content: string, tags?: string[], options?: StoreOptions): Promise<string>;

  /** Semantic search. Returns up to `topK` results ranked by relevance. */
  search(query: string, topK?: number, options?: SearchOptions): Promise<SearchResult[]>;

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
  | HairyClawMessage
  | { role: "assistant"; text: string; timestamp: string };

export interface ReflectionInput {
  runResult: RunResult;
  userMessage?: HairyClawMessage;
}
