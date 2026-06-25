import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupersedeTool } from "../../src/corra/supersede.js";

const noopLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: () => noopLogger };
const ctx = { traceId: "t", cwd: "/", dataDir: "/tmp", logger: noopLogger } as never;

afterEach(() => vi.unstubAllGlobals());

describe("corra_supersede", () => {
  it("finds the stale item, stores the correction, and supersedes old with new", async () => {
    const backend = {
      name: "hive",
      search: vi.fn().mockResolvedValue([{ id: "old-123", content: "stale fact", tags: [], createdAt: "", score: 1 }]),
      store: vi.fn().mockResolvedValue("new-456"),
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const tool = createSupersedeTool({ backend: backend as never, hiveApiUrl: "http://hive:8088", hiveApiKey: "k" });
    const res = await tool.execute({ query: "stale fact", newContent: "corrected fact" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(backend.store).toHaveBeenCalled();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("http://hive:8088/api/v1/knowledge/items/old-123/supersede");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ superseded_by: "new-456" });
  });
  it("returns isError when no matching item is found", async () => {
    const backend = { name: "hive", search: vi.fn().mockResolvedValue([]), store: vi.fn() };
    const tool = createSupersedeTool({ backend: backend as never, hiveApiUrl: "http://hive:8088" });
    const res = await tool.execute({ query: "nothing", newContent: "x" }, ctx);
    expect(res.isError).toBe(true);
    expect(backend.store).not.toHaveBeenCalled();
  });
});
