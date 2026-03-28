import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UploadManager } from "../src/uploads.js";
import type { UploadManagerOptions, UploadedFile } from "../src/uploads.js";

const tmpBase = () => join(tmpdir(), `hairy-uploads-test-${randomUUID()}`);

const makeManager = (overrides: Partial<UploadManagerOptions> = {}): UploadManager =>
  new UploadManager({
    baseDir: overrides.baseDir ?? tmpBase(),
    maxFileSizeMb: overrides.maxFileSizeMb,
    maxFilesPerThread: overrides.maxFilesPerThread,
    convertDocuments: overrides.convertDocuments,
  });

const textContent = (text: string): Buffer => Buffer.from(text, "utf8");

describe("UploadManager", () => {
  it("upload stores file in thread directory", async () => {
    const baseDir = tmpBase();
    const mgr = makeManager({ baseDir });
    const threadId = "thread-1";

    const file = await mgr.upload(threadId, "notes.txt", textContent("hello world"), "text/plain");

    expect(file.id).toBeDefined();
    expect(file.originalName).toBe("notes.txt");
    expect(file.mimeType).toBe("text/plain");
    expect(file.sizeBytes).toBe(11);
    expect(file.virtualPath).toBe("/uploads/notes.txt");
    expect(file.uploadedAt).toBeDefined();

    // Verify physical file exists
    const st = await stat(file.storedPath);
    expect(st.isFile()).toBe(true);
    expect(file.storedPath.startsWith(join(baseDir, threadId))).toBe(true);
  });

  it("upload with conversion extracts text for text files", async () => {
    const mgr = makeManager({ convertDocuments: true });

    const file = await mgr.upload(
      "thread-1",
      "data.json",
      textContent('{"key": "value"}'),
      "application/json",
    );

    expect(file.convertedText).toBe('{"key": "value"}');
    expect(file.convertedPath).toBeDefined();

    // Verify converted file was written
    if (file.convertedPath) {
      const content = await readFile(file.convertedPath, "utf8");
      expect(content).toBe('{"key": "value"}');
    }
  });

  it("list returns all uploads for thread", async () => {
    const mgr = makeManager();

    await mgr.upload("thread-1", "a.txt", textContent("aaa"), "text/plain");
    await mgr.upload("thread-1", "b.txt", textContent("bbb"), "text/plain");

    const files = mgr.list("thread-1");
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.originalName).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("delete removes file and metadata", async () => {
    const mgr = makeManager();

    const file = await mgr.upload("thread-1", "temp.txt", textContent("tmp"), "text/plain");

    expect(mgr.list("thread-1")).toHaveLength(1);

    const deleted = await mgr.delete("thread-1", file.id);
    expect(deleted).toBe(true);
    expect(mgr.list("thread-1")).toHaveLength(0);

    // File should be removed from disk
    await expect(stat(file.storedPath)).rejects.toThrow();
  });

  it("delete returns false for unknown file", async () => {
    const mgr = makeManager();
    const result = await mgr.delete("thread-1", "nonexistent-id");
    expect(result).toBe(false);
  });

  it("different threads are isolated", async () => {
    const mgr = makeManager();

    await mgr.upload("thread-a", "a.txt", textContent("aaa"), "text/plain");
    await mgr.upload("thread-b", "b.txt", textContent("bbb"), "text/plain");

    expect(mgr.list("thread-a")).toHaveLength(1);
    expect(mgr.list("thread-a")[0].originalName).toBe("a.txt");
    expect(mgr.list("thread-b")).toHaveLength(1);
    expect(mgr.list("thread-b")[0].originalName).toBe("b.txt");
  });

  it("max files per thread enforced", async () => {
    const mgr = makeManager({ maxFilesPerThread: 2 });

    await mgr.upload("thread-1", "a.txt", textContent("a"), "text/plain");
    await mgr.upload("thread-1", "b.txt", textContent("b"), "text/plain");

    await expect(mgr.upload("thread-1", "c.txt", textContent("c"), "text/plain")).rejects.toThrow(
      /maximum of 2 uploaded files/,
    );
  });

  it("max file size enforced", async () => {
    const mgr = makeManager({ maxFileSizeMb: 1 });

    // Create a buffer just over 1MB
    const oversized = Buffer.alloc(1024 * 1024 + 1, "x");

    await expect(
      mgr.upload("thread-1", "big.bin", oversized, "application/octet-stream"),
    ).rejects.toThrow(/exceeds maximum size/);
  });

  it("getPromptContext formats file list correctly", async () => {
    const mgr = makeManager();

    await mgr.upload("thread-1", "report.txt", textContent("some text"), "text/plain");
    await mgr.upload("thread-1", "photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");

    const context = mgr.getPromptContext("thread-1");

    expect(context).toContain("## Uploaded Files");
    expect(context).toContain("report.txt");
    expect(context).toContain("photo.png");
    expect(context).toContain("[image]");
    expect(context).toContain("Use the read tool");
  });

  it("getPromptContext returns empty string when no uploads", () => {
    const mgr = makeManager();
    expect(mgr.getPromptContext("empty-thread")).toBe("");
  });

  it("text files read directly without conversion tool", async () => {
    const mgr = makeManager({ convertDocuments: true });

    const file = await mgr.upload("thread-1", "readme.md", textContent("# Hello"), "text/markdown");

    expect(file.convertedText).toBe("# Hello");
  });

  it("unknown mime types stored but not converted", async () => {
    const mgr = makeManager({ convertDocuments: true });

    const file = await mgr.upload(
      "thread-1",
      "mystery.xyz",
      Buffer.from([0x00, 0x01, 0x02]),
      "application/x-unknown",
    );

    expect(file.convertedText).toBeUndefined();
    expect(file.convertedPath).toBeUndefined();
    expect(file.sizeBytes).toBe(3);

    // File is still stored
    const st = await stat(file.storedPath);
    expect(st.isFile()).toBe(true);
  });

  it("conversion disabled skips text extraction", async () => {
    const mgr = makeManager({ convertDocuments: false });

    const file = await mgr.upload(
      "thread-1",
      "data.json",
      textContent('{"a": 1}'),
      "application/json",
    );

    expect(file.convertedText).toBeUndefined();
    expect(file.convertedPath).toBeUndefined();
  });

  it("list returns empty array for unknown thread", () => {
    const mgr = makeManager();
    expect(mgr.list("no-such-thread")).toEqual([]);
  });
});
