import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentLoopEvent,
  type AgentLoopMessage,
  type AgentLoopStreamOptions,
  runAgentLoop,
} from "../src/agent-loop.js";
import { Orchestrator } from "../src/orchestrator.js";
import { PluginRunner } from "../src/plugin.js";
import { TaskQueue } from "../src/task-queue.js";
import type { AgentResponse, HairyClawMessage } from "../src/types.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const metrics = {
  increment: vi.fn(),
  gauge: vi.fn(),
  getAll: vi.fn(() => ({})),
};

const message = (text: string): HairyClawMessage => ({
  id: randomUUID(),
  channelId: "chat-1",
  channelType: "cli",
  senderId: "user-1",
  senderName: "User",
  content: { text },
  timestamp: new Date().toISOString(),
});

const queuePath = (): string => join(tmpdir(), `hairy-orchestrator-${randomUUID()}.json`);

const makeProvider = (turns: AgentLoopEvent[][]) => {
  let call = 0;
  return {
    stream: async function* (
      _messages: AgentLoopMessage[],
      _opts: AgentLoopStreamOptions,
    ): AsyncIterable<AgentLoopEvent> {
      const events = turns[call] ?? [{ type: "stop", reason: "end" }];
      call += 1;
      for (const event of events) {
        yield event;
      }
    },
  };
};

describe("plugin wiring through orchestrator + agent loop", () => {
  it("onUserMessage can block a message", async () => {
    const plugins = new PluginRunner([
      {
        name: "block-all",
        onUserMessage: async () => null,
      },
    ]);

    const handleRun = vi.fn(async (): Promise<AgentResponse> => ({ text: "should not run" }));

    const orchestrator = new Orchestrator({
      logger,
      metrics: metrics as never,
      queue: new TaskQueue(queuePath()),
      plugins,
      handleRun,
    });

    await orchestrator.start();
    await orchestrator.handleMessage(message("hello"));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handleRun).not.toHaveBeenCalled();
    await orchestrator.stop();
  });

  it("beforeModel can modify system prompt", async () => {
    let seenPrompt = "";
    const provider = {
      stream: async function* (
        _messages: AgentLoopMessage[],
        opts: AgentLoopStreamOptions,
      ): AsyncIterable<AgentLoopEvent> {
        seenPrompt = opts.systemPrompt ?? "";
        yield { type: "text_delta", text: "ok" };
        yield { type: "stop", reason: "end" };
      },
    };

    const plugins = new PluginRunner([
      {
        name: "injector",
        beforeModel: async (messages, opts) => ({
          messages,
          opts: {
            ...opts,
            systemPrompt: `${opts.systemPrompt ?? ""} injected`.trim(),
          },
        }),
      },
    ]);

    const responses: AgentResponse[] = [];

    const orchestrator = new Orchestrator({
      logger,
      metrics: metrics as never,
      queue: new TaskQueue(queuePath()),
      plugins,
      handleRun: async (msg, _traceId, pluginCtx) => {
        const result = await runAgentLoop(
          [{ role: "user", content: [{ type: "text", text: msg.content.text ?? "" }] }],
          {
            provider,
            executor: vi.fn(async () => ({ content: "", isError: false })),
            streamOpts: { model: "mock", systemPrompt: "base" },
            logger,
            plugins,
            pluginCtx,
          },
        );
        const response = { text: result.text };
        responses.push(response);
        return response;
      },
    });

    await orchestrator.start();
    await orchestrator.handleMessage(message("prompt test"));

    await vi.waitFor(() => expect(responses).toHaveLength(1), { timeout: 1_000 });
    expect(seenPrompt).toContain("injected");
    await orchestrator.stop();
  });

  it("beforeTool can block a tool call", async () => {
    const provider = makeProvider([
      [
        { type: "tool_call_start", toolCallId: "c1", toolName: "read" },
        { type: "tool_call_delta", toolCallId: "c1", toolArgsDelta: '{"path":"a"}' },
        { type: "tool_call_end", toolCallId: "c1" },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "stop", reason: "end" },
      ],
    ]);

    const plugins = new PluginRunner([
      {
        name: "tool-blocker",
        beforeTool: async () => null,
      },
    ]);

    const executor = vi.fn(async () => ({ content: "tool output", isError: false }));
    const toolResults: Array<{ isError: boolean; result: unknown }> = [];

    const orchestrator = new Orchestrator({
      logger,
      metrics: metrics as never,
      queue: new TaskQueue(queuePath()),
      plugins,
      handleRun: async (msg, _traceId, pluginCtx) => {
        const result = await runAgentLoop(
          [{ role: "user", content: [{ type: "text", text: msg.content.text ?? "" }] }],
          {
            provider,
            executor,
            streamOpts: { model: "mock" },
            logger,
            plugins,
            pluginCtx,
          },
        );
        toolResults.push({
          isError: result.toolCalls[0]?.isError ?? false,
          result: result.toolCalls[0]?.result,
        });
        return { text: result.text };
      },
    });

    await orchestrator.start();
    await orchestrator.handleMessage(message("block tool"));

    await vi.waitFor(() => expect(toolResults).toHaveLength(1), { timeout: 1_000 });
    expect(executor).not.toHaveBeenCalled();
    expect(toolResults[0]?.isError).toBe(true);
    expect(String(toolResults[0]?.result)).toContain("blocked by plugin");
    await orchestrator.stop();
  });

  it("beforeSend can modify final response", async () => {
    const tmp = join(tmpdir(), `hairy-orch-${randomUUID()}`);
    await mkdir(tmp, { recursive: true });

    const plugins = new PluginRunner([
      {
        name: "append",
        beforeSend: async (response) => ({ ...response, text: `${response.text} ✅` }),
      },
    ]);

    const seen: string[] = [];

    const orchestrator = new Orchestrator({
      logger,
      metrics: metrics as never,
      queue: new TaskQueue(join(tmp, "queue.json")),
      plugins,
      handleRun: async (_msg, _traceId, pluginCtx) => {
        const response = { text: "base" };
        const final = await plugins.runBeforeSend(response, pluginCtx);
        const out = final ?? response;
        seen.push(out.text);
        return out;
      },
    });

    await orchestrator.start();
    await orchestrator.handleMessage(message("modify send"));

    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 1_000 });
    expect(seen[0]).toBe("base ✅");
    await orchestrator.stop();
  });

  it("onRunStart and onRunEnd receive same traceId", async () => {
    const startTraceIds: string[] = [];
    const endTraceIds: string[] = [];

    const plugins = new PluginRunner([
      {
        name: "lifecycle",
        onRunStart: async (ctx) => {
          startTraceIds.push(ctx.traceId);
        },
        onRunEnd: async (ctx) => {
          endTraceIds.push(ctx.traceId);
        },
      },
    ]);

    const orchestrator = new Orchestrator({
      logger,
      metrics: metrics as never,
      queue: new TaskQueue(queuePath()),
      plugins,
      handleRun: async () => ({ text: "ok" }),
    });

    await orchestrator.start();
    await orchestrator.handleMessage(message("trace"));

    await vi.waitFor(() => expect(endTraceIds).toHaveLength(1), { timeout: 1_000 });

    expect(startTraceIds).toHaveLength(1);
    expect(startTraceIds[0]).toBe(endTraceIds[0]);
    expect(startTraceIds[0]?.length).toBeGreaterThan(0);
    await orchestrator.stop();
  });
});
