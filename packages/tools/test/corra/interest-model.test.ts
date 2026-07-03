import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  scoreItem,
  applyReaction,
  extractTopics,
  applySubscription,
  loadWeights,
  saveWeights,
  createInterestModelTool,
} from "../../src/corra/interest-model.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return logger; } };

describe("topics coercion + file persistence", () => {
  it("accepts a bare string for topics and persists weights to the local file (not hive)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-int-"));
    const store = vi.fn();
    const backend = { name: "x", search: vi.fn(), store, feedback: vi.fn() };
    const tool = createInterestModelTool({ memory: backend as never });
    const res = await tool.execute(
      { action: "react", topics: "ai agents", signal: "useful" },
      { traceId: "t", cwd: "/", dataDir: dir, logger } as never,
    );
    expect(res.isError).toBeFalsy();
    // weights go to the local file, NOT hive semantic-append
    expect(store).not.toHaveBeenCalled();
    const saved = JSON.parse(await readFile(join(dir, "corra", "interest-model.json"), "utf8"));
    expect(saved["ai agents"]).toBeGreaterThan(0.5);
  });
});

describe("interest model scoring (max matched weight, no divide-by-total decay)", () => {
  it("scores higher when a topic weight matches the item text", () => {
    const w = { "ai agents": 0.9, crypto: 0.1 };
    expect(scoreItem("new AI agents framework", w)).toBeGreaterThan(scoreItem("crypto price moves", w));
  });
  it("returns 0 when no weights", () => {
    expect(scoreItem("anything", {})).toBe(0);
  });
  it("does NOT decay as unrelated topics accumulate (the H1 bug)", () => {
    const sparse = { agents: 0.7 };
    const crowded: Record<string, number> = { agents: 0.7 };
    for (let i = 0; i < 50; i++) crowded[`topic${i}`] = 0.5;
    // matching 'agents' scores 0.7 in both — vocabulary size must not dilute it
    expect(scoreItem("about agents", crowded)).toBe(scoreItem("about agents", sparse));
    expect(scoreItem("about agents", crowded)).toBe(0.7);
  });
});

describe("reactions", () => {
  it("reinforces topics on a useful reaction", () => {
    expect(applyReaction({ "ai agents": 0.5 }, ["ai agents"], "useful")["ai agents"]).toBeGreaterThan(0.5);
  });
  it("decays topics on a wrong reaction", () => {
    expect(applyReaction({ "ai agents": 0.5 }, ["ai agents"], "wrong")["ai agents"]).toBeLessThan(0.5);
  });
  it("noted leaves weight unchanged and clamps stay in [0,1]", () => {
    expect(applyReaction({ "ai agents": 0.5 }, ["ai agents"], "noted")["ai agents"]).toBe(0.5);
    expect(applyReaction({ x: 0.95 }, ["x"], "useful").x).toBeLessThanOrEqual(1);
    expect(applyReaction({ x: 0.05 }, ["x"], "wrong").x).toBeGreaterThanOrEqual(0);
  });
});

describe("subscription learning", () => {
  it("extractTopics keeps meaningful words, drops stopwords/short words", () => {
    const t = extractTopics("New AI agents weekly issue");
    expect(t).toContain("agents");
    expect(t).not.toContain("new");
    expect(t).not.toContain("ai"); // too short (<4 chars)
  });
  it("applySubscription builds weight up to a cap ABOVE the ping threshold (can cross 0.6)", () => {
    let w: Record<string, number> = {};
    for (let i = 0; i < 20; i++) w = applySubscription(w, ["agents"]);
    expect(w.agents).toBeGreaterThan(0.6); // reachable now (old 0.55 cap could not)
    expect(w.agents).toBeLessThanOrEqual(0.9);
  });
});

describe("weights file round-trip", () => {
  it("saveWeights then loadWeights returns the same numeric map", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-int-"));
    await saveWeights(dir, { agents: 0.7, crypto: 0.2 });
    expect(await loadWeights(dir)).toEqual({ agents: 0.7, crypto: 0.2 });
  });
  it("loadWeights returns {} when the file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-int-"));
    expect(await loadWeights(dir)).toEqual({});
  });
});
