import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendToInbox, listInbox, readInboxItem, searchInbox } from "../../src/corra/inbox.js";

const mk = (over: Partial<{ messageId: string; from: string; subject: string; receivedAt: string; cleanText: string }> = {}) => ({
  messageId: over.messageId ?? "<a@x>",
  from: over.from ?? "AlphaSignal <news@alphasignal.ai>",
  subject: over.subject ?? "AI weekly",
  receivedAt: over.receivedAt ?? "2026-06-26T10:00:00Z",
  cleanText: over.cleanText ?? "new transformer results and agent frameworks",
  listId: undefined,
}) as never;

describe("inbox index", () => {
  it("appends, dedups by messageId, lists newest-first", async () => {
    const d = await mkdtemp(join(tmpdir(), "corra-inbox-"));
    await appendToInbox(d, mk({ messageId: "<1>", subject: "Older", receivedAt: "2026-06-25T10:00:00Z" }));
    await appendToInbox(d, mk({ messageId: "<2>", subject: "Newer", receivedAt: "2026-06-26T10:00:00Z" }));
    await appendToInbox(d, mk({ messageId: "<1>", subject: "Older dup" }));
    const list = await listInbox(d, 10);
    expect(list).toHaveLength(2);
    expect(list[0].subject).toBe("Newer");
  });
  it("reads an item by list number and by subject", async () => {
    const d = await mkdtemp(join(tmpdir(), "corra-inbox-"));
    await appendToInbox(d, mk({ messageId: "<1>", subject: "MarketBeat Daily", cleanText: "stocks up" }));
    expect((await readInboxItem(d, "1"))?.subject).toBe("MarketBeat Daily");
    expect((await readInboxItem(d, "marketbeat"))?.snippet).toContain("stocks up");
    expect(await readInboxItem(d, "99")).toBeUndefined();
  });
  it("searches across subject/sender/body", async () => {
    const d = await mkdtemp(join(tmpdir(), "corra-inbox-"));
    await appendToInbox(d, mk({ messageId: "<1>", subject: "AI weekly", cleanText: "agent frameworks" }));
    await appendToInbox(d, mk({ messageId: "<2>", subject: "Markets", from: "MarketBeat <x@y>", cleanText: "stocks" }));
    expect(await searchInbox(d, "agent")).toHaveLength(1);
    expect((await searchInbox(d, "marketbeat"))[0].subject).toBe("Markets");
  });
});
