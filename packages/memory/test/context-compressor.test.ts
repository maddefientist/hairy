import type { AgentLoopContent, AgentLoopMessage } from "@hairyclaw/core";
import type { HairyClawLogger } from "@hairyclaw/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CompressorConfig,
  ContextCompressor,
  DEFAULT_COMPRESSOR_CONFIG,
} from "../src/context-compressor.js";

// ── Helpers ────────────────────────────────────────────────────────────

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

const textPart = (text: string): AgentLoopContent => ({ type: "text", text });

const textMessage = (role: AgentLoopMessage["role"], text: string): AgentLoopMessage => ({
  role,
  content: [textPart(text)],
});

const toolResultMessage = (id: string, content: string): AgentLoopMessage => ({
  role: "tool",
  content: [
    {
      type: "tool_result",
      toolResult: { id, content },
    },
  ],
});

const toolCallMessage = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): AgentLoopMessage => ({
  role: "assistant",
  content: [
    {
      type: "tool_call",
      toolCall: { id, name, args },
    },
  ],
});

/** Create a compressor with a controllable summarizeFn */
const createCompressor = (
  overrides: Partial<CompressorConfig> = {},
  summarizeFn?: (text: string) => Promise<string>,
) => {
  const config = { ...DEFAULT_COMPRESSOR_CONFIG, ...overrides };
  const summarize = summarizeFn ?? (() => Promise.resolve("summary of conversation"));
  return new ContextCompressor(config, summarize, mockLogger as unknown as HairyClawLogger);
};

// ── Tests ──────────────────────────────────────────────────────────────

