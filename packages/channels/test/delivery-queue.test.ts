import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryQueue } from "../src/delivery-queue.js";

const queuePath = (): string => join(tmpdir(), "hairy-delivery-queue", `${randomUUID()}.json`);

describe("DeliveryQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueues and processes a message", async () => {
    const queue = new DeliveryQueue({ filePath: queuePath() });
    await queue.enqueue("telegram", "chat-1", { text: "hello" });

    const send = vi.fn(async () => {});
    const processed = await queue.processDue(send);

    expect(processed).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.stats().pending).toBe(0);
  });

  it("failed delivery increments attempts and schedules retry", async () => {
    const queue = new DeliveryQueue({ filePath: queuePath(), baseRetryMs: 1_000 });
    await queue.enqueue("telegram", "chat-1", { text: "hello" });

    const send = vi.fn(async () => {
      throw new Error("temporary");
    });

    await queue.processDue(send);

    const dead = queue.getDeadLetters();
    expect(dead.length).toBe(0);
    expect(queue.stats().pending).toBe(1);
  });

  it("uses exponential backoff timing", async () => {
    const queue = new DeliveryQueue({
      filePath: queuePath(),
      baseRetryMs: 1_000,
      maxRetryMs: 60_000,
    });
    await queue.enqueue("telegram", "chat-1", { text: "hello" });

    const send = vi.fn(async () => {
      throw new Error("temporary");
    });

    await queue.processDue(send);
    let processed = await queue.processDue(send);
    expect(processed).toBe(0);

    vi.advanceTimersByTime(2_000);
    processed = await queue.processDue(send);
    expect(processed).toBe(1);
  });

  it("moves exhausted messages to dead letters", async () => {
    const queue = new DeliveryQueue({
      filePath: queuePath(),
      maxAttempts: 2,
      baseRetryMs: 100,
      maxRetryMs: 100,
    });

    await queue.enqueue("telegram", "chat-1", { text: "hello" });
    const send = vi.fn(async () => {
      throw new Error("always fails");
    });

    await queue.processDue(send);
    vi.advanceTimersByTime(100);
    await queue.processDue(send);

    expect(queue.stats().pending).toBe(0);
    expect(queue.stats().deadLetters).toBe(1);
  });

  it("retrieves and removes dead letters", async () => {
    const queue = new DeliveryQueue({ filePath: queuePath(), maxAttempts: 1 });
    await queue.enqueue("telegram", "chat-1", { text: "hello" });

    await queue.processDue(async () => {
      throw new Error("broken");
    });

    const dead = queue.getDeadLetters();
    expect(dead).toHaveLength(1);

    await queue.removeDeadLetter(dead[0].id);
    expect(queue.getDeadLetters()).toHaveLength(0);
  });

  it("persists and reloads queue state", async () => {
    const filePath = queuePath();
    const writer = new DeliveryQueue({ filePath });
    await writer.enqueue("telegram", "chat-1", { text: "persist me" });

    const reader = new DeliveryQueue({ filePath });
    await reader.load();

    expect(reader.stats().pending).toBe(1);
  });

  it("processes multiple items in retry order", async () => {
    const queue = new DeliveryQueue({ filePath: queuePath() });
    await queue.enqueue("telegram", "chat-1", { text: "one" });
    vi.advanceTimersByTime(1);
    await queue.enqueue("telegram", "chat-1", { text: "two" });

    const delivered: string[] = [];
    await queue.processDue(async (_type, _id, response) => {
      delivered.push(response.text);
    });

    expect(delivered).toEqual(["one", "two"]);
  });

  it("stats returns correct counts", async () => {
    const queue = new DeliveryQueue({ filePath: queuePath(), maxAttempts: 1 });
    await queue.enqueue("telegram", "chat-1", { text: "a" });
    await queue.processDue(async () => {
      throw new Error("fail");
    });

    expect(queue.stats()).toEqual({ pending: 0, deadLetters: 1 });
  });

  it("processDue returns 0 for empty queue", async () => {
    const queue = new DeliveryQueue({ filePath: queuePath() });
    const processed = await queue.processDue(async () => {});
    expect(processed).toBe(0);
  });

  it("concurrent enqueue during processDue is safe", async () => {
    const queue = new DeliveryQueue({ filePath: queuePath() });
    await queue.enqueue("telegram", "chat-1", { text: "first" });

    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });

    const processing = queue.processDue(async () => sendGate);

    await Promise.resolve();
    const enqueuePromise = queue.enqueue("telegram", "chat-2", { text: "second" });

    releaseSend();
    const processed = await processing;
    await enqueuePromise;

    expect(processed).toBe(1);
    expect(queue.stats().pending).toBe(1);

    const send = vi.fn(async () => {});
    await queue.processDue(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.stats().pending).toBe(0);
  });
});
