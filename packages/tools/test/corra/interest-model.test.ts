import { describe, it, expect } from "vitest";
import { scoreItem, applyReaction } from "../../src/corra/interest-model.js";

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
