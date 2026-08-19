import { describe, expect, it, vi } from "vitest";
import { type CommandContext, CommandRouter, type CommandRuntime } from "../src/commands.js";

const makeRuntime = (
  opts: { operators?: string[] } = {},
): CommandRuntime & { model: string; clearCalls: number } => {
  const models = new Set(["anthropic/claude-sonnet-4", "openrouter/qwen-3-32b"]);
  // Channel-scoped operator ids, e.g. "telegram:user-1". Tests that pass a
  // bare id ("user-1") continue to work by scoping to the default "telegram"
  // channel used in makeCtx, unless a fully-scoped id is provided.
  const operators = new Set(
    (opts.operators ?? ["user-1"]).map((id) => (id.includes(":") ? id : `telegram:${id}`)),
  );
  const runtime = {
    model: "anthropic/claude-sonnet-4",
    clearCalls: 0,
    isOperator(channelType: string, senderId: string) {
      return operators.has(`${channelType}:${senderId}`);
    },
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

  it("/debug is operator-only", async () => {
    const runtime = makeRuntime({ operators: [] });
    runtime.getDebugSnapshot = () => ({ modelSelection: { configuredPrimaryId: "safe" } });
    const router = new CommandRouter();

    const denied = await router.route("/debug", makeCtx(runtime));
    expect(denied).toContain("Not authorized");

    const allowedRuntime = makeRuntime({ operators: ["user-1"] });
    allowedRuntime.getDebugSnapshot = () => ({ modelSelection: { configuredPrimaryId: "safe" } });
    const allowed = await router.route("/debug", makeCtx(allowedRuntime));
    expect(allowed).toContain("Debug snapshot");
    expect(allowed).toContain("configuredPrimaryId");
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

  describe("operator allowlist gating", () => {
    it("/clear is denied for a non-operator sender", async () => {
      const runtime = makeRuntime({ operators: ["user-1"] });
      const router = new CommandRouter();

      const ctx = makeCtx(runtime);
      const result = await router.route("/clear", { ...ctx, senderId: "user-2" });

      expect(result).toContain("Not authorized");
      expect(runtime.clearCalls).toBe(0);
    });

    it("/clear is denied for everyone when the allowlist is empty", async () => {
      const runtime = makeRuntime({ operators: [] });
      const router = new CommandRouter();

      const result = await router.route("/clear", makeCtx(runtime));

      expect(result).toContain("Not authorized");
      expect(runtime.clearCalls).toBe(0);
    });

    it("/clear succeeds for an authorized operator", async () => {
      const runtime = makeRuntime({ operators: ["user-1"] });
      const router = new CommandRouter();

      const result = await router.route("/clear", makeCtx(runtime));

      expect(result).toContain("Cleared");
      expect(runtime.clearCalls).toBe(1);
    });

    it("/update is denied for a non-operator sender", async () => {
      const runtime = makeRuntime({ operators: ["user-1"] }) as CommandRuntime;
      (runtime as unknown as { selfUpdate: CommandRuntime["selfUpdate"] }).selfUpdate =
        async () => ({
          success: true,
          previousVersion: "a",
          currentVersion: "b",
          changes: "",
        });
      const router = new CommandRouter();

      const ctx = makeCtx(runtime);
      const result = await router.route("/update", { ...ctx, senderId: "user-2" });

      expect(result).toContain("Not authorized");
    });

    it("/approve is denied for non-operators and explicitly unimplemented for operators", async () => {
      const runtime = makeRuntime({ operators: ["user-1"] });
      const router = new CommandRouter();
      const ctx = makeCtx(runtime);

      const denied = await router.route("/approve", { ...ctx, senderId: "user-2" });
      expect(denied).toContain("Not authorized");

      const asOperator = await router.route("/approve", ctx);
      expect(asOperator).toContain("not available in this release");
    });

    it("a runtime.isOperator that throws is treated as denied (fail closed)", async () => {
      const runtime = makeRuntime({ operators: ["user-1"] });
      runtime.isOperator = () => {
        throw new Error("boom");
      };
      const router = new CommandRouter();

      const result = await router.route("/clear", makeCtx(runtime));
      expect(result).toContain("Not authorized");
    });

    it("/model list and /model status remain available without operator access", async () => {
      const runtime = makeRuntime({ operators: [] }) as CommandRuntime & {
        listModelCatalog: () => Array<{ id: string; label: string; available: boolean }>;
      };
      runtime.listModelCatalog = () => [
        { id: "ollama/kimi-k2.6:cloud", label: "Kimi", available: true },
        {
          id: "supergrok/grok-4.6",
          label: "Grok 4.6",
          available: false,
          unavailableReason: "not provisioned",
        },
      ];
      const router = new CommandRouter();
      const ctx = makeCtx(runtime);

      const list = await router.route("/model list", ctx);
      expect(list).toContain("ollama/kimi-k2.6:cloud");
      expect(list).toContain("unavailable");

      const status = await router.route("/model status", ctx);
      expect(status).toContain("Primary model");
    });

    it("/model use is denied for a non-operator sender even though list/status are open", async () => {
      const runtime = makeRuntime({ operators: ["user-1"] }) as CommandRuntime & {
        useModel: CommandRuntime["useModel"];
      };
      const useModel = vi.fn(async () => ({ ok: true, message: "switched" }));
      runtime.useModel = useModel;
      const router = new CommandRouter();
      const ctx = makeCtx(runtime);

      const result = await router.route("/model use openrouter/z-ai/glm-5.2", {
        ...ctx,
        senderId: "user-2",
      });

      expect(result).toContain("Not authorized");
      expect(useModel).not.toHaveBeenCalled();
    });

    it("/model use succeeds for an authorized operator and calls runtime.useModel", async () => {
      const runtime = makeRuntime({ operators: ["user-1"] }) as CommandRuntime & {
        useModel: CommandRuntime["useModel"];
      };
      const useModel = vi.fn(async (id: string, actor: string) => ({
        ok: true,
        message: `primary switched to ${id} by ${actor}`,
      }));
      runtime.useModel = useModel;
      const router = new CommandRouter();

      const result = await router.route("/model use openrouter/z-ai/glm-5.2", makeCtx(runtime));

      expect(useModel).toHaveBeenCalledWith("openrouter/z-ai/glm-5.2", "user-1");
      expect(result).toContain("openrouter/z-ai/glm-5.2");
    });

    it("/model rollback requires operator access", async () => {
      const runtime = makeRuntime({ operators: [] }) as CommandRuntime & {
        rollbackModel: CommandRuntime["rollbackModel"];
      };
      const rollbackModel = vi.fn(async () => ({ ok: true, message: "rolled back" }));
      runtime.rollbackModel = rollbackModel;
      const router = new CommandRouter();

      const result = await router.route("/model rollback", makeCtx(runtime));

      expect(result).toContain("Not authorized");
      expect(rollbackModel).not.toHaveBeenCalled();
    });
  });

  describe("channel-scoped operator authorization (webhook impersonation prevention)", () => {
    it("isOperator is called with both channelType and senderId, never senderId alone", async () => {
      const runtime = makeRuntime({ operators: ["telegram:user-1"] });
      const isOperatorSpy = vi.spyOn(runtime, "isOperator");
      const router = new CommandRouter();

      await router.route("/clear", makeCtx(runtime));

      expect(isOperatorSpy).toHaveBeenCalledWith("telegram", "user-1");
    });

    it("a sender id that is an operator on one channel is NOT authorized on a different channel", async () => {
      const runtime = makeRuntime({ operators: ["telegram:user-1"] });
      const router = new CommandRouter();
      const ctx = makeCtx(runtime);

      // Same senderId, but arriving over "webhook" instead of "telegram" —
      // must not be treated as the telegram-scoped operator.
      const result = await router.route("/clear", { ...ctx, channelType: "webhook" });

      expect(result).toContain("Not authorized");
      expect(runtime.clearCalls).toBe(0);
    });

    it("a runtime that rejects the webhook channel outright denies mutating commands even if the allowlist would otherwise match", async () => {
      const runtime = makeRuntime({ operators: ["webhook:webhook-user"] });
      runtime.isOperator = (channelType: string, senderId: string) => {
        if (channelType === "webhook") return false;
        return senderId === "webhook-user";
      };
      const router = new CommandRouter();

      const result = await router.route("/clear", {
        channelType: "webhook",
        channelId: "hook-1",
        senderId: "webhook-user",
        runtime,
      });

      expect(result).toContain("Not authorized");
      expect(runtime.clearCalls).toBe(0);
    });

    it("scoped operator id succeeds for the correct channel", async () => {
      const runtime = makeRuntime({ operators: ["telegram:user-1"] });
      const router = new CommandRouter();

      const result = await router.route("/clear", makeCtx(runtime));

      expect(result).toContain("Cleared");
      expect(runtime.clearCalls).toBe(1);
    });
  });

  describe("role-aware model commands (brain/hands)", () => {
    it("/model brain reports feature disabled when role-aware selection is not wired", async () => {
      const runtime = makeRuntime();
      const router = new CommandRouter();

      const result = await router.route("/model brain", makeCtx(runtime));
      expect(result).toContain("not enabled");
    });

    it("/model brain status and /model hands status are open without operator access", async () => {
      const runtime = makeRuntime({ operators: [] }) as CommandRuntime & {
        isRoleAwareModelSelectionEnabled: () => boolean;
        getModelStatusForRole: (role: "brain" | "hands") => Record<string, unknown>;
      };
      runtime.isRoleAwareModelSelectionEnabled = () => true;
      const statusFor = (role: "brain" | "hands") => ({
        role,
        configuredPrimaryId:
          role === "brain" ? "ollama/glm-5.2:cloud" : "ollama/deepseek-v4-pro:cloud",
        configuredFallbackIds: [],
        resolvedChain: [role === "brain" ? "ollama/glm-5.2:cloud" : "ollama/deepseek-v4-pro:cloud"],
        resolvedWarnings: [],
        lastSuccessfulModel: undefined,
        lastSuccessLatencyMs: undefined,
        updatedAt: Date.now(),
        updatedBy: "default",
        circuits: {},
        rateLimits: {},
      });
      runtime.getModelStatusForRole = statusFor as never;
      const router = new CommandRouter();
      const ctx = makeCtx(runtime);

      const brain = await router.route("/model brain status", ctx);
      expect(brain).toContain("Role: brain");
      expect(brain).toContain("ollama/glm-5.2:cloud");

      const hands = await router.route("/model hands", ctx);
      expect(hands).toContain("Role: hands");
      expect(hands).toContain("ollama/deepseek-v4-pro:cloud");
    });

    it("/model hands use requires operator access and calls useModelForRole with the role", async () => {
      const runtime = makeRuntime({ operators: ["user-1"] }) as CommandRuntime & {
        isRoleAwareModelSelectionEnabled: () => boolean;
        useModelForRole: CommandRuntime["useModelForRole"];
      };
      runtime.isRoleAwareModelSelectionEnabled = () => true;
      const useModelForRole = vi.fn(async (role: string, id: string, actor: string) => ({
        ok: true,
        message: `${role} primary switched to ${id} by ${actor}`,
      }));
      runtime.useModelForRole = useModelForRole as never;
      const router = new CommandRouter();
      const ctx = makeCtx(runtime);

      const denied = await router.route("/model hands use ollama/deepseek-v4-pro:cloud", {
        ...ctx,
        senderId: "user-2",
      });
      expect(denied).toContain("Not authorized");
      expect(useModelForRole).not.toHaveBeenCalled();

      const result = await router.route("/model hands use ollama/deepseek-v4-pro:cloud", ctx);
      expect(useModelForRole).toHaveBeenCalledWith(
        "hands",
        "ollama/deepseek-v4-pro:cloud",
        "user-1",
      );
      expect(result).toContain("ollama/deepseek-v4-pro:cloud");
    });

    it("/model brain fallback and /model hands fallback are independent role calls", async () => {
      const runtime = makeRuntime({ operators: ["user-1"] }) as CommandRuntime & {
        isRoleAwareModelSelectionEnabled: () => boolean;
        setModelFallbacksForRole: CommandRuntime["setModelFallbacksForRole"];
      };
      runtime.isRoleAwareModelSelectionEnabled = () => true;
      const setModelFallbacksForRole = vi.fn(async (role: string, ids: string[]) => ({
        ok: true,
        message: `${role} fallbacks set to ${ids.join(",")}`,
      }));
      runtime.setModelFallbacksForRole = setModelFallbacksForRole as never;
      const router = new CommandRouter();
      const ctx = makeCtx(runtime);

      await router.route("/model brain fallback ollama/glm-5.2:cloud", ctx);
      await router.route("/model hands fallback ollama/deepseek-v4-flash:cloud", ctx);

      expect(setModelFallbacksForRole).toHaveBeenCalledWith(
        "brain",
        ["ollama/glm-5.2:cloud"],
        "user-1",
      );
      expect(setModelFallbacksForRole).toHaveBeenCalledWith(
        "hands",
        ["ollama/deepseek-v4-flash:cloud"],
        "user-1",
      );
    });

    it("/model hands test and /model hands rollback require operator access", async () => {
      const runtime = makeRuntime({ operators: [] }) as CommandRuntime & {
        isRoleAwareModelSelectionEnabled: () => boolean;
        testModelForRole: CommandRuntime["testModelForRole"];
        rollbackModelForRole: CommandRuntime["rollbackModelForRole"];
      };
      runtime.isRoleAwareModelSelectionEnabled = () => true;
      const testModelForRole = vi.fn(async () => ({ ok: true, message: "canary ok" }));
      const rollbackModelForRole = vi.fn(async () => ({ ok: true, message: "rolled back" }));
      runtime.testModelForRole = testModelForRole as never;
      runtime.rollbackModelForRole = rollbackModelForRole as never;
      const router = new CommandRouter();
      const ctx = makeCtx(runtime);

      const testResult = await router.route("/model hands test ollama/deepseek-v4-pro:cloud", ctx);
      expect(testResult).toContain("Not authorized");
      expect(testModelForRole).not.toHaveBeenCalled();

      const rollbackResult = await router.route("/model hands rollback", ctx);
      expect(rollbackResult).toContain("Not authorized");
      expect(rollbackModelForRole).not.toHaveBeenCalled();
    });

    it("legacy /model use remains a working unified/brain alias unaffected by role-aware wiring", async () => {
      const runtime = makeRuntime({ operators: ["user-1"] }) as CommandRuntime & {
        useModel: CommandRuntime["useModel"];
        isRoleAwareModelSelectionEnabled: () => boolean;
        useModelForRole: CommandRuntime["useModelForRole"];
      };
      runtime.isRoleAwareModelSelectionEnabled = () => true;
      const useModel = vi.fn(async (id: string, actor: string) => ({
        ok: true,
        message: `brain-alias switched to ${id} by ${actor}`,
      }));
      const useModelForRole = vi.fn();
      runtime.useModel = useModel;
      runtime.useModelForRole = useModelForRole as never;
      const router = new CommandRouter();

      const result = await router.route("/model use openrouter/z-ai/glm-5.2", makeCtx(runtime));

      expect(useModel).toHaveBeenCalledWith("openrouter/z-ai/glm-5.2", "user-1");
      expect(useModelForRole).not.toHaveBeenCalled();
      expect(result).toContain("brain-alias switched to openrouter/z-ai/glm-5.2");
    });
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
