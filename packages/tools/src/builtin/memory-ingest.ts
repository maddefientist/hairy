/**
 * memory_ingest — store knowledge in long-term memory.
 * Delegates to whichever MemoryBackend is configured (local, hive, etc.)
 *
 * Supports optional memory_type classification for typed memory
 * (requires hari-hive backend with TYPED_MEMORY_ENABLED).
 */
import { MEMORY_TYPES, type MemoryBackend } from "@hairyclaw/memory";
import { z } from "zod";
import type { Tool } from "../types.js";

const memoryIngestSchema = z.object({
  content: z.string().min(1).max(20000),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  memory_type: z.enum(MEMORY_TYPES).optional(),
  extraction_source: z.string().max(256).optional(),
});

export const createMemoryIngestTool = (backend: MemoryBackend): Tool => ({
  name: "memory_ingest",
  description: `Store a knowledge item in long-term memory (backend: ${backend.name}). Optionally classify with memory_type: ${MEMORY_TYPES.join(", ")}.`,
  parameters: memoryIngestSchema,
  async execute(args) {
    try {
      const input = memoryIngestSchema.parse(args);
      const storeOptions =
        input.memory_type || input.extraction_source
          ? { memoryType: input.memory_type, extractionSource: input.extraction_source }
          : undefined;
      const id = await backend.store(input.content, input.tags ?? [], storeOptions);
      return { content: `ingested knowledge item (id=${id})` };
    } catch (err: unknown) {
      return {
        content: err instanceof Error ? err.message : "memory ingest failed",
        isError: true,
      };
    }
  },
});
