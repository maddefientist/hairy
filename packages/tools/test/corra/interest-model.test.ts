import { describe, it, expect } from "vitest";
import { scoreItem, applyReaction, extractTopics, applySubscription } from "../../src/corra/interest-model.js";

describe("interest model", () => {
  it("scores higher when topic weights match item text", () => {
    const w = { "ai agents": 0.9, crypto: 0.1 };
    expect(scoreItem("new AI agents framework", w)).toBeGreaterThan(scoreItem("crypto price moves", w));
  });
  it("returns 0 when no weights", () => {
    expect(scoreItem("anything", {})).toBe(0);
  });
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
  it("applySubscription builds weight up to the cap, never above", () => {
    let w: Record<string, number> = {};
    for (let i = 0; i < 20; i++) w = applySubscription(w, ["agents"]);
    expect(w.agents).toBeGreaterThan(0);
    expect(w.agents).toBeLessThanOrEqual(0.55);
  });
});
