import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import type { Tool } from "../types.js";

const readInputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(2000).optional(),
});

const imageExt = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

const clampLines = (text: string, offset = 1, limit = 2000): string => {
  const lines = text.split("\n");
  const start = Math.max(offset - 1, 0);
  const end = Math.min(start + limit, lines.length);
  return lines.slice(start, end).join("\n");
};

export const createReadTool = (): Tool => ({
  name: "read",
  description: "Read text or image files with optional line offsets.",
  parameters: readInputSchema,
  async execute(args) {
    const input = readInputSchema.parse(args);
    const extension = extname(input.path).toLowerCase();

    try {
      if (imageExt.has(extension)) {
        const buf = await readFile(input.path);
        return {
          content: `image:${extension};base64,${buf.toString("base64")}`,
        };
      }

      const raw = await readFile(input.path, "utf8");
      return {
        content: clampLines(raw, input.offset, input.limit),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "read failed";
      return {
        content: message,
        isError: true,
      };
    }
  },
});
