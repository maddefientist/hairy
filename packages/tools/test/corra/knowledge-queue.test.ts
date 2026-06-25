import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addCandidate, nextKnowledgeState, promoteKnowledge } from "../../src/corra/knowledge-queue.js";

const q = [{ id: "1", title: "t", content: "c", tags: ["a"], status: "pending" as const }];

describe("nextKnowledgeState", () => {
  it("promote marks promoted", () => {
    expect(nextKnowledgeState(q, "promote", "1")[0].status).toBe("promoted");
  });
  it("reject removes", () => {
    expect(nextKnowledgeState(q, "reject", "1")).toHaveLength(0);
  });
  it("edit replaces content, stays pending", () => {
    const r = nextKnowledgeState(q, "edit", "1", "new")[0];
    expect(r.content).toBe("new");
    expect(r.status).toBe("pending");
  });
  it("unknown id no-op", () => {
    expect(nextKnowledgeState(q, "promote", "9")).toEqual(q);
  });
});

describe("promoteKnowledge safety", () => {
  it("writes to shared backend before marking promoted; stays pending if write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-k-"));
    const c = await addCandidate(dir, { title: "AI agents", content: "use orchestrator split", tags: ["arch"] });
    const failing = { name: "x", store: vi.fn().mockRejectedValue(new Error("down")), search: vi.fn().mockResolvedValue([]) };
    const res = await promoteKnowledge(dir, c.id, { sharedBackend: failing as never });
    expect(res.promoted).toBe(false);
    const saved = JSON.parse(await readFile(join(dir, "corra", "knowledge-queue.json"), "utf8"));
    expect(saved[0].status).toBe("pending");
  });
  it("refuses to re-promote an already-promoted candidate (no double write)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-k-"));
    const c = await addCandidate(dir, { title: "T", content: "C", tags: [] });
    const ok = { name: "x", store: vi.fn().mockResolvedValue("id1"), search: vi.fn().mockResolvedValue([]) };
    expect((await promoteKnowledge(dir, c.id, { sharedBackend: ok as never })).promoted).toBe(true);
    const second = await promoteKnowledge(dir, c.id, { sharedBackend: ok as never });
    expect(second.promoted).toBe(false);
    expect(ok.store).toHaveBeenCalledTimes(1);
  });
});
