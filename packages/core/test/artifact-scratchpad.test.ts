/**
 * Tests for Artifact Scratchpad
 *
 * Validates:
 * - put/get/list/delete operations
 * - Metadata tracking (producedBy, timestamp, type)
 * - Copy-on-read semantics (mutation safety)
 * - Concurrent access safety
 * - Orchestrator integration (scratchpad lifecycle, telemetry)
 */

import { describe, expect, it, vi } from "vitest";
import {
  type ArtifactEntry,
  type ArtifactMetadata,
  createArtifactScratchpad,
} from "../src/artifact-scratchpad.js";
import { FeatureFlagManager } from "../src/feature-flags.js";
import { Orchestrator } from "../src/orchestrator.js";

// ---------------------------------------------------------------------------
// Unit tests for createArtifactScratchpad
// ---------------------------------------------------------------------------

describe("createArtifactScratchpad", () => {
  const makeMeta = (
    agent = "agent-1",
    type: ArtifactMetadata["type"] = "text",
  ): ArtifactMetadata => ({
    producedBy: agent,
    timestamp: Date.now(),
    type,
  });

  it("starts empty", () => {
    const pad = createArtifactScratchpad();
    expect(pad.size).toBe(0);
    expect(pad.list()).toEqual([]);
  });

  it("put and get a value", () => {
    const pad = createArtifactScratchpad();
    const meta = makeMeta();
    pad.put("key1", { hello: "world" }, meta);

    const entry = pad.get("key1");
    expect(entry).toBeDefined();
    expect(entry?.key).toBe("key1");
    expect(entry?.value).toEqual({ hello: "world" });
    expect(entry?.metadata.producedBy).toBe("agent-1");
    expect(entry?.metadata.type).toBe("text");
    expect(pad.size).toBe(1);
  });

  it("get returns undefined for missing key", () => {
    const pad = createArtifactScratchpad();
    expect(pad.get("nonexistent")).toBeUndefined();
  });

  it("put overwrites existing key", () => {
    const pad = createArtifactScratchpad();
    pad.put("key1", "v1", makeMeta("agent-1"));
    pad.put("key1", "v2", makeMeta("agent-2"));

    const entry = pad.get("key1");
    expect(entry?.value).toBe("v2");
    expect(entry?.metadata.producedBy).toBe("agent-2");
    expect(pad.size).toBe(1);
  });

  it("list returns all entries", () => {
    const pad = createArtifactScratchpad();
    pad.put("a", 1, makeMeta("agent-1", "data"));
    pad.put("b", 2, makeMeta("agent-2", "code"));
    pad.put("c", 3, makeMeta("agent-3", "plan"));

    const entries = pad.list();
    expect(entries).toHaveLength(3);
    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual(["a", "b", "c"]);
  });

  it("delete removes an entry and returns true", () => {
    const pad = createArtifactScratchpad();
    pad.put("key1", "value", makeMeta());

    expect(pad.delete("key1")).toBe(true);
    expect(pad.get("key1")).toBeUndefined();
    expect(pad.size).toBe(0);
  });

  it("delete returns false for missing key", () => {
    const pad = createArtifactScratchpad();
    expect(pad.delete("nonexistent")).toBe(false);
  });

  it("metadata labels are preserved", () => {
    const pad = createArtifactScratchpad();
    const meta: ArtifactMetadata = {
      producedBy: "worker-x",
      timestamp: 1234567890,
      type: "code",
      labels: { language: "typescript", purpose: "test" },
    };
    pad.put("src", "const x = 1;", meta);

    const entry = pad.get("src");
    expect(entry?.metadata.labels).toEqual({ language: "typescript", purpose: "test" });
  });

  // Copy-on-read tests
  describe("copy-on-read semantics", () => {
    it("mutating returned value does not affect stored value", () => {
      const pad = createArtifactScratchpad();
      pad.put("key", { items: [1, 2, 3] }, makeMeta());

      const entry1 = pad.get("key");
      // Mutate the returned value
      (entry1?.value as { items: number[] }).items.push(4);

      // Original should be unchanged
      const entry2 = pad.get("key");
      expect((entry2?.value as { items: number[] }).items).toEqual([1, 2, 3]);
    });

    it("mutating original object after put does not affect stored value", () => {
      const pad = createArtifactScratchpad();
      const obj = { nested: { count: 0 } };
      pad.put("key", obj, makeMeta());

      // Mutate the original
      obj.nested.count = 999;

      const entry = pad.get("key");
      expect((entry?.value as { nested: { count: number } }).nested.count).toBe(0);
    });

    it("list returns independent copies", () => {
      const pad = createArtifactScratchpad();
      pad.put("key", { data: "original" }, makeMeta());

      const list1 = pad.list();
      (list1[0].value as { data: string }).data = "mutated";

      const list2 = pad.list();
      expect((list2[0].value as { data: string }).data).toBe("original");
    });
  });

  // Concurrent access tests
  describe("concurrent access", () => {
    it("parallel puts to different keys are safe", async () => {
      const pad = createArtifactScratchpad();
      const promises = Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() => {
          pad.put(`key-${i}`, `value-${i}`, makeMeta(`agent-${i}`));
        }),
      );

      await Promise.all(promises);
      expect(pad.size).toBe(50);
    });

    it("parallel reads and writes are safe", async () => {
      const pad = createArtifactScratchpad();
      pad.put("shared", { counter: 0 }, makeMeta());

      const promises: Promise<void>[] = [];

      // Mix of reads and writes
      for (let i = 0; i < 100; i++) {
        if (i % 2 === 0) {
          promises.push(
            Promise.resolve().then(() => {
              pad.put("shared", { counter: i }, makeMeta(`agent-${i}`));
            }),
          );
        } else {
          promises.push(
            Promise.resolve().then(() => {
              const entry = pad.get("shared");
              // Should always get a valid entry (never corrupted)
              expect(entry).toBeDefined();
              expect(typeof (entry?.value as { counter: number }).counter).toBe("number");
            }),
          );
        }
      }

      await Promise.all(promises);
    });
  });
});

