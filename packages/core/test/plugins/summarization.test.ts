import { describe, expect, it, vi } from "vitest";
import type { AgentLoopMessage, AgentLoopStreamOptions } from "../../src/agent-loop.js";
import type { PluginContext } from "../../src/plugin.js";
import {
  createSummarizationPlugin,
  estimateTokens,
  truncateText,
} from "../../src/plugins/summarization.js";

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

const streamOpts: AgentLoopStreamOptions = { model: "test-model" };

const makeTextMessage = (role: AgentLoopMessage["role"], text: string): AgentLoopMessage => ({
  role,
  content: [{ type: "text", text }],
});

const makeToolResultMessage = (id: string, content: string): AgentLoopMessage => ({
  role: "user",
  content: [{ type: "tool_result", toolResult: { id, content } }],
});

const makeToolCallMessage = (
  id: string,
  name: string,
  args: unknown,
  text?: string,
): AgentLoopMessage => {
  const content: AgentLoopMessage["content"] = [];
  if (text) {
    content.push({ type: "text", text });
  }
  content.push({ type: "tool_call", toolCall: { id, name, args } });
  return { role: "assistant", content };
};

/** Generate a long string of given length */
const longText = (chars: number): string => "x".repeat(chars);

describe("estimateTokens", () => {
  it("estimates tokens from text content", () => {
    const messages: AgentLoopMessage[] = [makeTextMessage("user", "hello world")];
    // "hello world" = 11 chars => ceil(11/4) = 3
    expect(estimateTokens(messages)).toBe(3);
  });

  it("estimates tokens from tool call content", () => {
    const messages: AgentLoopMessage[] = [makeToolCallMessage("tc1", "bash", { cmd: "ls" })];
    // JSON.stringify({cmd:"ls"}) = '{"cmd":"ls"}' = 12 chars => ceil(12/4) + 20 = 23
    expect(estimateTokens(messages)).toBe(23);
  });

  it("estimates tokens from tool result content", () => {
    const messages: AgentLoopMessage[] = [makeToolResultMessage("tr1", "result text")];
    // "result text" = 11 chars => ceil(11/4) + 10 = 13
    expect(estimateTokens(messages)).toBe(13);
  });

  it("returns 0 for empty messages", () => {
    expect(estimateTokens([])).toBe(0);
  });
});

describe("truncateText", () => {
  it("returns text unchanged if under limit", () => {
    expect(truncateText("short", 100)).toBe("short");
  });

  it("truncates and appends info if over limit", () => {
    const result = truncateText("abcdefghij", 5);
    expect(result).toBe("abcde... [truncated, was 10 chars]");
  });

  it("returns exact text at boundary", () => {
    expect(truncateText("exact", 5)).toBe("exact");
  });
});

