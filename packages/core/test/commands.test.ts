import { describe, expect, it, vi } from "vitest";
import { type CommandContext, CommandRouter, type CommandRuntime } from "../src/commands.js";

const makeRuntime = (): CommandRuntime & { model: string; clearCalls: number } => {
  const models = new Set(["anthropic/claude-sonnet-4", "openrouter/qwen-3-32b"]);
  const runtime = {
    model: "anthropic/claude-sonnet-4",
    clearCalls: 0,
    getModelInfo() {
      return {
        primary: runtime.model,
        fallbacks: ["openrouter/qwen-3-32b"],
      };
    },
    setPrimaryModel(model: string) {
      if (!models.has(model)) return false;
      runtime.model = model;
      return true;
    },
    getProviderHealth() {
      return new Map([
        [
          "anthropic:primary",
          {
            errorCount: 1,
            consecutiveErrors: 0,
            failureCounts: { timeout: 1, rate_limit: 0, auth: 0, server: 0 },
          },
        ],
      ]);
    },
    clearCooldowns() {
      runtime.clearCalls += 1;
    },
    getUptime() {
      return 3661;
    },
    getMetrics() {
      return { messages_in: 10, messages_out: 9 };
    },
    getQueueStats() {
      return { pending: 2, deadLetters: 1 };
    },
  };

  return runtime;
};

const makeCtx = (runtime: CommandRuntime): CommandContext => ({
  channelType: "telegram",
  channelId: "chat-1",
  senderId: "user-1",
  runtime,
});

describe("CommandRouter", () => {
  it("/help returns list of commands", async () => {
    const router = new CommandRouter();
    const result = await router.route("/help", makeCtx(makeRuntime()));

    expect(result).toContain("/help");
    expect(result).toContain("/status");
  });

  it("/status returns formatted status", async () => {
    const router = new CommandRouter();
    const result = await router.route("/status", makeCtx(makeRuntime()));

    expect(result).toContain("Uptime");
    expect(result).toContain("Queue");
    expect(result).toContain("Model");
  });

  it("unknown /command returns null", async () => {
    const router = new CommandRouter();
    const result = await router.route("/unknown", makeCtx(makeRuntime()));
    expect(result).toBeNull();
  });

  it("non-command returns null", async () => {
    const router = new CommandRouter();
    const result = await router.route("hello there", makeCtx(makeRuntime()));
    expect(result).toBeNull();
  });

  it("/model with no args shows current model", async () => {
    const router = new CommandRouter();
    const result = await router.route("/model", makeCtx(makeRuntime()));

    expect(result).toContain("Primary model");
    expect(result).toContain("Fallbacks");
  });

  it("/model <name> switches model", async () => {
    const runtime = makeRuntime();
    const router = new CommandRouter();

    const result = await router.route("/model openrouter/qwen-3-32b", makeCtx(runtime));

    expect(result).toContain("switched");
    expect(runtime.model).toBe("openrouter/qwen-3-32b");
  });

  it("/health shows provider health", async () => {
    const router = new CommandRouter();
    const result = await router.route("/health", makeCtx(makeRuntime()));

    expect(result).toContain("Provider health");
    expect(result).toContain("anthropic:primary");
  });

  it("/clear clears cooldowns", async () => {
    const runtime = makeRuntime();
    const router = new CommandRouter();

    const result = await router.route("/clear", makeCtx(runtime));

    expect(result).toContain("Cleared");
    expect(runtime.clearCalls).toBe(1);
  });

  it("alias routing works (/m → /model)", async () => {
    const router = new CommandRouter();
    const result = await router.route("/m", makeCtx(makeRuntime()));

    expect(result).toContain("Primary model");
  });

  it("command args are parsed correctly", async () => {
    const router = new CommandRouter();
    const spy = vi.fn(async (args: string) => `args=${args}`);

    router.register({
      name: "echo",
      description: "echo args",
      handler: async (args) => spy(args),
    });

    const result = await router.route("/echo one two three", makeCtx(makeRuntime()));

    expect(spy).toHaveBeenCalledWith("one two three");
    expect(result).toBe("args=one two three");
  });
});
