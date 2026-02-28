import { describe, expect, it, vi } from "vitest";
import {
  type AgentLoopEvent,
  type AgentLoopMessage,
  type AgentLoopStreamOptions,
  runAgentLoop,
} from "../src/agent-loop.js";

/** Minimal silent logger */
const noopLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => noopLogger,
};

/** Helper: create a mock provider that yields events per call */
const mockProvider = (turns: AgentLoopEvent[][]) => {
  let callIndex = 0;
  return {
    stream: async function* (
      _msgs: AgentLoopMessage[],
      _opts: AgentLoopStreamOptions,
    ): AsyncIterable<AgentLoopEvent> {
      const events = turns[callIndex] ?? [
        { type: "text_delta" as const, text: "fallback" },
        { type: "stop" as const, reason: "end" },
      ];
      callIndex++;
      for (const e of events) {
        yield e;
      }
    },
    callCount: () => callIndex,
  };
};

describe("runAgentLoop", () => {
  it("returns text when no tool calls are made", async () => {
    const provider = mockProvider([
      [
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world!" },
        { type: "stop", reason: "end" },
      ],
    ]);

    const result = await runAgentLoop([{ role: "user", content: [{ type: "text", text: "hi" }] }], {
      provider,
      executor: vi.fn(),
      streamOpts: { model: "test-model" },
      logger: noopLogger,
    });

    expect(result.text).toBe("Hello world!");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.iterations).toBe(1);
    expect(provider.callCount()).toBe(1);
  });

  it("executes tool calls and loops back to LLM", async () => {
    const provider = mockProvider([
      // Turn 1: LLM requests a tool call
      [
        { type: "text_delta", text: "Let me check..." },
        {
          type: "tool_call_start",
          toolCallId: "call_1",
          toolName: "bash",
        },
        {
          type: "tool_call_delta",
          toolCallId: "call_1",
          toolArgsDelta: '{"command":"echo hello"}',
        },
        { type: "tool_call_end", toolCallId: "call_1" },
        { type: "stop", reason: "tool_use" },
      ],
      // Turn 2: LLM produces final response
      [
        { type: "text_delta", text: "The output was: hello" },
        { type: "stop", reason: "end" },
      ],
    ]);

    const executor = vi.fn().mockResolvedValue({
      content: "hello\n",
      isError: false,
    });

    const result = await runAgentLoop(
      [{ role: "user", content: [{ type: "text", text: "run echo" }] }],
      {
        provider,
        executor,
        streamOpts: { model: "test-model" },
        logger: noopLogger,
      },
    );

    expect(result.text).toBe("The output was: hello");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe("bash");
    expect(result.iterations).toBe(2);
    expect(executor).toHaveBeenCalledWith("bash", { command: "echo hello" }, "call_1");
  });

  it("handles multiple tool calls in a single turn", async () => {
    const provider = mockProvider([
      // Turn 1: Two tool calls
      [
        {
          type: "tool_call_start",
          toolCallId: "c1",
          toolName: "read",
        },
        {
          type: "tool_call_delta",
          toolCallId: "c1",
          toolArgsDelta: '{"path":"a.txt"}',
        },
        { type: "tool_call_end", toolCallId: "c1" },
        {
          type: "tool_call_start",
          toolCallId: "c2",
          toolName: "read",
        },
        {
          type: "tool_call_delta",
          toolCallId: "c2",
          toolArgsDelta: '{"path":"b.txt"}',
        },
        { type: "tool_call_end", toolCallId: "c2" },
        { type: "stop", reason: "tool_use" },
      ],
      // Turn 2: Final
      [
        { type: "text_delta", text: "Both files read." },
        { type: "stop", reason: "end" },
      ],
    ]);

    const executor = vi.fn().mockResolvedValue({
      content: "file content",
      isError: false,
    });

    const result = await runAgentLoop(
      [
        {
          role: "user",
          content: [{ type: "text", text: "read both files" }],
        },
      ],
      {
        provider,
        executor,
        streamOpts: { model: "test-model" },
        logger: noopLogger,
      },
    );

    expect(result.text).toBe("Both files read.");
    expect(result.toolCalls).toHaveLength(2);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("respects maxIterations limit", async () => {
    // Provider always requests tool calls (infinite loop)
    const infiniteToolCalls: AgentLoopEvent[] = [
      {
        type: "tool_call_start",
        toolCallId: "call",
        toolName: "bash",
      },
      {
        type: "tool_call_delta",
        toolCallId: "call",
        toolArgsDelta: '{"command":"loop"}',
      },
      { type: "tool_call_end", toolCallId: "call" },
      { type: "stop", reason: "tool_use" },
    ];

    const provider = mockProvider(Array.from({ length: 5 }, () => infiniteToolCalls));

    const executor = vi.fn().mockResolvedValue({
      content: "ok",
      isError: false,
    });

    const result = await runAgentLoop(
      [{ role: "user", content: [{ type: "text", text: "loop" }] }],
      {
        provider,
        executor,
        streamOpts: { model: "test-model" },
        logger: noopLogger,
        maxIterations: 3,
      },
    );

    expect(result.iterations).toBe(3);
    expect(result.text).toContain("maximum");
    expect(executor).toHaveBeenCalledTimes(3);
  });

  it("accumulates usage across turns", async () => {
    const provider = mockProvider([
      [
        {
          type: "usage",
          usage: { input: 100, output: 50, costUsd: 0.001 },
        },
        {
          type: "tool_call_start",
          toolCallId: "c1",
          toolName: "bash",
        },
        {
          type: "tool_call_delta",
          toolCallId: "c1",
          toolArgsDelta: '{"command":"x"}',
        },
        { type: "tool_call_end", toolCallId: "c1" },
        { type: "stop", reason: "tool_use" },
      ],
      [
        {
          type: "usage",
          usage: { input: 200, output: 80, costUsd: 0.002 },
        },
        { type: "text_delta", text: "done" },
        { type: "stop", reason: "end" },
      ],
    ]);

    const result = await runAgentLoop([{ role: "user", content: [{ type: "text", text: "go" }] }], {
      provider,
      executor: vi.fn().mockResolvedValue({
        content: "ok",
        isError: false,
      }),
      streamOpts: { model: "test-model" },
      logger: noopLogger,
    });

    expect(result.totalUsage.input).toBe(300);
    expect(result.totalUsage.output).toBe(130);
    expect(result.totalUsage.costUsd).toBeCloseTo(0.003);
  });

  it("calls onTextDelta callback for streaming", async () => {
    const provider = mockProvider([
      [
        { type: "text_delta", text: "chunk1" },
        { type: "text_delta", text: "chunk2" },
        { type: "stop", reason: "end" },
      ],
    ]);

    const chunks: string[] = [];

    await runAgentLoop([{ role: "user", content: [{ type: "text", text: "hi" }] }], {
      provider,
      executor: vi.fn(),
      streamOpts: { model: "test-model" },
      logger: noopLogger,
      onTextDelta: (text) => chunks.push(text),
    });

    expect(chunks).toEqual(["chunk1", "chunk2"]);
  });

  it("handles tool execution errors gracefully", async () => {
    const provider = mockProvider([
      [
        {
          type: "tool_call_start",
          toolCallId: "c1",
          toolName: "bash",
        },
        {
          type: "tool_call_delta",
          toolCallId: "c1",
          toolArgsDelta: '{"command":"fail"}',
        },
        { type: "tool_call_end", toolCallId: "c1" },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "The command failed." },
        { type: "stop", reason: "end" },
      ],
    ]);

    const executor = vi.fn().mockResolvedValue({
      content: "permission denied",
      isError: true,
    });

    const result = await runAgentLoop(
      [{ role: "user", content: [{ type: "text", text: "run fail" }] }],
      {
        provider,
        executor,
        streamOpts: { model: "test-model" },
        logger: noopLogger,
      },
    );

    expect(result.text).toBe("The command failed.");
    expect(result.toolCalls[0].isError).toBe(true);
  });

  it("handles provider error with no tool calls or text", async () => {
    const provider = mockProvider([[{ type: "error", error: "rate limited" }]]);

    const result = await runAgentLoop([{ role: "user", content: [{ type: "text", text: "hi" }] }], {
      provider,
      executor: vi.fn(),
      streamOpts: { model: "test-model" },
      logger: noopLogger,
    });

    expect(result.text).toContain("error");
  });
});
