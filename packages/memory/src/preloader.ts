import type { HairyClawPlugin } from "@hairyclaw/core";
import type { HairyClawLogger } from "@hairyclaw/observability";
import type { MemoryBackend, SearchResult } from "./types.js";

export interface MemoryPreloaderOptions {
  backend: MemoryBackend;
  topK?: number;
  minScore?: number;
  maxChars?: number;
  cacheTtlMs?: number;
  logger?: HairyClawLogger;
}

interface CacheEntry {
  at: number;
  results: SearchResult[];
}

const DEFAULT_TOP_K = 3;
const DEFAULT_MIN_SCORE = 0.3;
const DEFAULT_MAX_CHARS = 2_000;
const DEFAULT_CACHE_TTL_MS = 5_000;

const noopLogger: HairyClawLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const latestUserText = (
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: Array<{ type: string; text?: string }>;
  }>,
): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") {
      continue;
    }

    const text = message.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  return null;
};

const renderMemories = (results: SearchResult[], maxChars: number): string => {
  const lines: string[] = [];
  let used = 0;

  for (const result of results) {
    const score = Number.isFinite(result.score) ? result.score.toFixed(3) : "0.000";
    const content = result.content.trim();
    if (content.length === 0) {
      continue;
    }

    const line = `- [${score}] ${content}`;
    const nextUsed = used + line.length + 1;
    if (nextUsed > maxChars) {
      if (lines.length === 0) {
        const allowed = Math.max(0, maxChars - 12);
        lines.push(`- [${score}] ${content.slice(0, allowed)}`.trimEnd());
      }
      break;
    }

    lines.push(line);
    used = nextUsed;
  }

  return lines.join("\n");
};

export const createMemoryPreloadPlugin = (opts: MemoryPreloaderOptions): HairyClawPlugin => {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const logger = opts.logger ?? noopLogger;
  const cache = new Map<string, CacheEntry>();

  return {
    name: "memory_preload",
    beforeModel: async (messages, streamOpts) => {
      const query = latestUserText(messages);
      if (!query) {
        return { messages, opts: streamOpts };
      }

      const now = Date.now();
      const cached = cache.get(query);
      const fromCache = cached && now - cached.at <= cacheTtlMs;

      let results: SearchResult[];
      if (fromCache && cached) {
        results = cached.results;
      } else {
        try {
          results = await opts.backend.search(query, Math.max(topK * 3, topK));
          cache.set(query, { at: now, results });
        } catch (error: unknown) {
          logger.warn(
            {
              error: error instanceof Error ? error.message : String(error),
              query,
            },
            "memory preload search failed",
          );
          return { messages, opts: streamOpts };
        }
      }

      const selected = results.filter((item) => item.score >= minScore).slice(0, topK);
      if (selected.length === 0) {
        return { messages, opts: streamOpts };
      }

      const rendered = renderMemories(selected, maxChars).trim();
      if (rendered.length === 0) {
        return { messages, opts: streamOpts };
      }

      const memoryBlock = `## Relevant Memories\n${rendered}`;
      const existing = streamOpts.systemPrompt?.trim() ?? "";
      const systemPrompt = existing.length > 0 ? `${memoryBlock}\n\n${existing}` : memoryBlock;

      return {
        messages,
        opts: {
          ...streamOpts,
          systemPrompt,
        },
      };
    },
  };
};
