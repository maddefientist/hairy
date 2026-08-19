import { setTimeout as delay } from "node:timers/promises";
import type { HairyClawLogger as Logger } from "@hairyclaw/observability";
import { ZodError } from "zod";
import type { ApprovalGate } from "./approval.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

interface RegistryOptions {
  logger: Logger;
  defaultTimeoutMs?: number;
  approvalGate?: ApprovalGate;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly defaultTimeoutMs: number;

  constructor(private readonly opts: RegistryOptions) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: `tool not found: ${name}`,
        isError: true,
      };
    }

    // Enforce the caller's tool profile here, at the point of execution, so a
    // child/sub-agent can never invoke a hidden tool by name even if it is
    // handed a broader tool list or definitions elsewhere.
    if (ctx.allowedTools && !ctx.allowedTools.includes(name)) {
      this.opts.logger.warn(
        { traceId: ctx.traceId, toolName: name },
        "tool call denied: not permitted for this execution profile",
      );
      return {
        content: `tool "${name}" is not permitted for this execution profile`,
        isError: true,
      };
    }

    const startedAt = Date.now();

    // Check approval gate before execution
    if (this.opts.approvalGate) {
      const decision = await this.opts.approvalGate.check(name, args);
      if (decision === "deny") {
        this.opts.logger.info(
          { traceId: ctx.traceId, toolName: name },
          "tool call denied by approval policy",
        );
        return { content: "tool call denied by approval policy", isError: true };
      }
      if (decision === "confirm") {
        this.opts.logger.info(
          { traceId: ctx.traceId, toolName: name },
          "tool call approved after confirmation",
        );
      }
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = tool.parameters.parse(args);
    } catch (error: unknown) {
      const isZod = error instanceof ZodError;
      const message = error instanceof Error ? error.message : "unknown validation error";
      this.opts.logger.warn(
        {
          err: error,
          traceId: ctx.traceId,
          toolName: name,
          durationMs: Date.now() - startedAt,
          isValidationError: isZod,
        },
        "tool argument validation failed",
      );
      return {
        content: isZod
          ? `Invalid arguments for tool ${name}: ${message}. Re-emit the call with arguments matching the declared parameter schema (numbers as JSON numbers, not strings, etc.).`
          : message,
        isError: true,
        isValidationError: isZod,
      };
    }

    try {
      const timeoutMs = tool.timeout_ms ?? this.defaultTimeoutMs;
      const result = await this.withTimeout(tool.execute(parsedArgs, ctx), timeoutMs);

      this.opts.logger.info(
        {
          traceId: ctx.traceId,
          toolName: name,
          durationMs: Date.now() - startedAt,
          isError: result.isError ?? false,
        },
        "tool executed",
      );

      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown tool error";
      this.opts.logger.error(
        {
          err: error,
          traceId: ctx.traceId,
          toolName: name,
          durationMs: Date.now() - startedAt,
        },
        "tool execution failed",
      );
      return {
        content: message,
        isError: true,
      };
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    const abort = delay(timeoutMs).then(() => {
      throw new Error(`tool timeout after ${timeoutMs}ms`);
    });

    return Promise.race([promise, abort]);
  }
}
