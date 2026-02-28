import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/scheduler.js";
import type { ScheduledTask } from "../src/types.js";

const tmpPath = () => join(tmpdir(), `hairy-scheduler-${randomUUID()}.json`);

const makeTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: randomUUID(),
  prompt: "do something",
  scheduleType: "once",
  scheduleValue: new Date(Date.now() + 60_000).toISOString(),
  status: "active",
  nextRun: null,
  lastRun: null,
  silent: false,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe("Scheduler", () => {
  let scheduler: Scheduler;
  let onTaskDue: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onTaskDue = vi.fn().mockResolvedValue(undefined);
    scheduler = new Scheduler({
      dataPath: tmpPath(),
      onTaskDue,
    });
  });

  afterEach(async () => {
    await scheduler.stopAll();
  });

  it("starts empty before load", () => {
    expect(scheduler.listTasks()).toHaveLength(0);
  });

  it("loads from empty file without error", async () => {
    await scheduler.load();
    expect(scheduler.listTasks()).toHaveLength(0);
  });

  it("creates and retrieves a task", async () => {
    await scheduler.load();
    const task = makeTask();
    await scheduler.createTask(task);

    const tasks = scheduler.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(task.id);
  });

  it("persists tasks across reload", async () => {
    const path = tmpPath();
    const s1 = new Scheduler({ dataPath: path, onTaskDue: vi.fn() });
    await s1.load();

    const task = makeTask({ status: "paused" });
    await s1.createTask(task);
    await s1.stopAll();

    const s2 = new Scheduler({ dataPath: path, onTaskDue: vi.fn() });
    await s2.load();
    const tasks = s2.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(task.id);
    await s2.stopAll();
  });

  it("fires interval task and calls onTaskDue", async () => {
    await scheduler.load();
    const task = makeTask({
      scheduleType: "interval",
      scheduleValue: "50", // 50ms
      status: "active",
    });

    await scheduler.createTask(task);
    await vi.waitFor(() => expect(onTaskDue).toHaveBeenCalled(), {
      timeout: 500,
    });
  });

  it("cancels a task", async () => {
    await scheduler.load();
    const task = makeTask({
      scheduleType: "interval",
      scheduleValue: "100",
    });
    await scheduler.createTask(task);

    const cancelled = await scheduler.cancelTask(task.id);
    expect(cancelled).toBe(true);

    const found = scheduler.listTasks().find((t) => t.id === task.id);
    expect(found?.status).toBe("completed");
  });

  it("returns false when cancelling unknown task", async () => {
    await scheduler.load();
    const result = await scheduler.cancelTask("does-not-exist");
    expect(result).toBe(false);
  });

  it("pauses and resumes a task", async () => {
    await scheduler.load();
    const task = makeTask({
      scheduleType: "interval",
      scheduleValue: "200",
    });
    await scheduler.createTask(task);

    const paused = await scheduler.pauseTask(task.id);
    expect(paused).toBe(true);
    expect(scheduler.listTasks().find((t) => t.id === task.id)?.status).toBe("paused");

    const resumed = await scheduler.resumeTask(task.id);
    expect(resumed).toBe(true);
    expect(scheduler.listTasks().find((t) => t.id === task.id)?.status).toBe("active");
  });

  it("getActiveTasks filters by status", async () => {
    await scheduler.load();
    await scheduler.createTask(makeTask({ status: "active" }));
    await scheduler.createTask(makeTask({ status: "paused" }));

    const active = scheduler.getActiveTasks();
    expect(active.every((t) => t.status === "active")).toBe(true);
  });

  it("stopAll clears all runners", async () => {
    await scheduler.load();
    await scheduler.createTask(makeTask({ scheduleType: "interval", scheduleValue: "100" }));
    await scheduler.createTask(makeTask({ scheduleType: "interval", scheduleValue: "100" }));

    await scheduler.stopAll();
    // After stopAll, no new firings should occur — just verify it doesn't throw
    expect(scheduler.listTasks().length).toBeGreaterThan(0);
  });
});
