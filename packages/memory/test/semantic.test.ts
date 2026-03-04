import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HiveMemoryBackend } from "../src/backends/hive.js";
import { LocalMemoryBackend } from "../src/backends/local.js";
import { SemanticMemory, createMemoryBackend } from "../src/semantic.js";

const tmpFile = () => join(tmpdir(), `hairy-semantic-${randomUUID()}.json`);

describe("SemanticMemory (local backend)", () => {
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

  it("reports backend name as 'local' by default", () => {
    const mem = new SemanticMemory({ filePath: tmpFile() });
    expect(mem.backendName).toBe("local");
  });
});

describe("SemanticMemory (hive backend with fallback)", () => {
  it("falls back to local when hive is unreachable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const hiveBackend = new HiveMemoryBackend({
      apiUrl: "http://nonexistent-hive.local",
    });
    const mem = new SemanticMemory({
      filePath: tmpFile(),
      backend: hiveBackend,
    });

    // Should not throw — SemanticMemory catches and falls back to local
    const id = await mem.store("fallback record", []);
    expect(typeof id).toBe("string");

    const results = await mem.search("fallback");
    expect(results.length).toBeGreaterThan(0);
  });

  it("reports backend name as 'hive' when hive configured", () => {
    const hiveBackend = new HiveMemoryBackend({
      apiUrl: "http://localhost:8088",
    });
    const mem = new SemanticMemory({
      filePath: tmpFile(),
      backend: hiveBackend,
    });
    expect(mem.backendName).toBe("hive");
  });
});

describe("createMemoryBackend", () => {
  it("returns local backend when no hive options provided and env unset", () => {
    // Use explicit opts without hive — skips env var detection
    const backend = createMemoryBackend({ filePath: tmpFile() });
    // If HARI_HIVE_URL is set in the real env, this will be hive — that's correct behavior
    const expectName = process.env.HARI_HIVE_URL ? "hive" : "local";
    expect(backend.name).toBe(expectName);
  });

  it("returns hive backend when explicit hive options provided", () => {
    const backend = createMemoryBackend({
      filePath: tmpFile(),
      hive: { apiUrl: "http://localhost:8088", namespace: "test" },
    });
    expect(backend.name).toBe("hive");
  });

  it("returns local backend when explicitly constructed without hive", () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    expect(backend.name).toBe("local");
  });
});

describe("LocalMemoryBackend", () => {
  it("implements MemoryBackend interface", async () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    expect(backend.name).toBe("local");
    const id = await backend.store("test content", ["tag1"]);
    expect(typeof id).toBe("string");
    const results = await backend.search("test", 5);
    expect(results.length).toBeGreaterThan(0);
  });
});
