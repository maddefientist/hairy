import { describe, expect, it } from "vitest";
import { createExecutionMetadata } from "../src/execution-metadata.js";
import {
  DEFAULT_TELEMETRY_CONFIG,
  STANDARD_METRICS,
  TELEMETRY_EVENTS,
  createTelemetryContext,
  getAllEventNames,
  getAllMetricNames,
  getMetadataLabels,
  isKnownEvent,
} from "../src/telemetry-events.js";

describe("Telemetry Events", () => {
  describe("TELEMETRY_EVENTS structure", () => {
    it("should have all required event categories", () => {
      expect(TELEMETRY_EVENTS.subagent).toBeDefined();
      expect(TELEMETRY_EVENTS.summarization).toBeDefined();
      expect(TELEMETRY_EVENTS.plugin).toBeDefined();
      expect(TELEMETRY_EVENTS.policy).toBeDefined();
      expect(TELEMETRY_EVENTS.tool).toBeDefined();
      expect(TELEMETRY_EVENTS.memory).toBeDefined();
      expect(TELEMETRY_EVENTS.model).toBeDefined();
      expect(TELEMETRY_EVENTS.message).toBeDefined();
      expect(TELEMETRY_EVENTS.orchestrator).toBeDefined();
      expect(TELEMETRY_EVENTS.verification).toBeDefined();
      expect(TELEMETRY_EVENTS.session).toBeDefined();
    });

    it("should have subagent events", () => {
      expect(TELEMETRY_EVENTS.subagent.start).toBe("subagent.start");
      expect(TELEMETRY_EVENTS.subagent.complete).toBe("subagent.complete");
      expect(TELEMETRY_EVENTS.subagent.error).toBe("subagent.error");
      expect(TELEMETRY_EVENTS.subagent.timeout).toBe("subagent.timeout");
    });

    it("should have memory events", () => {
      expect(TELEMETRY_EVENTS.memory.recallStart).toBe("memory.recall.start");
      expect(TELEMETRY_EVENTS.memory.recallComplete).toBe("memory.recall.complete");
      expect(TELEMETRY_EVENTS.memory.ingestStart).toBe("memory.ingest.start");
      expect(TELEMETRY_EVENTS.memory.ingestComplete).toBe("memory.ingest.complete");
    });

    it("should have policy events", () => {
      expect(TELEMETRY_EVENTS.policy.allow).toBe("policy.allow");
      expect(TELEMETRY_EVENTS.policy.deny).toBe("policy.deny");
      expect(TELEMETRY_EVENTS.policy.fallback).toBe("policy.fallback");
    });
  });

  describe("STANDARD_METRICS", () => {
    it("should define counters", () => {
      expect(STANDARD_METRICS.subagentsStarted).toBe("subagents.started");
      expect(STANDARD_METRICS.toolsExecuted).toBe("tools.executed");
      expect(STANDARD_METRICS.policiesAllowed).toBe("policies.allowed");
    });

    it("should define gauges", () => {
      expect(STANDARD_METRICS.activeSubagents).toBe("subagents.active");
      expect(STANDARD_METRICS.queueLength).toBe("queue.length");
      expect(STANDARD_METRICS.contextTokens).toBe("context.tokens");
    });
  });

  describe("getMetadataLabels", () => {
    it("should extract labels from metadata", () => {
      const metadata = createExecutionMetadata("trace-123", "agent-1").build();
      const labels = getMetadataLabels(metadata);

      expect(labels.turnId).toBe(metadata.turnId);
      expect(labels.traceId).toBe("trace-123");
      expect(labels.agentId).toBe("agent-1");
      expect(labels.executionMode).toBe("unified");
      expect(labels.executorType).toBe("model");
    });
  });

  describe("createTelemetryContext", () => {
    it("should create context with default options", () => {
      const metadata = createExecutionMetadata("trace-123", "agent-1").build();
      const context = createTelemetryContext("test.event", metadata);

      expect(context.eventName).toBe("test.event");
      expect(context.metadata).toBe(metadata);
      expect(context.labels?.traceId).toBe("trace-123");
      expect(context.labels?.agentId).toBe("agent-1");
    });

    it("should include optional fields in context", () => {
      const metadata = createExecutionMetadata("trace-123", "agent-1").build();
      const error = new Error("test error");
      const context = createTelemetryContext("test.event", metadata, {
        duration: 100,
        error,
        details: { reason: "timeout" },
        labels: { custom: "label" },
      });

      expect(context.duration).toBe(100);
      expect(context.error).toBe(error);
      expect(context.details?.reason).toBe("timeout");
      expect(context.labels?.custom).toBe("label");
    });

    it("should merge metadata labels with custom labels", () => {
      const metadata = createExecutionMetadata("trace-123", "agent-1").build();
      const context = createTelemetryContext("test.event", metadata, {
        labels: { custom: "value", traceId: "override-trace" },
      });

      // Custom labels should override metadata labels
      expect(context.labels?.custom).toBe("value");
      expect(context.labels?.traceId).toBe("override-trace");
    });
  });

  describe("isKnownEvent", () => {
    it("should recognize canonical event names", () => {
      expect(isKnownEvent("subagent.start")).toBe(true);
      expect(isKnownEvent("subagent.complete")).toBe(true);
      expect(isKnownEvent("policy.allow")).toBe(true);
      expect(isKnownEvent("memory.recall.start")).toBe(true);
    });

    it("should reject unknown event names", () => {
      expect(isKnownEvent("unknown.event")).toBe(false);
      expect(isKnownEvent("made.up.event")).toBe(false);
    });
  });

  describe("getAllEventNames", () => {
    it("should return list of all event names", () => {
      const names = getAllEventNames();

      expect(names).toContain("subagent.start");
      expect(names).toContain("policy.allow");
      expect(names).toContain("memory.recall.start");
      expect(names.length).toBeGreaterThan(20);
    });

    it("should have no duplicates", () => {
      const names = getAllEventNames();
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  describe("getAllMetricNames", () => {
    it("should return list of all metric names", () => {
      const names = getAllMetricNames();

      expect(names).toContain("subagents.started");
      expect(names).toContain("tools.executed");
      expect(names).toContain("queue.length");
      expect(names.length).toBeGreaterThan(10);
    });

    it("should have no duplicates", () => {
      const names = getAllMetricNames();
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  describe("DEFAULT_TELEMETRY_CONFIG", () => {
    it("should have telemetry enabled by default", () => {
      expect(DEFAULT_TELEMETRY_CONFIG.enabled).toBe(true);
    });

    it("should have reasonable defaults", () => {
      expect(DEFAULT_TELEMETRY_CONFIG.level).toBe("info");
      expect(DEFAULT_TELEMETRY_CONFIG.includeMetadata).toBe(true);
      expect(DEFAULT_TELEMETRY_CONFIG.includeDuration).toBe(true);
    });
  });
});
