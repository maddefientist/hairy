import type {
  AgentLoopEvent,
  AgentLoopMessage,
  AgentLoopOptions,
  AgentLoopResult,
  AgentLoopStreamOptions,
} from "@hairyclaw/core";
import { SubagentExecutor } from "@hairyclaw/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSubAgentTool } from "../src/builtin/subagent.js";
import type { ToolContext } from "../src/types.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const toolCtx = (): ToolContext => ({
  traceId: "trace-1",
  cwd: process.cwd(),
  dataDir: process.cwd(),
  logger,
});

const baseResult: AgentLoopResult = {
  text: "sub-agent output",
  toolCalls: [],
  totalUsage: { input: 0, output: 0, costUsd: 0 },
  iterations: 1,
};

describe("createSubAgentTool", () => {
  it("creates tool with configured name and description", () => {
    const tool = createSubAgentTool({
      name: "research_subagent",
      description: "Deep research specialist",
      systemPrompt: "You are a researcher.",
      runLoop: vi.fn(async () => baseResult),
    });

    expect(tool.name).toBe("research_subagent");
    expect(tool.description).toBe("Deep research specialist");
  });

  it("execute runs agent loop with system prompt", async () => {
    const runLoop = vi.fn(async () => baseResult);
    const tool = createSubAgentTool({
      name: "sub",
      description: "desc",
      systemPrompt: "You are a planner",
      model: "openrouter/gpt-4o-mini",
      runLoop,
    });

    await tool.execute({ task: "plan this" }, toolCtx());

    const call = runLoop.mock.calls[0] as [unknown[], AgentLoopOptions] | undefined;
    expect(call?.[1].streamOpts.systemPrompt).toBe("You are a planner");
    expect(call?.[1].streamOpts.model).toBe("openrouter/gpt-4o-mini");
  });

  it("passes task as user message to runAgentLoop", async () => {
    const runLoop = vi.fn(async () => baseResult);
    const tool = createSubAgentTool({
      name: "sub",
      description: "desc",
      systemPrompt: "sys",
      runLoop,
    });

    await tool.execute({ task: "summarize docs" }, toolCtx());

    const call = runLoop.mock.calls[0] as [
      Array<{ role: string; content: Array<{ type: string; text?: string }> }>,
      AgentLoopOptions,
    ];
    expect(call[0][0]?.role).toBe("user");
    expect(call[0][0]?.content[0]?.text).toBe("summarize docs");
  });

  it("timeout aborts sub-agent run", async () => {
    const runLoop = vi.fn(
      async () =>
        await new Promise<AgentLoopResult>((resolve) => {
          setTimeout(() => resolve(baseResult), 50);
        }),
    );

    const tool = createSubAgentTool({
      name: "sub",
      description: "desc",
      systemPrompt: "sys",
      timeoutMs: 10,
      runLoop,
    });

    const result = await tool.execute({ task: "slow work" }, toolCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  });

  it("returns sub-agent result text to parent", async () => {
    const runLoop = vi.fn(async () => ({ ...baseResult, text: "final answer" }));
    const tool = createSubAgentTool({
      name: "sub",
      description: "desc",
      systemPrompt: "sys",
      runLoop,
    });

    const result = await tool.execute({ task: "answer" }, toolCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("final answer");
  });

  it("sub-agent tools are executable by nested loop", async () => {
    const echoTool = {
      name: "echo",
      description: "Echo value",
      parameters: z.object({ value: z.string() }),
      execute: vi.fn(async (args: unknown) => {
        const parsed = z.object({ value: z.string() }).parse(args);
        return { content: parsed.value };
      }),
    };

    const runLoop = vi.fn(
      async (_messages: unknown, options: AgentLoopOptions): Promise<AgentLoopResult> => {
        const execution = await options.executor("echo", { value: "nested" }, "call-1");
        return {
          ...baseResult,
          text: execution.content,
        };
      },
    );

    const tool = createSubAgentTool({
      name: "sub",
      description: "desc",
      systemPrompt: "sys",
      tools: [echoTool],
      runLoop,
    });

    const result = await tool.execute({ task: "run nested" }, toolCtx());

    expect(result.content).toBe("nested");
    expect(echoTool.execute).toHaveBeenCalledTimes(1);
  });

  it("returns error when provider and runLoop are both missing", async () => {
    const tool = createSubAgentTool({
      name: "sub",
      description: "desc",
      systemPrompt: "sys",
    });

    const result = await tool.execute({ task: "hello" }, toolCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("provider is missing");
  });
});

describe("createSubAgentTool with SubagentExecutor", () => {
  const mockProvider = (text: string, delayMs = 0) => ({
    async *stream(
      _msgs: AgentLoopMessage[],
      _opts: AgentLoopStreamOptions,
    ): AsyncIterable<AgentLoopEvent> {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      yield { type: "text_delta" as const, text };
      yield { type: "stop" as const, reason: "end" };
    },
  });

  it("uses executor for parallel execution", async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 3 });

    const tool = createSubAgentTool({
      name: "parallel-sub",
      description: "parallel desc",
      systemPrompt: "You help.",
      provider: mockProvider("executor result"),
      subagentExecutor: executor,
    });

    const result = await tool.execute({ task: "work" }, toolCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("executor result");
  });

  it("returns error status from executor on failure", async () => {
    const failingRunLoop = vi.fn(async () => {
      throw new Error("provider crashed");
    });

    const executor = new SubagentExecutor({ maxConcurrent: 3, runLoop: failingRunLoop });

    const tool = createSubAgentTool({
      name: "failing-sub",
      description: "fails",
      systemPrompt: "sys",
      provider: mockProvider("unused"),
      subagentExecutor: executor,
    });

    const result = await tool.execute({ task: "crash" }, toolCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("provider crashed");
  });

  it("executor timeout results in error", async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 3 });

    const tool = createSubAgentTool({
      name: "slow-sub",
      description: "slow",
      systemPrompt: "sys",
      provider: mockProvider("slow", 200),
      timeoutMs: 30,
      subagentExecutor: executor,
    });

    const result = await tool.execute({ task: "slow work" }, toolCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  });

  it("backward compat: works without executor (uses runLoop)", async () => {
    const runLoop = vi.fn(async () => ({ ...baseResult, text: "sync result" }));

    const tool = createSubAgentTool({
      name: "sync-sub",
      description: "sync desc",
      systemPrompt: "sys",
      runLoop,
    });

    const result = await tool.execute({ task: "sync work" }, toolCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("sync result");
    expect(runLoop).toHaveBeenCalledTimes(1);
  });
});
