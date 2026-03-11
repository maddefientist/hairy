import { describe, expect, it, vi } from "vitest";
import { createMemoryPreloadPlugin } from "../src/preloader.js";
import type { MemoryBackend, SearchResult } from "../src/types.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const makeBackend = (
  results: SearchResult[] = [],
): MemoryBackend & { search: ReturnType<typeof vi.fn> } => ({
  name: "test",
  store: vi.fn(async () => "id-1"),
  search: vi.fn(async () => results),
});

const userMessages = (text: string) => [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  },
];

describe("createMemoryPreloadPlugin", () => {
  it("no user message: no search and passthrough", async () => {
    const backend = makeBackend();
    const plugin = createMemoryPreloadPlugin({ backend, logger });

    const result = await plugin.beforeModel?.(
      [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
      { model: "m" },
      {
        traceId: "t",
        channelType: "cli",
        channelId: "c",
        senderId: "u",
        state: new Map(),
        logger,
      },
    );

    expect(backend.search).not.toHaveBeenCalled();
    expect(result?.opts.systemPrompt).toBeUndefined();
  });

  it("injects relevant memories into system prompt", async () => {
    const backend = makeBackend([
      {
        id: "1",
        content: "User prefers terse answers.",
        tags: ["style"],
        createdAt: "2025-01-01",
        score: 0.8,
      },
    ]);
    const plugin = createMemoryPreloadPlugin({ backend, logger });

    const result = await plugin.beforeModel?.(
      userMessages("How should you respond?"),
      { model: "m", systemPrompt: "Base prompt" },
      {
        traceId: "t",
        channelType: "cli",
        channelId: "c",
        senderId: "u",
        state: new Map(),
        logger,
      },
    );

    expect(result?.opts.systemPrompt).toContain("## Relevant Memories");
    expect(result?.opts.systemPrompt).toContain("User prefers terse answers.");
    expect(result?.opts.systemPrompt).toContain("Base prompt");
  });

  it("no memories found: passthrough without memory block", async () => {
    const backend = makeBackend([]);
    const plugin = createMemoryPreloadPlugin({ backend, logger });

    const result = await plugin.beforeModel?.(
      userMessages("unknown"),
      { model: "m", systemPrompt: "base" },
      {
        traceId: "t",
        channelType: "cli",
        channelId: "c",
        senderId: "u",
        state: new Map(),
        logger,
      },
    );

    expect(result?.opts.systemPrompt).toBe("base");
  });

  it("applies min score filter", async () => {
    const backend = makeBackend([
      {
        id: "1",
        content: "Low confidence",
        tags: [],
        createdAt: "2025-01-01",
        score: 0.2,
      },
      {
        id: "2",
        content: "High confidence",
        tags: [],
        createdAt: "2025-01-01",
        score: 0.9,
      },
    ]);
    const plugin = createMemoryPreloadPlugin({ backend, minScore: 0.5, logger });

    const result = await plugin.beforeModel?.(
      userMessages("confidence"),
      { model: "m" },
      {
        traceId: "t",
        channelType: "cli",
        channelId: "c",
        senderId: "u",
        state: new Map(),
        logger,
      },
    );

    expect(result?.opts.systemPrompt).toContain("High confidence");
    expect(result?.opts.systemPrompt).not.toContain("Low confidence");
  });

  it("enforces max chars limit", async () => {
    const longText = "A".repeat(300);
    const backend = makeBackend([
      {
        id: "1",
        content: longText,
        tags: [],
        createdAt: "2025-01-01",
        score: 0.95,
      },
    ]);
    const plugin = createMemoryPreloadPlugin({ backend, maxChars: 80, logger });

    const result = await plugin.beforeModel?.(
      userMessages("long"),
      { model: "m" },
      {
        traceId: "t",
        channelType: "cli",
        channelId: "c",
        senderId: "u",
        state: new Map(),
        logger,
      },
    );

    const prompt = result?.opts.systemPrompt ?? "";
    expect(prompt.length).toBeLessThanOrEqual(110);
  });

  it("respects topK", async () => {
    const backend = makeBackend([
      { id: "1", content: "one", tags: [], createdAt: "x", score: 0.9 },
      { id: "2", content: "two", tags: [], createdAt: "x", score: 0.8 },
      { id: "3", content: "three", tags: [], createdAt: "x", score: 0.7 },
    ]);
    const plugin = createMemoryPreloadPlugin({ backend, topK: 2, logger });

    const result = await plugin.beforeModel?.(
      userMessages("numbers"),
      { model: "m" },
      {
        traceId: "t",
        channelType: "cli",
        channelId: "c",
        senderId: "u",
        state: new Map(),
        logger,
      },
    );

    const prompt = result?.opts.systemPrompt ?? "";
    expect(prompt).toContain("one");
    expect(prompt).toContain("two");
    expect(prompt).not.toContain("three");
  });

  it("uses cache for duplicate search within ttl", async () => {
    const backend = makeBackend([
      { id: "1", content: "cached", tags: [], createdAt: "x", score: 0.9 },
    ]);
    const plugin = createMemoryPreloadPlugin({ backend, cacheTtlMs: 5_000, logger });

    const ctx = {
      traceId: "t",
      channelType: "cli" as const,
      channelId: "c",
      senderId: "u",
      state: new Map<string, unknown>(),
      logger,
    };

    await plugin.beforeModel?.(userMessages("same"), { model: "m" }, ctx);
    await plugin.beforeModel?.(userMessages("same"), { model: "m" }, ctx);

    expect(backend.search).toHaveBeenCalledTimes(1);
  });

  it("exposes beforeModel hook", () => {
    const backend = makeBackend();
    const plugin = createMemoryPreloadPlugin({ backend, logger });

    expect(plugin.name).toBe("memory_preload");
    expect(typeof plugin.beforeModel).toBe("function");
  });
});
