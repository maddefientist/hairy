import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SemanticMemory } from "../src/semantic.js";

const tmpFile = () => join(tmpdir(), `hairy-semantic-${randomUUID()}.json`);

describe("SemanticMemory (local)", () => {
  it("stores and retrieves a record", async () => {
    const mem = new SemanticMemory({ filePath: tmpFile() });
    const id = await mem.store("TypeScript is a typed superset of JavaScript.", ["programming"]);

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns empty array when no records exist", async () => {
    const mem = new SemanticMemory({ filePath: tmpFile() });
    const results = await mem.search("anything");
    expect(results).toHaveLength(0);
  });

  it("returns relevant records for a query", async () => {
    const mem = new SemanticMemory({ filePath: tmpFile() });

    await mem.store("The capital of France is Paris.", ["geography"]);
    await mem.store("TypeScript adds static typing to JavaScript.", ["programming"]);
    await mem.store("Paris is known for the Eiffel Tower.", ["geography"]);

    const results = await mem.search("Paris France capital", 3);
    expect(results.length).toBeGreaterThan(0);
    // The Paris/France records should score higher than TypeScript
    expect(results[0]?.content).not.toContain("TypeScript");
  });

  it("respects topK limit", async () => {
    const mem = new SemanticMemory({ filePath: tmpFile() });

    for (let i = 0; i < 10; i++) {
      await mem.store(`Record about topic ${i}.`, ["test"]);
    }

    const results = await mem.search("topic", 3);
    expect(results).toHaveLength(3);
  });

  it("scores zero for unrelated content", async () => {
    const mem = new SemanticMemory({ filePath: tmpFile() });
    await mem.store("Cats are wonderful pets.", ["animals"]);

    const results = await mem.search("quantum physics");
    // Should return the record but with score 0
    expect(results[0]?.score).toBe(0);
  });

  it("persists records across instances", async () => {
    const path = tmpFile();
    const m1 = new SemanticMemory({ filePath: path });
    await m1.store("persisted content", ["test"]);

    const m2 = new SemanticMemory({ filePath: path });
    const results = await m2.search("persisted");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toBe("persisted content");
  });

  it("falls back to local when hive API is unavailable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const mem = new SemanticMemory({
      filePath: tmpFile(),
      hiveApiUrl: "http://nonexistent-hive.local",
    });

    // Should not throw — falls back to local
    const id = await mem.store("fallback record", []);
    expect(typeof id).toBe("string");

    const results = await mem.search("fallback");
    expect(results.length).toBeGreaterThan(0);
  });
});
