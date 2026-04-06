/**
 * Typed memory contract tests — M4 milestone.
 * Validates MemoryType enum, verification metadata, store/search options,
 * and backward compatibility across local and hive backends.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HiveMemoryBackend } from "../src/backends/hive.js";
import { LocalMemoryBackend } from "../src/backends/local.js";
import { SemanticMemory } from "../src/semantic.js";
import {
  MEMORY_TYPES,
  type MemoryType,
  type SearchOptions,
  type SearchResult,
  type StoreOptions,
  type VerificationMeta,
} from "../src/types.js";

const tmpFile = () => join(tmpdir(), `hairy-typed-mem-${randomUUID()}.json`);

// ── MemoryType enum ────────────────────────────────────────────────────

describe("MemoryType enum", () => {
  it("contains all 7 types matching hari-hive backend", () => {
    expect(MEMORY_TYPES).toEqual([
      "fact",
      "decision",
      "preference",
      "skill",
      "reference",
      "correction",
      "session_summary",
    ]);
  });

  it("has correct length", () => {
    expect(MEMORY_TYPES).toHaveLength(7);
  });

  it("values are assignable to MemoryType", () => {
    const t: MemoryType = "decision";
    expect(MEMORY_TYPES).toContain(t);
  });
});

// ── LocalMemoryBackend typed memory ────────────────────────────────────

describe("LocalMemoryBackend typed memory", () => {
  it("stores and retrieves memoryType", async () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    await backend.store("prefer dark mode", ["ui"], { memoryType: "preference" });
    const results = await backend.search("dark mode");
    expect(results[0]?.memoryType).toBe("preference");
  });

  it("filters search results by memoryType", async () => {
    const path = tmpFile();
    const backend = new LocalMemoryBackend({ filePath: path });
    await backend.store("use pnpm workspaces", ["tools"], { memoryType: "decision" });
    await backend.store("prefer dark mode", ["ui"], { memoryType: "preference" });
    await backend.store("TypeScript strict mode", ["code"], { memoryType: "fact" });

    const decisions = await backend.search("mode", 10, { memoryType: "decision" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.memoryType).toBe("decision");
    expect(decisions[0]?.content).toContain("pnpm");
  });

  it("returns all types when memoryType filter is omitted", async () => {
    const path = tmpFile();
    const backend = new LocalMemoryBackend({ filePath: path });
    await backend.store("fact one", [], { memoryType: "fact" });
    await backend.store("decision one", [], { memoryType: "decision" });
    await backend.store("untyped record", []);

    const results = await backend.search("one", 10);
    expect(results.length).toBe(3);
  });

  it("backward compat: store without options still works", async () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    const id = await backend.store("plain record", ["tag"]);
    expect(typeof id).toBe("string");
    const results = await backend.search("plain");
    expect(results[0]?.memoryType).toBeUndefined();
  });

  it("backward compat: search without options still works", async () => {
    const backend = new LocalMemoryBackend({ filePath: tmpFile() });
    await backend.store("content", ["tag"]);
    const results = await backend.search("content", 5);
    expect(results).toHaveLength(1);
  });
});

// ── SemanticMemory typed passthrough ───────────────────────────────────

describe("SemanticMemory typed memory passthrough", () => {
  it("passes StoreOptions through to backend", async () => {
    const path = tmpFile();
    const mem = new SemanticMemory({ filePath: path });
    await mem.store("a skill I learned", ["learning"], { memoryType: "skill" });
    const results = await mem.search("skill", 5, { memoryType: "skill" });
    expect(results[0]?.memoryType).toBe("skill");
  });

  it("passes SearchOptions through to backend", async () => {
    const path = tmpFile();
    const mem = new SemanticMemory({ filePath: path });
    await mem.store("correction A", [], { memoryType: "correction" });
    await mem.store("fact B", [], { memoryType: "fact" });

    const corrections = await mem.search("correction fact", 10, { memoryType: "correction" });
    expect(corrections).toHaveLength(1);
    expect(corrections[0]?.memoryType).toBe("correction");
  });

  it("works without options (backward compat)", async () => {
    const mem = new SemanticMemory({ filePath: tmpFile() });
    const id = await mem.store("untyped", []);
    expect(typeof id).toBe("string");
    const results = await mem.search("untyped");
    expect(results.length).toBeGreaterThan(0);
  });
});

// ── HiveMemoryBackend typed memory ─────────────────────────────────────

describe("HiveMemoryBackend typed memory", () => {
  it("sends memory_type on ingest when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ counts: { knowledge_items: 1 } }),
    });
    global.fetch = fetchMock;

    const backend = new HiveMemoryBackend({ apiUrl: "http://test-hive:8088" });
    await backend.store("a decision", ["arch"], { memoryType: "decision" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test-hive:8088/ingest");
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    const items = body.knowledge_items as Array<Record<string, unknown>>;
    expect(items[0]?.memory_type).toBe("decision");
  });

  it("sends extraction_source on ingest when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ counts: { knowledge_items: 1 } }),
    });
    global.fetch = fetchMock;

    const backend = new HiveMemoryBackend({ apiUrl: "http://test-hive:8088" });
    await backend.store("extracted fact", [], {
      memoryType: "fact",
      extractionSource: "session-extract",
    });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    const items = body.knowledge_items as Array<Record<string, unknown>>;
    expect(items[0]?.extraction_source).toBe("session-extract");
  });

  it("does not send memory_type when not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ counts: { knowledge_items: 1 } }),
    });
    global.fetch = fetchMock;

    const backend = new HiveMemoryBackend({ apiUrl: "http://test-hive:8088" });
    await backend.store("plain content", ["tag"]);

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    const items = body.knowledge_items as Array<Record<string, unknown>>;
    expect(items[0]?.memory_type).toBeUndefined();
  });

  it("sends memory_type filter on recall when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    global.fetch = fetchMock;

    const backend = new HiveMemoryBackend({ apiUrl: "http://test-hive:8088" });
    await backend.search("query", 5, { memoryType: "skill" });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.memory_type).toBe("skill");
  });

  it("sends max_staleness filter on recall when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    global.fetch = fetchMock;

    const backend = new HiveMemoryBackend({ apiUrl: "http://test-hive:8088" });
    await backend.search("query", 5, { maxStaleness: 0.5 });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.max_staleness).toBe(0.5);
  });

  it("does not send filters when options omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    global.fetch = fetchMock;

    const backend = new HiveMemoryBackend({ apiUrl: "http://test-hive:8088" });
    await backend.search("query", 5);

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.memory_type).toBeUndefined();
    expect(body.max_staleness).toBeUndefined();
  });

  it("parses memory_type from hive recall response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "item-1",
            scope: "knowledge",
            score: 0.9,
            snippet: "use pnpm for monorepos",
            tags: ["tools"],
            memory_type: "decision",
            last_verified_at: "2026-04-01T00:00:00Z",
            staleness_score: 0.1,
            extraction_source: "session-extract",
          },
        ],
      }),
    });
    global.fetch = fetchMock;

    const backend = new HiveMemoryBackend({ apiUrl: "http://test-hive:8088" });
    const results = await backend.search("pnpm", 5);

    expect(results).toHaveLength(1);
    expect(results[0]?.memoryType).toBe("decision");
    expect(results[0]?.verification).toBeDefined();
    expect(results[0]?.verification?.lastVerifiedAt).toBe("2026-04-01T00:00:00Z");
    expect(results[0]?.verification?.stalenessScore).toBe(0.1);
    expect(results[0]?.verification?.extractionSource).toBe("session-extract");
  });

  it("parses snippet field as content from hive recall response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "item-2",
            scope: "knowledge",
            score: 0.8,
            snippet: "snippet content here",
            tags: [],
          },
        ],
      }),
    });
    global.fetch = fetchMock;

    const backend = new HiveMemoryBackend({ apiUrl: "http://test-hive:8088" });
    const results = await backend.search("snippet", 5);
    expect(results[0]?.content).toBe("snippet content here");
  });

  it("handles recall response without typed memory fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "old-item",
            score: 0.7,
            content: "legacy content",
            tags: ["old"],
          },
        ],
      }),
    });
    global.fetch = fetchMock;

    const backend = new HiveMemoryBackend({ apiUrl: "http://test-hive:8088" });
    const results = await backend.search("legacy", 5);

    expect(results).toHaveLength(1);
    expect(results[0]?.memoryType).toBeUndefined();
    expect(results[0]?.verification).toBeUndefined();
  });

  it("ignores invalid memory_type values from response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "bad-type",
            score: 0.6,
            content: "content",
            tags: [],
            memory_type: "not_a_real_type",
          },
        ],
      }),
    });
    global.fetch = fetchMock;

    const backend = new HiveMemoryBackend({ apiUrl: "http://test-hive:8088" });
    const results = await backend.search("query", 5);
    expect(results[0]?.memoryType).toBeUndefined();
  });
});

// ── VerificationMeta parsing edge cases ────────────────────────────────

describe("VerificationMeta parsing", () => {
  it("returns undefined when no verification fields present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ id: "x", score: 0.5, content: "c", tags: [] }],
      }),
    });
    global.fetch = fetchMock;

    const backend = new HiveMemoryBackend({ apiUrl: "http://test:8088" });
    const results = await backend.search("q");
    expect(results[0]?.verification).toBeUndefined();
  });

  it("returns partial verification when only staleness_score present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ id: "x", score: 0.5, content: "c", tags: [], staleness_score: 0.42 }],
      }),
    });
    global.fetch = fetchMock;

    const backend = new HiveMemoryBackend({ apiUrl: "http://test:8088" });
    const results = await backend.search("q");
    expect(results[0]?.verification?.stalenessScore).toBe(0.42);
    expect(results[0]?.verification?.lastVerifiedAt).toBeUndefined();
  });
});
