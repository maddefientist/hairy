import { describe, expect, it } from "vitest";
import { z } from "zod";
import { splitCsv } from "../../src/coerce.js";

describe("splitCsv", () => {
  it("splits a comma-separated string into a trimmed array", () => {
    expect(splitCsv("ai, agents ,llm")).toEqual(["ai", "agents", "llm"]);
  });
  it("drops empty segments", () => {
    expect(splitCsv("ai,, ,agents")).toEqual(["ai", "agents"]);
  });
  it("passes arrays through untouched", () => {
    expect(splitCsv(["ai", "agents"])).toEqual(["ai", "agents"]);
  });
  it("passes non-strings through (undefined stays undefined)", () => {
    expect(splitCsv(undefined)).toBeUndefined();
  });
  it("works as a zod preprocessor for both shapes", () => {
    const schema = z.preprocess(splitCsv, z.array(z.string())).optional();
    expect(schema.parse("a, b")).toEqual(["a", "b"]);
    expect(schema.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(schema.parse(undefined)).toBeUndefined();
  });
});
