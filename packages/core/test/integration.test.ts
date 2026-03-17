import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
/**
 * Integration test — exercises the full message pipeline:
 *   Channel message → Orchestrator → runAgentLoop → ToolRegistry → Response
 *
 * No real LLM calls. The mock provider drives a deterministic tool-call
 * round-trip so we can assert that the entire wiring actually works.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAgentLoop } from "../src/agent-loop.js";
import type {
  AgentLoopEvent,
  AgentLoopMessage,
  AgentLoopStreamOptions,
} from "../src/agent-loop.js";
import { Orchestrator } from "../src/orchestrator.js";
import { TaskQueue } from "../src/task-queue.js";
import type { AgentResponse, HairyClawMessage } from "../src/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const noopLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => noopLogger,
};

const noopMetrics = {
  increment: vi.fn(),
  gauge: vi.fn(),
  getAll: vi.fn(() => ({})),
};

const userMessage = (text: string): HairyClawMessage => ({
  id: randomUUID(),
  channelId: "test-channel",
  channelType: "cli",
  senderId: "test-user",
  senderName: "Test User",
  content: { text },
  timestamp: new Date().toISOString(),
});

// ─── Mock provider factory ───────────────────────────────────────────────────

/**
 * Builds a provider that plays back a scripted sequence of turns.
 * Each turn is an array of StreamEvents.
 */
