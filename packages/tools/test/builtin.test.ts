import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
/**
 * Builtin tool tests — bash, read, write, edit.
 * These use real filesystem operations in temp directories.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBashTool } from "../src/builtin/bash.js";
import { createEditTool } from "../src/builtin/edit.js";
import { createReadTool } from "../src/builtin/read.js";
import { createWriteTool } from "../src/builtin/write.js";

const noopLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => noopLogger,
};

let tmpDir: string;

const ctx = () => ({
  traceId: "t-1",
  cwd: tmpDir,
  dataDir: tmpDir,
  logger: noopLogger,
});

beforeEach(async () => {
  tmpDir = join(tmpdir(), `hairy-tools-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── bash ──────────────────────────────────────────────────────────────────

describe("bash tool", () => {
  const bash = createBashTool();

  it("executes a simple command", async () => {
    const result = await bash.execute({ command: "echo hello" }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("hello");
  });

  it("returns stderr in output", async () => {
    const result = await bash.execute({ command: "echo warning >&2" }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("warning");
  });

  it("returns isError true on non-zero exit", async () => {
    const result = await bash.execute({ command: "exit 1" }, ctx());
    expect(result.isError).toBe(true);
  });

  it("times out slow commands", async () => {
    const result = await bash.execute({ command: "sleep 10", timeout: 50 }, ctx());
    expect(result.isError).toBe(true);
    // Node exec timeout produces "Command failed" or "timed out" depending on platform
    expect(result.content.length).toBeGreaterThan(0);
  }, 3000);

  it("rejects blocked commands", async () => {
    const safeBash = createBashTool({ blockedCommands: ["rm"] });
    const result = await safeBash.execute({ command: "rm -rf /" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked");
  });

  it("rejects commands not in allowlist", async () => {
    const safeBash = createBashTool({ allowedCommands: ["echo"] });
    const result = await safeBash.execute({ command: "ls -la" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not allowed");
  });

  it("allows commands in the allowlist", async () => {
    const safeBash = createBashTool({ allowedCommands: ["echo"] });
    const result = await safeBash.execute({ command: "echo hi" }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("hi");
  });
});

// ─── read ──────────────────────────────────────────────────────────────────

describe("read tool", () => {
  const read = createReadTool();

  it("reads a text file", async () => {
    const path = join(tmpDir, "hello.txt");
    await writeFile(path, "line 1\nline 2\nline 3\n", "utf8");

    const result = await read.execute({ path }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("line 1");
    expect(result.content).toContain("line 3");
  });

  it("respects offset and limit", async () => {
    const path = join(tmpDir, "multi.txt");
    await writeFile(path, "a\nb\nc\nd\ne\n", "utf8");

    const result = await read.execute({ path, offset: 2, limit: 2 }, ctx());
    expect(result.content).toContain("b");
    expect(result.content).toContain("c");
    expect(result.content).not.toContain("a");
    expect(result.content).not.toContain("d");
  });

  it("returns isError for missing file", async () => {
    const result = await read.execute({ path: join(tmpDir, "nonexistent.txt") }, ctx());
    expect(result.isError).toBe(true);
  });

  it("reads an image as base64", async () => {
    // Minimal 1x1 PNG bytes
    const pngBytes = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b55000000" +
        "0a49444154789c6260000000000200e221bc330000000049454e44ae426082",
      "hex",
    );
    const path = join(tmpDir, "pixel.png");
    await writeFile(path, pngBytes);

    const result = await read.execute({ path }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("image:.");
    expect(result.content).toContain("base64,");
  });
});

// ─── write ─────────────────────────────────────────────────────────────────

describe("write tool", () => {
  const write = createWriteTool();

  it("creates a new file with content", async () => {
    const path = join(tmpDir, "new.txt");
    const result = await write.execute({ path, content: "hello world" }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("wrote");

    const { readFile } = await import("node:fs/promises");
    const data = await readFile(path, "utf8");
    expect(data).toBe("hello world");
  });

  it("creates parent directories automatically", async () => {
    const path = join(tmpDir, "deep", "nested", "file.txt");
    const result = await write.execute({ path, content: "deep" }, ctx());
    expect(result.isError).toBeFalsy();
  });

  it("overwrites an existing file", async () => {
    const path = join(tmpDir, "overwrite.txt");
    await writeFile(path, "old content", "utf8");

    await write.execute({ path, content: "new content" }, ctx());

    const { readFile } = await import("node:fs/promises");
    const data = await readFile(path, "utf8");
    expect(data).toBe("new content");
  });

  it("rejects paths outside cwd", async () => {
    const result = await write.execute({ path: "/etc/passwd", content: "hacked" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("project root");
  });

  it("rejects path traversal attempts", async () => {
    const result = await write.execute({ path: "../../etc/passwd", content: "escaped" }, ctx());
    expect(result.isError).toBe(true);
  });
});

// ─── edit ──────────────────────────────────────────────────────────────────

describe("edit tool", () => {
  const edit = createEditTool();

  it("replaces exact text in a file", async () => {
    const path = join(tmpDir, "editable.ts");
    await writeFile(path, "const x = 1;\nconst y = 2;\n", "utf8");

    const result = await edit.execute(
      { path, oldText: "const x = 1;", newText: "const x = 42;" },
      ctx(),
    );

    expect(result.isError).toBeFalsy();

    const { readFile } = await import("node:fs/promises");
    const data = await readFile(path, "utf8");
    expect(data).toContain("const x = 42;");
    expect(data).toContain("const y = 2;");
  });

  it("returns isError when oldText not found", async () => {
    const path = join(tmpDir, "no-match.txt");
    await writeFile(path, "hello world", "utf8");

    const result = await edit.execute(
      { path, oldText: "this text does not exist", newText: "replacement" },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("rejects paths outside cwd", async () => {
    const result = await edit.execute(
      { path: "/etc/hosts", oldText: "localhost", newText: "evil" },
      ctx(),
    );
    expect(result.isError).toBe(true);
  });

  it("handles multiline replacements", async () => {
    const path = join(tmpDir, "multiline.txt");
    await writeFile(path, "line1\nline2\nline3\n", "utf8");

    await edit.execute({ path, oldText: "line1\nline2", newText: "replaced" }, ctx());

    const { readFile } = await import("node:fs/promises");
    const data = await readFile(path, "utf8");
    expect(data).toContain("replaced");
    expect(data).not.toContain("line1");
    expect(data).not.toContain("line2");
    expect(data).toContain("line3");
  });
});
