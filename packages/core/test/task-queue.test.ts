import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskQueue } from "../src/task-queue.js";

describe("TaskQueue", () => {
  it("dequeues by priority and persists state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hairy-queue-"));
    const path = join(dir, "queue.json");
    const queue = new TaskQueue(path);

    await queue.enqueue(
      {
        id: "1",
        kind: "message",
        payload: {
          id: "m1",
          channelId: "c1",
          channelType: "cli",
          senderId: "u1",
          senderName: "U",
          content: { text: "hello" },
          timestamp: new Date().toISOString(),
        },
        enqueuedAt: new Date().toISOString(),
      },
      "background",
    );

    await queue.enqueue(
      {
        id: "2",
        kind: "message",
        payload: {
          id: "m2",
          channelId: "c1",
          channelType: "cli",
          senderId: "u1",
          senderName: "U",
          content: { text: "urgent" },
          timestamp: new Date().toISOString(),
        },
        enqueuedAt: new Date().toISOString(),
      },
      "urgent",
    );

    const first = await queue.dequeue();
    expect(first?.id).toBe("2");

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      urgent: unknown[];
      background: unknown[];
    };
    expect(persisted.urgent).toHaveLength(0);
    expect(persisted.background).toHaveLength(1);
  });
});
