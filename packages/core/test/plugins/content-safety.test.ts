import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../src/plugin.js";
import { createContentSafetyPlugin } from "../../src/plugins/content-safety.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const makeCtx = (): PluginContext => ({
  traceId: "trace-1",
  channelType: "cli",
  channelId: "channel-1",
  senderId: "user-1",
  state: new Map<string, unknown>(),
  logger,
});

afterEach(() => {
  process.env.TEST_SECRET = undefined;
});

describe("createContentSafetyPlugin", () => {
  it("clean response passes through", async () => {
    const plugin = createContentSafetyPlugin();
    const ctx = makeCtx();

    const result = await plugin.afterModel?.("Hello, this is safe.", [], ctx);

    expect(result).toBe("Hello, this is safe.");
    expect(ctx.state.get("contentSafety.retry")).toBeUndefined();
  });

  it("blocked pattern triggers filtering", async () => {
    const plugin = createContentSafetyPlugin({ blockedPatterns: [/password\s*=\s*/i] });
    const ctx = makeCtx();

    const result = await plugin.afterModel?.("password = hunter2", [], ctx);

    expect(result).toBeNull();
    expect(ctx.state.get("contentSafety.filteredResponse")).toBe(
      "I've filtered my response for safety. Let me try again differently.",
    );
  });

  it("api key pattern is detected and blocked", async () => {
    const plugin = createContentSafetyPlugin();
    const ctx = makeCtx();

    const result = await plugin.afterModel?.("Here is key sk-abc1234567890", [], ctx);

    expect(result).toBeNull();
    expect(String(ctx.state.get("contentSafety.reason"))).toContain("blocked pattern matched");
  });

  it("env var value leak is blocked", async () => {
    process.env.TEST_SECRET = "super-secret-value";
    const plugin = createContentSafetyPlugin({ protectEnvVars: ["TEST_SECRET"] });
    const ctx = makeCtx();

    const result = await plugin.afterModel?.("Token: super-secret-value", [], ctx);

    expect(result).toBeNull();
    expect(String(ctx.state.get("contentSafety.reason"))).toContain("TEST_SECRET");
  });

  it("long response is truncated", async () => {
    const plugin = createContentSafetyPlugin({ maxResponseLength: 40 });
    const ctx = makeCtx();

    const result = await plugin.afterModel?.("A".repeat(120), [], ctx);

    expect(result?.includes("[truncated — full response available via /expand]")).toBe(true);
    expect((result ?? "").length).toBeLessThanOrEqual(70);
  });

  it("custom check is called", async () => {
    const customCheck = vi.fn(() => ({ safe: true }));
    const plugin = createContentSafetyPlugin({ customCheck });

    await plugin.afterModel?.("safe content", [], makeCtx());

    expect(customCheck).toHaveBeenCalledWith("safe content");
  });

  it("custom check can block response", async () => {
    const customCheck = vi.fn(() => ({ safe: false, reason: "policy violation" }));
    const plugin = createContentSafetyPlugin({ customCheck });
    const ctx = makeCtx();

    const result = await plugin.afterModel?.("content", [], ctx);

    expect(result).toBeNull();
    expect(ctx.state.get("contentSafety.reason")).toBe("policy violation");
  });

  it("unsafe content marks retry flag", async () => {
    const plugin = createContentSafetyPlugin({ blockedPatterns: [/doxx/i] });
    const ctx = makeCtx();

    const result = await plugin.afterModel?.("Please doxx this person", [], ctx);

    expect(result).toBeNull();
    expect(ctx.state.get("contentSafety.retry")).toBe(true);
  });
});
