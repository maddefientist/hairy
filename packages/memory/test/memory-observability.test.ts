import { describe, expect, it, vi } from "vitest";
import { MemoryObserver } from "../src/observability.js";
import type { MemoryBackend, SearchResult } from "../src/types.js";

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

const createMockBackend = (): MemoryBackend => ({
  name: "mock-backend",
  store: vi.fn().mockResolvedValue("item-123"),
  search: vi.fn().mockResolvedValue([
    {
      id: "r1",
      content: "test result",
      tags: [],
      createdAt: new Date().toISOString(),
      score: 0.95,
    } satisfies SearchResult,
  ]),
  feedback: vi.fn().mockResolvedValue(undefined),
});

describe("MemoryObserver", () => {
  it("wraps backend name", () => {
    const logger = createLogger();
    const backend = createMockBackend();
    const observer = new MemoryObserver(backend, logger);

    expect(observer.name).toBe("observed(mock-backend)");
  });

  it("delegates store to inner backend and tracks ingest count", async () => {
    const logger = createLogger();
    const backend = createMockBackend();
    const observer = new MemoryObserver(backend, logger);

    const id = await observer.store("hello world", ["tag1"]);
    expect(id).toBe("item-123");
    expect(backend.store).toHaveBeenCalledWith("hello world", ["tag1"], undefined);

    const metrics = observer.getMemoryMetrics();
    expect(metrics.ingestCount).toBe(1);
    expect(metrics.lastIngestAt).toBeDefined();
  });

  it("delegates search to inner backend and tracks recall metrics", async () => {
    const logger = createLogger();
    const backend = createMockBackend();
    const observer = new MemoryObserver(backend, logger);

    const results = await observer.search("test query", 5);
    expect(results).toHaveLength(1);
    expect(backend.search).toHaveBeenCalledWith("test query", 5, undefined);

    const metrics = observer.getMemoryMetrics();
    expect(metrics.recallCount).toBe(1);
    expect(metrics.totalRecallAttempts).toBe(1);
    expect(metrics.lastRecallAt).toBeDefined();
    expect(metrics.lastRecallLatencyMs).toBeGreaterThanOrEqual(0);
    expect(metrics.avgRecallLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks cache hits for repeated identical queries", async () => {
    const logger = createLogger();
    const backend = createMockBackend();
    const observer = new MemoryObserver(backend, logger);

    await observer.search("same query", 5);
    await observer.search("same query", 5);
    await observer.search("different query", 5);
    await observer.search("same query", 5);

    const metrics = observer.getMemoryMetrics();
    expect(metrics.recallCount).toBe(4);
    expect(metrics.totalRecallAttempts).toBe(4);
    // "same query" appeared 3 times, 2 are cache hits
    expect(metrics.cacheHits).toBe(2);
    expect(metrics.cacheHitRatio).toBeCloseTo(0.5, 1);
  });

  it("computes average recall latency", async () => {
    const logger = createLogger();
    const backend = createMockBackend();
    const observer = new MemoryObserver(backend, logger);

    await observer.search("q1");
    await observer.search("q2");
    await observer.search("q3");

    const metrics = observer.getMemoryMetrics();
    expect(metrics.recallCount).toBe(3);
    expect(metrics.avgRecallLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("delegates feedback to inner backend", async () => {
    const logger = createLogger();
    const backend = createMockBackend();
    const observer = new MemoryObserver(backend, logger);

    await observer.feedback("item-1", "useful");
    expect(backend.feedback).toHaveBeenCalledWith("item-1", "useful");
  });

  it("feedback is a no-op when inner backend does not support it", async () => {
    const logger = createLogger();
    const backend: MemoryBackend = {
      name: "no-feedback",
      store: vi.fn().mockResolvedValue("id"),
      search: vi.fn().mockResolvedValue([]),
    };
    const observer = new MemoryObserver(backend, logger);

    // Should not throw
    await observer.feedback("item-1", "useful");
  });

  it("resetMetrics clears all counters", async () => {
    const logger = createLogger();
    const backend = createMockBackend();
    const observer = new MemoryObserver(backend, logger);

    await observer.store("data");
    await observer.search("query");

    observer.resetMetrics();
    const metrics = observer.getMemoryMetrics();

    expect(metrics.recallCount).toBe(0);
    expect(metrics.ingestCount).toBe(0);
    expect(metrics.cacheHits).toBe(0);
    expect(metrics.totalRecallAttempts).toBe(0);
    expect(metrics.lastRecallAt).toBeUndefined();
    expect(metrics.lastIngestAt).toBeUndefined();
    expect(metrics.lastRecallLatencyMs).toBeUndefined();
    expect(metrics.avgRecallLatencyMs).toBe(0);
    expect(metrics.cacheHitRatio).toBe(0);
  });

  it("propagates store errors and does not count them", async () => {
    const logger = createLogger();
    const backend = createMockBackend();
    (backend.store as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("store failed"));
    const observer = new MemoryObserver(backend, logger);

    await expect(observer.store("bad data")).rejects.toThrow("store failed");
    expect(observer.getMemoryMetrics().ingestCount).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it("propagates search errors and does not count them", async () => {
    const logger = createLogger();
    const backend = createMockBackend();
    (backend.search as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("search failed"));
    const observer = new MemoryObserver(backend, logger);

    await expect(observer.search("bad query")).rejects.toThrow("search failed");
    expect(observer.getMemoryMetrics().recallCount).toBe(0);
    // But totalRecallAttempts still increments (we tracked the attempt)
    expect(observer.getMemoryMetrics().totalRecallAttempts).toBe(1);
  });

  it("passes StoreOptions through to inner backend", async () => {
    const logger = createLogger();
    const backend = createMockBackend();
    const observer = new MemoryObserver(backend, logger);

    await observer.store("content", ["tag"], { memoryType: "fact", extractionSource: "session" });
    expect(backend.store).toHaveBeenCalledWith("content", ["tag"], {
      memoryType: "fact",
      extractionSource: "session",
    });
  });

  it("passes SearchOptions through to inner backend", async () => {
    const logger = createLogger();
    const backend = createMockBackend();
    const observer = new MemoryObserver(backend, logger);

    await observer.search("query", 10, { memoryType: "decision", maxStaleness: 0.5 });
    expect(backend.search).toHaveBeenCalledWith("query", 10, {
      memoryType: "decision",
      maxStaleness: 0.5,
    });
  });
});
