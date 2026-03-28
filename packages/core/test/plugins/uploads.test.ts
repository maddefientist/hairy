import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../src/plugin.js";
import type { UploadsPromptProvider } from "../../src/plugins/uploads.js";
import { createUploadsPlugin } from "../../src/plugins/uploads.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const ctx = (): PluginContext => ({
  traceId: "trace-1",
  channelType: "cli",
  channelId: "channel-1",
  senderId: "user-1",
  state: new Map<string, unknown>(),
  logger,
});

const mockUploadManager = (promptContext: string): UploadsPromptProvider => ({
  getPromptContext: vi.fn().mockReturnValue(promptContext),
});

describe("createUploadsPlugin", () => {
  it("injects upload context into system prompt", async () => {
    const mgr = mockUploadManager(
      "## Uploaded Files\n- report.pdf (application/pdf, 245.3KB) [converted to text]",
    );

    const plugin = createUploadsPlugin({
      uploadManager: mgr,
      threadId: "thread-1",
      maxInjectionChars: 1000,
    });

    const result = await plugin.beforeModel?.(
      [],
      { model: "test-model", systemPrompt: "You are helpful." },
      ctx(),
    );

    expect(result).not.toBeNull();
    expect(result?.opts.systemPrompt).toContain("You are helpful.");
    expect(result?.opts.systemPrompt).toContain("## Uploaded Files");
    expect(result?.opts.systemPrompt).toContain("report.pdf");
  });

  it("does nothing when no uploads", async () => {
    const mgr = mockUploadManager("");

    const plugin = createUploadsPlugin({
      uploadManager: mgr,
      threadId: "thread-1",
    });

    const originalOpts = { model: "test-model", systemPrompt: "Base prompt." };
    const result = await plugin.beforeModel?.([], originalOpts, ctx());

    expect(result).not.toBeNull();
    expect(result?.opts.systemPrompt).toBe("Base prompt.");
  });

  it("respects maxInjectionChars", async () => {
    const longContext = `## Uploaded Files\n${"x".repeat(1000)}`;
    const mgr = mockUploadManager(longContext);

    const plugin = createUploadsPlugin({
      uploadManager: mgr,
      threadId: "thread-1",
      maxInjectionChars: 50,
    });

    const result = await plugin.beforeModel?.([], { model: "test-model", systemPrompt: "" }, ctx());

    expect(result).not.toBeNull();
    // The injected context should be trimmed to maxInjectionChars
    const prompt = result?.opts.systemPrompt ?? "";
    expect(prompt.length).toBeLessThanOrEqual(50);
  });

  it("sets system prompt when none exists", async () => {
    const mgr = mockUploadManager("## Uploaded Files\n- file.txt");

    const plugin = createUploadsPlugin({
      uploadManager: mgr,
      threadId: "thread-1",
      maxInjectionChars: 500,
    });

    const result = await plugin.beforeModel?.([], { model: "test-model" }, ctx());

    expect(result).not.toBeNull();
    expect(result?.opts.systemPrompt).toContain("## Uploaded Files");
    expect(result?.opts.systemPrompt).not.toContain("\n\n## Uploaded Files");
  });

  it("preserves messages unchanged", async () => {
    const mgr = mockUploadManager("## Uploaded Files\n- file.txt");

    const plugin = createUploadsPlugin({
      uploadManager: mgr,
      threadId: "thread-1",
      maxInjectionChars: 500,
    });

    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
    ];
    const result = await plugin.beforeModel?.(messages, { model: "test-model" }, ctx());

    expect(result).not.toBeNull();
    expect(result?.messages).toBe(messages);
  });

  it("plugin has correct name", () => {
    const mgr = mockUploadManager("");
    const plugin = createUploadsPlugin({
      uploadManager: mgr,
      threadId: "thread-1",
    });

    expect(plugin.name).toBe("uploads");
  });
});
