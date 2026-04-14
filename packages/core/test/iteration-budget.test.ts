import { describe, expect, it } from "vitest";
import { IterationBudget, createSubagentBudget } from "../src/iteration-budget.js";

describe("IterationBudget", () => {
  it("consume returns true until max is reached", () => {
    const budget = new IterationBudget(3);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
  });

  it("consume returns false after max is reached", () => {
    const budget = new IterationBudget(2);
    budget.consume();
    budget.consume();
    expect(budget.consume()).toBe(false);
  });

  it("refund gives back one iteration", () => {
    const budget = new IterationBudget(2);
    budget.consume();
    budget.consume();
    expect(budget.exhausted).toBe(true);
    budget.refund();
    expect(budget.exhausted).toBe(false);
    expect(budget.consume()).toBe(true);
  });

  it("refund does not go below zero", () => {
    const budget = new IterationBudget(2);
    budget.refund(); // used is already 0
    expect(budget.used).toBe(0);
  });

  it("exhausted returns true when used >= maxTotal", () => {
    const budget = new IterationBudget(1);
    expect(budget.exhausted).toBe(false);
    budget.consume();
    expect(budget.exhausted).toBe(true);
  });

  it("remaining returns correct count", () => {
    const budget = new IterationBudget(5);
    expect(budget.remaining).toBe(5);
    budget.consume();
    expect(budget.remaining).toBe(4);
    budget.consume();
    budget.consume();
    expect(budget.remaining).toBe(2);
  });

  it("remaining never goes below zero", () => {
    const budget = new IterationBudget(1);
    budget.consume();
    budget.consume(); // over-consume, returns false
    expect(budget.remaining).toBe(0);
  });

  it("reset clears used count", () => {
    const budget = new IterationBudget(3);
    budget.consume();
    budget.consume();
    budget.reset();
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(3);
    expect(budget.exhausted).toBe(false);
  });

  describe("createSubagentBudget", () => {
    it("creates budget with default 25 iterations", () => {
      const budget = createSubagentBudget();
      expect(budget.maxTotal).toBe(25);
      expect(budget.used).toBe(0);
    });

    it("creates budget with custom max", () => {
      const budget = createSubagentBudget(10);
      expect(budget.maxTotal).toBe(10);
    });
  });
});
