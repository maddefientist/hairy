import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addDraft, approveDraft, nextQueueState } from "../../src/corra/x-draft-queue.js";

const q = [{ id: "1", text: "hello", status: "pending" as const }];

describe("nextQueueState", () => {
  it("approve marks a draft approved", () => {
    expect(nextQueueState(q, "approve", "1")[0].status).toBe("approved");
  });
  it("skip removes the draft", () => {
    expect(nextQueueState(q, "skip", "1")).toHaveLength(0);
  });
  it("edit replaces text and keeps pending", () => {
    const r = nextQueueState(q, "edit", "1", "new text")[0];
    expect(r.text).toBe("new text");
    expect(r.status).toBe("pending");
  });
  it("unknown id is a no-op", () => {
    expect(nextQueueState(q, "approve", "9")).toEqual(q);
  });
});

describe("approveDraft safety", () => {
  it("posts before marking approved; draft stays pending if the post fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-q-"));
    const d = await addDraft(dir, "hello world");
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const res = await approveDraft(dir, d.id, { n8nWebhookUrl: "", postFn: failing });
    expect(res.posted).toBe(false);
    const saved = JSON.parse(await readFile(join(dir, "corra", "x-queue.json"), "utf8"));
    expect(saved[0].status).toBe("pending");
  });
  it("refuses to re-post an already-approved draft (no double post)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-q-"));
    const d = await addDraft(dir, "hi");
    const ok = vi.fn().mockResolvedValue(undefined);
    expect((await approveDraft(dir, d.id, { n8nWebhookUrl: "x", postFn: ok })).posted).toBe(true);
    const second = await approveDraft(dir, d.id, { n8nWebhookUrl: "x", postFn: ok });
    expect(second.posted).toBe(false);
    expect(ok).toHaveBeenCalledTimes(1);
  });
  it("returns not-found for a missing id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-q-"));
    const res = await approveDraft(dir, "99", { n8nWebhookUrl: "x", postFn: vi.fn() });
    expect(res.posted).toBe(false);
    expect(res.reason).toContain("not found");
  });
});
