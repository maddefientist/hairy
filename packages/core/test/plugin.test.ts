import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { HairyClawPlugin, PluginContext } from "../src/plugin.js";
import { PluginRunner } from "../src/plugin.js";
import type { AgentResponse, HairyClawMessage, ToolCallRecord } from "../src/types.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const baseMessage = (text = "hello"): HairyClawMessage => ({
  id: randomUUID(),
  channelId: "c1",
  channelType: "cli",
  senderId: "u1",
  senderName: "User",
  content: { text },
  timestamp: new Date().toISOString(),
});

const baseCtx = (): PluginContext => ({
  traceId: "trace-1",
  channelType: "cli",
  channelId: "c1",
  senderId: "u1",
  state: new Map<string, unknown>(),
  logger,
});

const sampleResponse: AgentResponse = { text: "done" };

const noToolCalls: ToolCallRecord[] = [];

describe("PluginRunner", () => {
  it("plugin with no hooks is a no-op", async () => {
    const runner = new PluginRunner([{ name: "noop" }]);
    const ctx = baseCtx();

    const user = await runner.runOnUserMessage(baseMessage("x"), ctx);
    const beforeModel = await runner.runBeforeModel(
      [{ role: "user", content: [{ type: "text", text: "x" }] }],
      { model: "m" },
      ctx,
    );
    const afterModel = await runner.runAfterModel("ok", [], ctx);

    expect(user?.content.text).toBe("x");
    expect(beforeModel?.messages[0]?.content[0]?.text).toBe("x");
    expect(afterModel).toBe("ok");
  });

  it("onUserMessage can modify message text", async () => {
    const runner = new PluginRunner([
      {
        name: "uppercase",
        onUserMessage: async (msg) => ({
          ...msg,
          content: { ...msg.content, text: msg.content.text?.toUpperCase() },
        }),
      },
    ]);

    const result = await runner.runOnUserMessage(baseMessage("hello"), baseCtx());
    expect(result?.content.text).toBe("HELLO");
  });

  it("onUserMessage returning null blocks message", async () => {
    const runner = new PluginRunner([
      {
        name: "blocker",
        onUserMessage: async () => null,
      },
    ]);

    const result = await runner.runOnUserMessage(baseMessage("hello"), baseCtx());
    expect(result).toBeNull();
  });

  it("chains multiple plugins in priority order", async () => {
    const runner = new PluginRunner([
      {
        name: "second",
        priority: 20,
        onUserMessage: async (msg) => ({
          ...msg,
          content: { ...msg.content, text: `${msg.content.text}-second` },
        }),
      },
      {
        name: "first",
        priority: 10,
        onUserMessage: async (msg) => ({
          ...msg,
          content: { ...msg.content, text: `${msg.content.text}-first` },
        }),
      },
    ]);

    const result = await runner.runOnUserMessage(baseMessage("hello"), baseCtx());
    expect(result?.content.text).toBe("hello-first-second");
  });

  it("beforeModel can inject system prompt content", async () => {
    const runner = new PluginRunner([
      {
        name: "inject",
        beforeModel: async (messages, opts) => ({
          messages,
          opts: {
            ...opts,
            systemPrompt: `${opts.systemPrompt ?? ""} Be concise.`.trim(),
          },
        }),
      },
    ]);

    const result = await runner.runBeforeModel([], { model: "x", systemPrompt: "base" }, baseCtx());
    expect(result?.opts.systemPrompt).toBe("base Be concise.");
  });

  it("beforeModel returning null skips model call", async () => {
    const runner = new PluginRunner([
      {
        name: "maintenance",
        beforeModel: async () => null,
      },
    ]);

    const result = await runner.runBeforeModel([], { model: "x" }, baseCtx());
    expect(result).toBeNull();
  });

  it("afterModel can modify response text", async () => {
    const runner = new PluginRunner([
      {
        name: "suffix",
        afterModel: async (text) => `${text}!`,
      },
    ]);

    const result = await runner.runAfterModel("great", noToolCalls, baseCtx());
    expect(result).toBe("great!");
  });

  it("afterModel returning null triggers one retry in host loop", async () => {
    let attempts = 0;
    const runner = new PluginRunner([
      {
        name: "force-retry-once",
        afterModel: async (text) => {
          attempts += 1;
          if (attempts === 1) return null;
          return `${text} ok`;
        },
      },
    ]);

    const runWithSingleRetry = async (): Promise<{ result: string | null; attempts: number }> => {
      const ctx = baseCtx();
      let tries = 0;
      while (tries < 2) {
        tries += 1;
        const result = await runner.runAfterModel("answer", noToolCalls, ctx);
        if (result !== null) {
          return { result, attempts: tries };
        }
      }
      return { result: null, attempts: tries };
    };

    const outcome = await runWithSingleRetry();
    expect(outcome.result).toBe("answer ok");
    expect(outcome.attempts).toBe(2);
  });

  it("beforeTool can modify args", async () => {
    const runner = new PluginRunner([
      {
        name: "arg-transform",
        beforeTool: async (_name, args) => ({
          args: { ...(args as Record<string, unknown>), safe: true },
        }),
      },
    ]);

    const result = await runner.runBeforeTool("bash", { cmd: "ls" }, baseCtx());
    expect(result?.args).toEqual({ cmd: "ls", safe: true });
  });

  it("beforeTool returning null blocks tool call", async () => {
    const runner = new PluginRunner([
      {
        name: "deny",
        beforeTool: async () => null,
      },
    ]);

    const result = await runner.runBeforeTool("bash", { cmd: "rm" }, baseCtx());
    expect(result).toBeNull();
  });

  it("afterTool can modify result", async () => {
    const runner = new PluginRunner([
      {
        name: "decorate",
        afterTool: async (_tool, result, isError) => ({ result: `[${result}]`, isError }),
      },
    ]);

    const result = await runner.runAfterTool("read", "hello", false, baseCtx());
    expect(result.result).toBe("[hello]");
    expect(result.isError).toBe(false);
  });

  it("onToolError can provide fallback result", async () => {
    const runner = new PluginRunner([
      {
        name: "fallback",
        onToolError: async () => ({ result: "fallback result", isError: false }),
      },
    ]);

    const result = await runner.runOnToolError("read", new Error("disk"), baseCtx());
    expect(result).toEqual({ result: "fallback result", isError: false });
  });

  it("onModelError can provide fallback text", async () => {
    const runner = new PluginRunner([
      {
        name: "fallback",
        onModelError: async () => "fallback text",
      },
    ]);

    const result = await runner.runOnModelError(new Error("boom"), baseCtx());
    expect(result).toBe("fallback text");
  });

  it("beforeSend can suppress response", async () => {
    const runner = new PluginRunner([
      {
        name: "suppress",
        beforeSend: async () => null,
      },
    ]);

    const result = await runner.runBeforeSend(sampleResponse, baseCtx());
    expect(result).toBeNull();
  });

  it("beforeSend can modify response", async () => {
    const runner = new PluginRunner([
      {
        name: "append",
        beforeSend: async (response) => ({ ...response, text: `${response.text} ✅` }),
      },
    ]);

    const result = await runner.runBeforeSend({ text: "done" }, baseCtx());
    expect(result?.text).toBe("done ✅");
  });

  it("onRunStart and onRunEnd are called", async () => {
    const onRunStart = vi.fn(async () => {});
    const onRunEnd = vi.fn(async () => {});
    const runner = new PluginRunner([
      {
        name: "hooks",
        onRunStart,
        onRunEnd,
      },
    ]);

    const ctx = baseCtx();
    await runner.runOnRunStart(ctx);
    await runner.runOnRunEnd(ctx, undefined, undefined);

    expect(onRunStart).toHaveBeenCalledTimes(1);
    expect(onRunEnd).toHaveBeenCalledTimes(1);
  });

  it("shares state across hooks in a single run", async () => {
    const runner = new PluginRunner([
      {
        name: "stateful",
        onRunStart: async (ctx) => {
          ctx.state.set("counter", 1);
        },
        beforeModel: async (messages, opts, ctx) => {
          const count = (ctx.state.get("counter") as number) ?? 0;
          ctx.state.set("counter", count + 1);
          return { messages, opts };
        },
      },
    ]);

    const ctx = baseCtx();
    await runner.runOnRunStart(ctx);
    await runner.runBeforeModel([], { model: "x" }, ctx);

    expect(ctx.state.get("counter")).toBe(2);
  });

  it("plugin errors are logged and chain continues", async () => {
    const runner = new PluginRunner([
      {
        name: "bad",
        onUserMessage: async () => {
          throw new Error("nope");
        },
      },
      {
        name: "good",
        onUserMessage: async (msg) => ({
          ...msg,
          content: { ...msg.content, text: "recovered" },
        }),
      },
    ]);

    const result = await runner.runOnUserMessage(baseMessage("x"), baseCtx());

    expect(result?.content.text).toBe("recovered");
    expect(logger.error).toHaveBeenCalled();
  });
});
