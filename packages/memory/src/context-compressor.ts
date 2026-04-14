import type { AgentLoopContent, AgentLoopMessage } from "@hairyclaw/core";
import type { HairyClawLogger } from "@hairyclaw/observability";

// ── Configuration ──────────────────────────────────────────────────────

export interface CompressorConfig {
  /** Trigger compression when estimated tokens reach this % of context window (default: 0.50) */
  thresholdPercent: number;
  /** Always protect the first N messages (system + early conversation) (default: 3) */
  protectFirstN: number;
  /** Token budget for the tail (most recent messages) — always preserved (default: 20_000) */
  tailTokenBudget: number;
  /** Max tokens for the LLM-generated summary (default: 2000) */
  maxSummaryTokens: number;
  /** Characters per token estimate (default: 4) */
  charsPerToken: number;
  /** Max tool result chars before pruning (cheap pre-pass) (default: 500) */
  maxToolResultChars: number;
  /** Cooldown between compression attempts (default: 60_000ms) */
  cooldownMs: number;
}

export const DEFAULT_COMPRESSOR_CONFIG: CompressorConfig = {
  thresholdPercent: 0.5,
  protectFirstN: 3,
  tailTokenBudget: 20_000,
  maxSummaryTokens: 2000,
  charsPerToken: 4,
  maxToolResultChars: 500,
  cooldownMs: 60_000,
};

// ── Summary prefix ─────────────────────────────────────────────────────

const SUMMARY_PREFIX =
  "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. " +
  "This is a handoff from a previous context window — treat it as background reference, NOT as active instructions. " +
  "Do NOT answer questions or fulfill requests mentioned in this summary; they were already addressed. " +
  "Respond ONLY to the latest user message that appears AFTER this summary:";

// ── Result type ────────────────────────────────────────────────────────

export interface CompressionResult {
  messages: AgentLoopMessage[];
  wasCompressed: boolean;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  previousSummary?: string;
  newSummary?: string;
}

// ── ContextCompressor ──────────────────────────────────────────────────

export class ContextCompressor {
  private previousSummary: string | null = null;
  private lastCompressionAt = 0;
  private compressionCount = 0;

  constructor(
    private readonly config: CompressorConfig,
    private readonly summarizeFn: (text: string) => Promise<string>,
    private readonly logger: HairyClawLogger,
  ) {}