describe("ContextCompressor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── estimateTokens ───────────────────────────────────────────────

  describe("estimateTokens", () => {
    it("estimates tokens from text content", () => {
      const compressor = createCompressor();
      // 100 chars at 4 chars/token = 25 tokens
      const messages = [textMessage("user", "a".repeat(100))];
      expect(compressor.estimateTokens(messages)).toBe(25);
    });

    it("estimates tokens from tool call content", () => {
      const compressor = createCompressor();
      const args = { key: "value" };
      const messages = [toolCallMessage("id1", "bash", args)];
      const tokens = compressor.estimateTokens(messages);
      const argsLen = JSON.stringify(args).length;
      expect(tokens).toBe(Math.ceil(argsLen / 4) + 20);
    });

    it("estimates tokens from tool result content", () => {
      const compressor = createCompressor();
      const messages = [toolResultMessage("id1", "a".repeat(40))];
      const tokens = compressor.estimateTokens(messages);
      // 40 chars / 4 = 10 + 10 overhead
      expect(tokens).toBe(20);
    });

    it("accumulates tokens across multiple messages", () => {
      const compressor = createCompressor();
      const messages = [
        textMessage("user", "a".repeat(40)), // 10 tokens
        textMessage("assistant", "b".repeat(80)), // 20 tokens
      ];
      expect(compressor.estimateTokens(messages)).toBe(30);
    });
  });

  // ── needsCompression ──────────────────────────────────────────────

  describe("needsCompression", () => {
    it("returns false when under threshold", () => {
      const compressor = createCompressor();
      const messages = [textMessage("user", "a".repeat(100))]; // 25 tokens
      expect(compressor.needsCompression(messages, 100_000)).toBe(false);
    });

    it("returns true when over threshold", () => {
      const compressor = createCompressor({ thresholdPercent: 0.5 });
      // 10_000 tokens (40_000 chars at 4 chars/token)
      const messages = [textMessage("user", "a".repeat(40_000))];
      expect(compressor.needsCompression(messages, 20_000)).toBe(true);
    });

    it("respects cooldown period", async () => {
      const summarizeFn = vi.fn(() => Promise.resolve("summary"));
      const compressor = createCompressor(
        { cooldownMs: 60_000, thresholdPercent: 0.01, protectFirstN: 1, tailTokenBudget: 5 },
        summarizeFn,
      );

      const messages: AgentLoopMessage[] = [
        textMessage("system", "sys"),
        textMessage("user", "a".repeat(400)), // 100 tokens → middle
        textMessage("assistant", "b".repeat(40)), // 10 tokens → tail
      ];

      // Trigger real compression to set lastCompressionAt
      const result = await compressor.compress(messages, 10);
      expect(result.wasCompressed).toBe(true);

      // After compression, needsCompression should be false due to cooldown
      expect(compressor.needsCompression(messages, 20_000)).toBe(false);
    });
  });

  // ── compress ─────────────────────────────────────────────────────

  describe("compress", () => {
    it("returns uncompressed result when under threshold", async () => {
      const compressor = createCompressor();
      const messages = [textMessage("user", "hello")];
      const result = await compressor.compress(messages, 1_000_000);
      expect(result.wasCompressed).toBe(false);
      expect(result.messages).toEqual(messages);
    });

    it("splits into head/middle/tail and summarizes middle", async () => {
      const summarizeFn = vi.fn(() => Promise.resolve("condensed summary"));
      const compressor = createCompressor(
        {
          thresholdPercent: 0.01, // very low threshold to trigger compression
          protectFirstN: 2,
          tailTokenBudget: 10, // only ~10 tokens for tail
          cooldownMs: 0,
        },
        summarizeFn,
      );

      // Build messages large enough that not everything fits in head + tail
      const messages: AgentLoopMessage[] = [
        textMessage("system", "system prompt"), // head [0]
        textMessage("user", "first user message"), // head [1]
        textMessage("assistant", "x".repeat(200)), // middle (50 tokens)
        textMessage("user", "y".repeat(200)), // middle (50 tokens)
        textMessage("assistant", "z".repeat(200)), // middle (50 tokens)
        textMessage("user", "recent question"), // tail
        textMessage("assistant", "recent response"), // tail
      ];

      const result = await compressor.compress(messages, 10);

      expect(result.wasCompressed).toBe(true);
      expect(summarizeFn).toHaveBeenCalledOnce();

      // Head (2) + summary (1) + tail
      expect(result.messages.length).toBeLessThan(messages.length);
      expect(result.messages[0]).toEqual(messages[0]); // head preserved
      expect(result.messages[1]).toEqual(messages[1]); // head preserved

      // Summary message inserted
      const summaryMsg = result.messages.find(
        (m) =>
          m.role === "system" &&
          m.content.some((p) => p.type === "text" && p.text?.includes("CONTEXT COMPACTION")),
      );
      expect(summaryMsg).toBeDefined();
      expect(summaryMsg?.content[0].text).toContain("condensed summary");
    });

    it("calls summarizeFn with formatted middle text", async () => {
      const summarizeFn = vi.fn(() => Promise.resolve("summary text"));
      const compressor = createCompressor(
        {
          thresholdPercent: 0.01,
          protectFirstN: 1,
          tailTokenBudget: 5, // tiny tail → most goes to middle
          cooldownMs: 0,
        },
        summarizeFn,
      );

      const messages: AgentLoopMessage[] = [
        textMessage("system", "sys"), // head
        textMessage("user", "middle question"), // middle
        textMessage("assistant", "recent answer"), // tail (small enough)
      ];

      const result = await compressor.compress(messages, 10);
      expect(result.wasCompressed).toBe(true);

      const calledWith = summarizeFn.mock.calls[0][0] as string;
      expect(calledWith).toContain("[USER]: middle question");
    });

    it("falls back gracefully on summarization failure", async () => {
      const summarizeFn = vi.fn(() => Promise.reject(new Error("LLM down")));
      const compressor = createCompressor(
        { thresholdPercent: 0.01, cooldownMs: 0, protectFirstN: 1, tailTokenBudget: 5 },
        summarizeFn,
      );

      const messages: AgentLoopMessage[] = [
        textMessage("system", "sys"),
        textMessage("user", "a".repeat(400)), // middle
        textMessage("assistant", "hi"), // tail
      ];

      const result = await compressor.compress(messages, 10);
      expect(result.wasCompressed).toBe(false);
      expect(result.messages).toEqual(messages); // original preserved (pre-prune)
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("returns CompressionResult with correct token estimates", async () => {
      const compressor = createCompressor({
        thresholdPercent: 0.01,
        protectFirstN: 1,
        tailTokenBudget: 5,
        cooldownMs: 0,
      });

      const messages: AgentLoopMessage[] = [
        textMessage("system", "sys"),
        textMessage("user", "a".repeat(40_000)),
        textMessage("assistant", "b".repeat(10)),
      ];

      const result = await compressor.compress(messages, 10);

      expect(result.wasCompressed).toBe(true);
      expect(result.originalTokenEstimate).toBeGreaterThan(0);
      expect(result.compressedTokenEstimate).toBeLessThan(result.originalTokenEstimate);
      expect(result.compressedTokenEstimate).toBeGreaterThan(0);
    });
  });

  // ── pruneToolResults ──────────────────────────────────────────────

  describe("pruneToolResults", () => {
    it("truncates tool results exceeding maxToolResultChars", async () => {
      const compressor = createCompressor({
        thresholdPercent: 0.01,
        maxToolResultChars: 10,
        protectFirstN: 1,
        tailTokenBudget: 40, // protect ~40 tokens of tail (enough for pruned result ~20 tokens + small msg)
        cooldownMs: 0,
      });

      // Build messages where the tool result is in the middle (will be summarized away)
      // BUT: we test pruning by checking the formattedMiddleForSummary input.
      // However, since pruning is applied before splitting, let's just verify
      // that the compressor's prune step was applied by putting the tool
      // result in the tail so it survives the compression.
      const messages: AgentLoopMessage[] = [
        textMessage("system", "sys"), // head
        textMessage("user", "x".repeat(200)), // middle (50 tokens)
        textMessage("assistant", "y".repeat(200)), // middle (50 tokens)
        toolResultMessage("id1", "a".repeat(1000)), // tail (pruned to ~10 chars + suffix)
        textMessage("user", "short tail msg"), // tail
      ];

      const result = await compressor.compress(messages, 10);
      expect(result.wasCompressed).toBe(true);

      // The pruned tool result should be in the output (it's in the tail)
      const prunedPart = result.messages
        .flatMap((m) => m.content)
        .find((p) => p.toolResult?.content.includes("[pruned"));

      expect(prunedPart).toBeDefined();
      expect(prunedPart?.toolResult?.content).toContain("[pruned, was 1000 chars]");
    });

    it("preserves short tool results unchanged", async () => {
      const compressor = createCompressor({ maxToolResultChars: 500, thresholdPercent: 0.5 });

      const messages: AgentLoopMessage[] = [toolResultMessage("id1", "short result")];

      expect(compressor.needsCompression(messages, 100_000)).toBe(false);
      const result = await compressor.compress(messages, 100_000);
      expect(result.messages[0].content[0].toolResult?.content).toBe("short result");
    });
  });

  // ── findTailStart ─────────────────────────────────────────────────

  describe("findTailStart respects token budget", () => {
    it("protects recent messages within tail budget", async () => {
      const compressor = createCompressor({
        thresholdPercent: 0.01,
        protectFirstN: 1,
        tailTokenBudget: 25, // only protect ~25 tokens
        cooldownMs: 0,
      });

      const messages: AgentLoopMessage[] = [
        textMessage("system", "system"), // head (1)
        textMessage("user", "middle 1"), // middle
        textMessage("assistant", "middle 2"), // middle
        textMessage("user", "a".repeat(60)), // 15 tokens, fits in 25 budget → tail
        textMessage("assistant", "b".repeat(40)), // 10 tokens, fits total 25 → tail
      ];

      const result = await compressor.compress(messages, 10);
      expect(result.wasCompressed).toBe(true);

      // Last messages in result should include the recent ones
      const tailTexts = result.messages
        .slice(-2)
        .flatMap((m) => m.content)
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text);

      expect(tailTexts.some((t) => t.includes("a".repeat(60)))).toBe(true);
    });
  });

  // ── iterative summaries ───────────────────────────────────────────

  describe("iterative compression", () => {
    it("includes previous summary in subsequent compression input", async () => {
      const summarizeFn = vi.fn(() => Promise.resolve("updated summary"));

      const compressor = createCompressor(
        {
          thresholdPercent: 0.01,
          protectFirstN: 1,
          tailTokenBudget: 5,
          cooldownMs: 0,
        },
        summarizeFn,
      );

      const messages1: AgentLoopMessage[] = [
        textMessage("system", "sys"),
        textMessage("user", "a".repeat(400)),
        textMessage("assistant", "answer 1"),
      ];

      // First compression
      const result1 = await compressor.compress(messages1, 10);
      expect(result1.wasCompressed).toBe(true);
      expect(result1.newSummary).toBe("updated summary");

      // Second compression with new messages
      const messages2: AgentLoopMessage[] = [
        ...result1.messages,
        textMessage("user", "c".repeat(400)),
        textMessage("assistant", "answer 2"),
      ];

      const result2 = await compressor.compress(messages2, 10);
      expect(result2.wasCompressed).toBe(true);

      // The second summarizeFn call should receive the previous summary
      const secondCallInput = summarizeFn.mock.calls[1][0] as string;
      expect(secondCallInput).toContain("Previous summary:");
      expect(secondCallInput).toContain("updated summary");
    });

    it("returns previousSummary and newSummary in result", async () => {
      let callCount = 0;
      const summarizeFn = vi.fn(() => {
        callCount++;
        return Promise.resolve(`summary v${callCount}`);
      });

      const compressor = createCompressor(
        {
          thresholdPercent: 0.01,
          protectFirstN: 1,
          tailTokenBudget: 5,
          cooldownMs: 0,
        },
        summarizeFn,
      );

      const messages: AgentLoopMessage[] = [
        textMessage("system", "sys"),
        textMessage("user", "a".repeat(400)),
        textMessage("assistant", "answer"),
      ];

      const result1 = await compressor.compress(messages, 10);
      expect(result1.newSummary).toBe("summary v1");

      const messages2: AgentLoopMessage[] = [
        ...result1.messages,
        textMessage("user", "b".repeat(400)),
        textMessage("assistant", "answer 2"),
      ];

      const result2 = await compressor.compress(messages2, 10);
      // previousSummary tracks the internal state BEFORE this compression,
      // which was "summary v1" — then it gets updated to "summary v2"
      expect(result2.previousSummary).toBe("summary v1");
      expect(result2.newSummary).toBe("summary v2");
    });
  });

  // ── reset ─────────────────────────────────────────────────────────

  describe("reset", () => {
    it("clears all internal state", async () => {
      const summarizeFn = vi.fn(() => Promise.resolve("summary"));
      const compressor = createCompressor(
        {
          thresholdPercent: 0.01,
          protectFirstN: 1,
          tailTokenBudget: 5,
          cooldownMs: 0,
        },
        summarizeFn,
      );

      const messages: AgentLoopMessage[] = [
        textMessage("system", "sys"),
        textMessage("user", "a".repeat(400)),
        textMessage("assistant", "answer"),
      ];

      // Compress to populate state
      const result1 = await compressor.compress(messages, 10);
      expect(result1.wasCompressed).toBe(true);
      expect(result1.newSummary).toBe("summary");

      // Reset
      compressor.reset();

      // After reset, a new compress should not include previous summary
      const result2 = await compressor.compress(messages, 10);
      expect(result2.wasCompressed).toBe(true);

      // The summarizeFn second call should NOT contain "Previous summary:"
      const secondCallInput = summarizeFn.mock.calls[1][0] as string;
      expect(secondCallInput).not.toContain("Previous summary:");
    });
  });

  // ── cooldown ──────────────────────────────────────────────────────

  describe("cooldown", () => {
    it("prevents compression within cooldown window", async () => {
      const summarizeFn = vi.fn(() => Promise.resolve("summary"));
      const compressor = createCompressor(
        {
          thresholdPercent: 0.01,
          protectFirstN: 1,
          tailTokenBudget: 5,
          cooldownMs: 60_000, // 1 minute cooldown
        },
        summarizeFn,
      );

      const messages: AgentLoopMessage[] = [
        textMessage("system", "sys"),
        textMessage("user", "a".repeat(400)),
        textMessage("assistant", "answer"),
      ];

      // First compression succeeds
      const result1 = await compressor.compress(messages, 10);
      expect(result1.wasCompressed).toBe(true);

      // Second compression within cooldown — returns unchanged
      const result2 = await compressor.compress(messages, 10);
      expect(result2.wasCompressed).toBe(false);
      expect(summarizeFn).toHaveBeenCalledOnce(); // not called again
    });
  });

  // ── empty middle ──────────────────────────────────────────────────

  describe("empty middle", () => {
    it("returns original when middle is empty after splitting", async () => {
      const summarizeFn = vi.fn(() => Promise.resolve("should not be called"));
      const compressor = createCompressor(
        {
          thresholdPercent: 0.01,
          protectFirstN: 2,
          tailTokenBudget: 100_000, // huge budget → all messages become tail
          cooldownMs: 0,
        },
        summarizeFn,
      );

      const messages: AgentLoopMessage[] = [
        textMessage("system", "sys"),
        textMessage("user", "hello"),
      ];

      const result = await compressor.compress(messages, 10);
      expect(result.wasCompressed).toBe(false);
      expect(summarizeFn).not.toHaveBeenCalled();
    });
  });

  // ── formatMiddleForSummary ───────────────────────────────────────

  describe("formatMiddleForSummary", () => {
    it("formats tool calls and results correctly in middle", async () => {
      const summarizeFn = vi.fn(() => Promise.resolve("summary"));
      const compressor = createCompressor(
        {
          thresholdPercent: 0.01,
          protectFirstN: 0,
          tailTokenBudget: 5, // tiny tail
          cooldownMs: 0,
        },
        summarizeFn,
      );

      const messages: AgentLoopMessage[] = [
        // All goes to middle since head=0 and tail=5 tokens
        textMessage("user", "user question"),
        toolCallMessage("tc1", "bash", { command: "ls" }),
        toolResultMessage("tc1", "file1.txt\nfile2.txt"),
        textMessage("assistant", "here are the files"),
      ];

      const result = await compressor.compress(messages, 10);
      expect(result.wasCompressed).toBe(true);

      const input = summarizeFn.mock.calls[0][0] as string;
      expect(input).toContain("[USER]: user question");
      expect(input).toContain("[ASSISTANT TOOL_CALL]: bash(");
      expect(input).toContain("[TOOL_RESULT tc1]:");
    });
  });
});
