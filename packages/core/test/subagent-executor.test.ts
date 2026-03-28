import { describe, expect, it, vi } from "vitest";
import type {
  AgentLoopEvent,
  AgentLoopMessage,
  AgentLoopStreamOptions,
} from "../src/agent-loop.js";
import { SubagentExecutor } from "../src/subagent-executor.js";

const noopLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => noopLogger,
};

/** Helper: create a mock provider that returns text after optional delay */
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

const noopExecutor = vi.fn(async () => ({ content: "", isError: false }));

const baseSubmitOpts = (overrides: Record<string, unknown> = {}) => ({
  task: "do something",
  systemPrompt: "You are a helper.",
  provider: mockProvider("done"),
  executor: noopExecutor,
  tools: [],
  model: "test-model",
  parentTraceId: "trace-parent-1",
  logger: noopLogger,
  ...overrides,
});

describe("SubagentExecutor", () => {
  it("submits a single task that completes successfully", async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 3 });
    const taskId = await executor.submit(baseSubmitOpts());

    const result = await executor.waitFor(taskId);

    expect(result.status).toBe("completed");
    expect(result.result).toBe("done");
    expect(result.error).toBeUndefined();
    expect(result.taskId).toBe(taskId);
    expect(result.parentTraceId).toBe("trace-parent-1");
    expect(result.startedAt).toBeTypeOf("number");
    expect(result.completedAt).toBeTypeOf("number");
  });

  it("submits multiple tasks that run concurrently", async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 3 });
    const startTime = Date.now();

    const id1 = await executor.submit(
      baseSubmitOpts({ provider: mockProvider("r1", 50), task: "task 1" }),
    );
    const id2 = await executor.submit(
      baseSubmitOpts({ provider: mockProvider("r2", 50), task: "task 2" }),
    );
    const id3 = await executor.submit(
      baseSubmitOpts({ provider: mockProvider("r3", 50), task: "task 3" }),
    );

    const results = await executor.waitForAll();
    const elapsed = Date.now() - startTime;

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe("completed");
    }

    // All 3 tasks with 50ms delay should complete well under 300ms if parallel
    expect(elapsed).toBeLessThan(300);
  });

  it("respects concurrency limit", async () => {
    const timeline: Array<{ event: string; time: number }> = [];
    const startTime = Date.now();

    const trackedProvider = (text: string, delayMs: number) => ({
      async *stream(
        _msgs: AgentLoopMessage[],
        _opts: AgentLoopStreamOptions,
      ): AsyncIterable<AgentLoopEvent> {
        timeline.push({ event: `start-${text}`, time: Date.now() - startTime });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        timeline.push({ event: `end-${text}`, time: Date.now() - startTime });
        yield { type: "text_delta" as const, text };
        yield { type: "stop" as const, reason: "end" };
      },
    });

    // max 2 concurrent, submit 4 tasks each taking 50ms
    const executor = new SubagentExecutor({ maxConcurrent: 2 });

    const ids = await Promise.all([
      executor.submit(baseSubmitOpts({ provider: trackedProvider("a", 50), taskId: "t-a" })),
      executor.submit(baseSubmitOpts({ provider: trackedProvider("b", 50), taskId: "t-b" })),
      executor.submit(baseSubmitOpts({ provider: trackedProvider("c", 50), taskId: "t-c" })),
      executor.submit(baseSubmitOpts({ provider: trackedProvider("d", 50), taskId: "t-d" })),
    ]);

    const results = await executor.waitForAll();

    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.status).toBe("completed");
    }

    // With max 2 concurrency and 4 tasks of 50ms each, should take ~100ms+
    // If all ran in parallel (no limit), would be ~50ms
    // The key check: at most 2 "start" events should occur before any "end" event
    const sortedTimeline = [...timeline].sort((a, b) => a.time - b.time);
    let activeCount = 0;
    let maxActive = 0;
    for (const entry of sortedTimeline) {
      if (entry.event.startsWith("start")) {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
      } else {
        activeCount--;
      }
    }
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("task timeout sets status to timed_out", async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 3, defaultTimeoutMs: 30 });

    const taskId = await executor.submit(
      baseSubmitOpts({
        provider: mockProvider("slow", 200),
        timeoutMs: 30,
      }),
    );

    const result = await executor.waitFor(taskId);

    expect(result.status).toBe("timed_out");
    expect(result.error).toContain("timed out");
  });

  it("task error sets status to failed with error message", async () => {
    const failingRunLoop = vi.fn(async () => {
      throw new Error("model exploded");
    });

    const executor = new SubagentExecutor({ maxConcurrent: 3, runLoop: failingRunLoop });

    const taskId = await executor.submit(baseSubmitOpts());

    const result = await executor.waitFor(taskId);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("model exploded");
  });

  it("getResult returns undefined for unknown taskId", () => {
    const executor = new SubagentExecutor();
    expect(executor.getResult("nonexistent")).toBeUndefined();
  });

  it("waitFor resolves when task completes", async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 3 });

    const taskId = await executor.submit(baseSubmitOpts({ provider: mockProvider("waited", 20) }));

    const result = await executor.waitFor(taskId);

    expect(result.status).toBe("completed");
    expect(result.result).toBe("waited");
  });

  it("waitForAll resolves when all tasks complete", async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 3 });

    await executor.submit(baseSubmitOpts({ provider: mockProvider("r1", 10), taskId: "w1" }));
    await executor.submit(baseSubmitOpts({ provider: mockProvider("r2", 20), taskId: "w2" }));
    await executor.submit(baseSubmitOpts({ provider: mockProvider("r3", 30), taskId: "w3" }));

    const results = await executor.waitForAll();

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe("completed");
    }
  });

  it("waitForAll returns empty array when no tasks are running", async () => {
    const executor = new SubagentExecutor();
    const results = await executor.waitForAll();
    expect(results).toHaveLength(0);
  });

  it("cleanup removes completed tasks", async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 3 });

    const taskId = await executor.submit(baseSubmitOpts({ taskId: "cleanup-me" }));
    await executor.waitFor(taskId);

    expect(executor.getResult(taskId)).toBeDefined();

    executor.cleanup(taskId);

    expect(executor.getResult(taskId)).toBeUndefined();
  });

  it("activeCount tracks running tasks correctly", async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 5 });

    expect(executor.activeCount).toBe(0);

    const id1 = await executor.submit(
      baseSubmitOpts({ provider: mockProvider("a", 100), taskId: "ac-1" }),
    );
    const id2 = await executor.submit(
      baseSubmitOpts({ provider: mockProvider("b", 100), taskId: "ac-2" }),
    );

    // Give tasks a moment to start
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executor.activeCount).toBeGreaterThanOrEqual(1);

    await executor.waitForAll();
    expect(executor.activeCount).toBe(0);
  });

  it("uses custom taskId when provided", async () => {
    const executor = new SubagentExecutor();
    const taskId = await executor.submit(baseSubmitOpts({ taskId: "custom-id-123" }));

    expect(taskId).toBe("custom-id-123");

    const result = await executor.waitFor(taskId);
    expect(result.taskId).toBe("custom-id-123");
  });

  it("waitFor throws for unknown taskId", async () => {
    const executor = new SubagentExecutor();
    await expect(executor.waitFor("ghost")).rejects.toThrow("unknown task");
  });

  it("listTasks returns all tracked tasks", async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 3 });

    await executor.submit(baseSubmitOpts({ taskId: "list-1" }));
    await executor.submit(baseSubmitOpts({ taskId: "list-2" }));
    await executor.waitForAll();

    const tasks = executor.listTasks();
    expect(tasks).toHaveLength(2);
    const ids = tasks.map((t) => t.taskId);
    expect(ids).toContain("list-1");
    expect(ids).toContain("list-2");
  });

  it("propagates parentTraceId to task result", async () => {
    const executor = new SubagentExecutor();
    const taskId = await executor.submit(baseSubmitOpts({ parentTraceId: "parent-trace-xyz" }));

    const result = await executor.waitFor(taskId);
    expect(result.parentTraceId).toBe("parent-trace-xyz");
  });

  it("tracks toolCallCount from agent loop result", async () => {
    // Provider that triggers a tool call, then completes
    const toolCallProvider = {
      callCount: 0,
      async *stream(
        _msgs: AgentLoopMessage[],
        _opts: AgentLoopStreamOptions,
      ): AsyncIterable<AgentLoopEvent> {
        if (toolCallProvider.callCount === 0) {
          toolCallProvider.callCount++;
          yield { type: "tool_call_start" as const, toolCallId: "c1", toolName: "echo" };
          yield { type: "tool_call_delta" as const, toolCallId: "c1", toolArgsDelta: '{"x":1}' };
          yield { type: "tool_call_end" as const, toolCallId: "c1" };
          yield { type: "stop" as const, reason: "tool_use" };
        } else {
          yield { type: "text_delta" as const, text: "done" };
          yield { type: "stop" as const, reason: "end" };
        }
      },
    };

    const toolExecutor = vi.fn(async () => ({ content: "ok", isError: false }));

    const executor = new SubagentExecutor();
    const taskId = await executor.submit(
      baseSubmitOpts({
        provider: toolCallProvider,
        executor: toolExecutor,
      }),
    );

    const result = await executor.waitFor(taskId);
    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
  });
});
