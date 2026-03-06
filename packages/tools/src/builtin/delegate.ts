/**
 * delegate — orchestrator-to-executor tool.
 *
 * The orchestrator (GLM-5:cloud) calls this tool with a focused instruction.
 * A smaller, faster model (qwen3.5:9b) executes the instruction using the
 * real tool set (bash, read, write, edit, web-search, etc.) in a mini
 * agent loop.
 *
 * This separates reasoning (cloud model, good at planning) from execution
 * (local model, fast and reliable at tool-calling).
 */
import { runAgentLoop } from "@hairy/core";
import type {
  AgentLoopMessage,
  AgentLoopProvider,
  AgentLoopStreamOptions,
  AgentLoopToolDef,
  ToolExecutor,
} from "@hairy/core";
import type { HairyLogger } from "@hairy/observability";
import { z } from "zod";
import type { Tool } from "../types.js";

const delegateSchema = z.object({
  instruction: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "Clear, specific instruction for the executor. Include file paths, expected output format, and success criteria. The executor is capable but works best with precise direction.",
    ),
  context: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "Additional context the executor needs (e.g. relevant file contents, prior results). Keep concise.",
    ),
  max_steps: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Maximum tool-use iterations for the executor (default: 5)."),
});

export interface DelegateToolOptions {
  /** The provider instance to use for execution (should target the executor model) */
  executorProvider: AgentLoopProvider;
  /** Model ID for the executor (e.g. 'qwen3.5:9b') */
  executorModel: string;
  /** Tool definitions available to the executor */
  executorTools: AgentLoopToolDef[];
  /** Tool executor function (same registry, just scoped to executor-safe tools) */
  executor: ToolExecutor;
  /** Logger */
  logger: HairyLogger;
}

const EXECUTOR_SYSTEM_PROMPT = `You are a precise tool executor. You receive focused instructions and execute them using the tools available to you.

Rules:
- Follow the instruction exactly. Do not deviate or add unrequested work.
- Use the minimum number of tool calls needed.
- Return a clear, concise summary of what you did and the results.
- If something fails, report the error clearly — do not retry unless the instruction says to.
- Do not engage in conversation. Just execute and report.
- If the instruction is ambiguous, make a reasonable choice and note what you assumed.`;

export const createDelegateTool = (opts: DelegateToolOptions): Tool => ({
  name: "delegate",
  description:
    "Delegate a task to the executor agent for tool execution. The executor can run bash commands, read/write/edit files, and search the web. Provide clear, specific instructions. Use this for any action that requires interacting with the system.",
  parameters: delegateSchema,
  async execute(args) {
    const input = delegateSchema.parse(args);

    const instruction = input.context
      ? `## Context\n${input.context}\n\n## Instruction\n${input.instruction}`
      : input.instruction;

    const messages: AgentLoopMessage[] = [
      { role: "user", content: [{ type: "text", text: instruction }] },
    ];

    opts.logger.info(
      {
        instruction: input.instruction.slice(0, 200),
        maxSteps: input.max_steps ?? 5,
        executorModel: opts.executorModel,
      },
      "delegate: starting executor",
    );

    const startedAt = Date.now();

    try {
      const result = await runAgentLoop(messages, {
        provider: opts.executorProvider,
        executor: opts.executor,
        streamOpts: {
          model: opts.executorModel,
          systemPrompt: EXECUTOR_SYSTEM_PROMPT,
          tools: opts.executorTools,
          maxTokens: 4096,
          temperature: 0.1,
        },
        logger: opts.logger,
        maxIterations: input.max_steps ?? 5,
      });

      const durationMs = Date.now() - startedAt;

      opts.logger.info(
        {
          iterations: result.iterations,
          toolCalls: result.toolCalls.length,
          durationMs,
          resultLength: result.text.length,
        },
        "delegate: executor finished",
      );

      // Build a structured result for the orchestrator
      const toolSummary =
        result.toolCalls.length > 0
          ? result.toolCalls
              .map((tc) => {
                const status = tc.isError ? "❌ ERROR" : "✓";
                const resultStr = typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result);
                const resultPreview = resultStr.slice(0, 500);
                return `${status} ${tc.toolName} (${tc.durationMs}ms): ${resultPreview}`;
              })
              .join("\n")
          : "(no tools called)";

      return {
        content: [
          `## Executor Result (${result.iterations} iterations, ${result.toolCalls.length} tool calls, ${durationMs}ms)`,
          "",
          result.text || "(executor produced no text output)",
          "",
          "### Tool Execution Log",
          toolSummary,
        ].join("\n"),
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startedAt;
      const errMsg = err instanceof Error ? err.message : String(err);

      opts.logger.error({ err, durationMs }, "delegate: executor failed");

      return {
        content: `Executor failed after ${durationMs}ms: ${errMsg}`,
        isError: true,
      };
    }
  },
});
