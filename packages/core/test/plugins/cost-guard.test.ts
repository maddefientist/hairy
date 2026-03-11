import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../src/plugin.js";
import { createCostGuardPlugin } from "../../src/plugins/cost-guard.js";
import type { RunResult } from "../../src/types.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const ctx = (): PluginContext => ({
  traceId: "trace-1",
  channelType: "cli",
  channelId: "channel-1",
  senderId: "user-1",
  state: new Map<string, unknown>(),
  logger,
});

const resultWithCost = (total: number): RunResult => ({
  traceId: "trace-1",
  response: { text: "ok" },
  stopReason: "end",
  toolCalls: [],
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: total / 2, output: total / 2, total },
  },
  durationMs: 10,
});

describe("createCostGuardPlugin", () => {
  it("under budget passes through", async () => {
    const plugin = createCostGuardPlugin({ dailyBudgetUsd: 10, alertThresholdPct: 80 });

    const result = await plugin.beforeModel?.([], { model: "m" }, ctx());
    expect(result).not.toBeNull();
  });

  it("alerts at threshold but still allows requests", async () => {
    const onAlert = vi.fn();
    const plugin = createCostGuardPlugin({
      dailyBudgetUsd: 10,
      alertThresholdPct: 80,
      onAlert,
    });

    await plugin.onRunEnd?.(ctx(), resultWithCost(8), undefined);
    const result = await plugin.beforeModel?.([], { model: "m" }, ctx());

    expect(result).not.toBeNull();
    expect(onAlert).toHaveBeenCalledWith(8, 10);
  });

  it("blocks when budget exceeded and calls onBlock", async () => {
    const onBlock = vi.fn();
    const plugin = createCostGuardPlugin({
      dailyBudgetUsd: 5,
      alertThresholdPct: 80,
      onBlock,
    });

    await plugin.onRunEnd?.(ctx(), resultWithCost(6), undefined);
    const result = await plugin.beforeModel?.([], { model: "m" }, ctx());

    expect(result).toBeNull();
    expect(onBlock).toHaveBeenCalledWith(6, 5);
  });

  it("daily reset clears spend at UTC day change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T23:50:00.000Z"));

    const onBlock = vi.fn();
    const plugin = createCostGuardPlugin({
      dailyBudgetUsd: 2,
      alertThresholdPct: 80,
      onBlock,
    });

    await plugin.onRunEnd?.(ctx(), resultWithCost(3), undefined);
    const blocked = await plugin.beforeModel?.([], { model: "m" }, ctx());
    expect(blocked).toBeNull();

    vi.setSystemTime(new Date("2026-03-11T00:01:00.000Z"));
    const afterReset = await plugin.beforeModel?.([], { model: "m" }, ctx());

    expect(afterReset).not.toBeNull();
    expect(onBlock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("accumulates cost across multiple runs", async () => {
    const onBlock = vi.fn();
    const plugin = createCostGuardPlugin({
      dailyBudgetUsd: 10,
      alertThresholdPct: 80,
      onBlock,
    });

    await plugin.onRunEnd?.(ctx(), resultWithCost(4), undefined);
    await plugin.onRunEnd?.(ctx(), resultWithCost(7), undefined);

    const result = await plugin.beforeModel?.([], { model: "m" }, ctx());
    expect(result).toBeNull();
    expect(onBlock).toHaveBeenCalledWith(11, 10);
  });

  it("zero budget blocks everything", async () => {
    const onBlock = vi.fn();
    const plugin = createCostGuardPlugin({ dailyBudgetUsd: 0, alertThresholdPct: 80, onBlock });

    const result = await plugin.beforeModel?.([], { model: "m" }, ctx());

    expect(result).toBeNull();
    expect(onBlock).toHaveBeenCalledWith(0, 0);
  });
});
