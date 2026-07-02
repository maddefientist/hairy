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

describe("in-flight / no-double-post safety", () => {
  const readQueue = async (dir: string) =>
    JSON.parse(await readFile(join(dir, "corra", "x-queue.json"), "utf8"));

  it("a definite HTTP rejection (n8n !ok) rolls back to pending so the owner can retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-q-"));
    const d = await addDraft(dir, "retryable");
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await approveDraft(dir, d.id, { n8nWebhookUrl: "http://n8n.local/x", n8nSharedSecret: "s" });
      expect(res.posted).toBe(false);
      expect((await readQueue(dir))[0].status).toBe("pending");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an ambiguous network error holds the draft in-flight (posting) and never auto-reposts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-q-"));
    const d = await addDraft(dir, "unconfirmed");
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const first = await approveDraft(dir, d.id, { n8nWebhookUrl: "http://n8n.local/x", n8nSharedSecret: "s" });
      expect(first.posted).toBe(false);
      expect((await readQueue(dir))[0].status).toBe("posting");
      // A second approve of an in-flight draft must refuse — no second POST.
      const second = await approveDraft(dir, d.id, { n8nWebhookUrl: "http://n8n.local/x", n8nSharedSecret: "s" });
      expect(second.posted).toBe(false);
      expect(second.reason).toContain("interrupted");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("webhook auth header", () => {
  it("sends the x-corra-secret header to the n8n webhook when a shared secret is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-q-"));
    const d = await addDraft(dir, "authenticated post");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await approveDraft(dir, d.id, {
        n8nWebhookUrl: "http://n8n.local/webhook/corra-x",
        n8nSharedSecret: "s3cr3t",
      });
      expect(res.posted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://n8n.local/webhook/corra-x");
      expect((init as RequestInit).headers).toMatchObject({ "x-corra-secret": "s3cr3t" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails CLOSED: refuses to post (no network call) when the webhook is set but no secret is configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-q-"));
    const d = await addDraft(dir, "no secret");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await approveDraft(dir, d.id, { n8nWebhookUrl: "http://n8n.local/webhook/corra-x" });
      expect(res.posted).toBe(false);
      expect(res.reason).toContain("secret");
      expect(fetchMock).not.toHaveBeenCalled();
      const saved = JSON.parse(await readFile(join(dir, "corra", "x-queue.json"), "utf8"));
      expect(saved[0].status).toBe("pending");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
