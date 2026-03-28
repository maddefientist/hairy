import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalSandboxProvider } from "../src/local-provider.js";

const createTempBaseDir = async (): Promise<string> => {
  return mkdtemp(join(tmpdir(), "hairy-sandbox-"));
};

describe("LocalSandboxProvider", () => {
  it("acquire creates thread directories", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });

    const sandbox = await provider.acquire("thread-1");
    expect(sandbox.id).toBeDefined();
    expect(sandbox.threadId).toBe("thread-1");

    expect(existsSync(join(baseDir, "thread-1", "workspace"))).toBe(true);
    expect(existsSync(join(baseDir, "thread-1", "uploads"))).toBe(true);
    expect(existsSync(join(baseDir, "thread-1", "outputs"))).toBe(true);
  });

  it("get retrieves an acquired sandbox", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });

    const sandbox = await provider.acquire("thread-2");
    expect(provider.get(sandbox.id)).toBe(sandbox);
  });

  it("get returns undefined for unknown sandbox id", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });

    expect(provider.get("nonexistent")).toBeUndefined();
  });

  it("executeCommand returns stdout and stderr", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });
    const sandbox = await provider.acquire("thread-3");

    const result = await sandbox.executeCommand("echo hello");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("executeCommand rejects blocked commands", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({
      baseDir,
      blockedCommands: ["rm", "sudo"],
    });
    const sandbox = await provider.acquire("thread-4");

    const result = await sandbox.executeCommand("rm -rf /");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("blocked");
  });

  it("executeCommand rejects commands not in allowed list", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({
      baseDir,
      allowedCommands: ["ls", "echo"],
    });
    const sandbox = await provider.acquire("thread-5");

    const result = await sandbox.executeCommand("curl http://evil.com");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not in the allowed");
  });

  it("executeCommand rejects shell operators", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });
    const sandbox = await provider.acquire("thread-6");

    const result = await sandbox.executeCommand("echo hello; rm -rf /");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("shell operators");
  });

  it("readFile and writeFile work through virtual paths", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });
    const sandbox = await provider.acquire("thread-7");

    await sandbox.writeFile("/workspace/test.txt", "sandbox content");
    const content = await sandbox.readFile("/workspace/test.txt");
    expect(content).toBe("sandbox content");

    // Verify the file is actually on disk at the right physical location
    const physical = await readFile(join(baseDir, "thread-7", "workspace", "test.txt"), "utf8");
    expect(physical).toBe("sandbox content");
  });

  it("writeFile with append flag appends content", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });
    const sandbox = await provider.acquire("thread-append");

    await sandbox.writeFile("/workspace/log.txt", "line1\n");
    await sandbox.writeFile("/workspace/log.txt", "line2\n", true);
    const content = await sandbox.readFile("/workspace/log.txt");
    expect(content).toBe("line1\nline2\n");
  });

  it("readFile rejects path traversal", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });
    const sandbox = await provider.acquire("thread-8");

    await expect(sandbox.readFile("/workspace/../../etc/passwd")).rejects.toThrow("path traversal");
  });

  it("writeFile rejects path traversal", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });
    const sandbox = await provider.acquire("thread-9");

    await expect(sandbox.writeFile("/workspace/../../../etc/evil", "pwned")).rejects.toThrow(
      "path traversal",
    );
  });

  it("release removes sandbox from active map but keeps files", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });

    const sandbox = await provider.acquire("thread-10");
    await sandbox.writeFile("/workspace/keep-me.txt", "important");

    await provider.release(sandbox.id);
    expect(provider.get(sandbox.id)).toBeUndefined();

    // File should still exist on disk
    const content = await readFile(join(baseDir, "thread-10", "workspace", "keep-me.txt"), "utf8");
    expect(content).toBe("important");
  });

  it("multiple sandboxes can coexist", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });

    const sandbox1 = await provider.acquire("thread-a");
    const sandbox2 = await provider.acquire("thread-b");

    await sandbox1.writeFile("/workspace/a.txt", "from A");
    await sandbox2.writeFile("/workspace/b.txt", "from B");

    expect(await sandbox1.readFile("/workspace/a.txt")).toBe("from A");
    expect(await sandbox2.readFile("/workspace/b.txt")).toBe("from B");

    // Sandbox A should not see sandbox B's files
    await expect(sandbox1.readFile("/workspace/b.txt")).rejects.toThrow();
  });

  it("listDir returns virtual paths", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });
    const sandbox = await provider.acquire("thread-list");

    await sandbox.writeFile("/workspace/file1.txt", "content1");
    await sandbox.writeFile("/workspace/sub/file2.txt", "content2");

    const entries = await sandbox.listDir("/workspace");
    expect(entries).toContain("/workspace/file1.txt");
    expect(entries).toContain("/workspace/sub");
    expect(entries).toContain("/workspace/sub/file2.txt");
  });

  it("executeCommand runs in workspace directory", async () => {
    const baseDir = await createTempBaseDir();
    const provider = new LocalSandboxProvider({ baseDir });
    const sandbox = await provider.acquire("thread-cwd");

    // Write a file and verify we can see it from a command
    await sandbox.writeFile("/workspace/marker.txt", "found");
    const result = await sandbox.executeCommand("cat marker.txt");
    expect(result.stdout.trim()).toBe("found");
    expect(result.exitCode).toBe(0);
  });
});
