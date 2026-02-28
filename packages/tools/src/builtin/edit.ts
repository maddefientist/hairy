import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "../types.js";

const editInputSchema = z.object({
  path: z.string().min(1),
  oldText: z.string(),
  newText: z.string(),
});

const isWithin = (base: string, target: string): boolean => {
  const normalizedBase = resolve(base);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}/`);
};

export const createEditTool = (): Tool => ({
  name: "edit",
  description: "Replace exact text in a file.",
  parameters: editInputSchema,
  async execute(args, ctx) {
    const input = editInputSchema.parse(args);
    const resolved = resolve(ctx.cwd, input.path);

    if (!isWithin(ctx.cwd, resolved)) {
      return {
        content: "edit path must stay inside project root",
        isError: true,
      };
    }

    const current = await readFile(resolved, "utf8");
    if (!current.includes(input.oldText)) {
      return {
        content: "oldText not found",
        isError: true,
      };
    }

    const next = current.replace(input.oldText, input.newText);
    await writeFile(resolved, next, "utf8");

    return {
      content: `updated ${resolved}`,
    };
  },
});
