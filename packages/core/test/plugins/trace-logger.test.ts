import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../src/plugin.js";
import { createTraceLoggerPlugin } from "../../src/plugins/trace-logger.js";
import type { RunResult } from "../../src/types.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const makeCtx = (): PluginContext => ({
  traceId: "trace-123",
  channelType: "telegram",
  channelId: "chat-1",
  senderId: "user-1",
  state: new Map<string, unknown>(),
  logger,
});

const runResult: RunResult = {
  traceId: "trace-123",
  response: { text: "final" },
  stopReason: "end",
  toolCalls: [],
  usage: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0.1, output: 0.2, total: 0.3 },
  },
  durationMs: 55,
};

const readEntries = async (dir: string): Promise<Array<Record<string, unknown>>> => {
  const files = await readdir(dir);
  const file = files.find((name) => name.startsWith("traces-") && name.endsWith(".jsonl"));
  if (!file) {
    return [];
  }

  const raw = await readFile(join(dir, file), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("createTraceLoggerPlugin", () => {
  it("writes trace entries in expected order", async () => {
    const logDir = join(tmpdir(), `hairy-traces-${randomUUID()}`);
    const plugin = createTraceLoggerPlugin({ logDir });
    const ctx = makeCtx();

    await plugin.onRunStart?.(ctx);
    await plugin.beforeModel?.([], { model: "m" }, ctx);
    await plugin.afterModel?.("hello", [], ctx);
    await plugin.beforeTool?.("read", { path: "a" }, ctx);
    await plugin.afterTool?.("read", "ok", false, ctx);
    await plugin.onRunEnd?.(ctx, runResult, undefined);

    const entries = await readEntries(logDir);
    expect(entries.map((entry) => entry.type)).toEqual([
      "run_start",
      "model_request",
      "model_response",
      "tool_start",
      "tool_end",
      "run_end",
    ]);
  });

  it("creates log file with current UTC date", async () => {
    const logDir = join(tmpdir(), `hairy-traces-${randomUUID()}`);
    const plugin = createTraceLoggerPlugin({ logDir });
    const ctx = makeCtx();

    await plugin.onRunStart?.(ctx);

    const files = await readdir(logDir);
    const expectedPrefix = `traces-${new Date().toISOString().slice(0, 10)}`;
    expect(files.some((file) => file.startsWith(expectedPrefix))).toBe(true);
  });

  it("each entry includes traceId and timestamp", async () => {
    const logDir = join(tmpdir(), `hairy-traces-${randomUUID()}`);
    const plugin = createTraceLoggerPlugin({ logDir });
    const ctx = makeCtx();

    await plugin.onRunStart?.(ctx);
    await plugin.onRunEnd?.(ctx, runResult, undefined);

    const entries = await readEntries(logDir);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(entry.traceId).toBe("trace-123");
      expect(typeof entry.timestamp).toBe("string");
    }
  });

  it("includeContent=true stores request/response content", async () => {
    const logDir = join(tmpdir(), `hairy-traces-${randomUUID()}`);
    const plugin = createTraceLoggerPlugin({ logDir, includeContent: true });
    const ctx = makeCtx();

    await plugin.beforeModel?.(
      [{ role: "user", content: [{ type: "text", text: "question" }] }],
      { model: "m", systemPrompt: "sys" },
      ctx,
    );
    await plugin.afterModel?.("answer", [], ctx);

    const entries = await readEntries(logDir);
    const request = entries.find((entry) => entry.type === "model_request");
    const response = entries.find((entry) => entry.type === "model_response");

    expect(request?.requestContent).toBeDefined();
    expect(response?.responseText).toBe("answer");
  });

  it("default includeContent=false omits request/response content", async () => {
    const logDir = join(tmpdir(), `hairy-traces-${randomUUID()}`);
    const plugin = createTraceLoggerPlugin({ logDir });
    const ctx = makeCtx();

    await plugin.beforeModel?.(
      [{ role: "user", content: [{ type: "text", text: "question" }] }],
      { model: "m", systemPrompt: "sys" },
      ctx,
    );
    await plugin.afterModel?.("answer", [], ctx);

    const entries = await readEntries(logDir);
    const request = entries.find((entry) => entry.type === "model_request");
    const response = entries.find((entry) => entry.type === "model_response");

    expect(request?.requestContent).toBeUndefined();
    expect(response?.responseText).toBeUndefined();
  });
});
