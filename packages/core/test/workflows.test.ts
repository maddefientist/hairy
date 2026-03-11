import { describe, expect, it, vi } from "vitest";
import type {
  AgentLoopEvent,
  AgentLoopMessage,
  AgentLoopStreamOptions,
} from "../src/agent-loop.js";
import type { PluginContext } from "../src/plugin.js";
import {
  AgentStep,
  LoopFlow,
  ParallelFlow,
  SequentialFlow,
  type WorkflowStep,
  runWorkflow,
} from "../src/workflows.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const ctx = (): PluginContext => ({
  traceId: "t-1",
  channelType: "cli",
  channelId: "c-1",
  senderId: "u-1",
  state: new Map<string, unknown>(),
  logger,
});

const step = (
  name: string,
  runFn: (state: Map<string, unknown>) => Promise<Map<string, unknown>> | Map<string, unknown>,
): WorkflowStep => ({
  name,
  run: async (state) => runFn(state),
});

describe("workflow primitives", () => {
  it("SequentialFlow runs steps in order", async () => {
    const calls: string[] = [];
    const flow = new SequentialFlow("seq", [
      step("a", async () => {
        calls.push("a");
        return new Map();
      }),
      step("b", async () => {
        calls.push("b");
        return new Map();
      }),
    ]);

    await flow.run(new Map(), ctx());
    expect(calls).toEqual(["a", "b"]);
  });

  it("SequentialFlow passes state between steps", async () => {
    const flow = new SequentialFlow("seq", [
      step("a", async () => new Map([["x", 1]])),
      step("b", async (state) => new Map([["y", (state.get("x") as number) + 1]])),
    ]);

    const result = await flow.run(new Map(), ctx());
    expect(result.get("x")).toBe(1);
    expect(result.get("y")).toBe(2);
  });

  it("ParallelFlow runs steps concurrently", async () => {
    const starts: number[] = [];
    const flow = new ParallelFlow("par", [
      step("a", async () => {
        starts.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Map([["a", true]]);
      }),
      step("b", async () => {
        starts.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Map([["b", true]]);
      }),
    ]);

    await flow.run(new Map(), ctx());
    expect(Math.abs(starts[0] - starts[1])).toBeLessThan(15);
  });

  it("ParallelFlow merges outputs", async () => {
    const flow = new ParallelFlow("par", [
      step("a", async () => new Map([["a", 1]])),
      step("b", async () => new Map([["b", 2]])),
    ]);

    const result = await flow.run(new Map(), ctx());
    expect(result.get("a")).toBe(1);
    expect(result.get("b")).toBe(2);
  });

  it("ParallelFlow respects maxConcurrency", async () => {
    let active = 0;
    let maxSeen = 0;
    const mk = (name: string): WorkflowStep =>
      step(name, async () => {
        active += 1;
        maxSeen = Math.max(maxSeen, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return new Map([[name, true]]);
      });

    const flow = new ParallelFlow("par", [mk("a"), mk("b"), mk("c")], { maxConcurrency: 2 });
    await flow.run(new Map(), ctx());

    expect(maxSeen).toBe(2);
  });

  it("LoopFlow repeats until condition is met", async () => {
    const loop = new LoopFlow(
      "loop",
      step("inc", async (state) => new Map([["n", ((state.get("n") as number) ?? 0) + 1]])),
      {
        until: (state) => ((state.get("n") as number) ?? 0) >= 3,
        maxIterations: 10,
      },
    );

    const result = await loop.run(new Map(), ctx());
    expect(result.get("n")).toBe(3);
  });

  it("LoopFlow stops at maxIterations", async () => {
    const loop = new LoopFlow(
      "loop",
      step("inc", async (state) => new Map([["n", ((state.get("n") as number) ?? 0) + 1]])),
      {
        until: () => false,
        maxIterations: 2,
      },
    );

    const result = await loop.run(new Map(), ctx());
    expect(result.get("n")).toBe(2);
  });

  it("LoopFlow accumulates state across iterations", async () => {
    const loop = new LoopFlow(
      "loop",
      step("collect", async (state) => {
        const existing = (state.get("items") as string[]) ?? [];
        return new Map([["items", [...existing, "x"]]]);
      }),
      {
        until: (state) => ((state.get("items") as string[]) ?? []).length >= 2,
        maxIterations: 5,
      },
    );

    const result = await loop.run(new Map(), ctx());
    expect(result.get("items")).toEqual(["x", "x"]);
  });

  it("AgentStep interpolates prompt template from state", async () => {
    let capturedPrompt = "";
    const provider = {
      stream: async function* (
        messages: AgentLoopMessage[],
        _opts: AgentLoopStreamOptions,
      ): AsyncIterable<AgentLoopEvent> {
        capturedPrompt = messages[0]?.content[0]?.text ?? "";
        yield { type: "text_delta", text: "ok" };
        yield { type: "stop", reason: "end" };
      },
    };

    const stepInstance = new AgentStep({
      name: "agent",
      promptTemplate: "Hello {state.name}",
      outputKey: "result",
      model: "mock-model",
    });

    const state = new Map<string, unknown>([
      ["name", "Ada"],
      [
        "workflow.agentRuntime",
        {
          provider,
          executor: async () => ({ content: "", isError: false }),
          defaultModel: "mock-model",
        },
      ],
    ]);

    await stepInstance.run(state, { ...ctx(), state });
    expect(capturedPrompt).toBe("Hello Ada");
  });

  it("AgentStep stores response under outputKey", async () => {
    const provider = {
      stream: async function* (): AsyncIterable<AgentLoopEvent> {
        yield { type: "text_delta", text: "agent output" };
        yield { type: "stop", reason: "end" };
      },
    };

    const stepInstance = new AgentStep({
      name: "agent",
      promptTemplate: "run",
      outputKey: "answer",
      model: "mock-model",
    });

    const state = new Map<string, unknown>([
      [
        "workflow.agentRuntime",
        {
          provider,
          executor: async () => ({ content: "", isError: false }),
          defaultModel: "mock-model",
        },
      ],
    ]);

    const output = await stepInstance.run(state, { ...ctx(), state });
    expect(output.get("answer")).toBe("agent output");
  });

  it("supports nested flows", async () => {
    const nested = new SequentialFlow("root", [
      new ParallelFlow("parallel", [
        step("a", async () => new Map([["a", 1]])),
        step("b", async () => new Map([["b", 2]])),
      ]),
      step(
        "sum",
        async (state) =>
          new Map([["sum", (state.get("a") as number) + (state.get("b") as number)]]),
      ),
    ]);

    const result = await nested.run(new Map(), ctx());
    expect(result.get("sum")).toBe(3);
  });

  it("empty flow returns input state", async () => {
    const state = new Map<string, unknown>([["x", 1]]);
    const flow = new SequentialFlow("empty", []);

    const result = await flow.run(state, ctx());
    expect(result.get("x")).toBe(1);
  });

  it("parallel step errors are collected without crashing", async () => {
    const flow = new ParallelFlow("par", [
      step("bad", async () => {
        throw new Error("boom");
      }),
      step("good", async () => new Map([["ok", true]])),
    ]);

    const result = await flow.run(new Map(), ctx());
    expect(result.get("ok")).toBe(true);
    expect(result.get("workflow.error.bad")).toBe("boom");
  });

  it("runWorkflow uses empty map when no initial state is provided", async () => {
    const flow = step("set", async () => new Map([["x", 1]]));
    const result = await runWorkflow(flow);
    expect(result.get("x")).toBe(1);
  });
});
