/**
 * memory_recall — semantic recall tool.
 * Delegates to whichever MemoryBackend is configured (local, hive, etc.)
 * No vendor lock-in — works out of the box with local JSON backend.
 *
 * Supports optional memory_type filter for typed memory recall
 * (requires hari-hive backend with TYPED_MEMORY_ENABLED).
 */
import { MEMORY_TYPES, type MemoryBackend, type SearchResult } from "@hairyclaw/memory";
import { z } from "zod";
import type { Tool } from "../types.js";

const memoryRecallSchema = z.object({
  query: z.string().min(1).max(2000),
  top_k: z.number().int().positive().max(20).optional(),
  memory_type: z.enum(MEMORY_TYPES).optional(),
  max_staleness: z.number().min(0).max(1).optional(),
});

const formatResults = (items: SearchResult[]): string => {
  if (items.length === 0) return "No recall results.";

  const lines: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const scorePart = typeof item.score === "number" ? ` score=${item.score.toFixed(3)}` : "";
    const tagsPart = item.tags.length > 0 ? ` tags=[${item.tags.join(",")}]` : "";
    const typePart = item.memoryType ? ` type=${item.memoryType}` : "";
    const stalePart =
      item.verification?.stalenessScore !== undefined
        ? ` staleness=${item.verification.stalenessScore.toFixed(2)}`
        : "";
    lines.push(`${i + 1}.${scorePart}${tagsPart}${typePart}${stalePart}`);
    lines.push(item.content);
  }
  return lines.join("\n");
};

export const createMemoryRecallTool = (backend: MemoryBackend): Tool => ({
  name: "memory_recall",
  description: `Semantic recall from long-term memory (backend: ${backend.name}). Optionally filter by memory_type: ${MEMORY_TYPES.join(", ")}.`,
  parameters: memoryRecallSchema,
  async execute(args) {
    try {
      const input = memoryRecallSchema.parse(args);
      const searchOptions =
        input.memory_type || input.max_staleness !== undefined
          ? { memoryType: input.memory_type, maxStaleness: input.max_staleness }
          : undefined;
      const results = await backend.search(input.query, input.top_k ?? 5, searchOptions);
      return { content: formatResults(results) };
    } catch (err: unknown) {
      return {
        content: err instanceof Error ? err.message : "memory recall failed",
        isError: true,
      };
    }
  },
});
