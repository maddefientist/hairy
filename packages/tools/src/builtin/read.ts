import { readFile, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "../types.js";

const readInputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(2000).optional(),
});

const imageExt = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/** Paths that should never be readable by the agent, regardless of cwd. */
const BLOCKED_PREFIXES = ["/etc/shadow", "/etc/gshadow", "/proc/", "/sys/"];

const BLOCKED_PATTERNS = ["/.ssh/", "/.aws/", "/.gnupg/", "/.config/gcloud/", "/.kube/config"];

const isBlockedPath = (resolved: string): boolean => {
  for (const prefix of BLOCKED_PREFIXES) {
    if (resolved.startsWith(prefix)) return true;
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (resolved.includes(pattern)) return true;
  }
  return false;
};

const isWithin = (base: string, target: string): boolean => {
  const normalizedBase = resolve(base);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}/`);
};

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
  async execute(args, ctx) {
    const input = readInputSchema.parse(args);
    const resolved = resolve(ctx.cwd, input.path);

    // Block sensitive paths regardless of project root.
    if (isBlockedPath(resolved)) {
      return {
        content: `read blocked: '${resolved}' is a restricted path`,
        isError: true,
      };
    }

    // Resolve symlinks to prevent traversal, then verify still within project.
    let real: string;
    try {
      real = await realpath(resolved);
    } catch {
      // File doesn't exist yet or broken symlink — fall through to readFile which will error.
      real = resolved;
    }

    if (isBlockedPath(real)) {
      return {
        content: "read blocked: path resolves to a restricted location",
        isError: true,
      };
    }

    // Must be within project root OR data dir.
    if (!isWithin(ctx.cwd, real) && !isWithin(ctx.dataDir, real)) {
      return {
        content: "read path must be inside project root or data directory",
        isError: true,
      };
    }

    const extension = extname(input.path).toLowerCase();

    try {
      if (imageExt.has(extension)) {
        const buf = await readFile(resolved);
        return {
          content: `image:${extension};base64,${buf.toString("base64")}`,
        };
      }

      const raw = await readFile(resolved, "utf8");
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