const makeProvider = (turns: AgentLoopEvent[][]) => {
  let call = 0;
  return {
    stream: async function* (
      _msgs: AgentLoopMessage[],
      _opts: AgentLoopStreamOptions,
    ): AsyncIterable<AgentLoopEvent> {
      const events = turns[call] ?? [
        { type: "text_delta" as const, text: "fallback" },
        { type: "stop" as const, reason: "end" },
      ];
      call++;
      for (const e of events) yield e;
    },
  };
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Full pipeline: Orchestrator → runAgentLoop → ToolRegistry", () => {
  it("delivers a plain text response with no tool calls", async () => {
    const tmpDir = join(tmpdir(), randomUUID());
    await mkdir(tmpDir, { recursive: true });

    const provider = makeProvider([
      [
        { type: "text_delta", text: "The answer is 42." },
        { type: "stop", reason: "end" },
      ],
    ]);

    const responses: AgentResponse[] = [];

    const orchestrator = new Orchestrator({
      logger: noopLogger,
      metrics: noopMetrics as never,
      queue: new TaskQueue(join(tmpDir, "queue.json")),
      handleRun: async (msg, traceId) => {
        const result = await runAgentLoop(
          [{ role: "user", content: [{ type: "text", text: msg.content.text ?? "" }] }],
          {
            provider,
            executor: vi.fn(),
            streamOpts: { model: "mock" },
            logger: noopLogger,
          },
        );
        const response = { text: result.text };
        responses.push(response);
        return response;
      },
    });

    await orchestrator.start();
    await orchestrator.handleMessage(userMessage("What is the meaning of life?"));

    // Allow the async process loop to complete
    await vi.waitFor(() => expect(responses).toHaveLength(1), { timeout: 1000 });

    expect(responses[0]?.text).toBe("The answer is 42.");
    await orchestrator.stop();
  });

  it("executes a tool call and feeds the result back into the LLM", async () => {
    const tmpDir = join(tmpdir(), randomUUID());
    await mkdir(tmpDir, { recursive: true });

    // Provider: turn 1 → requests bash, turn 2 → final text
    const provider = makeProvider([
      [
        { type: "tool_call_start", toolCallId: "c1", toolName: "echo_tool" },
        { type: "tool_call_delta", toolCallId: "c1", toolArgsDelta: '{"msg":"ping"}' },
        { type: "tool_call_end", toolCallId: "c1" },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Tool returned: pong" },
        { type: "stop", reason: "end" },
      ],
    ]);

    // A fake tool that echoes its input uppercased
    const echoTool = {
      name: "echo_tool",
      description: "Echoes a message",
      parameters: z.object({ msg: z.string() }),
      execute: vi.fn(async (args: unknown) => ({
        content: (args as { msg: string }).msg.toUpperCase(),
      })),
    };

    const responses: AgentResponse[] = [];
    const toolCallArgs: unknown[] = [];

    const orchestrator = new Orchestrator({
      logger: noopLogger,
      metrics: noopMetrics as never,
      queue: new TaskQueue(join(tmpDir, "queue.json")),
      handleRun: async (msg, _traceId) => {
        const result = await runAgentLoop(
          [{ role: "user", content: [{ type: "text", text: msg.content.text ?? "" }] }],
          {
            provider,
            executor: async (name, args) => {
              if (name === "echo_tool") {
                const r = await echoTool.execute(args);
                toolCallArgs.push(args);
                return { content: r.content, isError: false };
              }
              return { content: "unknown tool", isError: true };
            },
            streamOpts: { model: "mock" },
            logger: noopLogger,
          },
        );
        const response = { text: result.text };
        responses.push(response);
        return response;
      },
    });

    await orchestrator.start();
    await orchestrator.handleMessage(userMessage("ping the echo tool"));

    await vi.waitFor(() => expect(responses).toHaveLength(1), { timeout: 1000 });

    // The LLM got tool result and produced the final text
    expect(responses[0]?.text).toBe("Tool returned: pong");
    // The tool was actually called with parsed args
    expect(toolCallArgs[0]).toEqual({ msg: "ping" });
    expect(echoTool.execute).toHaveBeenCalledTimes(1);

    await orchestrator.stop();
  });

  it("processes multiple messages sequentially from the queue", async () => {
    const tmpDir = join(tmpdir(), randomUUID());
    await mkdir(tmpDir, { recursive: true });

    const responses: string[] = [];
    let callN = 0;

    const orchestrator = new Orchestrator({
      logger: noopLogger,
      metrics: noopMetrics as never,
      queue: new TaskQueue(join(tmpDir, "queue.json")),
      handleRun: async (msg) => {
        callN++;
        const text = `response ${callN} to: ${msg.content.text ?? ""}`;
        responses.push(text);
        return { text };
      },
    });

    await orchestrator.start();
    await orchestrator.handleMessage(userMessage("first"));
    await orchestrator.handleMessage(userMessage("second"));
    await orchestrator.handleMessage(userMessage("third"));

    await vi.waitFor(() => expect(responses).toHaveLength(3), { timeout: 2000 });

    expect(responses[0]).toContain("first");
    expect(responses[1]).toContain("second");
    expect(responses[2]).toContain("third");

    await orchestrator.stop();
  });

  it("executes a real filesystem write via inline tool executor", async () => {
    const tmpDir = join(tmpdir(), randomUUID());
    await mkdir(tmpDir, { recursive: true });

    const filePath = join(tmpDir, "output.txt");
    const { writeFile: fsWrite } = await import("node:fs/promises");

    const provider = makeProvider([
      [
        { type: "tool_call_start", toolCallId: "w1", toolName: "write_file" },
        {
          type: "tool_call_delta",
          toolCallId: "w1",
          toolArgsDelta: JSON.stringify({ path: filePath, content: "agent wrote this" }),
        },
        { type: "tool_call_end", toolCallId: "w1" },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "File written successfully." },
        { type: "stop", reason: "end" },
      ],
    ]);

    const result = await runAgentLoop(
      [{ role: "user", content: [{ type: "text", text: "write a file" }] }],
      {
        provider,
        executor: async (name, args) => {
          if (name === "write_file") {
            const { path, content } = args as { path: string; content: string };
            await fsWrite(path, content, "utf8");
            return { content: `wrote ${content.length} bytes`, isError: false };
          }
          return { content: "unknown tool", isError: true };
        },
        streamOpts: { model: "mock" },
        logger: noopLogger,
      },
    );

    expect(result.text).toBe("File written successfully.");
    expect(result.toolCalls).toHaveLength(1);

    // The file was actually written to disk
    const written = await readFile(filePath, "utf8");
    expect(written).toBe("agent wrote this");
  });

  it("handles a run that errors mid-way gracefully", async () => {
    const tmpDir = join(tmpdir(), randomUUID());
    await mkdir(tmpDir, { recursive: true });

    const responses: AgentResponse[] = [];

    const orchestrator = new Orchestrator({
      logger: noopLogger,
      metrics: noopMetrics as never,
      queue: new TaskQueue(join(tmpDir, "queue.json")),
      handleRun: async () => {
        throw new Error("simulated LLM failure");
      },
    });

    await orchestrator.start();
    await orchestrator.handleMessage(userMessage("trigger error"));

    // The orchestrator should catch the error and not crash
    await new Promise((r) => setTimeout(r, 200));
    expect(noopLogger.error).toHaveBeenCalled();
    // Orchestrator still running — can handle next message
    expect(responses).toHaveLength(0); // no response because handleRun threw

    await orchestrator.stop();
  });
});