// ---------------------------------------------------------------------------
// Orchestrator scratchpad integration tests
// ---------------------------------------------------------------------------

describe("Orchestrator scratchpad integration", () => {
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

  const makeMetrics = () => ({
    increment: vi.fn(),
    gauge: vi.fn(),
    histogram: vi.fn(),
    timing: vi.fn(),
  });

  const makeQueue = () => ({
    enqueue: vi.fn(),
    dequeue: vi.fn(async () => null),
    load: vi.fn(),
    save: vi.fn(),
    peek: vi.fn(),
    length: 0,
  });

  it("returns undefined when sharedArtifacts flag is disabled", () => {
    const flags = new FeatureFlagManager({
      features: { sharedArtifacts: false },
    });
    const orch = new Orchestrator({
      logger: makeLogger(),
      metrics: makeMetrics(),
      queue: makeQueue(),
      featureFlags: flags,
      handleRun: vi.fn(),
    });

    expect(orch.getScratchpad("trace-1")).toBeUndefined();
  });

  it("creates and returns scratchpad when flag is enabled", () => {
    const flags = new FeatureFlagManager({
      features: { sharedArtifacts: true },
    });
    const orch = new Orchestrator({
      logger: makeLogger(),
      metrics: makeMetrics(),
      queue: makeQueue(),
      featureFlags: flags,
      handleRun: vi.fn(),
    });

    const pad = orch.getScratchpad("trace-1");
    expect(pad).toBeDefined();

    // Same trace returns same scratchpad
    const pad2 = orch.getScratchpad("trace-1");
    expect(pad2).toBe(pad);
  });

  it("putArtifact emits telemetry", () => {
    const logger = makeLogger();
    const flags = new FeatureFlagManager({
      features: { sharedArtifacts: true, standardizedTelemetry: true },
    });
    const orch = new Orchestrator({
      logger,
      metrics: makeMetrics(),
      queue: makeQueue(),
      featureFlags: flags,
      handleRun: vi.fn(),
    });

    const result = orch.putArtifact("trace-1", "output.ts", "const x = 1;", {
      producedBy: "coder-agent",
      timestamp: Date.now(),
      type: "code",
    });

    expect(result).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "artifact.put",
        key: "output.ts",
        producedBy: "coder-agent",
        type: "code",
      }),
      "artifact.put",
    );
  });

  it("getArtifact emits telemetry", () => {
    const logger = makeLogger();
    const flags = new FeatureFlagManager({
      features: { sharedArtifacts: true, standardizedTelemetry: true },
    });
    const orch = new Orchestrator({
      logger,
      metrics: makeMetrics(),
      queue: makeQueue(),
      featureFlags: flags,
      handleRun: vi.fn(),
    });

    orch.putArtifact(
      "trace-1",
      "data.json",
      { foo: "bar" },
      {
        producedBy: "fetcher",
        timestamp: Date.now(),
        type: "data",
      },
    );

    const value = orch.getArtifact("trace-1", "data.json");
    expect(value).toEqual({ foo: "bar" });

    // Check telemetry for get
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "artifact.get",
        key: "data.json",
        found: true,
      }),
      "artifact.get",
    );
  });

  it("getArtifact returns undefined for missing key", () => {
    const flags = new FeatureFlagManager({
      features: { sharedArtifacts: true },
    });
    const orch = new Orchestrator({
      logger: makeLogger(),
      metrics: makeMetrics(),
      queue: makeQueue(),
      featureFlags: flags,
      handleRun: vi.fn(),
    });

    expect(orch.getArtifact("trace-1", "missing")).toBeUndefined();
  });

  it("putArtifact returns false when flag is disabled", () => {
    const flags = new FeatureFlagManager({
      features: { sharedArtifacts: false },
    });
    const orch = new Orchestrator({
      logger: makeLogger(),
      metrics: makeMetrics(),
      queue: makeQueue(),
      featureFlags: flags,
      handleRun: vi.fn(),
    });

    const result = orch.putArtifact("trace-1", "key", "value", {
      producedBy: "agent",
      timestamp: Date.now(),
      type: "text",
    });
    expect(result).toBe(false);
  });

  it("deleteScratchpad removes the pad for a trace", () => {
    const flags = new FeatureFlagManager({
      features: { sharedArtifacts: true },
    });
    const orch = new Orchestrator({
      logger: makeLogger(),
      metrics: makeMetrics(),
      queue: makeQueue(),
      featureFlags: flags,
      handleRun: vi.fn(),
    });

    orch.putArtifact("trace-1", "key", "value", {
      producedBy: "agent",
      timestamp: Date.now(),
      type: "text",
    });

    expect(orch.deleteScratchpad("trace-1")).toBe(true);
    // New getScratchpad creates a fresh one
    const pad = orch.getScratchpad("trace-1");
    expect(pad?.size).toBe(0);
  });
});
