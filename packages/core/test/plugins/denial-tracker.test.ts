/**
 * Tests for Denial Tracker Plugin and Shadowed Rule Diagnostics
 *
 * Validates:
 * - Denial tracking: records, patterns, analytics
 * - Pattern detection after threshold
 * - Telemetry emission
 * - Feature flag gating
 * - diagnoseRules(): shadowed rules, conflicts, recommendations
 * - Integration with guardrails
 */

import { describe, expect, it, vi } from "vitest";
import { FeatureFlagManager } from "../../src/feature-flags.js";
import type { PluginContext } from "../../src/plugin.js";
import { TELEMETRY_EVENTS } from "../../src/telemetry-events.js";
import {
  DenialTracker,
  type DenialRecord,
  type DiagnosticRule,
  createDenialTrackerPlugin,
  diagnoseRules,
} from "../../src/plugins/denial-tracker.js";

const makeLogger = () => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return logger;
};

const makeCtx = (overrides: Partial<PluginContext> = {}): PluginContext => ({
  traceId: "trace-1",
  channelType: "cli",
  channelId: "channel-1",
  senderId: "user-1",
  state: new Map(),
  logger: makeLogger(),
  ...overrides,
});

const makeRecord = (overrides: Partial<DenialRecord> = {}): DenialRecord => ({
  toolName: "bash",
  args: { command: "sudo rm -rf /" },
  reason: "blocked command",
  timestamp: Date.now(),
  traceId: "trace-1",
  ...overrides,
});

// ---------------------------------------------------------------------------
// DenialTracker unit tests
// ---------------------------------------------------------------------------

