import { describe, expect, it, vi } from "vitest";
import { WorkerStatusRegistry } from "../src/worker-status.js";

const createLogger = () => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return logger;
};

describe("WorkerStatusRegistry", () => {
  it("registers a worker in idle state", () => {
    const logger = createLogger();
    const registry = new WorkerStatusRegistry(logger);

    registry.register("w1", "agent-alpha");
    expect(registry.size).toBe(1);

    const status = registry.getStatus("w1");
    expect(status).toBeDefined();
    expect(status?.workerId).toBe("w1");
    expect(status?.agentId).toBe("agent-alpha");
    expect(status?.state).toBe("idle");
    expect(status?.artifactCount).toBe(0);
  });

  it("transitions worker state with telemetry", () => {
    const logger = createLogger();
    const registry = new WorkerStatusRegistry(logger);

    registry.register("w1", "agent-1");
    registry.transition("w1", "processing", { currentTask: "summarize docs" });

    const status = registry.getStatus("w1");
    expect(status?.state).toBe("processing");
    expect(status?.currentTask).toBe("summarize docs");
    expect(status?.startedAt).toBeGreaterThan(0);

    // Telemetry emitted
    const events = logger.info.mock.calls.map((c) => c[0]?.event).filter(Boolean);
    expect(events).toContain("worker.status_change");
  });

  it("transitions through full lifecycle: idle -> processing -> waiting_for_tool -> completed", () => {
    const logger = createLogger();
    const registry = new WorkerStatusRegistry(logger);

    registry.register("w1", "agent-1");
    expect(registry.getStatus("w1")?.state).toBe("idle");

    registry.transition("w1", "processing", { currentTask: "fetch data" });
    expect(registry.getStatus("w1")?.state).toBe("processing");

    registry.transition("w1", "waiting_for_tool");
    expect(registry.getStatus("w1")?.state).toBe("waiting_for_tool");

    registry.transition("w1", "completed");
    expect(registry.getStatus("w1")?.state).toBe("completed");
  });

  it("transitions to error state with message", () => {
    const logger = createLogger();
    const registry = new WorkerStatusRegistry(logger);

    registry.register("w1", "agent-1");
    registry.transition("w1", "error", { errorMessage: "OOM killed" });

    const status = registry.getStatus("w1");
    expect(status?.state).toBe("error");
    expect(status?.errorMessage).toBe("OOM killed");
  });

  it("unregisters a worker", () => {
    const logger = createLogger();
    const registry = new WorkerStatusRegistry(logger);

    registry.register("w1", "agent-1");
    expect(registry.size).toBe(1);

    const removed = registry.unregister("w1");
    expect(removed).toBe(true);
    expect(registry.size).toBe(0);
    expect(registry.getStatus("w1")).toBeUndefined();
  });

  it("unregister returns false for unknown worker", () => {
    const logger = createLogger();
    const registry = new WorkerStatusRegistry(logger);
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  it("incrementArtifacts increases count", () => {
    const logger = createLogger();
    const registry = new WorkerStatusRegistry(logger);

    registry.register("w1", "agent-1");
    registry.incrementArtifacts("w1");
    registry.incrementArtifacts("w1", 3);

    expect(registry.getStatus("w1")?.artifactCount).toBe(4);
  });

  it("getWorkerStatuses returns all workers", () => {
    const logger = createLogger();
    const registry = new WorkerStatusRegistry(logger);

    registry.register("w1", "agent-1");
    registry.register("w2", "agent-2");
    registry.register("w3", "agent-3");

    const all = registry.getWorkerStatuses();
    expect(all).toHaveLength(3);
  });

  it("getWorkersByState filters by state", () => {
    const logger = createLogger();
    const registry = new WorkerStatusRegistry(logger);

    registry.register("w1", "a1");
    registry.register("w2", "a2");
    registry.register("w3", "a3");

    registry.transition("w1", "processing");
    registry.transition("w3", "processing");

    const processing = registry.getWorkersByState("processing");
    expect(processing).toHaveLength(2);

    const idle = registry.getWorkersByState("idle");
    expect(idle).toHaveLength(1);
    expect(idle[0].workerId).toBe("w2");
  });

  it("activeCount counts processing and waiting_for_tool", () => {
    const logger = createLogger();
    const registry = new WorkerStatusRegistry(logger);

    registry.register("w1", "a1");
    registry.register("w2", "a2");
    registry.register("w3", "a3");

    expect(registry.activeCount).toBe(0);

    registry.transition("w1", "processing");
    registry.transition("w2", "waiting_for_tool");

    expect(registry.activeCount).toBe(2);

    registry.transition("w1", "completed");
    expect(registry.activeCount).toBe(1);
  });

  it("transition on unknown worker logs warning", () => {
    const logger = createLogger();
    const registry = new WorkerStatusRegistry(logger);

    registry.transition("unknown-id", "processing");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("getStatus returns a copy (mutations do not affect registry)", () => {
    const logger = createLogger();
    const registry = new WorkerStatusRegistry(logger);

    registry.register("w1", "a1");
    const status = registry.getStatus("w1");
    if (status) {
      status.state = "error";
    }

    expect(registry.getStatus("w1")?.state).toBe("idle");
  });
});
