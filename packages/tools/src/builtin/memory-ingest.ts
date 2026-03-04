/**
 * memory_ingest — store knowledge in long-term memory.
 * Delegates to whichever MemoryBackend is configured (local, hive, etc.)
 */
import type { MemoryBackend } from "@hairy/memory";
import { z } from "zod";
import type { Tool } from "../types.js";

const memoryIngestSchema = z.object({
  content: z.string().min(1).max(20000),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
});

export const createMemoryIngestTool = (backend: MemoryBackend): Tool => ({
  name: "memory_ingest",
  description: `Store a knowledge item in long-term memory (backend: ${backend.name}).`,
  parameters: memoryIngestSchema,
  async execute(args) {
    const input = memoryIngestSchema.parse(args);
    try {
      const id = await backend.store(input.content, input.tags ?? []);
      return { content: `ingested knowledge item (id=${id})` };
    } catch (err: unknown) {
      return {
        content: err instanceof Error ? err.message : "memory ingest failed",
        isError: true,
      };
    }
  },
});
