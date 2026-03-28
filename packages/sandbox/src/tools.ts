import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Sandbox } from "./types.js";

const execAsync = promisify(exec);

/**
 * Minimal tool interface mirroring @hairyclaw/tools Tool shape.
 * Duplicated here to avoid a circular dependency between sandbox and tools packages.
 */
export interface SandboxTool {
  name: string;
  description: string;
  parameters: z.ZodSchema;
  execute(args: unknown, ctx: SandboxToolContext): Promise<SandboxToolResult>;
}

export interface SandboxToolContext {
  traceId: string;
  cwd: string;
  dataDir: string;
}

export interface SandboxToolResult {
  content: string;
  isError?: boolean;
}

// --- Schemas ---

const bashSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().int().positive().max(120_000).optional(),
});

const readSchema = z.object({
  path: z.string().min(1),
});

const writeSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  append: z.boolean().optional(),
});

// --- Factories ---

/**
 * Create a sandbox-aware bash tool.
 * Routes through sandbox when available, falls back to direct execution.
 */
export const createSandboxBashTool = (getSandbox: () => Sandbox | undefined): SandboxTool => ({
  name: "sandbox_bash",
  description: "Execute a command in the sandbox environment (or direct if no sandbox).",
  parameters: bashSchema,
  async execute(args, ctx) {
    const input = bashSchema.parse(args);
    const sandbox = getSandbox();

    if (sandbox) {
      const result = await sandbox.executeCommand(input.command, input.timeout);
      const output = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n");
      const failed = result.exitCode !== 0;
      return {
        content: output.trim() || "(no output)",
        ...(failed ? { isError: true } : {}),
      };
    }

    // Fallback: direct execution
    try {
      const result = await execAsync(input.command, {
        cwd: ctx.cwd,
        timeout: input.timeout ?? 30_000,
        maxBuffer: 1_048_576,
      });
      const output = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n");
      return { content: output.trim() };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "bash execution failed";
      return { content: message, isError: true };
    }
  },
});

/**
 * Create a sandbox-aware read tool.
 * Routes through sandbox when available, falls back to direct file read.
 */
export const createSandboxReadTool = (getSandbox: () => Sandbox | undefined): SandboxTool => ({
  name: "sandbox_read",
  description: "Read a file from the sandbox (or direct if no sandbox).",
  parameters: readSchema,
  async execute(args, ctx) {
    const input = readSchema.parse(args);
    const sandbox = getSandbox();

    if (sandbox) {
      try {
        const content = await sandbox.readFile(input.path);
        return { content };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "read failed";
        return { content: message, isError: true };
      }
    }

    // Fallback: direct read
    try {
      const resolved = resolve(ctx.cwd, input.path);
      const content = await readFile(resolved, "utf8");
      return { content };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "read failed";
      return { content: message, isError: true };
    }
  },
});

/**
 * Create a sandbox-aware write tool.
 * Routes through sandbox when available, falls back to direct file write.
 */
export const createSandboxWriteTool = (getSandbox: () => Sandbox | undefined): SandboxTool => ({
  name: "sandbox_write",
  description: "Write a file in the sandbox (or direct if no sandbox).",
  parameters: writeSchema,
  async execute(args, ctx) {
    const input = writeSchema.parse(args);
    const sandbox = getSandbox();

    if (sandbox) {
      try {
        await sandbox.writeFile(input.path, input.content, input.append);
        return {
          content: `wrote ${input.content.length} bytes to ${input.path}`,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "write failed";
        return { content: message, isError: true };
      }
    }

    // Fallback: direct write
    try {
      const resolved = resolve(ctx.cwd, input.path);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, input.content, "utf8");
      return {
        content: `wrote ${input.content.length} bytes to ${resolved}`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "write failed";
      return { content: message, isError: true };
    }
  },
});
