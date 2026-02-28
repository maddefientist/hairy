import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "../types.js";

const writeInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const isWithin = (base: string, target: string): boolean => {
  const normalizedBase = resolve(base);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}/`);
};

export const createWriteTool = (): Tool => ({
  name: "write",
  description: "Write text content to a file (create parent dirs automatically).",
  parameters: writeInputSchema,
  async execute(args, ctx) {
    const input = writeInputSchema.parse(args);
    const resolved = resolve(ctx.cwd, input.path);

    if (!isWithin(ctx.cwd, resolved)) {
      return {
        content: "write path must stay inside project root",
        isError: true,
      };
    }

    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, input.content, "utf8");

    return {
      content: `wrote ${input.content.length} bytes to ${resolved}`,
    };
  },
});
