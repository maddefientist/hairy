import type { AgentLoopOptions, AgentLoopResult } from "@hairyclaw/core";
import { CHILD_MAX_ITERATIONS } from "@hairyclaw/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createChainTool } from "../src/builtin/chain.js";
import type { Tool, ToolContext } from "../src/types.js";

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
  text: "role output",
  toolCalls: [],
  totalUsage: { input: 0, output: 0, costUsd: 0 },
  iterations: 1,
};

const stubProviderFactory = () => ({
  async *stream() {
    // never actually invoked: runLoop is stubbed for these tests
  },
});

describe("createChainTool nested tool definitions", () => {
  it("passes real JSON-schema tool definitions (not empty objects) to the nested agent loop", async () => {
    const echoTool: Tool = {
      name: "echo",
      description: "Echo a value",
      parameters: z.object({ value: z.string().min(1), tag: z.string().optional() }),
      execute: vi.fn(async (args: unknown) => {
        const parsed = z
          .object({ value: z.string().min(1), tag: z.string().optional() })
          .parse(args);
        return { content: parsed.value };
      }),
    };

    const runLoop = vi.fn(async (_messages: unknown, _options: AgentLoopOptions) => baseResult);

    const tool = createChainTool({
      providerFactory: stubProviderFactory,
      defaultModel: "test-model",
      tools: [echoTool],
      runLoop,
    });

    const result = await tool.execute({ chain: "implement", task: "do the thing" }, toolCtx());

    expect(result.isError).toBeFalsy();
    expect(runLoop).toHaveBeenCalled();

    const firstCall = runLoop.mock.calls[0] as [unknown, AgentLoopOptions];
    const toolDefs = firstCall[1].streamOpts.tools as Array<{
      name: string;
      parameters: { type: string; properties: Record<string, unknown>; required: string[] };
    }>;
    const echoDef = toolDefs.find((t) => t.name === "echo");
    expect(echoDef).toBeDefined();
    expect(echoDef?.parameters.type).toBe("object");
    expect(echoDef?.parameters.properties.value).toMatchObject({ type: "string" });
    expect(echoDef?.parameters.required).toEqual(["value"]);
  });

  it("defaults each role's maxIterations to the shared CHILD_MAX_ITERATIONS bound", async () => {
    const runLoop = vi.fn(async (_messages: unknown, _options: AgentLoopOptions) => baseResult);

    const tool = createChainTool({
      providerFactory: stubProviderFactory,
      defaultModel: "test-model",
      tools: [],
      runLoop,
    });

    await tool.execute({ chain: "implement", task: "do the thing" }, toolCtx());

    for (const call of runLoop.mock.calls as Array<[unknown, AgentLoopOptions]>) {
      expect(call[1].maxIterations).toBe(CHILD_MAX_ITERATIONS);
    }
  });
});
