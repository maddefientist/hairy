import {
  type AgentLoopProvider,
  type AgentLoopResult,
  type SubagentExecutor,
  type ToolExecutor,
  runAgentLoop,
} from "@hairyclaw/core";
import type { HairyClawLogger } from "@hairyclaw/observability";
import { z } from "zod";
import type { Tool, ToolContext } from "../types.js";

const subAgentArgsSchema = z.object({
  task: z.string().min(1).max(20_000),
});

const DEFAULT_TIMEOUT_MS = 120_000;

const noopLogger: HairyClawLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const missingProvider: AgentLoopProvider = {
  async *stream() {
    yield { type: "error", error: "subagent provider is not configured" };
  },
};

type RunAgentLoopFn = typeof runAgentLoop;

export interface SubAgentToolOptions {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  tools?: Tool[];
  maxIterations?: number;
  timeoutMs?: number;
  provider?: AgentLoopProvider;
  executor?: ToolExecutor;
  runLoop?: RunAgentLoopFn;
  logger?: HairyClawLogger;
}

export interface ParallelSubAgentToolOptions extends SubAgentToolOptions {
  subagentExecutor?: SubagentExecutor;
}

const toToolDef = (
  tool: Tool,
): { name: string; description: string; parameters: Record<string, unknown> } => ({
  name: tool.name,
  description: tool.description,
  parameters: {},
});

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`sub-agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const createToolExecutor = (tools: Tool[], ctx: ToolContext): ToolExecutor => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return async (name, args) => {
    const tool = byName.get(name);
    if (!tool) {
      return {
        content: `tool not found in sub-agent: ${name}`,
        isError: true,
      };
    }

    const result = await tool.execute(args, ctx);
    return {
      content: result.content,
      isError: result.isError ?? false,
    };
  };
};

export const createSubAgentTool = (opts: ParallelSubAgentToolOptions): Tool => ({
  name: opts.name,
  description: opts.description,
  parameters: subAgentArgsSchema,
  async execute(args, ctx) {
    const input = subAgentArgsSchema.parse(args);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const tools = opts.tools ?? [];
    const logger = opts.logger ?? ctx.logger ?? noopLogger;

    if (!opts.provider && !opts.runLoop && !opts.subagentExecutor) {
      return {
        content: "sub-agent provider is missing",
        isError: true,
      };
    }

    // Path 1: Use SubagentExecutor for parallel execution
    if (opts.subagentExecutor) {
      const provider = opts.provider ?? missingProvider;
      const toolExecutor = opts.executor ?? createToolExecutor(tools, ctx);

      try {
        const taskId = await opts.subagentExecutor.submit({
          task: input.task,
          systemPrompt: opts.systemPrompt,
          provider,
          executor: toolExecutor,
          tools: tools.map(toToolDef),
          model: opts.model ?? "default",
          parentTraceId: ctx.traceId,
          logger,
          timeoutMs,
        });

        const result = await opts.subagentExecutor.waitFor(taskId, timeoutMs);

        if (result.status === "completed" && result.result !== undefined) {
          return { content: result.result };
        }

        return {
          content: result.error ?? `sub-agent ${result.status}`,
          isError: true,
        };
      } catch (error: unknown) {
        return {
          content: error instanceof Error ? error.message : "sub-agent execution failed",
          isError: true,
        };
      }
    }

    // Path 2: Direct synchronous execution (backward compat)
    const provider = opts.provider ?? missingProvider;
    const toolExecutor = opts.executor ?? createToolExecutor(tools, ctx);
    const runLoop = opts.runLoop ?? runAgentLoop;

    const loopPromise = runLoop([{ role: "user", content: [{ type: "text", text: input.task }] }], {
      provider,
      executor: toolExecutor,
      logger,
      maxIterations: opts.maxIterations,
      streamOpts: {
        model: opts.model ?? "default",
        systemPrompt: opts.systemPrompt,
        tools: tools.map(toToolDef),
      },
    });

    try {
      const result: AgentLoopResult = await withTimeout(loopPromise, timeoutMs);
      return { content: result.text };
    } catch (error: unknown) {
      return {
        content: error instanceof Error ? error.message : "sub-agent execution failed",
        isError: true,
      };
    }
  },
});
