import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectHealth, formatHealth } from "../../src/corra/health.js";

const seed = async (files: Record<string, unknown>) => {
  const dir = await mkdtemp(join(tmpdir(), "corra-health-"));
  await mkdir(join(dir, "corra"), { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(dir, "corra", name), JSON.stringify(data), "utf8");
  }
  return dir;
};

describe("collectHealth", () => {
  it("summarizes inbox, interest topics, deferred count and last mail", async () => {
    const dir = await seed({
      "inbox.json": [
        { messageId: "a", receivedAt: "2026-07-01T10:00:00Z" },
        { messageId: "b", receivedAt: "2026-07-03T10:00:00Z" },
      ],
      "interest-model.json": { agents: 0.7, crypto: 0.2 },
      "hive-deferred.json": [{ messageId: "x" }],
    });
    const h = await collectHealth(dir);
    expect(h.inboxCount).toBe(2);
    expect(h.interestTopics).toBe(2);
    expect(h.hiveDeferred).toBe(1);
    expect(h.lastMailAt).toBe("2026-07-03T10:00:00Z");
  });

  it("returns zeros when no state files exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-health-"));
    const h = await collectHealth(dir);
    expect(h).toEqual({ inboxCount: 0, lastMailAt: null, interestTopics: 0, hiveDeferred: 0 });
  });
});

describe("formatHealth", () => {
  it("shows the deferred warning only when there are deferred items", () => {
    expect(formatHealth({ inboxCount: 5, lastMailAt: null, interestTopics: 3, hiveDeferred: 0 })).not.toContain("deferred");
    expect(formatHealth({ inboxCount: 5, lastMailAt: null, interestTopics: 3, hiveDeferred: 2 })).toContain("2 hive-deferred");
  });
});
