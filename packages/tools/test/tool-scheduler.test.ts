import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolScheduler } from "../src/scheduler.js";

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

describe("ToolScheduler", () => {
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("executes a single tool immediately", async () => {
    const scheduler = new ToolScheduler(logger, { maxConcurrent: 5 });
    const result = await scheduler.submit("my-tool", async () => "done");
    expect(result).toBe("done");

    const status = scheduler.getStatus();
    expect(status.totalSubmitted).toBe(1);
    expect(status.totalCompleted).toBe(1);
    expect(status.activeTasks).toBe(0);
  });

  it("respects maxConcurrent limit", async () => {
    const scheduler = new ToolScheduler(logger, { maxConcurrent: 2, maxQueueSize: 50 });

    let running = 0;
    let maxRunning = 0;
    const resolvers: Array<() => void> = [];

    const makeTask = () =>
      scheduler.submit("task", () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        return new Promise<string>((resolve) => {
          resolvers.push(() => {
            running--;
            resolve("ok");
          });
        });
      });

    // Submit 4 tasks
    const p1 = makeTask();
    const p2 = makeTask();
    const p3 = makeTask();
    const p4 = makeTask();

    // Wait a tick for the first two to start
    await new Promise((r) => setTimeout(r, 10));

    // Only 2 should be running
    expect(running).toBe(2);
    expect(maxRunning).toBe(2);

    // Resolve first two
    resolvers[0]();
    resolvers[1]();
    await p1;
    await p2;

    // Wait for next two to start
    await new Promise((r) => setTimeout(r, 10));
    expect(running).toBe(2);

    resolvers[2]();
    resolvers[3]();
    await p3;
    await p4;

    expect(scheduler.getStatus().totalCompleted).toBe(4);
  });

  it("handles task failures gracefully", async () => {
    const scheduler = new ToolScheduler(logger, { maxConcurrent: 5 });

    await expect(
      scheduler.submit("fail-tool", async () => {
        throw new Error("tool broke");
      }),
    ).rejects.toThrow("tool broke");

    const status = scheduler.getStatus();
    expect(status.totalFailed).toBe(1);
    expect(status.totalCompleted).toBe(0);
    expect(status.activeTasks).toBe(0);
  });

  it("rejects when queue is full", async () => {
    const scheduler = new ToolScheduler(logger, { maxConcurrent: 1, maxQueueSize: 2 });

    // Start one long-running task to block the slot
    const blocker = scheduler.submit(
      "blocker",
      () => new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 100)),
    );

    // Queue two more (fills the queue)
    const q1 = scheduler.submit("q1", async () => "q1");
    const q2 = scheduler.submit("q2", async () => "q2");

    // Third queue entry should be rejected
    await expect(scheduler.submit("q3", async () => "q3")).rejects.toThrow("queue full");

    const status = scheduler.getStatus();
    expect(status.totalRejected).toBe(1);

    // Cleanup: wait for everything to finish
    await blocker;
    await q1;
    await q2;
  });

  it("executes high-priority tasks before normal and low", async () => {
    const scheduler = new ToolScheduler(logger, { maxConcurrent: 1, maxQueueSize: 10 });

    const order: string[] = [];

    // Block the single slot
    let unblock: () => void;
    const blocker = scheduler.submit(
      "blocker",
      () =>
        new Promise<string>((resolve) => {
          unblock = () => resolve("done");
        }),
    );

    // Wait for blocker to start
    await new Promise((r) => setTimeout(r, 10));

    // Submit in order: low, normal, high — high should execute first after blocker
    const pLow = scheduler.submit("low-tool", async () => { order.push("low"); return "low"; }, "low");
    const pNormal = scheduler.submit("normal-tool", async () => { order.push("normal"); return "normal"; }, "normal");
    const pHigh = scheduler.submit("high-tool", async () => { order.push("high"); return "high"; }, "high");

    // Release the blocker
    unblock!();
    await blocker;
    await pHigh;
    await pNormal;
    await pLow;

    expect(order).toEqual(["high", "normal", "low"]);
  });

  it("emits queue overflow warning at threshold", async () => {
    const scheduler = new ToolScheduler(logger, {
      maxConcurrent: 1,
      maxQueueSize: 20,
      queueWarningThreshold: 2,
    });

    // Block the slot
    let unblock: () => void;
    const blocker = scheduler.submit(
      "blocker",
      () =>
        new Promise<string>((resolve) => {
          unblock = () => resolve("done");
        }),
    );
    await new Promise((r) => setTimeout(r, 10));

    // Queue up tasks beyond threshold
    const tasks = [];
    for (let i = 0; i < 3; i++) {
      tasks.push(scheduler.submit(`task-${i}`, async () => `result-${i}`));
    }

    // Should have warned about queue overflow
    const warnCalls = logger.warn.mock.calls;
    const overflowWarnings = warnCalls.filter(
      (c) => c[0]?.event === "tool.scheduler.queue_overflow",
    );
    expect(overflowWarnings.length).toBeGreaterThan(0);

    unblock!();
    await blocker;
    await Promise.all(tasks);
  });

  it("reports active and queued counts", async () => {
    const scheduler = new ToolScheduler(logger, { maxConcurrent: 1, maxQueueSize: 10 });

    let unblock: () => void;
    const blocker = scheduler.submit(
      "b",
      () =>
        new Promise<string>((resolve) => {
          unblock = () => resolve("done");
        }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(scheduler.active).toBe(1);

    const queued = scheduler.submit("q", async () => "ok");
    expect(scheduler.queued).toBe(1);

    unblock!();
    await blocker;
    await queued;

    // Allow the finally block in executeTask to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(scheduler.active).toBe(0);
    expect(scheduler.queued).toBe(0);
  });
});
