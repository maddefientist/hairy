import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupersedeTool } from "../../src/corra/supersede.js";

const noopLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: () => noopLogger };
const ctx = { traceId: "t", cwd: "/", dataDir: "/tmp", logger: noopLogger } as never;

const backendFinding = (oldId: string) => ({
  name: "hive",
  search: vi.fn().mockResolvedValue([{ id: oldId, content: "stale fact", tags: [], createdAt: "", score: 1 }]),
  store: vi.fn(),
});

// URL-routing fetch mock for the ingest -> query -> supersede sequence.
const routeFetch = (opts: { queryResults?: Array<{ id: string; kind: string }>; ingestOk?: boolean; supersedeOk?: boolean }) =>
  vi.fn(async (url: string) => {
    if (url.includes("/ingest")) return { ok: opts.ingestOk ?? true, status: opts.ingestOk === false ? 422 : 200 } as Response;
    if (url.includes("/query")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: opts.queryResults ?? [] }),
      } as unknown as Response;
    }
    // supersede
    return { ok: opts.supersedeOk ?? true, status: opts.supersedeOk === false ? 404 : 200 } as Response;
  });

afterEach(() => vi.unstubAllGlobals());

describe("corra_supersede", () => {
  it("stores the correction and supersedes old with the REAL queried hive id (not a fabricated one)", async () => {
    const backend = backendFinding("old-123");
    const fetchMock = routeFetch({ queryResults: [{ id: "real-new-789", kind: "knowledge_item" }] });
    vi.stubGlobal("fetch", fetchMock);
    const tool = createSupersedeTool({ backend: backend as never, hiveApiUrl: "http://hive:8088", hiveApiKey: "k", namespace: "corra" });
    const res = await tool.execute({ query: "stale fact", newContent: "corrected fact" }, ctx);
    expect(res.isError).toBeFalsy();
    // backend.store must NOT be used (its return value is a fabricated id — the M1 bug)
    expect(backend.store).not.toHaveBeenCalled();
    const supersedeCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/supersede"));
    expect(supersedeCall?.[0]).toBe("http://hive:8088/api/v1/knowledge/items/old-123/supersede");
    expect(JSON.parse((supersedeCall?.[1] as { body: string }).body)).toEqual({ superseded_by: "real-new-789" });
  });

  it("refuses to supersede (no link) when the correction's real id cannot be resolved", async () => {
    const backend = backendFinding("old-123");
    const fetchMock = routeFetch({ queryResults: [] }); // query resolves nothing
    vi.stubGlobal("fetch", fetchMock);
    const tool = createSupersedeTool({ backend: backend as never, hiveApiUrl: "http://hive:8088", namespace: "corra" });
    const res = await tool.execute({ query: "stale fact", newContent: "corrected fact" }, ctx);
    expect(res.isError).toBe(true);
    // never posts a supersede with a bogus id
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/supersede"))).toBe(false);
  });

  it("returns isError when the correction ingest fails", async () => {
    const backend = backendFinding("old-123");
    const fetchMock = routeFetch({ ingestOk: false });
    vi.stubGlobal("fetch", fetchMock);
    const tool = createSupersedeTool({ backend: backend as never, hiveApiUrl: "http://hive:8088", namespace: "corra" });
    const res = await tool.execute({ query: "stale fact", newContent: "corrected fact" }, ctx);
    expect(res.isError).toBe(true);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/supersede"))).toBe(false);
  });

  it("returns isError when no matching item is found (no ingest, no supersede)", async () => {
    const backend = { name: "hive", search: vi.fn().mockResolvedValue([]), store: vi.fn() };
    const fetchMock = routeFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const tool = createSupersedeTool({ backend: backend as never, hiveApiUrl: "http://hive:8088", namespace: "corra" });
    const res = await tool.execute({ query: "nothing", newContent: "x" }, ctx);
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
