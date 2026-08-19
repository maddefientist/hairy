import { describe, expect, it } from "vitest";
import { createSubagentBudget } from "../src/iteration-budget.js";
import {
  CHILD_MAX_ITERATIONS,
  MAX_COMPRESSION_RETRIES_PER_ITERATION,
  MAX_PROVIDER_RETRIES_PER_ATTEMPT,
  PRIMARY_MAX_ITERATIONS,
} from "../src/iteration-limits.js";

describe("iteration-limits single source", () => {
  it("primary is 35 and child is 15", () => {
    expect(PRIMARY_MAX_ITERATIONS).toBe(35);
    expect(CHILD_MAX_ITERATIONS).toBe(15);
  });

  it("retry caps are bounded, small integers", () => {
    expect(MAX_PROVIDER_RETRIES_PER_ATTEMPT).toBeGreaterThan(0);
    expect(MAX_PROVIDER_RETRIES_PER_ATTEMPT).toBeLessThanOrEqual(5);
    expect(MAX_COMPRESSION_RETRIES_PER_ITERATION).toBeGreaterThan(0);
    expect(MAX_COMPRESSION_RETRIES_PER_ITERATION).toBeLessThanOrEqual(5);
  });

  it("createSubagentBudget defaults to CHILD_MAX_ITERATIONS", () => {
    const budget = createSubagentBudget();
    expect(budget.maxTotal).toBe(CHILD_MAX_ITERATIONS);
  });
});
