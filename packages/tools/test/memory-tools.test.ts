/**
 * Memory tool tests for typed memory parameters — M4 milestone.
 * Tests memory_recall and memory_ingest tools with new optional
 * memory_type, max_staleness, and extraction_source parameters.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryBackend } from "@hairyclaw/memory";
import { describe, expect, it, vi } from "vitest";
import { createMemoryIngestTool } from "../src/builtin/memory-ingest.js";
import { createMemoryRecallTool } from "../src/builtin/memory-recall.js";

const tmpFile = () => join(tmpdir(), `hairy-tool-mem-${randomUUID()}.json`);

// ── memory_recall tool ─────────────────────────────────────────────────

describe("memory_recall tool", () => {
  it("works without memory_type (backward compat)", async () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    await backend.store("test content", ["tag"]);
    const tool = createMemoryRecallTool(backend);

    const result = await tool.execute({ query: "test" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("test content");
  });

  it("accepts memory_type parameter", async () => {
    const path = tmpFile();
    const backend = new LocalMemoryBackend({ filePath: path });
    await backend.store("a decision", ["arch"], { memoryType: "decision" });
    await backend.store("a fact", ["info"], { memoryType: "fact" });

    const tool = createMemoryRecallTool(backend);
    const result = await tool.execute({ query: "decision fact", memory_type: "decision" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("a decision");
    expect(result.content).not.toContain("a fact");
  });

  it("accepts max_staleness parameter", async () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    await backend.store("content", []);
    const tool = createMemoryRecallTool(backend);

    // Local backend doesn't filter by staleness, but param should be accepted
    const result = await tool.execute({ query: "content", max_staleness: 0.5 });
    expect(result.isError).toBeFalsy();
  });

  it("rejects invalid memory_type", async () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    const tool = createMemoryRecallTool(backend);

    // Zod validation should reject invalid enum value
    const result = await tool.execute({ query: "test", memory_type: "invalid_type" });
    expect(result.isError).toBe(true);
  });

  it("rejects max_staleness > 1", async () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    const tool = createMemoryRecallTool(backend);

    const result = await tool.execute({ query: "test", max_staleness: 1.5 });
    expect(result.isError).toBe(true);
  });

  it("includes memory_type in formatted output", async () => {
    const path = tmpFile();
    const backend = new LocalMemoryBackend({ filePath: path });
    await backend.store("skill content", ["learn"], { memoryType: "skill" });

    const tool = createMemoryRecallTool(backend);
    const result = await tool.execute({ query: "skill" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("type=skill");
  });

  it("description mentions available memory types", () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    const tool = createMemoryRecallTool(backend);
    expect(tool.description).toContain("fact");
    expect(tool.description).toContain("decision");
    expect(tool.description).toContain("memory_type");
  });

  it("returns 'No recall results.' for empty results", async () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    const tool = createMemoryRecallTool(backend);
    const result = await tool.execute({ query: "nonexistent" });
    expect(result.content).toBe("No recall results.");
  });
});

// ── memory_ingest tool ─────────────────────────────────────────────────

describe("memory_ingest tool", () => {
  it("works without memory_type (backward compat)", async () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    const tool = createMemoryIngestTool(backend);

    const result = await tool.execute({ content: "plain knowledge" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("ingested");
  });

  it("accepts memory_type parameter", async () => {
    const path = tmpFile();
    const backend = new LocalMemoryBackend({ filePath: path });
    const tool = createMemoryIngestTool(backend);

    const result = await tool.execute({
      content: "use vitest for testing",
      memory_type: "decision",
    });
    expect(result.isError).toBeFalsy();

    // Verify it was stored with the type
    const searchResults = await backend.search("vitest", 5, { memoryType: "decision" });
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]?.memoryType).toBe("decision");
  });

  it("accepts extraction_source parameter", async () => {
    const path = tmpFile();
    const backend = new LocalMemoryBackend({ filePath: path });
    const tool = createMemoryIngestTool(backend);

    const result = await tool.execute({
      content: "extracted during session",
      memory_type: "fact",
      extraction_source: "session-extract",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("ingested");
  });

  it("rejects invalid memory_type", async () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    const tool = createMemoryIngestTool(backend);

    const result = await tool.execute({
      content: "test",
      memory_type: "bogus_type",
    });
    expect(result.isError).toBe(true);
  });

  it("rejects extraction_source > 256 chars", async () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    const tool = createMemoryIngestTool(backend);

    const result = await tool.execute({
      content: "test",
      extraction_source: "x".repeat(257),
    });
    expect(result.isError).toBe(true);
  });

  it("description mentions available memory types", () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    const tool = createMemoryIngestTool(backend);
    expect(tool.description).toContain("fact");
    expect(tool.description).toContain("memory_type");
  });

  it("works with tags and memory_type together", async () => {
    const path = tmpFile();
    const backend = new LocalMemoryBackend({ filePath: path });
    const tool = createMemoryIngestTool(backend);

    const result = await tool.execute({
      content: "prefer dark mode in IDE",
      tags: ["ui", "editor"],
      memory_type: "preference",
    });
    expect(result.isError).toBeFalsy();

    const searchResults = await backend.search("dark mode", 5, { memoryType: "preference" });
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]?.tags).toContain("ui");
  });
});
