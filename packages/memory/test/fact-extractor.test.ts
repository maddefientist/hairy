import { describe, expect, it } from "vitest";
import { extractFacts } from "../src/fact-extractor.js";

describe("extractFacts", () => {
  it("extracts preference from 'I prefer TypeScript'", () => {
    const facts = extractFacts([{ role: "user", text: "I prefer TypeScript over Python." }]);

    expect(facts.length).toBeGreaterThanOrEqual(1);
    const preference = facts.find((f) => f.category === "preference");
    expect(preference).toBeDefined();
    expect(preference?.content.toLowerCase()).toContain("prefer");
    expect(preference?.content.toLowerCase()).toContain("typescript");
    expect(preference?.confidence).toBe(0.8);
  });

  it("extracts knowledge from 'We use pnpm workspaces'", () => {
    const facts = extractFacts([
      { role: "user", text: "We use pnpm workspaces for our monorepo." },
    ]);

    expect(facts.length).toBeGreaterThanOrEqual(1);
    const knowledge = facts.find((f) => f.category === "knowledge");
    expect(knowledge).toBeDefined();
    expect(knowledge?.content.toLowerCase()).toContain("pnpm workspaces");
    expect(knowledge?.confidence).toBe(0.75);
  });

  it("extracts goal from 'I want to ship by March'", () => {
    const facts = extractFacts([{ role: "user", text: "I want to ship by March." }]);

    expect(facts.length).toBeGreaterThanOrEqual(1);
    const goal = facts.find((f) => f.category === "goal");
    expect(goal).toBeDefined();
    expect(goal?.content.toLowerCase()).toContain("want to");
    expect(goal?.confidence).toBe(0.7);
  });

  it("extracts context from 'I'm working on an agent framework'", () => {
    const facts = extractFacts([{ role: "user", text: "I'm working on an agent framework." }]);

    expect(facts.length).toBeGreaterThanOrEqual(1);
    const context = facts.find((f) => f.category === "context");
    expect(context).toBeDefined();
    expect(context?.content.toLowerCase()).toContain("working on");
    expect(context?.confidence).toBe(0.7);
  });

  it("extracts behavior from 'I always test my code'", () => {
    const facts = extractFacts([{ role: "user", text: "I always test my code before merging." }]);

    expect(facts.length).toBeGreaterThanOrEqual(1);
    const behavior = facts.find((f) => f.category === "behavior");
    expect(behavior).toBeDefined();
    expect(behavior?.content.toLowerCase()).toContain("always");
    expect(behavior?.confidence).toBe(0.75);
  });

  it("returns no facts for generic statements", () => {
    const facts = extractFacts([
      { role: "user", text: "Hello, how are you?" },
      { role: "user", text: "Thanks for the help." },
      { role: "user", text: "Can you explain this code?" },
    ]);

    expect(facts).toHaveLength(0);
  });

  it("extracts multiple facts from one message with multiple patterns", () => {
    const facts = extractFacts([
      {
        role: "user",
        text: "I prefer TypeScript. I always write tests. I want to ship by Friday.",
      },
    ]);

    expect(facts.length).toBeGreaterThanOrEqual(3);

    const categories = facts.map((f) => f.category);
    expect(categories).toContain("preference");
    expect(categories).toContain("behavior");
    expect(categories).toContain("goal");
  });

  it("confidence scores are within expected ranges", () => {
    const facts = extractFacts([
      {
        role: "user",
        text: "I prefer Vim. We use Docker. I want to learn Go. Currently studying. I usually refactor.",
      },
    ]);

    for (const fact of facts) {
      expect(fact.confidence).toBeGreaterThanOrEqual(0.7);
      expect(fact.confidence).toBeLessThanOrEqual(1.0);
    }

    const preference = facts.find((f) => f.category === "preference");
    expect(preference?.confidence).toBe(0.8);

    const knowledge = facts.find((f) => f.category === "knowledge");
    expect(knowledge?.confidence).toBe(0.75);

    const goal = facts.find((f) => f.category === "goal");
    expect(goal?.confidence).toBe(0.7);
  });

  it("ignores assistant messages", () => {
    const facts = extractFacts([
      { role: "assistant", text: "I prefer TypeScript over Python." },
      { role: "assistant", text: "I always test my code." },
    ]);

    expect(facts).toHaveLength(0);
  });

  it("handles empty and whitespace-only messages", () => {
    const facts = extractFacts([
      { role: "user", text: "" },
      { role: "user", text: "   " },
    ]);

    expect(facts).toHaveLength(0);
  });

  it("deduplicates identical patterns within messages", () => {
    const facts = extractFacts([
      { role: "user", text: "I prefer TypeScript." },
      { role: "user", text: "I prefer TypeScript." },
    ]);

    const prefFacts = facts.filter((f) => f.content.toLowerCase().includes("typescript"));
    expect(prefFacts).toHaveLength(1);
  });
});
