import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalSandboxProvider } from "../src/local-provider.js";
import {
  createSandboxBashTool,
  createSandboxReadTool,
  createSandboxWriteTool,
} from "../src/tools.js";
import type { SandboxToolContext } from "../src/tools.js";
import type { Sandbox } from "../src/types.js";

const createTempBaseDir = async (): Promise<string> => {
  return mkdtemp(join(tmpdir(), "hairy-sandbox-tools-"));
};

const makeCtx = (cwd: string): SandboxToolContext => ({
  traceId: "test-trace",
  cwd,
  dataDir: cwd,
});

describe("sandbox tools", () => {
  describe("createSandboxBashTool", () => {
    it("routes through sandbox when available", async () => {
      const baseDir = await createTempBaseDir();
      const provider = new LocalSandboxProvider({ baseDir });
      const sandbox = await provider.acquire("tool-bash-1");

      const tool = createSandboxBashTool(() => sandbox);
      const ctx = makeCtx(baseDir);

      const result = await tool.execute({ command: "echo sandbox-active" }, ctx);
      expect(result.content).toContain("sandbox-active");
      expect(result.isError).toBeUndefined();
    });

    it("falls back to direct execution when no sandbox", async () => {
      const baseDir = await createTempBaseDir();
      const tool = createSandboxBashTool(() => undefined);
      const ctx = makeCtx(baseDir);

      const result = await tool.execute({ command: "echo direct-mode" }, ctx);
      expect(result.content).toContain("direct-mode");
    });

    it("returns error status for failed commands in sandbox", async () => {
      const baseDir = await createTempBaseDir();
      const provider = new LocalSandboxProvider({ baseDir });
      const sandbox = await provider.acquire("tool-bash-err");

      const tool = createSandboxBashTool(() => sandbox);
      const ctx = makeCtx(baseDir);

      const result = await tool.execute({ command: "false" }, ctx);
      expect(result.isError).toBe(true);
    });
  });

  describe("createSandboxReadTool", () => {
    it("reads files through sandbox using virtual paths", async () => {
      const baseDir = await createTempBaseDir();
      const provider = new LocalSandboxProvider({ baseDir });
      const sandbox = await provider.acquire("tool-read-1");

      await sandbox.writeFile("/workspace/hello.txt", "hello from sandbox");

      const tool = createSandboxReadTool(() => sandbox);
      const ctx = makeCtx(baseDir);

      const result = await tool.execute({ path: "/workspace/hello.txt" }, ctx);
      expect(result.content).toBe("hello from sandbox");
      expect(result.isError).toBeUndefined();
    });

    it("falls back to direct file read when no sandbox", async () => {
      const baseDir = await createTempBaseDir();
      const provider = new LocalSandboxProvider({ baseDir });
      const sandbox = await provider.acquire("tool-read-fallback");

      // Write a file at the physical location the fallback will try
      await sandbox.writeFile("/workspace/direct.txt", "direct content");
      const physicalPath = join(baseDir, "tool-read-fallback", "workspace", "direct.txt");

      const tool = createSandboxReadTool(() => undefined);
      const ctx = makeCtx(baseDir);

      const result = await tool.execute({ path: physicalPath }, ctx);
      expect(result.content).toBe("direct content");
    });

    it("returns error for missing files", async () => {
      const baseDir = await createTempBaseDir();
      const provider = new LocalSandboxProvider({ baseDir });
      const sandbox = await provider.acquire("tool-read-miss");

      const tool = createSandboxReadTool(() => sandbox);
      const ctx = makeCtx(baseDir);

      const result = await tool.execute({ path: "/workspace/nope.txt" }, ctx);
      expect(result.isError).toBe(true);
    });
  });

  describe("createSandboxWriteTool", () => {
    it("writes files through sandbox using virtual paths", async () => {
      const baseDir = await createTempBaseDir();
      const provider = new LocalSandboxProvider({ baseDir });
      const sandbox = await provider.acquire("tool-write-1");

      const tool = createSandboxWriteTool(() => sandbox);
      const ctx = makeCtx(baseDir);

      const result = await tool.execute(
        { path: "/workspace/output.txt", content: "written via tool" },
        ctx,
      );
      expect(result.content).toContain("wrote");
      expect(result.isError).toBeUndefined();

      const readBack = await sandbox.readFile("/workspace/output.txt");
      expect(readBack).toBe("written via tool");
    });

    it("falls back to direct file write when no sandbox", async () => {
      const baseDir = await createTempBaseDir();

      const tool = createSandboxWriteTool(() => undefined);
      const ctx = makeCtx(baseDir);

      const filePath = join(baseDir, "fallback-file.txt");
      const result = await tool.execute({ path: filePath, content: "direct write" }, ctx);
      expect(result.content).toContain("wrote");

      // Read back directly to verify
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(filePath, "utf8");
      expect(content).toBe("direct write");
    });

    it("returns error for path traversal in sandbox", async () => {
      const baseDir = await createTempBaseDir();
      const provider = new LocalSandboxProvider({ baseDir });
      const sandbox = await provider.acquire("tool-write-traversal");

      const tool = createSandboxWriteTool(() => sandbox);
      const ctx = makeCtx(baseDir);

      const result = await tool.execute(
        { path: "/workspace/../../../etc/evil", content: "pwned" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("path traversal");
    });
  });
});
