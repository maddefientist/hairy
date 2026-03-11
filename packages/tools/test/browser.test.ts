import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createBrowserTool } from "../src/builtin/browser.js";
import type { Tool } from "../src/types.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const toolCtx = {
  traceId: "trace-1",
  cwd: process.cwd(),
  dataDir: process.cwd(),
  logger,
};

const makePlaywright = (overrides?: {
  title?: string;
  evaluate?: unknown;
  screenshot?: string | Buffer;
}) => {
  const page = {
    goto: vi.fn(async () => {}),
    title: vi.fn(async () => overrides?.title ?? "Example"),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    evaluate: vi.fn(async () => overrides?.evaluate ?? "Body text"),
    screenshot: vi.fn(async () => overrides?.screenshot ?? "base64-shot"),
  };

  return {
    page,
    module: {
      chromium: {
        launch: vi.fn(async () => ({
          newPage: vi.fn(async () => page),
        })),
      },
    },
  };
};

describe("createBrowserTool", () => {
  it("navigate returns page title + content", async () => {
    const { module } = makePlaywright({ title: "Docs", evaluate: "Hello world" });
    const tool = createBrowserTool({ loadPlaywright: async () => module as never });

    const result = await tool.execute({ action: "navigate", url: "https://example.com" }, toolCtx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Title: Docs");
    expect(result.content).toContain("Hello world");
  });

  it("screenshot returns base64 data", async () => {
    const { module } = makePlaywright({ screenshot: "abc123" });
    const tool = createBrowserTool({ loadPlaywright: async () => module as never });

    const result = await tool.execute(
      { action: "screenshot", url: "https://example.com" },
      toolCtx,
    );

    expect(result.content).toBe("abc123");
  });

  it("invalid URL returns error", async () => {
    const { module } = makePlaywright();
    const tool = createBrowserTool({ loadPlaywright: async () => module as never });

    const result = await tool.execute({ action: "navigate", url: "ftp://example.com" }, toolCtx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unsupported URL protocol");
  });

  it("gracefully falls back when Playwright is unavailable", async () => {
    const fallbackTool: Tool = {
      name: "web-fetch",
      description: "fallback",
      parameters: z.object({ url: z.string().url() }),
      execute: vi.fn(async () => ({ content: "Fetched fallback content" })),
    };

    const tool = createBrowserTool({
      loadPlaywright: async () => {
        throw new Error("playwright missing");
      },
      fallbackTool,
    });

    const navigateResult = await tool.execute(
      { action: "navigate", url: "https://example.com" },
      toolCtx,
    );
    const clickResult = await tool.execute({ action: "click", selector: "#btn" }, toolCtx);

    expect(navigateResult.content).toContain("using web-fetch fallback");
    expect(clickResult.isError).toBe(true);
  });
});
