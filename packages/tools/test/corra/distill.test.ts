import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDistillTool } from "../../src/corra/distill.js";
import { listCandidates } from "../../src/corra/knowledge-queue.js";

const noopLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => noopLogger,
};

const makeCtx = (dataDir: string) =>
  ({ traceId: "t", cwd: "/", dataDir, logger: noopLogger } as never);

const okPayload = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    provenance: { source_url: "https://youtube.com/x" },
    transcript_ref: "sha256:abc",
    lessons: [{ claim: "Do X", citation: "12:30", memory_type: "skill", confidence: 0.9 }],
  }),
});

const errPayload = (status: number) => ({
  ok: false,
  status,
  json: async () => ({ detail: "boom" }),
});

afterEach(() => vi.unstubAllGlobals());

describe("corra_distill", () => {
  it("POSTs to /api/v1/distill, drafts each lesson into the queue, returns counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-distill-"));
    const fetchMock = vi.fn(async () => okPayload() as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const tool = createDistillTool({ hiveApiUrl: "http://hive:8088/", hiveApiKey: "secret-key" });
    const res = await tool.execute(
      { source_url: "https://youtube.com/x", media_type: "video", title: "T" },
      makeCtx(dir),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("http://hive:8088/api/v1/distill");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("secret-key");
    expect(headers.authorization).toBe("Bearer secret-key");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ source_url: "https://youtube.com/x", text: undefined, media_type: "video", title: "T" });

    const parsed = JSON.parse(res.content);
    expect(parsed.distilled).toBe(1);
    expect(parsed.drafted).toBe(1);
    expect(parsed.transcript_ref).toBe("sha256:abc");

    const pending = await listCandidates(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0].title).toBe("Do X");
    expect(pending[0].content).toContain("Source: https://youtube.com/x @ 12:30");
    expect(pending[0].content).toContain("confidence: 0.9");
    expect(pending[0].tags).toEqual(["corra:intake", "video", "skill"]);
    expect(pending[0].status).toBe("pending");
  });

  it("does not send x-api-key/authorization when no key is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-distill-"));
    const fetchMock = vi.fn(async () => okPayload() as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const tool = createDistillTool({ hiveApiUrl: "http://hive:8088" });
    await tool.execute(
      { text: "some article body", media_type: "article", title: "T" },
      makeCtx(dir),
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it("HTTP 500 returns an error object and drafts 0 candidates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-distill-"));
    const fetchMock = vi.fn(async () => errPayload(500) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const tool = createDistillTool({ hiveApiUrl: "http://hive:8088", hiveApiKey: "k" });
    const res = await tool.execute(
      { source_url: "https://youtube.com/x", media_type: "video" },
      makeCtx(dir),
    );
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content);
    expect(parsed.error).toBe("distill failed: HTTP 500");
    const pending = await listCandidates(dir);
    expect(pending).toHaveLength(0);
  });

  it("network throw returns 'distill endpoint unreachable' and drafts 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-distill-"));
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const tool = createDistillTool({ hiveApiUrl: "http://hive:8088" });
    const res = await tool.execute(
      { source_url: "https://youtube.com/x", media_type: "video" },
      makeCtx(dir),
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).error).toBe("distill endpoint unreachable");
    expect((await listCandidates(dir))).toHaveLength(0);
  });

  it("video without source_url is rejected by zod validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-distill-"));
    const fetchMock = vi.fn(async () => okPayload() as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const tool = createDistillTool({ hiveApiUrl: "http://hive:8088" });
    await expect(
      tool.execute({ media_type: "video" }, makeCtx(dir)),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listCandidates(dir))).toHaveLength(0);
  });

  it("article with empty text is rejected by zod validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-distill-"));
    const fetchMock = vi.fn(async () => okPayload() as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const tool = createDistillTool({ hiveApiUrl: "http://hive:8088" });
    await expect(
      tool.execute({ text: "   ", media_type: "article" }, makeCtx(dir)),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips malformed lessons without crashing; drafts only valid ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-distill-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          provenance: { source_url: "https://youtube.com/x" },
          transcript_ref: "sha256:z",
          lessons: [
            { claim: "Good lesson", citation: "1:00", memory_type: "skill", confidence: 0.8 },
            { citation: "no claim", memory_type: "fact", confidence: 0.5 }, // missing claim
            "not-an-object", // non-object
            { claim: "", citation: "empty", memory_type: "skill", confidence: 0.1 }, // empty claim
          ],
        }),
      })) as unknown as typeof fetch,
    );
    const tool = createDistillTool({ hiveApiUrl: "http://hive:8088", hiveApiKey: "k" });
    const res = await tool.execute(
      { source_url: "https://youtube.com/x", media_type: "video" },
      makeCtx(dir),
    );
    const parsed = JSON.parse(res.content);
    expect(parsed.distilled).toBe(4);
    expect(parsed.drafted).toBe(1);
    expect(parsed.skipped).toBe(3);
    const pending = await listCandidates(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0].title).toBe("Good lesson");
  });

  it("caps oversized lesson content so the queue candidate stays bounded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-distill-"));
    const huge = "A".repeat(50_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          provenance: { source_url: "https://youtube.com/x" },
          transcript_ref: "sha256:z",
          lessons: [{ claim: huge, citation: huge, memory_type: "skill", confidence: 0.9 }],
        }),
      })) as unknown as typeof fetch,
    );
    const tool = createDistillTool({ hiveApiUrl: "http://hive:8088", hiveApiKey: "k" });
    await tool.execute({ source_url: "https://youtube.com/x", media_type: "video" }, makeCtx(dir));
    const pending = await listCandidates(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0].title.length).toBeLessThanOrEqual(120);
    expect(pending[0].content.length).toBeLessThanOrEqual(8_000);
  });
});