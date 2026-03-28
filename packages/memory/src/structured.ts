/**
 * StructuredMemory — stores discrete facts with categories, confidence scores,
 * and deduplication. Injects relevant facts into the system prompt.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HairyClawPlugin, PluginContext, RunResult } from "@hairyclaw/core";
import { extractFacts } from "./fact-extractor.js";

export type FactCategory = "preference" | "knowledge" | "context" | "behavior" | "goal";

export interface Fact {
  id: string;
  content: string;
  category: FactCategory;
  confidence: number;
  source: string;
  createdAt: string;
  lastReferencedAt?: string;
}

export interface UserContext {
  workContext: string;
  personalContext: string;
  topOfMind: string;
}

export interface StructuredMemoryData {
  userContext: UserContext;
  facts: Fact[];
  lastUpdated: string;
}

export interface StructuredMemoryOptions {
  filePath: string;
  maxFacts?: number;
  confidenceThreshold?: number;
  maxInjectionChars?: number;
}

const DEFAULT_MAX_FACTS = 100;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_MAX_INJECTION_CHARS = 2_000;

/**
 * Normalize content for deduplication:
 * trim, collapse whitespace, lowercase.
 */
const normalizeContent = (content: string): string =>
  content.trim().replace(/\s+/g, " ").toLowerCase();

const emptyData = (): StructuredMemoryData => ({
  userContext: {
    workContext: "",
    personalContext: "",
    topOfMind: "",
  },
  facts: [],
  lastUpdated: new Date().toISOString(),
});

export class StructuredMemory {
  private data: StructuredMemoryData;
  private readonly filePath: string;
  private readonly maxFacts: number;
  private readonly confidenceThreshold: number;
  private readonly maxInjectionChars: number;

