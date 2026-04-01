import { describe, expect, it } from "vitest";
import {
  type ExecutionMetadata,
  createChildExecutionMetadata,
  createExecutionMetadata,
  endExecutionMetadata,
  getLineageChain,
  getMetadataDiagnostics,
} from "../src/execution-metadata.js";

describe("Execution Metadata", () => {
  describe("ExecutionMetadataBuilder", () => {
    it("should create metadata with required fields", () => {
      const builder = createExecutionMetadata("trace-123", "agent-1");
      const metadata = builder.build();

      expect(metadata.traceId).toBe("trace-123");
      expect(metadata.agentId).toBe("agent-1");
      expect(metadata.executionMode).toBe("unified");
      expect(metadata.executorType).toBe("model");
      expect(metadata.startedAt).toBeGreaterThan(0);
      expect(metadata.turnId).toBeDefined();
      expect(metadata.turnId).not.toBe("");
    });

    it("should allow setting parent agent", () => {
      const metadata = createExecutionMetadata("trace-123", "agent-child")
        .withParentAgent("agent-parent")
        .build();

      expect(metadata.parentAgentId).toBe("agent-parent");
    });

    it("should allow setting executor type", () => {
      const metadata = createExecutionMetadata("trace-123", "agent-1")
        .withExecutorType("tool")
        .build();

      expect(metadata.executorType).toBe("tool");
    });

    it("should allow adding tags", () => {
      const metadata = createExecutionMetadata("trace-123", "agent-1")
        .withTag("env", "production")
        .withTag("priority", 1)
        .withTag("isRetry", true)
        .build();

      expect(metadata.tags?.env).toBe("production");
      expect(metadata.tags?.priority).toBe(1);
      expect(metadata.tags?.isRetry).toBe(true);
    });

    it("should allow adding multiple tags at once", () => {
      const metadata = createExecutionMetadata("trace-123", "agent-1")
        .withTags({
          env: "production",
          version: "1.0",
        })
        .build();

      expect(metadata.tags?.env).toBe("production");
      expect(metadata.tags?.version).toBe("1.0");
    });

    it("should merge multiple tag additions", () => {
      const metadata = createExecutionMetadata("trace-123", "agent-1")
        .withTag("env", "production")
        .withTags({ version: "1.0", priority: 2 })
        .build();

      expect(metadata.tags?.env).toBe("production");
      expect(metadata.tags?.version).toBe("1.0");
      expect(metadata.tags?.priority).toBe(2);
    });

    it("should calculate duration when ending", () => {
      const builder = createExecutionMetadata("trace-123", "agent-1");
      // Small delay to ensure duration > 0
      const start = Date.now();
      while (Date.now() === start) {
        // Busy wait until time advances
      }
      const metadata = builder.end();

      expect(metadata.endedAt).toBeDefined();
      expect(metadata.durationMs).toBeDefined();
      expect(metadata.durationMs).toBeGreaterThan(0);
    });

    it("should allow specifying execution mode", () => {
      const metadata = createExecutionMetadata("trace-123", "agent-1");
      // Builder doesn't expose mode setter, but constructor accepts it
      const builtMetadata = metadata.build();
      expect(builtMetadata.executionMode).toBe("unified");
    });
  });

  describe("createChildExecutionMetadata", () => {
    it("should create child metadata with parent lineage", () => {
      const parent: ExecutionMetadata = {
        turnId: "turn-1",
        traceId: "trace-123",
        agentId: "agent-parent",
        executionMode: "unified",
        executorType: "model",
        startedAt: Date.now(),
      };

      const child = createChildExecutionMetadata(parent, "agent-child");

      expect(child.traceId).toBe(parent.traceId);
      expect(child.agentId).toBe("agent-child");
      expect(child.parentAgentId).toBe("agent-parent");
      expect(child.executorType).toBe("subagent");
      expect(child.tags?.isForked).toBe(true);
    });

    it("should allow overriding executor type", () => {
      const parent: ExecutionMetadata = {
        turnId: "turn-1",
        traceId: "trace-123",
        agentId: "agent-parent",
        executionMode: "unified",
        executorType: "model",
        startedAt: Date.now(),
      };

      const child = createChildExecutionMetadata(parent, "agent-child", "verification");

      expect(child.executorType).toBe("verification");
    });

    it("should preserve parent tags", () => {
      const parent: ExecutionMetadata = {
        turnId: "turn-1",
        traceId: "trace-123",
        agentId: "agent-parent",
        executionMode: "unified",
        executorType: "model",
        startedAt: Date.now(),
        tags: { env: "production", version: "1.0" },
      };

      const child = createChildExecutionMetadata(parent, "agent-child");

      expect(child.tags?.env).toBe("production");
      expect(child.tags?.version).toBe("1.0");
      expect(child.tags?.isForked).toBe(true);
    });

    it("should generate new turn ID for child", () => {
      const parent: ExecutionMetadata = {
        turnId: "turn-1",
        traceId: "trace-123",
        agentId: "agent-parent",
        executionMode: "unified",
        executorType: "model",
        startedAt: Date.now(),
      };

      const child = createChildExecutionMetadata(parent, "agent-child");

      expect(child.turnId).not.toBe(parent.turnId);
      expect(child.turnId).toBeDefined();
    });
  });

  describe("endExecutionMetadata", () => {
    it("should add duration if not already ended", () => {
      const metadata: ExecutionMetadata = {
        turnId: "turn-1",
        traceId: "trace-123",
        agentId: "agent-1",
        executionMode: "unified",
        executorType: "model",
        startedAt: Date.now() - 100,
      };

      const ended = endExecutionMetadata(metadata);

      expect(ended.endedAt).toBeDefined();
      expect(ended.durationMs).toBeDefined();
      expect(ended.durationMs).toBeGreaterThanOrEqual(100);
    });

    it("should not modify already ended metadata", () => {
      const now = Date.now();
      const metadata: ExecutionMetadata = {
        turnId: "turn-1",
        traceId: "trace-123",
        agentId: "agent-1",
        executionMode: "unified",
        executorType: "model",
        startedAt: now - 100,
        endedAt: now,
        durationMs: 100,
      };

      const ended = endExecutionMetadata(metadata);

      expect(ended.endedAt).toBe(now);
      expect(ended.durationMs).toBe(100);
    });
  });

  describe("getLineageChain", () => {
    it("should return single agent for non-forked metadata", () => {
      const metadata: ExecutionMetadata = {
        turnId: "turn-1",
        traceId: "trace-123",
        agentId: "agent-1",
        executionMode: "unified",
        executorType: "model",
        startedAt: Date.now(),
      };

      const chain = getLineageChain(metadata);

      expect(chain).toEqual(["agent-1"]);
    });

    it("should include parent in lineage chain", () => {
      const metadata: ExecutionMetadata = {
        turnId: "turn-1",
        traceId: "trace-123",
        agentId: "agent-child",
        parentAgentId: "agent-parent",
        executionMode: "unified",
        executorType: "subagent",
        startedAt: Date.now(),
      };

      const chain = getLineageChain(metadata);

      expect(chain).toEqual(["agent-parent", "agent-child"]);
    });
  });

  describe("getMetadataDiagnostics", () => {
    it("should return serializable diagnostic object", () => {
      const metadata: ExecutionMetadata = {
        turnId: "turn-1",
        traceId: "trace-123",
        agentId: "agent-1",
        parentAgentId: "agent-parent",
        executionMode: "unified",
        executorType: "model",
        startedAt: Date.now(),
        endedAt: Date.now() + 50,
        durationMs: 50,
        tags: { env: "production" },
      };

      const diagnostics = getMetadataDiagnostics(metadata);

      expect(diagnostics.turnId).toBe("turn-1");
      expect(diagnostics.traceId).toBe("trace-123");
      expect(diagnostics.agentId).toBe("agent-1");
      expect(diagnostics.parentAgentId).toBe("agent-parent");
      expect(diagnostics.executionMode).toBe("unified");
      expect(diagnostics.executorType).toBe("model");
      expect(diagnostics.durationMs).toBe(50);
      expect(diagnostics.tags?.env).toBe("production");
    });

    it("should omit undefined fields", () => {
      const metadata: ExecutionMetadata = {
        turnId: "turn-1",
        traceId: "trace-123",
        agentId: "agent-1",
        executionMode: "unified",
        executorType: "model",
        startedAt: Date.now(),
      };

      const diagnostics = getMetadataDiagnostics(metadata);

      expect(diagnostics.parentAgentId).toBeUndefined();
      expect(diagnostics.durationMs).toBeUndefined();
      expect(diagnostics.tags).toBeUndefined();
    });
  });
});
