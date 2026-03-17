import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationMemory } from "../src/conversation.js";

/** Each test gets its own temp file so they don't interfere */
const tmpFile = () => join(tmpdir(), `hairy-conv-test-${randomUUID()}.jsonl`);

describe("ConversationMemory", () => {
  it("starts empty when file does not exist", async () => {
    const mem = new ConversationMemory({ filePath: tmpFile() });
    const history = await mem.getHistory();
    expect(history).toHaveLength(0);
  });

  it("appends and retrieves entries", async () => {
    const mem = new ConversationMemory({ filePath: tmpFile() });

    await mem.append({
      role: "assistant",
      text: "Hello there!",
      timestamp: new Date().toISOString(),
    });
    await mem.append({
      role: "assistant",
      text: "How can I help?",
      timestamp: new Date().toISOString(),
    });

    const history = await mem.getHistory();
    expect(history).toHaveLength(2);
    expect((history[0] as { text: string }).text).toBe("Hello there!");
    expect((history[1] as { text: string }).text).toBe("How can I help?");
  });

  it("trims history to maxEntries", async () => {
    const mem = new ConversationMemory({
      filePath: tmpFile(),
      maxEntries: 3,
    });

    for (let i = 0; i < 5; i++) {
      await mem.append({
        role: "assistant",
        text: `message ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const history = await mem.getHistory();
    expect(history).toHaveLength(3);
    expect((history[0] as { text: string }).text).toBe("message 2");
    expect((history[2] as { text: string }).text).toBe("message 4");
  });

  it("getContext respects token budget", async () => {
    const mem = new ConversationMemory({ filePath: tmpFile() });

    // Each entry is ~25 chars → ~6 estimated tokens
    for (let i = 0; i < 10; i++) {
      await mem.append({
        role: "assistant",
        text: `short message number ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    // With a tight budget only recent entries should be returned
    const ctx = await mem.getContext(30);
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx.length).toBeLessThan(10);
  });

  it("compact replaces history with a summary", async () => {
    const mem = new ConversationMemory({ filePath: tmpFile() });

    for (let i = 0; i < 5; i++) {
      await mem.append({
        role: "assistant",
        text: `message ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    await mem.compact("User asked about the weather, was told it's sunny.");

    const history = await mem.getHistory();
    expect(history).toHaveLength(1);
    expect((history[0] as { text: string }).text).toContain("Context summary");
  });

  it("clear removes all entries", async () => {
    const mem = new ConversationMemory({ filePath: tmpFile() });

    await mem.append({
      role: "assistant",
      text: "something",
      timestamp: new Date().toISOString(),
    });
    await mem.clear();

    const history = await mem.getHistory();
    expect(history).toHaveLength(0);
  });

  it("handles HairyClawMessage entries", async () => {
    const mem = new ConversationMemory({ filePath: tmpFile() });

    await mem.append({
      id: "msg-1",
      channelId: "ch-1",
      channelType: "cli",
      senderId: "user-1",
      senderName: "Alice",
      content: { text: "Hello from Alice" },
      timestamp: new Date().toISOString(),
    });

    const history = await mem.getHistory();
    expect(history).toHaveLength(1);
    const entry = history[0] as { content: { text: string } };
    expect(entry.content.text).toBe("Hello from Alice");
  });
});