describe("createSummarizationPlugin", () => {
  it("short conversation passes through unchanged", async () => {
    const plugin = createSummarizationPlugin({ triggerTokens: 1000 });
    const messages: AgentLoopMessage[] = [
      makeTextMessage("user", "hello"),
      makeTextMessage("assistant", "hi there"),
    ];

    const result = await plugin.beforeModel?.(messages, streamOpts, ctx());

    expect(result).not.toBeNull();
    expect(result?.messages).toBe(messages); // same reference — no copy needed
    expect(result?.opts).toBe(streamOpts);
  });

  it("long conversation compresses old messages and keeps recent ones", async () => {
    // Each message ~1000 chars => ~250 tokens. 30 messages = ~7500 tokens
    const messages: AgentLoopMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(makeTextMessage(i % 2 === 0 ? "user" : "assistant", longText(1000)));
    }

    const plugin = createSummarizationPlugin({
      triggerTokens: 100, // very low threshold so it triggers
      keepMessages: 5,
    });

    const result = await plugin.beforeModel?.(messages, streamOpts, ctx());

    expect(result).not.toBeNull();
    // old: 25 compressed + 1 summary note + 5 recent = 31
    expect(result?.messages.length).toBe(31);

    // The summary note should be at index 25
    const summaryNote = result?.messages[25];
    expect(summaryNote?.role).toBe("system");
    expect(summaryNote?.content[0].text).toContain("25 messages compressed");

    // Recent messages should be identical to original last 5
    for (let i = 0; i < 5; i++) {
      expect(result?.messages[26 + i]).toEqual(messages[25 + i]);
    }
  });

  it("tool results in old messages get truncated", async () => {
    const messages: AgentLoopMessage[] = [
      makeTextMessage("user", longText(2000)),
      makeToolCallMessage("tc1", "bash", { cmd: "cat big-file.txt" }),
      makeToolResultMessage("tc1", longText(10000)), // huge tool result
      // recent messages
      makeTextMessage("user", longText(2000)),
      makeTextMessage("assistant", longText(2000)),
    ];

    const plugin = createSummarizationPlugin({
      triggerTokens: 100,
      keepMessages: 2,
      maxToolResultChars: 200,
    });

    const result = await plugin.beforeModel?.(messages, streamOpts, ctx());
    expect(result).not.toBeNull();

    // old messages: 3 compressed + 1 summary + 2 recent = 6
    expect(result?.messages.length).toBe(6);

    // The tool result (index 2) should be truncated
    const compressedToolResult = result?.messages[2];
    const toolResultPart = compressedToolResult?.content[0];
    expect(toolResultPart?.toolResult?.content.length).toBeLessThan(10000);
    expect(toolResultPart?.toolResult?.content).toContain("[truncated, was 10000 chars]");
  });

  it("system note injected at boundary", async () => {
    const messages: AgentLoopMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeTextMessage("user", longText(1000)));
    }

    const plugin = createSummarizationPlugin({
      triggerTokens: 100,
      keepMessages: 3,
    });

    const result = await plugin.beforeModel?.(messages, streamOpts, ctx());
    expect(result).not.toBeNull();

    // 7 old compressed + 1 summary + 3 recent = 11
    expect(result?.messages.length).toBe(11);

    const summaryIdx = 7;
    const summaryMsg = result?.messages[summaryIdx];
    expect(summaryMsg?.role).toBe("system");
    expect(summaryMsg?.content[0].text).toBe(
      "[Earlier conversation summarized. 7 messages compressed.]",
    );
  });

  it("keepMessages = 0 compresses everything except summary note", async () => {
    const messages: AgentLoopMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(makeTextMessage("user", longText(1000)));
    }

    const plugin = createSummarizationPlugin({
      triggerTokens: 100,
      keepMessages: 0,
    });

    const result = await plugin.beforeModel?.(messages, streamOpts, ctx());
    expect(result).not.toBeNull();

    // 5 compressed + 1 summary + 0 recent = 6
    expect(result?.messages.length).toBe(6);

    const summaryMsg = result?.messages[5];
    expect(summaryMsg?.role).toBe("system");
    expect(summaryMsg?.content[0].text).toContain("5 messages compressed");
  });

  it("custom triggerTokens respected", async () => {
    const messages: AgentLoopMessage[] = [
      makeTextMessage("user", longText(100)), // ~25 tokens
      makeTextMessage("assistant", longText(100)), // ~25 tokens
    ];

    // Threshold high enough — no compression
    const highPlugin = createSummarizationPlugin({ triggerTokens: 1000 });
    const highResult = await highPlugin.beforeModel?.(messages, streamOpts, ctx());
    expect(highResult?.messages).toBe(messages);

    // Threshold low enough — triggers compression
    const lowPlugin = createSummarizationPlugin({ triggerTokens: 10, keepMessages: 1 });
    const lowResult = await lowPlugin.beforeModel?.(messages, streamOpts, ctx());
    expect(lowResult?.messages.length).toBe(3); // 1 compressed + 1 summary + 1 recent
  });

  it("messages array not mutated (returns new array)", async () => {
    const messages: AgentLoopMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeTextMessage("user", longText(1000)));
    }
    const originalLength = messages.length;
    const originalFirst = messages[0];

    const plugin = createSummarizationPlugin({
      triggerTokens: 100,
      keepMessages: 3,
    });

    const result = await plugin.beforeModel?.(messages, streamOpts, ctx());

    // Original array is unchanged
    expect(messages.length).toBe(originalLength);
    expect(messages[0]).toBe(originalFirst);

    // Result is a different array
    expect(result?.messages).not.toBe(messages);
  });

  it("empty messages passes through", async () => {
    const plugin = createSummarizationPlugin({ triggerTokens: 100 });
    const messages: AgentLoopMessage[] = [];

    const result = await plugin.beforeModel?.(messages, streamOpts, ctx());
    expect(result).not.toBeNull();
    expect(result?.messages).toBe(messages);
    expect(result?.messages.length).toBe(0);
  });

  it("tool call args in old messages are compressed", async () => {
    const bigArgs = { data: longText(5000) };
    const messages: AgentLoopMessage[] = [
      makeTextMessage("user", "run something"),
      makeToolCallMessage("tc1", "bash", bigArgs, "let me run that"),
      makeToolResultMessage("tc1", "output here"),
      makeTextMessage("user", longText(2000)),
      makeTextMessage("assistant", longText(2000)),
    ];

    const plugin = createSummarizationPlugin({
      triggerTokens: 100,
      keepMessages: 2,
    });

    const result = await plugin.beforeModel?.(messages, streamOpts, ctx());
    expect(result).not.toBeNull();

    // old: 3 + 1 summary + 2 recent = 6
    expect(result?.messages.length).toBe(6);

    // The tool call (index 1) should have compressed args
    const compressedCall = result?.messages[1];
    const toolCallPart = compressedCall?.content.find((c) => c.toolCall);
    expect(toolCallPart?.toolCall?.args).toBe("[compressed]");
    expect(toolCallPart?.toolCall?.name).toBe("bash");
  });

  it("logs compression stats", async () => {
    const testCtx = ctx();
    const messages: AgentLoopMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeTextMessage("user", longText(1000)));
    }

    const plugin = createSummarizationPlugin({
      triggerTokens: 100,
      keepMessages: 3,
    });

    await plugin.beforeModel?.(messages, streamOpts, testCtx);

    expect(testCtx.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        originalTokens: expect.any(Number),
        compressedTokens: expect.any(Number),
        oldMessages: 7,
        recentMessages: 3,
        savedTokens: expect.any(Number),
      }),
      "context summarization applied",
    );
  });

  it("has priority 50 to run before other plugins", () => {
    const plugin = createSummarizationPlugin();
    expect(plugin.priority).toBe(50);
  });
});
