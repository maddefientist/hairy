import type {
  ModelInfo,
  Provider,
  ProviderContent,
  ProviderMessage,
  StreamEvent,
  StreamOptions,
  ToolDefinition,
} from "./types.js";

interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
}

const mapThinkingBudget = (level: StreamOptions["thinkingLevel"]): number | undefined => {
  if (level === "high") return 4096;
  if (level === "medium") return 2048;
  if (level === "low") return 1024;
  return undefined;
};

/** Convert our ProviderMessage[] to Anthropic's message format */
const toAnthropicMessages = (
  messages: ProviderMessage[],
): Array<{ role: "user" | "assistant"; content: unknown }> => {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const blocks: unknown[] = [];

      for (const part of m.content) {
        if (part.type === "text" && typeof part.text === "string") {
          blocks.push({ type: "text", text: part.text });
        } else if (part.type === "tool_call" && part.toolCall) {
          // Assistant's tool_use block
          blocks.push({
            type: "tool_use",
            id: part.toolCall.id,
            name: part.toolCall.name,
            input: part.toolCall.args,
          });
        } else if (part.type === "tool_result" && part.toolResult) {
          // User's tool_result block
          blocks.push({
            type: "tool_result",
            tool_use_id: part.toolResult.id,
            content: part.toolResult.content,
            is_error: part.toolResult.isError ?? false,
          });
        }
      }

      // If only one text block, simplify to string
      if (
        blocks.length === 1 &&
        typeof blocks[0] === "object" &&
        blocks[0] !== null &&
        (blocks[0] as { type: string }).type === "text"
      ) {
        return {
          role: m.role as "user" | "assistant",
          content: (blocks[0] as { text: string }).text,
        };
      }

      return {
        role: m.role as "user" | "assistant",
        content: blocks,
      };
    });
};

/** Convert our ToolDefinition to Anthropic's tool format */
const toAnthropicTools = (
  tools: ToolDefinition[],
): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> => {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object",
      ...t.parameters,
    },
  }));
};

/** Type for Anthropic API response content block */
interface AnthropicContentBlock {
  type: "text" | "tool_use" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
}

interface AnthropicResponse {
  id?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage?: { input_tokens?: number; output_tokens?: number };
}

export const createAnthropicProvider = (opts: AnthropicOptions = {}): Provider => {
  const baseUrl = opts.baseUrl ?? "https://api.anthropic.com/v1";

  return {
    name: "anthropic",
    supportsImages: true,
    supportsThinking: true,

    async *stream(
      messages: ProviderMessage[],
      streamOpts: StreamOptions,
    ): AsyncIterable<StreamEvent> {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        yield { type: "error", error: "ANTHROPIC_API_KEY is missing" };
        return;
      }

      const body: Record<string, unknown> = {
        model: streamOpts.model,
        max_tokens: streamOpts.maxTokens ?? 4096,
        temperature: streamOpts.temperature,
        system: streamOpts.systemPrompt,
        messages: toAnthropicMessages(messages),
      };

      // Include tools if provided
      if (streamOpts.tools && streamOpts.tools.length > 0) {
        body.tools = toAnthropicTools(streamOpts.tools);
      }

      // Extended thinking
      if (streamOpts.thinkingLevel && streamOpts.thinkingLevel !== "off") {
        body.thinking = {
          type: "enabled",
          budget_tokens: mapThinkingBudget(streamOpts.thinkingLevel),
        };
      }

      const timeoutMs = streamOpts.timeoutMs ?? 120_000;

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (message.includes("abort") || message.includes("timeout")) {
          yield { type: "error", error: `request timed out after ${timeoutMs}ms` };
          return;
        }

        yield {
          type: "error",
          error: `anthropic unreachable: ${error instanceof Error ? error.message : "request failed"}`,
        };
        return;
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "unknown");
        yield {
          type: "error",
          error: `anthropic ${response.status}: ${errorBody}`,
        };
        return;
      }

      const payload = (await response.json()) as AnthropicResponse;

      // Emit usage
      if (payload.usage) {
        yield {
          type: "usage",
          usage: {
            input: payload.usage.input_tokens ?? 0,
            output: payload.usage.output_tokens ?? 0,
            costUsd: 0, // TODO: calculate from model pricing
          },
        };
      }

      // Process content blocks
      for (const block of payload.content ?? []) {
        if (block.type === "text" && block.text) {
          yield { type: "text_delta", text: block.text };
        } else if (block.type === "tool_use" && block.id && block.name) {
          yield {
            type: "tool_call_start",
            toolCallId: block.id,
            toolName: block.name,
          };
          // Emit the full args as a single delta
          if (block.input !== undefined) {
            yield {
              type: "tool_call_delta",
              toolCallId: block.id,
              toolArgsDelta: JSON.stringify(block.input),
            };
          }
          yield {
            type: "tool_call_end",
            toolCallId: block.id,
          };
        } else if (block.type === "thinking" && block.thinking) {
          yield { type: "thinking", text: block.thinking };
        }
      }

      yield {
        type: "stop",
        reason: payload.stop_reason === "tool_use" ? "tool_use" : "end",
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      return [
        {
          id: "claude-sonnet-4-20250514",
          name: "Claude Sonnet 4",
          provider: "anthropic",
          contextWindow: 200000,
          supportsImages: true,
          supportsThinking: true,
        },
        {
          id: "claude-haiku-3-5-20241022",
          name: "Claude 3.5 Haiku",
          provider: "anthropic",
          contextWindow: 200000,
          supportsImages: true,
          supportsThinking: false,
        },
      ];
    },
  };
};
