import { describe, it, expect } from "vitest";
import { selectPushWorthy } from "../../src/corra/digest.js";

describe("selectPushWorthy", () => {
  it("returns only items at/above threshold, sorted desc", () => {
    const out = selectPushWorthy([{ id: "a", score: 0.3 }, { id: "b", score: 0.8 }, { id: "c", score: 0.6 }], 0.5);
    expect(out.map((i) => i.id)).toEqual(["b", "c"]);
  });
  it("empty when none qualify", () => {
    expect(selectPushWorthy([{ id: "a", score: 0.1 }], 0.5)).toHaveLength(0);
  });
});
