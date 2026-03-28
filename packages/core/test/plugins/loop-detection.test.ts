import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../src/plugin.js";
import { createLoopDetectionPlugin } from "../../src/plugins/loop-detection.js";
import type { ToolCallRecord } from "../../src/types.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const ctx = (traceId = "trace-1"): PluginContext => ({
  traceId,
  channelType: "cli",
  channelId: "channel-1",
  senderId: "user-1",
  state: new Map<string, unknown>(),
  logger,
});

const toolCall = (toolName: string, args: Record<string, unknown> = {}): ToolCallRecord => ({
  toolName,
  args,
  result: "ok",
  isError: false,
  durationMs: 10,
});

describe("createLoopDetectionPlugin", () => {
  it("no tool calls passes through unchanged", async () => {
    const plugin = createLoopDetectionPlugin();
    const result = await plugin.afterModel?.("hello", [], ctx());
    expect(result).toBe("hello");
  });

  it("different tool calls each time produce no warning", async () => {
    const plugin = createLoopDetectionPlugin({ warnThreshold: 3, hardLimit: 5 });
    const c = ctx();

    for (let i = 0; i < 10; i++) {
      const calls = [toolCall("tool_a", { i })];
      const result = await plugin.afterModel?.(`response-${i}`, calls, c);
      expect(result).toBe(`response-${i}`);
    }
  });

  it("same tool calls 3 times triggers warning", async () => {
    const plugin = createLoopDetectionPlugin({ warnThreshold: 3, hardLimit: 5 });
    const c = ctx();
    const calls = [toolCall("tool_a", { x: 1 })];

    // First two — no warning
    const r1 = await plugin.afterModel?.("r1", calls, c);
    expect(r1).toBe("r1");
    const r2 = await plugin.afterModel?.("r2", calls, c);
    expect(r2).toBe("r2");

    // Third — warning injected
    const r3 = await plugin.afterModel?.("r3", calls, c);
    expect(r3).toContain("r3");
    expect(r3).toContain("[LOOP DETECTED]");
  });

  it("same tool calls 5 times returns null (hard stop)", async () => {
    const plugin = createLoopDetectionPlugin({ warnThreshold: 3, hardLimit: 5 });
    const c = ctx();
    const calls = [toolCall("tool_a", { x: 1 })];

    // Calls 1-4
    for (let i = 0; i < 4; i++) {
      await plugin.afterModel?.(`r${i}`, calls, c);
    }

    // Call 5 — hard stop
    const r5 = await plugin.afterModel?.("r5", calls, c);
    expect(r5).toBeNull();
    expect(c.state.get("loopDetection.forcedStop")).toBe(true);
    expect(c.state.get("loopDetection.filteredResponse")).toContain("[HARD STOP]");
  });

  it("warning only fires once per unique hash", async () => {
    const plugin = createLoopDetectionPlugin({ warnThreshold: 3, hardLimit: 10 });
    const c = ctx();
    const calls = [toolCall("tool_a", { x: 1 })];

    // Calls 1-2: no warning
    await plugin.afterModel?.("r1", calls, c);
    await plugin.afterModel?.("r2", calls, c);

    // Call 3: warning
    const r3 = await plugin.afterModel?.("r3", calls, c);
    expect(r3).toContain("[LOOP DETECTED]");

    // Call 4: no warning (already warned for this hash)
    const r4 = await plugin.afterModel?.("r4", calls, c);
    expect(r4).toBe("r4");
  });

  it("LRU eviction works when maxTrackedTraces exceeded", async () => {
    const plugin = createLoopDetectionPlugin({
      warnThreshold: 2,
      hardLimit: 5,
      maxTrackedTraces: 3,
    });

    // Fill 3 traces
    for (let i = 0; i < 3; i++) {
      const c = ctx(`trace-${i}`);
      const calls = [toolCall("tool_a", { x: 1 })];
      await plugin.afterModel?.("r", calls, c);
    }

    // Add a 4th trace — should evict trace-0
    const c4 = ctx("trace-3");
    const calls4 = [toolCall("tool_a", { x: 1 })];
    await plugin.afterModel?.("r", calls4, c4);

    // trace-0 should be evicted, so its count should be reset
    // A new call on trace-0 starts fresh — no warning at count 1
    const c0 = ctx("trace-0");
    const calls0 = [toolCall("tool_a", { x: 1 })];
    const result = await plugin.afterModel?.("fresh", calls0, c0);
    expect(result).toBe("fresh"); // No warning — count is only 1 now
  });

  it("onRunEnd cleans up traceId state", async () => {
    const plugin = createLoopDetectionPlugin({ warnThreshold: 2, hardLimit: 5 });
    const c = ctx();
    const calls = [toolCall("tool_a", { x: 1 })];

    // Build up count
    await plugin.afterModel?.("r1", calls, c);

    // Clean up
    await plugin.onRunEnd?.(c, undefined, undefined);

    // After cleanup, same trace starts fresh — count 1, no warning
    const c2 = ctx(); // same traceId
    const result = await plugin.afterModel?.("fresh", calls, c2);
    expect(result).toBe("fresh");
  });

  it("different traceIds tracked independently", async () => {
    const plugin = createLoopDetectionPlugin({ warnThreshold: 2, hardLimit: 5 });
    const calls = [toolCall("tool_a", { x: 1 })];

    // trace-a: 2 calls → warning
    const ca = ctx("trace-a");
    await plugin.afterModel?.("r1", calls, ca);
    const ra2 = await plugin.afterModel?.("r2", calls, ca);
    expect(ra2).toContain("[LOOP DETECTED]");

    // trace-b: only 1 call → no warning
    const cb = ctx("trace-b");
    const rb1 = await plugin.afterModel?.("r1", calls, cb);
    expect(rb1).toBe("r1");
  });
});
