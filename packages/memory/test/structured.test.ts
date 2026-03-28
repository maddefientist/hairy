import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StructuredMemory } from "../src/structured.js";
import type { FactCategory } from "../src/structured.js";

const tmpFile = () => join(tmpdir(), `hairy-structured-test-${randomUUID()}.json`);

const makeFact = (
  overrides: Partial<{
    content: string;
    category: FactCategory;
    confidence: number;
    source: string;
  }> = {},
) => ({
  content: overrides.content ?? "User prefers TypeScript",
  category: (overrides.category ?? "preference") as FactCategory,
  confidence: overrides.confidence ?? 0.8,
  source: overrides.source ?? "conversation",
});

describe("StructuredMemory", () => {
  it("load/save cycle preserves data", async () => {
    const filePath = tmpFile();
    const mem = new StructuredMemory({ filePath });

    mem.addFact(makeFact({ content: "User likes Rust" }));
    mem.updateUserContext({ workContext: "agent framework" });
    await mem.save();

    const mem2 = new StructuredMemory({ filePath });
    await mem2.load();

    const data = mem2.getData();
    expect(data.facts).toHaveLength(1);
    expect(data.facts[0].content).toBe("User likes Rust");
    expect(data.userContext.workContext).toBe("agent framework");

    // Verify the file on disk is valid JSON
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toBeDefined();
  });

  it("addFact creates fact with id and timestamp", () => {
    const mem = new StructuredMemory({ filePath: tmpFile() });
    const fact = mem.addFact(makeFact());

    expect(fact).not.toBeNull();
    expect(fact?.id).toBeDefined();
    expect(fact?.id.length).toBeGreaterThan(0);
    expect(fact?.createdAt).toBeDefined();
    expect(new Date(fact?.createdAt ?? "").getTime()).not.toBeNaN();
    expect(fact?.content).toBe("User prefers TypeScript");
    expect(fact?.category).toBe("preference");
    expect(fact?.confidence).toBe(0.8);
  });

  it("detects duplicates (same content, different casing)", () => {
    const mem = new StructuredMemory({ filePath: tmpFile() });

    const first = mem.addFact(makeFact({ content: "User prefers TypeScript" }));
    expect(first).not.toBeNull();

    // Same content, different case
    const dup = mem.addFact(makeFact({ content: "user PREFERS typescript" }));
    expect(dup).toBeNull();

    // Same content with extra whitespace
    const dupSpaces = mem.addFact(makeFact({ content: "  User   prefers   TypeScript  " }));
    expect(dupSpaces).toBeNull();

    expect(mem.getFacts()).toHaveLength(1);
  });

  it("getFacts filters by category", () => {
    const mem = new StructuredMemory({ filePath: tmpFile() });

    mem.addFact(makeFact({ content: "Prefers TypeScript", category: "preference" }));
    mem.addFact(makeFact({ content: "Uses pnpm", category: "knowledge" }));
    mem.addFact(makeFact({ content: "Ship v1 by March", category: "goal" }));
    mem.addFact(makeFact({ content: "Always tests code", category: "behavior" }));

    expect(mem.getFacts("preference")).toHaveLength(1);
    expect(mem.getFacts("knowledge")).toHaveLength(1);
    expect(mem.getFacts("goal")).toHaveLength(1);
    expect(mem.getFacts("behavior")).toHaveLength(1);
    expect(mem.getFacts("context")).toHaveLength(0);

    // No filter returns all
    expect(mem.getFacts()).toHaveLength(4);
  });

  it("updateUserContext merges partial updates", () => {
    const mem = new StructuredMemory({ filePath: tmpFile() });

    mem.updateUserContext({ workContext: "building agent framework" });
    expect(mem.getData().userContext.workContext).toBe("building agent framework");
    expect(mem.getData().userContext.personalContext).toBe("");

    mem.updateUserContext({ personalContext: "likes coffee" });
    expect(mem.getData().userContext.workContext).toBe("building agent framework");
    expect(mem.getData().userContext.personalContext).toBe("likes coffee");

    mem.updateUserContext({ topOfMind: "fixing tests" });
    expect(mem.getData().userContext.topOfMind).toBe("fixing tests");
    expect(mem.getData().userContext.workContext).toBe("building agent framework");
  });

  it("getPromptInjection formats correctly within char limit", () => {
    const mem = new StructuredMemory({ filePath: tmpFile(), maxInjectionChars: 5000 });

    mem.updateUserContext({
      workContext: "agent framework",
      personalContext: "coffee enthusiast",
      topOfMind: "structured memory task",
    });

    mem.addFact(
      makeFact({ content: "User prefers TypeScript over Python", category: "preference" }),
    );
    mem.addFact(makeFact({ content: "Project uses pnpm workspaces", category: "knowledge" }));
    mem.addFact(
      makeFact({ content: "Ship HairyClaw v1 by March", category: "goal", confidence: 0.7 }),
    );

    const injection = mem.getPromptInjection();

    expect(injection).toContain("<memory>");
    expect(injection).toContain("</memory>");
    expect(injection).toContain("## Current Context");
    expect(injection).toContain("- Work: agent framework");
    expect(injection).toContain("- Personal: coffee enthusiast");
    expect(injection).toContain("- Focus: structured memory task");
    expect(injection).toContain("## Known Facts");
    expect(injection).toContain("[preference] User prefers TypeScript over Python");
    expect(injection).toContain("[knowledge] Project uses pnpm workspaces");
    expect(injection).toContain("[goal] Ship HairyClaw v1 by March");
  });

  it("getPromptInjection truncates when over maxInjectionChars", () => {
    const mem = new StructuredMemory({ filePath: tmpFile(), maxInjectionChars: 100 });

    mem.updateUserContext({ workContext: "a very long work context that goes on and on" });
    for (let i = 0; i < 10; i++) {
      mem.addFact(
        makeFact({ content: `fact number ${i} with some extra content`, category: "knowledge" }),
      );
    }

    const injection = mem.getPromptInjection();
    expect(injection.length).toBeLessThanOrEqual(100);
    expect(injection).toContain("</memory>");
  });

  it("prune removes lowest-confidence facts when over limit", () => {
    const mem = new StructuredMemory({ filePath: tmpFile(), maxFacts: 3 });

    mem.addFact(makeFact({ content: "fact high conf", confidence: 0.95 }));
    mem.addFact(makeFact({ content: "fact medium conf", confidence: 0.8 }));
    mem.addFact(makeFact({ content: "fact low conf", confidence: 0.7 }));

    // Manually add a 4th to trigger prune
    // Force-add via internal data for this test
    expect(mem.getFacts()).toHaveLength(3);

    // Add another fact — should trigger prune
    const fourth = mem.addFact(makeFact({ content: "fact very high conf", confidence: 0.99 }));
    expect(fourth).not.toBeNull();

    const remaining = mem.getFacts();
    expect(remaining).toHaveLength(3);

    // The lowest confidence fact should be gone
    const contents = remaining.map((f) => f.content);
    expect(contents).not.toContain("fact low conf");
    expect(contents).toContain("fact high conf");
    expect(contents).toContain("fact very high conf");
  });

  it("max facts enforced on insertion", () => {
    const mem = new StructuredMemory({ filePath: tmpFile(), maxFacts: 2 });

    mem.addFact(makeFact({ content: "first fact", confidence: 0.9 }));
    mem.addFact(makeFact({ content: "second fact", confidence: 0.9 }));

    // Third should trigger prune of lowest
    const third = mem.addFact(makeFact({ content: "third fact", confidence: 0.95 }));
    expect(third).not.toBeNull();

    expect(mem.getFacts()).toHaveLength(2);
    const contents = mem.getFacts().map((f) => f.content);
    expect(contents).toContain("third fact");
  });

  it("rejects facts below confidence threshold", () => {
    const mem = new StructuredMemory({
      filePath: tmpFile(),
      confidenceThreshold: 0.8,
    });

    const low = mem.addFact(makeFact({ content: "low confidence fact", confidence: 0.5 }));
    expect(low).toBeNull();

    const borderline = mem.addFact(makeFact({ content: "borderline fact", confidence: 0.79 }));
    expect(borderline).toBeNull();

    const ok = mem.addFact(makeFact({ content: "good confidence fact", confidence: 0.8 }));
    expect(ok).not.toBeNull();

    expect(mem.getFacts()).toHaveLength(1);
  });

  it("load from nonexistent file starts with empty data", async () => {
    const mem = new StructuredMemory({ filePath: tmpFile() });
    await mem.load();

    const data = mem.getData();
    expect(data.facts).toHaveLength(0);
    expect(data.userContext.workContext).toBe("");
    expect(data.userContext.personalContext).toBe("");
    expect(data.userContext.topOfMind).toBe("");
  });
});