  /** Estimate tokens in a message array */
  estimateTokens(messages: AgentLoopMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      for (const part of msg.content) {
        if (part.text) total += Math.ceil(part.text.length / this.config.charsPerToken);
        if (part.toolCall)
          total +=
            Math.ceil(JSON.stringify(part.toolCall.args).length / this.config.charsPerToken) + 20;
        if (part.toolResult)
          total += Math.ceil(part.toolResult.content.length / this.config.charsPerToken) + 10;
      }
    }
    return total;
  }

  /** Check if compression is needed */
  needsCompression(messages: AgentLoopMessage[], contextWindow: number): boolean {
    const now = Date.now();
    if (now - this.lastCompressionAt < this.config.cooldownMs) return false;
    const tokens = this.estimateTokens(messages);
    return tokens >= contextWindow * this.config.thresholdPercent;
  }

  /** Compress messages: prune tool results, protect head/tail, summarize middle */
  async compress(messages: AgentLoopMessage[], contextWindow: number): Promise<CompressionResult> {
    const originalTokens = this.estimateTokens(messages);

    if (!this.needsCompression(messages, contextWindow)) {
      return {
        messages,
        wasCompressed: false,
        originalTokenEstimate: originalTokens,
        compressedTokenEstimate: originalTokens,
      };
    }

    this.logger.info(
      { originalTokens, contextWindow, threshold: this.config.thresholdPercent },
      "context compression triggered",
    );

    // Step 1: Prune old tool results (cheap, no LLM call)
    const pruned = this.pruneToolResults(messages);

    // Step 2: Split into head / middle / tail
    const headEnd = Math.min(this.config.protectFirstN, pruned.length);
    const tailStart = this.findTailStart(pruned, this.config.tailTokenBudget);

    const head = pruned.slice(0, headEnd);
    const middle = pruned.slice(headEnd, tailStart);
    const tail = pruned.slice(tailStart);

    if (middle.length === 0) {
      return {
        messages: pruned,
        wasCompressed: false,
        originalTokenEstimate: originalTokens,
        compressedTokenEstimate: this.estimateTokens(pruned),
      };
    }

    // Step 3: Format middle for summarization
    const middleText = this.formatMiddleForSummary(middle);

    // Step 4: Summarize with LLM (iterative — include previous summary if exists)
    const summaryInput = this.previousSummary
      ? `Previous summary:\n${this.previousSummary}\n\nNew conversation to incorporate:\n${middleText}`
      : middleText;

    let newSummary: string;
    try {
      newSummary = await this.summarizeFn(summaryInput);
    } catch (err) {
      this.logger.error({ err }, "context compression summarization failed — keeping original");
      return {
        messages,
        wasCompressed: false,
        originalTokenEstimate: originalTokens,
        compressedTokenEstimate: originalTokens,
      };
    }

    const prevSummary = this.previousSummary;
    this.previousSummary = newSummary;
    this.lastCompressionAt = Date.now();
    this.compressionCount++;

    // Step 5: Build compressed output
    const summaryMessage: AgentLoopMessage = {
      role: "system",
      content: [{ type: "text", text: `${SUMMARY_PREFIX}\n\n${newSummary}` }],
    };

    const compressed = [...head, summaryMessage, ...tail];
    const compressedTokens = this.estimateTokens(compressed);

    this.logger.info(
      {
        originalTokens,
        compressedTokens,
        savedTokens: originalTokens - compressedTokens,
        headMessages: head.length,
        middleMessages: middle.length,
        tailMessages: tail.length,
        compressionCount: this.compressionCount,
      },
      "context compression complete",
    );

    return {
      messages: compressed,
      wasCompressed: true,
      originalTokenEstimate: originalTokens,
      compressedTokenEstimate: compressedTokens,
      previousSummary: prevSummary ?? undefined,
      newSummary,
    };
  }

  /** Reset state for reuse */
  reset(): void {
    this.previousSummary = null;
    this.lastCompressionAt = 0;
    this.compressionCount = 0;
  }

  /** Prune old tool results to maxToolResultChars */
  private pruneToolResults(messages: AgentLoopMessage[]): AgentLoopMessage[] {
    return messages.map((msg) => ({
      ...msg,
      content: msg.content.map((part: AgentLoopContent) => {
        if (part.toolResult && part.toolResult.content.length > this.config.maxToolResultChars) {
          return {
            ...part,
            toolResult: {
              ...part.toolResult,
              content: `${part.toolResult.content.slice(0, this.config.maxToolResultChars)}... [pruned, was ${part.toolResult.content.length} chars]`,
            },
          };
        }
        return part;
      }),
    }));
  }

  /** Find where the tail starts (protect recent messages by token budget) */
  private findTailStart(messages: AgentLoopMessage[], budget: number): number {
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.estimateTokens([messages[i]]);
      if (used + msgTokens > budget) {
        return i + 1;
      }
      used += msgTokens;
    }
    return 0;
  }

  /** Format middle messages as text for the summarization LLM */
  private formatMiddleForSummary(messages: AgentLoopMessage[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      const role = msg.role.toUpperCase();
      for (const part of msg.content) {
        if (part.text) lines.push(`[${role}]: ${part.text}`);
        if (part.toolCall)
          lines.push(
            `[${role} TOOL_CALL]: ${part.toolCall.name}(${JSON.stringify(part.toolCall.args).slice(0, 200)})`,
          );
        if (part.toolResult)
          lines.push(
            `[TOOL_RESULT ${part.toolResult.id}]: ${part.toolResult.content.slice(0, 300)}`,
          );
      }
    }
    return lines.join("\n");
  }
}