describe("DenialTracker", () => {
  it("tracks a single denial", () => {
    const logger = makeLogger();
    const tracker = new DenialTracker({ logger });

    tracker.trackDenial(makeRecord());

    const records = tracker.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].toolName).toBe("bash");
  });

  it("tracks multiple denials", () => {
    const logger = makeLogger();
    const tracker = new DenialTracker({ logger });

    tracker.trackDenial(makeRecord({ toolName: "bash" }));
    tracker.trackDenial(makeRecord({ toolName: "read", reason: "blocked path" }));
    tracker.trackDenial(makeRecord({ toolName: "write", reason: "blocked path" }));

    expect(tracker.getRecords()).toHaveLength(3);
  });

  it("emits policy.denial.tracked telemetry", () => {
    const logger = makeLogger();
    const tracker = new DenialTracker({ logger });

    tracker.trackDenial(makeRecord());

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: TELEMETRY_EVENTS.denial.tracked,
        toolName: "bash",
      }),
      TELEMETRY_EVENTS.denial.tracked,
    );
  });

  it("detects pattern after threshold (default 5)", () => {
    const logger = makeLogger();
    const tracker = new DenialTracker({ logger });

    for (let i = 0; i < 5; i++) {
      tracker.trackDenial(makeRecord({ timestamp: Date.now() + i }));
    }

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: TELEMETRY_EVENTS.denial.patternDetected,
        toolName: "bash",
        count: 5,
      }),
      expect.stringContaining("denial pattern detected"),
    );
  });

  it("detects pattern at custom threshold", () => {
    const logger = makeLogger();
    const tracker = new DenialTracker({ logger, patternThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      tracker.trackDenial(makeRecord({ timestamp: Date.now() + i }));
    }

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: TELEMETRY_EVENTS.denial.patternDetected,
        count: 3,
      }),
      expect.any(String),
    );
  });

  it("does not emit pattern before threshold", () => {
    const logger = makeLogger();
    const tracker = new DenialTracker({ logger, patternThreshold: 5 });

    for (let i = 0; i < 4; i++) {
      tracker.trackDenial(makeRecord({ timestamp: Date.now() + i }));
    }

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("different tool+reason combos are tracked separately", () => {
    const logger = makeLogger();
    const tracker = new DenialTracker({ logger, patternThreshold: 3 });

    // 3 denials of bash+blocked command
    for (let i = 0; i < 3; i++) {
      tracker.trackDenial(makeRecord({ toolName: "bash", reason: "blocked command" }));
    }
    // 2 denials of read+blocked path (not enough for threshold)
    for (let i = 0; i < 2; i++) {
      tracker.trackDenial(makeRecord({ toolName: "read", reason: "blocked path" }));
    }

    const analytics = tracker.getAnalytics();
    expect(analytics.patterns).toHaveLength(1);
    expect(analytics.patterns[0].toolName).toBe("bash");
  });

  it("enforces maxRecords limit (FIFO)", () => {
    const logger = makeLogger();
    const tracker = new DenialTracker({ logger, maxRecords: 3 });

    tracker.trackDenial(makeRecord({ toolName: "tool-1" }));
    tracker.trackDenial(makeRecord({ toolName: "tool-2" }));
    tracker.trackDenial(makeRecord({ toolName: "tool-3" }));
    tracker.trackDenial(makeRecord({ toolName: "tool-4" }));

    const records = tracker.getRecords();
    expect(records).toHaveLength(3);
    expect(records[0].toolName).toBe("tool-2"); // tool-1 evicted
  });

  it("clear removes all records", () => {
    const logger = makeLogger();
    const tracker = new DenialTracker({ logger });

    tracker.trackDenial(makeRecord());
    tracker.trackDenial(makeRecord());
    tracker.clear();

    expect(tracker.getRecords()).toHaveLength(0);
    expect(tracker.getAnalytics().totalDenials).toBe(0);
    expect(tracker.getAnalytics().patterns).toHaveLength(0);
  });

  it("suppresses telemetry when standardizedTelemetry is disabled", () => {
    const logger = makeLogger();
    const flags = new FeatureFlagManager({
      features: { standardizedTelemetry: false },
    });
    const tracker = new DenialTracker({ logger, featureFlags: flags });

    tracker.trackDenial(makeRecord());

    // Should not emit info-level telemetry
    expect(logger.info).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DenialTracker.getAnalytics() tests
// ---------------------------------------------------------------------------

describe("DenialTracker.getAnalytics", () => {
  it("returns correct byTool breakdown", () => {
    const logger = makeLogger();
    const tracker = new DenialTracker({ logger });

    tracker.trackDenial(makeRecord({ toolName: "bash" }));
    tracker.trackDenial(makeRecord({ toolName: "bash" }));
    tracker.trackDenial(makeRecord({ toolName: "read" }));

    const analytics = tracker.getAnalytics();
    expect(analytics.totalDenials).toBe(3);
    expect(analytics.byTool[0]).toEqual({ toolName: "bash", count: 2 });
    expect(analytics.byTool[1]).toEqual({ toolName: "read", count: 1 });
  });

  it("returns correct byPath breakdown", () => {
    const logger = makeLogger();
    const tracker = new DenialTracker({ logger });

    tracker.trackDenial(makeRecord({ toolName: "read", args: { path: "/etc/passwd" } }));
    tracker.trackDenial(makeRecord({ toolName: "read", args: { path: "/etc/passwd" } }));
    tracker.trackDenial(makeRecord({ toolName: "read", args: { path: "~/.ssh/id_rsa" } }));
    tracker.trackDenial(makeRecord({ toolName: "bash", args: { command: "ls" } }));

    const analytics = tracker.getAnalytics();
    expect(analytics.byPath[0]).toEqual({ path: "/etc/passwd", count: 2 });
    expect(analytics.byPath[1]).toEqual({ path: "~/.ssh/id_rsa", count: 1 });
  });

  it("returns empty analytics when no denials", () => {
    const logger = makeLogger();
    const tracker = new DenialTracker({ logger });

    const analytics = tracker.getAnalytics();
    expect(analytics.totalDenials).toBe(0);
    expect(analytics.byTool).toEqual([]);
    expect(analytics.byPath).toEqual([]);
    expect(analytics.patterns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createDenialTrackerPlugin tests
// ---------------------------------------------------------------------------

describe("createDenialTrackerPlugin", () => {
  it("plugin does not block tool calls (passthrough)", async () => {
    const logger = makeLogger();
    const { plugin } = createDenialTrackerPlugin({ logger });

    const result = await plugin.beforeTool?.("bash", { command: "ls" }, makeCtx());
    expect(result).toEqual({ args: { command: "ls" } });
  });

  it("plugin passes through when denialTracking is disabled", async () => {
    const logger = makeLogger();
    const flags = new FeatureFlagManager({
      features: { denialTracking: false },
    });
    const { plugin } = createDenialTrackerPlugin({ logger, featureFlags: flags });

    const result = await plugin.beforeTool?.("bash", { command: "ls" }, makeCtx());
    expect(result).toEqual({ args: { command: "ls" } });
  });

  it("exposes tracker for external denial recording", () => {
    const logger = makeLogger();
    const { tracker } = createDenialTrackerPlugin({ logger });

    tracker.trackDenial(makeRecord());
    expect(tracker.getRecords()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// diagnoseRules() tests
// ---------------------------------------------------------------------------

describe("diagnoseRules", () => {
  it("returns clean report for non-conflicting rules", () => {
    const rules: DiagnosticRule[] = [
      { type: "allow", scope: "tool", value: "read" },
      { type: "allow", scope: "tool", value: "write" },
      { type: "block", scope: "tool", value: "bash" },
    ];

    const report = diagnoseRules(rules);
    expect(report.shadowedRules).toHaveLength(0);
    expect(report.conflicts).toHaveLength(0);
    expect(report.recommendations).toContain("No shadowed or conflicting rules detected. Policy looks clean.");
  });

  it("detects shadowed path rule (narrow blocked by broader block)", () => {
    const rules: DiagnosticRule[] = [
      { type: "block", scope: "path", value: "/" },
      { type: "block", scope: "path", value: "/etc/passwd" },
    ];

    const report = diagnoseRules(rules);
    expect(report.shadowedRules).toHaveLength(1);
    expect(report.shadowedRules[0].shadowedRule.value).toBe("/etc/passwd");
    expect(report.shadowedRules[0].shadowedBy.value).toBe("/");
  });

  it("detects shadowed allow path rule", () => {
    const rules: DiagnosticRule[] = [
      { type: "allow", scope: "path", value: "/home" },
      { type: "allow", scope: "path", value: "/home/user/docs" },
    ];

    const report = diagnoseRules(rules);
    expect(report.shadowedRules).toHaveLength(1);
    expect(report.shadowedRules[0].shadowedRule.value).toBe("/home/user/docs");
    expect(report.shadowedRules[0].shadowedBy.value).toBe("/home");
  });

  it("detects conflicting tool rules (allow + block same tool)", () => {
    const rules: DiagnosticRule[] = [
      { type: "allow", scope: "tool", value: "bash" },
      { type: "block", scope: "tool", value: "bash" },
    ];

    const report = diagnoseRules(rules);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].explanation).toContain("both allowed and blocked");
  });

  it("detects conflicting path rules (allow + block same path)", () => {
    const rules: DiagnosticRule[] = [
      { type: "allow", scope: "path", value: "/etc" },
      { type: "block", scope: "path", value: "/etc" },
    ];

    const report = diagnoseRules(rules);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].explanation).toContain("/etc");
  });

  it("detects overlap conflict: allowed path contains blocked path", () => {
    const rules: DiagnosticRule[] = [
      { type: "allow", scope: "path", value: "/home" },
      { type: "block", scope: "path", value: "/home/user/.ssh" },
    ];

    const report = diagnoseRules(rules);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].explanation).toContain("contains blocked path");
  });

  it("detects overlap conflict: blocked path contains allowed path", () => {
    const rules: DiagnosticRule[] = [
      { type: "block", scope: "path", value: "/etc" },
      { type: "allow", scope: "path", value: "/etc/hostname" },
    ];

    const report = diagnoseRules(rules);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].explanation).toContain("contains allowed path");
  });

  it("detects conflicting command rules", () => {
    const rules: DiagnosticRule[] = [
      { type: "allow", scope: "command", value: "sudo" },
      { type: "block", scope: "command", value: "sudo" },
    ];

    const report = diagnoseRules(rules);
    expect(report.conflicts).toHaveLength(1);
  });

  it("warns about very broad block paths", () => {
    const rules: DiagnosticRule[] = [
      { type: "block", scope: "path", value: "/" },
    ];

    const report = diagnoseRules(rules);
    expect(report.recommendations.some((r) => r.includes("Very broad block path"))).toBe(true);
  });

  it("generates recommendations for shadows and conflicts", () => {
    const rules: DiagnosticRule[] = [
      { type: "block", scope: "path", value: "/" },
      { type: "block", scope: "path", value: "/etc" },
      { type: "allow", scope: "tool", value: "bash" },
      { type: "block", scope: "tool", value: "bash" },
    ];

    const report = diagnoseRules(rules);
    expect(report.recommendations.some((r) => r.includes("shadowed rule"))).toBe(true);
    expect(report.recommendations.some((r) => r.includes("conflicting rule"))).toBe(true);
  });

  it("handles empty rule set", () => {
    const report = diagnoseRules([]);
    expect(report.shadowedRules).toHaveLength(0);
    expect(report.conflicts).toHaveLength(0);
    expect(report.recommendations).toContain("No shadowed or conflicting rules detected. Policy looks clean.");
  });

  it("does not flag different-type rules as shadowed", () => {
    const rules: DiagnosticRule[] = [
      { type: "allow", scope: "path", value: "/" },
      { type: "block", scope: "path", value: "/etc" },
    ];

    // These are not shadowed (different types) — they are a conflict
    const report = diagnoseRules(rules);
    expect(report.shadowedRules).toHaveLength(0);
    expect(report.conflicts).toHaveLength(1);
  });

  it("does not flag different-scope rules as conflicts", () => {
    const rules: DiagnosticRule[] = [
      { type: "allow", scope: "tool", value: "read" },
      { type: "block", scope: "command", value: "read" },
    ];

    const report = diagnoseRules(rules);
    expect(report.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: denial tracker + guardrails
// ---------------------------------------------------------------------------

describe("denial tracker + guardrails integration", () => {
  it("tracker records denials from guardrails decisions", async () => {
    const logger = makeLogger();
    const flags = new FeatureFlagManager({
      features: { denialTracking: true, standardizedTelemetry: true },
    });
    const { tracker } = createDenialTrackerPlugin({
      logger,
      featureFlags: flags,
      patternThreshold: 3,
    });

    // Simulate guardrails denying bash 3 times
    for (let i = 0; i < 3; i++) {
      tracker.trackDenial({
        toolName: "bash",
        args: { command: "sudo rm -rf /" },
        reason: "blocked command: sudo",
        timestamp: Date.now() + i,
        traceId: `trace-${i}`,
        senderId: "user-1",
      });
    }

    const analytics = tracker.getAnalytics();
    expect(analytics.totalDenials).toBe(3);
    expect(analytics.byTool[0]).toEqual({ toolName: "bash", count: 3 });
    expect(analytics.patterns).toHaveLength(1);
    expect(analytics.patterns[0].toolName).toBe("bash");
    expect(analytics.patterns[0].count).toBe(3);

    // Verify pattern telemetry was emitted
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: TELEMETRY_EVENTS.denial.patternDetected,
      }),
      expect.any(String),
    );
  });
});
