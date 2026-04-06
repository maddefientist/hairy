/**
 * Tests for Agent Snapshot Contract
 *
 * Validates:
 * - Snapshot creation with all fields
 * - Snapshot restoration (with and without messages)
 * - Serialization/deserialization
 * - Orchestrator snapshot/restore integration
 * - Artifact management
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentLoopMessage } from "../src/agent-loop.js";
import {
  createAgentSnapshot,
  createSnapshotArtifact,
  deserializeSnapshot,
  restoreFromSnapshot,
  serializeSnapshot,
} from "../src/agent-snapshot.js";
import { createExecutionMetadata } from "../src/execution-metadata.js";
import { Orchestrator } from "../src/orchestrator.js";
import { TaskQueue } from "../src/task-queue.js";

const mockLogger = () => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return logger;
};

const mockMetrics = () => ({
  increment: vi.fn(),
  gauge: vi.fn(),
  getAll: vi.fn(() => ({ counters: [], gauges: [] })),
  toPrometheus: vi.fn(() => ""),
});

const queuePath = (): string => join(tmpdir(), `hairy-snapshot-${randomUUID()}.json`);

describe("Agent Snapshot", () => {
  describe("createAgentSnapshot", () => {
    it("creates a snapshot with required fields", () => {
      const snapshot = createAgentSnapshot({
        agentId: "orchestrator",
        traceId: "trace-1",
        messagesSummary: "Discussed architecture decisions",
      });

      expect(snapshot.snapshotId).toBeDefined();
      expect(snapshot.agentId).toBe("orchestrator");
      expect(snapshot.traceId).toBe("trace-1");
      expect(snapshot.messagesSummary).toBe("Discussed architecture decisions");
      expect(snapshot.activeTools).toEqual([]);
      expect(snapshot.artifacts).toEqual([]);
      expect(snapshot.createdAt).toBeGreaterThan(0);
    });

    it("captures active tools from string array", () => {
      const snapshot = createAgentSnapshot({
        agentId: "worker-1",
        traceId: "trace-2",
        messagesSummary: "summary",
        activeTools: ["bash", "read", "write"],
      });

      expect(snapshot.activeTools).toEqual(["bash", "read", "write"]);
    });

    it("captures active tools from tool definitions", () => {
      const snapshot = createAgentSnapshot({
        agentId: "worker-1",
        traceId: "trace-2",
        messagesSummary: "summary",
        activeTools: [
          { name: "bash", description: "Run bash", parameters: {} },
          { name: "web_search", description: "Search web", parameters: {} },
        ],
      });

      expect(snapshot.activeTools).toEqual(["bash", "web_search"]);
    });

    it("includes execution metadata", () => {
      const metadata = createExecutionMetadata("trace-3", "orchestrator", "unified").build();

      const snapshot = createAgentSnapshot({
        agentId: "orchestrator",
        traceId: "trace-3",
        messagesSummary: "summary",
        executionMetadata: metadata,
      });

      expect(snapshot.executionMetadata).toBeDefined();
      expect(snapshot.executionMetadata?.traceId).toBe("trace-3");
    });

    it("includes artifacts", () => {
      const artifact = createSnapshotArtifact("decision", "Use TypeScript", "Chose TS over JS");

      const snapshot = createAgentSnapshot({
        agentId: "orchestrator",
        traceId: "trace-4",
        messagesSummary: "summary",
        artifacts: [artifact],
      });

      expect(snapshot.artifacts).toHaveLength(1);
      expect(snapshot.artifacts[0].kind).toBe("decision");
      expect(snapshot.artifacts[0].label).toBe("Use TypeScript");
    });

    it("includes custom state", () => {
      const snapshot = createAgentSnapshot({
        agentId: "orchestrator",
        traceId: "trace-5",
        messagesSummary: "summary",
        state: { completedSteps: 3, model: "claude-sonnet" },
      });

      expect(snapshot.state?.completedSteps).toBe(3);
      expect(snapshot.state?.model).toBe("claude-sonnet");
    });

    it("optionally stores full messages", () => {
      const messages: AgentLoopMessage[] = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      ];

      const snapshot = createAgentSnapshot({
        agentId: "orchestrator",
        traceId: "trace-6",
        messagesSummary: "Greeting exchange",
        messages,
      });

      expect(snapshot.messages).toHaveLength(2);
    });
  });

  describe("createSnapshotArtifact", () => {
    it("creates an artifact with all fields", () => {
      const artifact = createSnapshotArtifact("file", "config.ts", "const config = {}");

      expect(artifact.id).toBeDefined();
      expect(artifact.kind).toBe("file");
      expect(artifact.label).toBe("config.ts");
      expect(artifact.content).toBe("const config = {}");
      expect(artifact.createdAt).toBeGreaterThan(0);
    });

    it("supports all artifact kinds", () => {
      for (const kind of ["decision", "file", "result", "error"] as const) {
        const artifact = createSnapshotArtifact(kind, `test-${kind}`, "content");
        expect(artifact.kind).toBe(kind);
      }
    });
  });

  describe("restoreFromSnapshot", () => {
    it("restores messages from snapshot with full messages", () => {
      const messages: AgentLoopMessage[] = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ];

      const snapshot = createAgentSnapshot({
        agentId: "worker-1",
        traceId: "trace-r1",
        messagesSummary: "Greeting",
        messages,
        activeTools: ["bash"],
      });

      const restored = restoreFromSnapshot(snapshot);

      expect(restored.messages).toHaveLength(2);
      expect(restored.messages[0].role).toBe("user");
      expect(restored.activeTools).toEqual(["bash"]);
    });

    it("creates system context message when no full messages present", () => {
      const snapshot = createAgentSnapshot({
        agentId: "worker-1",
        traceId: "trace-r2",
        messagesSummary: "Analyzed codebase and found 3 issues",
      });

      const restored = restoreFromSnapshot(snapshot);

      expect(restored.messages).toHaveLength(1);
      expect(restored.messages[0].role).toBe("system");
      expect(restored.messages[0].content[0].text).toContain("worker-1");
      expect(restored.messages[0].content[0].text).toContain("found 3 issues");
    });

    it("builds context addendum from artifacts", () => {
      const snapshot = createAgentSnapshot({
        agentId: "worker-1",
        traceId: "trace-r3",
        messagesSummary: "summary",
        artifacts: [
          createSnapshotArtifact("decision", "Use Zod", "For validation"),
          createSnapshotArtifact("error", "API timeout", "Connection refused"),
        ],
      });

      const restored = restoreFromSnapshot(snapshot);

      expect(restored.contextAddendum).toContain("Previous Agent Context");
      expect(restored.contextAddendum).toContain("[decision] Use Zod");
      expect(restored.contextAddendum).toContain("[error] API timeout");
    });

    it("returns empty addendum when no artifacts", () => {
      const snapshot = createAgentSnapshot({
        agentId: "worker-1",
        traceId: "trace-r4",
        messagesSummary: "summary",
      });

      const restored = restoreFromSnapshot(snapshot);
      expect(restored.contextAddendum).toBe("");
    });

    it("preserves execution metadata", () => {
      const metadata = createExecutionMetadata("trace-r5", "worker-1", "unified").build();

      const snapshot = createAgentSnapshot({
        agentId: "worker-1",
        traceId: "trace-r5",
        messagesSummary: "summary",
        executionMetadata: metadata,
      });

      const restored = restoreFromSnapshot(snapshot);
      expect(restored.executionMetadata?.traceId).toBe("trace-r5");
    });

    it("preserves custom state", () => {
      const snapshot = createAgentSnapshot({
        agentId: "worker-1",
        traceId: "trace-r6",
        messagesSummary: "summary",
        state: { iteration: 5 },
      });

      const restored = restoreFromSnapshot(snapshot);
      expect(restored.state?.iteration).toBe(5);
    });
  });

  describe("serialization", () => {
    it("roundtrips snapshot through serialize/deserialize", () => {
      const original = createAgentSnapshot({
        agentId: "orchestrator",
        traceId: "trace-s1",
        messagesSummary: "Did some work",
        activeTools: ["bash", "read"],
        artifacts: [createSnapshotArtifact("decision", "chose vitest", "over jest")],
        state: { step: 2 },
      });

      const json = serializeSnapshot(original);
      const restored = deserializeSnapshot(json);

      expect(restored.snapshotId).toBe(original.snapshotId);
      expect(restored.agentId).toBe(original.agentId);
      expect(restored.traceId).toBe(original.traceId);
      expect(restored.messagesSummary).toBe(original.messagesSummary);
      expect(restored.activeTools).toEqual(original.activeTools);
      expect(restored.artifacts).toHaveLength(1);
    });

    it("throws on invalid JSON", () => {
      expect(() => deserializeSnapshot("not json")).toThrow();
    });

    it("throws on missing snapshotId", () => {
      expect(() =>
        deserializeSnapshot(
          '{"agentId": "x", "traceId": "y", "messagesSummary": "z", "activeTools": []}',
        ),
      ).toThrow("missing snapshotId");
    });

    it("throws on missing agentId", () => {
      expect(() =>
        deserializeSnapshot(
          '{"snapshotId": "x", "traceId": "y", "messagesSummary": "z", "activeTools": []}',
        ),
      ).toThrow("missing agentId");
    });

    it("throws on missing traceId", () => {
      expect(() =>
        deserializeSnapshot(
          '{"snapshotId": "x", "agentId": "y", "messagesSummary": "z", "activeTools": []}',
        ),
      ).toThrow("missing traceId");
    });

    it("throws on missing messagesSummary", () => {
      expect(() =>
        deserializeSnapshot(
          '{"snapshotId": "x", "agentId": "y", "traceId": "z", "activeTools": []}',
        ),
      ).toThrow("missing messagesSummary");
    });

    it("throws on missing activeTools", () => {
      expect(() =>
        deserializeSnapshot(
          '{"snapshotId": "x", "agentId": "y", "traceId": "z", "messagesSummary": "s"}',
        ),
      ).toThrow("missing activeTools");
    });

    it("throws on non-object JSON", () => {
      expect(() => deserializeSnapshot('"just a string"')).toThrow("expected object");
    });
  });

  describe("Orchestrator snapshot integration", () => {
    it("creates and retrieves a snapshot", async () => {
      const logger = mockLogger();
      const orchestrator = new Orchestrator({
        logger,
        metrics: mockMetrics() as never,
        queue: new TaskQueue(queuePath()),
        handleRun: async () => ({ text: "ok" }),
      });

      const snapshot = orchestrator.createSnapshot({
        traceId: "trace-orch-1",
        messagesSummary: "Discussed project architecture",
        activeTools: ["bash", "read"],
      });

      expect(snapshot.snapshotId).toBeDefined();
      expect(snapshot.agentId).toBe("orchestrator");

      const retrieved = orchestrator.getSnapshot(snapshot.snapshotId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.traceId).toBe("trace-orch-1");
    });

    it("restores a snapshot", async () => {
      const logger = mockLogger();
      const orchestrator = new Orchestrator({
        logger,
        metrics: mockMetrics() as never,
        queue: new TaskQueue(queuePath()),
        handleRun: async () => ({ text: "ok" }),
      });

      const snapshot = orchestrator.createSnapshot({
        traceId: "trace-orch-2",
        messagesSummary: "Did three things",
        activeTools: ["write"],
        artifacts: [createSnapshotArtifact("result", "output.txt", "file content")],
      });

      const restored = orchestrator.restoreSnapshot(snapshot.snapshotId);

      expect(restored).toBeDefined();
      expect(restored?.messages).toHaveLength(1);
      expect(restored?.messages[0].role).toBe("system");
      expect(restored?.activeTools).toEqual(["write"]);
      expect(restored?.contextAddendum).toContain("output.txt");
    });

    it("returns undefined for unknown snapshot ID", () => {
      const logger = mockLogger();
      const orchestrator = new Orchestrator({
        logger,
        metrics: mockMetrics() as never,
        queue: new TaskQueue(queuePath()),
        handleRun: async () => ({ text: "ok" }),
      });

      const restored = orchestrator.restoreSnapshot("nonexistent");
      expect(restored).toBeUndefined();
    });

    it("lists all snapshots", () => {
      const logger = mockLogger();
      const orchestrator = new Orchestrator({
        logger,
        metrics: mockMetrics() as never,
        queue: new TaskQueue(queuePath()),
        handleRun: async () => ({ text: "ok" }),
      });

      orchestrator.createSnapshot({
        traceId: "trace-1",
        messagesSummary: "summary 1",
      });
      orchestrator.createSnapshot({
        traceId: "trace-2",
        messagesSummary: "summary 2",
      });

      const list = orchestrator.listSnapshots();
      expect(list).toHaveLength(2);
    });

    it("deletes a snapshot", () => {
      const logger = mockLogger();
      const orchestrator = new Orchestrator({
        logger,
        metrics: mockMetrics() as never,
        queue: new TaskQueue(queuePath()),
        handleRun: async () => ({ text: "ok" }),
      });

      const snapshot = orchestrator.createSnapshot({
        traceId: "trace-del",
        messagesSummary: "temporary",
      });

      expect(orchestrator.deleteSnapshot(snapshot.snapshotId)).toBe(true);
      expect(orchestrator.getSnapshot(snapshot.snapshotId)).toBeUndefined();
      expect(orchestrator.deleteSnapshot(snapshot.snapshotId)).toBe(false);
    });

    it("logs snapshot creation and restoration", () => {
      const logger = mockLogger();
      const orchestrator = new Orchestrator({
        logger,
        metrics: mockMetrics() as never,
        queue: new TaskQueue(queuePath()),
        handleRun: async () => ({ text: "ok" }),
      });

      const snapshot = orchestrator.createSnapshot({
        traceId: "trace-log",
        messagesSummary: "test",
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ snapshotId: snapshot.snapshotId }),
        "agent snapshot created",
      );

      orchestrator.restoreSnapshot(snapshot.snapshotId);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ snapshotId: snapshot.snapshotId }),
        "agent snapshot restored",
      );
    });
  });
});
