import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/registry.js";
import type { Tool } from "../src/types.js";

const noopLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => noopLogger,
};

const testCtx = {
  traceId: "trace-123",
  cwd: "/tmp",
  dataDir: "/tmp/data",
  logger: noopLogger,
};

const makeTool = (
  name: string,
  execute: (args: unknown) => Promise<{ content: string; isError?: boolean }>,
  timeoutMs?: number,
): Tool => ({
  name,
  description: `${name} tool`,
  parameters: z.object({ input: z.string() }),
  timeout_ms: timeoutMs,
  execute,
});

describe("ToolRegistry", () => {
  it("registers and retrieves tools", () => {
    const registry = new ToolRegistry({ logger: noopLogger });
    const tool = makeTool("echo", async (args) => ({
      content: (args as { input: string }).input,
    }));

    registry.register(tool);

    expect(registry.get("echo")).toBe(tool);
    expect(registry.list()).toHaveLength(1);
  });

  it("unregisters tools", () => {
    const registry = new ToolRegistry({ logger: noopLogger });
    registry.register(makeTool("echo", async () => ({ content: "ok" })));

    expect(registry.unregister("echo")).toBe(true);
    expect(registry.get("echo")).toBeUndefined();
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  it("returns error for unknown tool", async () => {
    const registry = new ToolRegistry({ logger: noopLogger });
    const result = await registry.execute("not-a-tool", {}, testCtx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("executes a tool with valid args", async () => {
    const registry = new ToolRegistry({ logger: noopLogger });
    registry.register(
      makeTool("greet", async (args) => ({
        content: `hello ${(args as { input: string }).input}`,
      })),
    );

    const result = await registry.execute("greet", { input: "world" }, testCtx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("hello world");
  });

  it("returns error when zod validation fails", async () => {
    const registry = new ToolRegistry({ logger: noopLogger });
    registry.register(makeTool("typed", async () => ({ content: "ok" })));

    // Pass wrong type for 'input' (number instead of string)
    const result = await registry.execute("typed", { input: 42 }, testCtx);

    expect(result.isError).toBe(true);
  });

  it("times out slow tools", async () => {
    const registry = new ToolRegistry({ logger: noopLogger });
    registry.register(
      makeTool(
        "slow",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return { content: "done" };
        },
        50, // 50ms timeout
      ),
    );

    const result = await registry.execute("slow", { input: "x" }, testCtx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timeout");
  }, 2000);

  it("catches tool execution errors", async () => {
    const registry = new ToolRegistry({ logger: noopLogger });
    registry.register(
      makeTool("boom", async () => {
        throw new Error("something exploded");
      }),
    );

    const result = await registry.execute("boom", { input: "x" }, testCtx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("something exploded");
  });

  it("lists all registered tools", () => {
    const registry = new ToolRegistry({ logger: noopLogger });
    registry.register(makeTool("a", async () => ({ content: "" })));
    registry.register(makeTool("b", async () => ({ content: "" })));
    registry.register(makeTool("c", async () => ({ content: "" })));

    const names = registry.list().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(names).toHaveLength(3);
  });
});
