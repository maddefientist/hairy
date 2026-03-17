import { setTimeout as delay } from "node:timers/promises";
import type { HairyClawLogger as Logger } from "@hairyclaw/observability";
import type { Tool, ToolContext, ToolResult } from "./types.js";

interface RegistryOptions {
  logger: Logger;
  defaultTimeoutMs?: number;
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

    const startedAt = Date.now();

    try {
      const parsedArgs = tool.parameters.parse(args);
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
