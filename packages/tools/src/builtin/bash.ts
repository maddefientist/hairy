import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Tool } from "../types.js";

const execAsync = promisify(exec);

const bashInputSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().int().positive().max(120_000).optional(),
  maxOutputBytes: z.number().int().positive().max(5_000_000).optional(),
});

interface BashToolOptions {
  allowedCommands?: string[];
  blockedCommands?: string[];
}

const getFirstToken = (command: string): string => {
  return command.trim().split(/\s+/)[0] ?? "";
};

export const createBashTool = (opts: BashToolOptions = {}): Tool => ({
  name: "bash",
  description: "Execute a shell command with timeout and output truncation.",
  parameters: bashInputSchema,
  async execute(args) {
    const input = bashInputSchema.parse(args);
    const firstToken = getFirstToken(input.command);

    if (opts.allowedCommands && !opts.allowedCommands.includes(firstToken)) {
      return {
        content: `command '${firstToken}' is not allowed`,
        isError: true,
      };
    }

    if (opts.blockedCommands?.includes(firstToken)) {
      return {
        content: `command '${firstToken}' is blocked`,
        isError: true,
      };
    }

    try {
      const result = await execAsync(input.command, {
        timeout: input.timeout ?? 30_000,
        maxBuffer: input.maxOutputBytes ?? 1_048_576,
      });

      const content = [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n");
      return {
        content: content.trim(),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "bash execution failed";
      return {
        content: message,
        isError: true,
      };
    }
  },
});
