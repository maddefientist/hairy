import type { AgentLoopContent, AgentLoopMessage, AgentLoopStreamOptions } from "../agent-loop.js";
import type { PluginManifest } from "../plugin-manifest.js";
import type { HairyClawPlugin, PluginContext } from "../plugin.js";

export const MANIFEST: PluginManifest = {
  name: "summarization",
  version: "1.0.0",
  description: "Compresses old context when token count exceeds threshold to keep prompts within limits",
  capabilities: ["context-summarization", "token-management"],
  requiredPermissions: [],
  trustLevel: "builtin",
};

export interface SummarizationOptions {
  triggerTokens?: number;
  keepMessages?: number;
  maxToolResultChars?: number;
}

const DEFAULT_TRIGGER_TOKENS = 80_000;
const DEFAULT_KEEP_MESSAGES = 20;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 500;

export const estimateTokens = (messages: AgentLoopMessage[]): number => {
  let total = 0;
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part.text) {
        total += Math.ceil(part.text.length / 4);
      }
      if (part.toolCall) {
        total += Math.ceil(JSON.stringify(part.toolCall.args).length / 4) + 20;
      }
      if (part.toolResult) {
        total += Math.ceil(part.toolResult.content.length / 4) + 10;
      }
    }
  }
  return total;
};

export const truncateText = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... [truncated, was ${text.length} chars]`;
};

const compressContent = (part: AgentLoopContent, maxToolResultChars: number): AgentLoopContent => {
  if (part.toolResult) {
    const toolId = part.toolResult.id;
    const content = part.toolResult.content;
    return {
      type: "tool_result",
      toolResult: {
        id: toolId,
        content: truncateText(content, maxToolResultChars),
        isError: part.toolResult.isError,
      },
    };
  }

  if (part.toolCall) {
    return {
      type: "tool_call",
      toolCall: {
        id: part.toolCall.id,
        name: part.toolCall.name,
        args: "[compressed]",
      },
    };
  }

  return part;
};

const compressMessage = (msg: AgentLoopMessage, maxToolResultChars: number): AgentLoopMessage => ({
  role: msg.role,
  content: msg.content.map((part) => compressContent(part, maxToolResultChars)),
});

export const createSummarizationPlugin = (opts?: SummarizationOptions): HairyClawPlugin => {
  const triggerTokens = opts?.triggerTokens ?? DEFAULT_TRIGGER_TOKENS;
  const keepMessages = opts?.keepMessages ?? DEFAULT_KEEP_MESSAGES;
  const maxToolResultChars = opts?.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;

  return {
    name: "summarization",
    priority: 50,

    beforeModel: async (
      messages: AgentLoopMessage[],
      streamOpts: AgentLoopStreamOptions,
      ctx: PluginContext,
    ): Promise<{ messages: AgentLoopMessage[]; opts: AgentLoopStreamOptions } | null> => {
      const totalTokens = estimateTokens(messages);

      if (totalTokens <= triggerTokens) {
        return { messages, opts: streamOpts };
      }

      const splitIndex = Math.max(0, messages.length - keepMessages);
      const oldMessages = messages.slice(0, splitIndex);
      const recentMessages = messages.slice(splitIndex);

      const compressed = oldMessages.map((msg) => compressMessage(msg, maxToolResultChars));

      const summaryNote: AgentLoopMessage = {
        role: "system",
        content: [
          {
            type: "text",
            text: `[Earlier conversation summarized. ${oldMessages.length} messages compressed.]`,
          },
        ],
      };

      const result = [...compressed, summaryNote, ...recentMessages];

      const compressedTokens = estimateTokens(result);
      ctx.logger.info(
        {
          originalTokens: totalTokens,
          compressedTokens,
          oldMessages: oldMessages.length,
          recentMessages: recentMessages.length,
          savedTokens: totalTokens - compressedTokens,
        },
        "context summarization applied",
      );

      return { messages: result, opts: streamOpts };
    },
  };
};