  constructor(opts: StructuredMemoryOptions) {
    this.filePath = opts.filePath;
    this.maxFacts = opts.maxFacts ?? DEFAULT_MAX_FACTS;
    this.confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.maxInjectionChars = opts.maxInjectionChars ?? DEFAULT_MAX_INJECTION_CHARS;
    this.data = emptyData();
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isStructuredMemoryData(parsed)) {
        this.data = parsed;
      }
    } catch {
      // File doesn't exist or invalid — start fresh
      this.data = emptyData();
    }
  }

  async save(): Promise<void> {
    this.data.lastUpdated = new Date().toISOString();
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }

  /**
   * Add a fact. Deduplicates by normalized content.
   * Returns the created Fact, or null if duplicate or below confidence threshold.
   */
  addFact(fact: Omit<Fact, "id" | "createdAt">): Fact | null {
    if (fact.confidence < this.confidenceThreshold) {
      return null;
    }

    const normalized = normalizeContent(fact.content);
    const isDuplicate = this.data.facts.some(
      (existing) => normalizeContent(existing.content) === normalized,
    );

    if (isDuplicate) {
      return null;
    }

    // If at capacity, evict the lowest-confidence fact to make room
    if (this.data.facts.length >= this.maxFacts) {
      this.evictLowest();
    }

    const newFact: Fact = {
      ...fact,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };

    this.data.facts.push(newFact);
    return newFact;
  }

  /** Get facts, optionally filtered by category. */
  getFacts(category?: FactCategory): Fact[] {
    if (!category) {
      return [...this.data.facts];
    }
    return this.data.facts.filter((f) => f.category === category);
  }

  /** Merge partial updates into user context. */
  updateUserContext(partial: Partial<UserContext>): void {
    if (partial.workContext !== undefined) {
      this.data.userContext.workContext = partial.workContext;
    }
    if (partial.personalContext !== undefined) {
      this.data.userContext.personalContext = partial.personalContext;
    }
    if (partial.topOfMind !== undefined) {
      this.data.userContext.topOfMind = partial.topOfMind;
    }
  }

  /** Format memory data as a markdown block for prompt injection. */
  getPromptInjection(): string {
    const ctx = this.data.userContext;
    const lines: string[] = ["<memory>"];

    // Current context section
    const hasContext = ctx.workContext || ctx.personalContext || ctx.topOfMind;
    if (hasContext) {
      lines.push("## Current Context");
      if (ctx.workContext) {
        lines.push(`- Work: ${ctx.workContext}`);
      }
      if (ctx.personalContext) {
        lines.push(`- Personal: ${ctx.personalContext}`);
      }
      if (ctx.topOfMind) {
        lines.push(`- Focus: ${ctx.topOfMind}`);
      }
      lines.push("");
    }

    // Known facts section
    if (this.data.facts.length > 0) {
      lines.push("## Known Facts");

      // Sort by confidence descending for priority
      const sorted = [...this.data.facts].sort((a, b) => b.confidence - a.confidence);

      for (const fact of sorted) {
        const line = `- [${fact.category}] ${fact.content}`;
        lines.push(line);
      }
    }

    lines.push("</memory>");

    let result = lines.join("\n");

    // Truncate if over limit
    if (result.length > this.maxInjectionChars) {
      result = `${result.slice(0, this.maxInjectionChars - 12)}\n</memory>`;
    }

    return result;
  }

  /** Get raw data (returns a shallow copy). */
  getData(): StructuredMemoryData {
    return {
      ...this.data,
      userContext: { ...this.data.userContext },
      facts: [...this.data.facts],
    };
  }

  /**
   * Prune lowest-confidence facts when over maxFacts.
   * Returns the number of facts removed.
   */
  prune(): number {
    if (this.data.facts.length <= this.maxFacts) {
      return 0;
    }

    const excess = this.data.facts.length - this.maxFacts;
    return this.evictN(excess);
  }

  /**
   * Evict the single lowest-confidence fact.
   * Used internally when at capacity before inserting a new fact.
   */
  private evictLowest(): void {
    if (this.data.facts.length === 0) return;
    this.evictN(1);
  }

  /**
   * Evict the N lowest-confidence facts.
   * Ties broken by oldest first.
   */
  private evictN(count: number): number {
    if (count <= 0 || this.data.facts.length === 0) return 0;

    // Sort ascending by confidence, then by age (oldest first for ties)
    const sorted = [...this.data.facts].sort((a, b) => {
      const confDiff = a.confidence - b.confidence;
      if (confDiff !== 0) return confDiff;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    const toRemove = new Set(sorted.slice(0, count).map((f) => f.id));
    this.data.facts = this.data.facts.filter((f) => !toRemove.has(f.id));
    return toRemove.size;
  }
}

/**
 * Create a plugin that runs fact extraction on conversation end.
 */
export const createMemoryUpdatePlugin = (memory: StructuredMemory): HairyClawPlugin => ({
  name: "memory_update",
  onRunEnd: async (_ctx: PluginContext, result?: RunResult, _error?: Error): Promise<void> => {
    if (!result) {
      return;
    }

    // Extract user text from tool calls that contain conversation data
    // The RunResult has toolCalls with args and results, but we mainly want
    // user messages. We'll extract facts from the response text as well.
    const messages: Array<{ role: string; text: string }> = [];

    if (result.response.text) {
      messages.push({ role: "assistant", text: result.response.text });
    }

    // Extract facts from any message data we have
    if (messages.length > 0) {
      const extracted = extractFacts(messages);
      for (const fact of extracted) {
        memory.addFact({
          content: fact.content,
          category: fact.category,
          confidence: fact.confidence,
          source: "conversation",
        });
      }

      // Fire-and-forget save — don't block the response
      void memory.save();
    }
  },
});

/** Type guard for loaded data */
const isStructuredMemoryData = (value: unknown): value is StructuredMemoryData => {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.lastUpdated === "string" &&
    Array.isArray(obj.facts) &&
    typeof obj.userContext === "object" &&
    obj.userContext !== null
  );
};
