import { describe, expect, it, vi } from "vitest";
import { CostTracker } from "../src/cost-tracker.js";

const makeEntry = (
  overrides: Partial<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  }> = {},
) => ({
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
  ...overrides,
});

describe("CostTracker", () => {
  it("record adds an entry", () => {
    const tracker = new CostTracker(10);
    tracker.record(makeEntry());

    const entries = tracker.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("anthropic");
    expect(entries[0].timestamp).toBeGreaterThan(0);
  });

  it("isWithinBudget returns true when under budget", () => {
    const tracker = new CostTracker(10);
    tracker.record(makeEntry({ costUsd: 5 }));

    expect(tracker.isWithinBudget()).toBe(true);
  });

  it("isWithinBudget returns false when over budget", () => {
    const tracker = new CostTracker(10);
    tracker.record(makeEntry({ costUsd: 10 }));
    tracker.record(makeEntry({ costUsd: 1 }));

    expect(tracker.isWithinBudget()).toBe(false);
  });

  it("isWithinBudget returns false when exactly at budget", () => {
    const tracker = new CostTracker(0.01);
    tracker.record(makeEntry({ costUsd: 0.01 }));

    expect(tracker.isWithinBudget()).toBe(false);
  });

  it("dailySpend accumulates costs", () => {
    const tracker = new CostTracker(100);
    tracker.record(makeEntry({ costUsd: 1.5 }));
    tracker.record(makeEntry({ costUsd: 2.5 }));

    expect(tracker.dailySpend).toBeCloseTo(4.0);
  });

  it("report aggregates by provider", () => {
    const tracker = new CostTracker(100);
    const now = Date.now();
    tracker.record(makeEntry({ provider: "anthropic", costUsd: 3 }));
    tracker.record(makeEntry({ provider: "anthropic", costUsd: 2 }));
    tracker.record(makeEntry({ provider: "ollama", costUsd: 0 }));

    const report = tracker.report(now - 1000, now + 1000);

    expect(report.totalCostUsd).toBeCloseTo(5);
    expect(report.byProvider.anthropic.calls).toBe(2);
    expect(report.byProvider.anthropic.costUsd).toBeCloseTo(5);
    expect(report.byProvider.ollama.calls).toBe(1);
    expect(report.byProvider.ollama.costUsd).toBeCloseTo(0);
  });

  it("report aggregates by model", () => {
    const tracker = new CostTracker(100);
    const now = Date.now();
    tracker.record(makeEntry({ model: "claude-sonnet-4-20250514", costUsd: 4 }));
    tracker.record(makeEntry({ model: "claude-opus-4-20250514", costUsd: 6 }));

    const report = tracker.report(now - 1000, now + 1000);

    expect(report.byModel["claude-sonnet-4-20250514"].calls).toBe(1);
    expect(report.byModel["claude-sonnet-4-20250514"].costUsd).toBeCloseTo(4);
    expect(report.byModel["claude-opus-4-20250514"].calls).toBe(1);
    expect(report.byModel["claude-opus-4-20250514"].costUsd).toBeCloseTo(6);
  });

  it("report filters by time range", () => {
    const tracker = new CostTracker(100);
    tracker.record(makeEntry({ costUsd: 5 }));

    // Far past range
    const report = tracker.report(0, 1000);
    expect(report.totalCostUsd).toBeCloseTo(0);
  });

  it("report includes token totals", () => {
    const tracker = new CostTracker(100);
    const now = Date.now();
    tracker.record(makeEntry({ inputTokens: 1000, outputTokens: 500 }));

    const report = tracker.report(now - 1000, now + 1000);

    expect(report.totalInputTokens).toBe(1000);
    expect(report.totalOutputTokens).toBe(500);
  });

  it("fires onBudgetAlert callback at threshold", () => {
    const onAlert = vi.fn();
    const tracker = new CostTracker(10, 80, onAlert);

    tracker.record(makeEntry({ costUsd: 8 }));

    expect(onAlert).toHaveBeenCalledOnce();
    expect(onAlert).toHaveBeenCalledWith(8, 10);
  });

  it("does not fire onBudgetAlert below threshold", () => {
    const onAlert = vi.fn();
    const tracker = new CostTracker(10, 80, onAlert);

    tracker.record(makeEntry({ costUsd: 5 }));

    expect(onAlert).not.toHaveBeenCalled();
  });

  it("fires onBudgetExceeded callback when budget exceeded", () => {
    const onExceeded = vi.fn();
    const tracker = new CostTracker(10, 80, undefined, onExceeded);

    tracker.record(makeEntry({ costUsd: 10 }));

    expect(onExceeded).toHaveBeenCalledOnce();
    expect(onExceeded).toHaveBeenCalledWith(10, 10);
  });

  it("fires onBudgetExceeded but not onBudgetAlert when jumping past both", () => {
    const onAlert = vi.fn();
    const onExceeded = vi.fn();
    const tracker = new CostTracker(10, 80, onAlert, onExceeded);

    // Single record that jumps past both threshold and budget
    tracker.record(makeEntry({ costUsd: 12 }));

    // When cost >= budget (12 >= 10), only exceeded fires, not alert
    // Alert requires: cost >= threshold AND cost < budget
    // At 12: 12 >= 8 (true) but 12 < 10 (false) → alert NOT called
    expect(onAlert).not.toHaveBeenCalled();
    expect(onExceeded).toHaveBeenCalledOnce();
  });

  it("reset clears entries and daily cost", () => {
    const tracker = new CostTracker(100);
    tracker.record(makeEntry({ costUsd: 5 }));
    tracker.record(makeEntry({ costUsd: 3 }));

    tracker.reset();

    expect(tracker.getEntries()).toHaveLength(0);
    expect(tracker.dailySpend).toBe(0);
    expect(tracker.isWithinBudget()).toBe(true);
  });

  it("dailyBudgetUsd of 0 disables budget checks", () => {
    const onAlert = vi.fn();
    const onExceeded = vi.fn();
    const tracker = new CostTracker(0, 80, onAlert, onExceeded);

    tracker.record(makeEntry({ costUsd: 999 }));

    expect(onAlert).not.toHaveBeenCalled();
    expect(onExceeded).not.toHaveBeenCalled();
    // With budget 0, isWithinBudget checks dailyCost < 0, which is false
    expect(tracker.isWithinBudget()).toBe(false);
  });

  it("getEntries returns a copy", () => {
    const tracker = new CostTracker(100);
    tracker.record(makeEntry());

    const entries = tracker.getEntries();
    entries.length = 0;

    expect(tracker.getEntries()).toHaveLength(1);
  });
});
