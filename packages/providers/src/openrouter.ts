import type {
  ModelInfo,
  Provider,
  ProviderContent,
  ProviderMessage,
  StreamEvent,
  StreamOptions,
  ToolDefinition,
} from "./types.js";

interface OpenRouterOptions {
  apiKey?: string;
  baseUrl?: string;
}

/** Convert to OpenAI-compatible message format */
const toOpenAiMessages = (messages: ProviderMessage[]): Array<Record<string, unknown>> => {
  const result: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (m.role === "user" || m.role === "system") {
      // Collect text parts
      const text = m.content
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text ?? "")
        .join("\n");

      // Collect tool results (OpenAI puts these as separate "tool" role messages)
      const toolResults = m.content.filter((p) => p.type === "tool_result" && p.toolResult);

      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          if (!tr.toolResult) continue;
          result.push({
            role: "tool",
            tool_call_id: tr.toolResult.id,
            content: tr.toolResult.content,
          });
        }
      } else if (text) {
        result.push({ role: m.role, content: text });
      }
    } else if (m.role === "assistant") {
      const text = m.content
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text ?? "")
        .join("\n");

      const toolCalls = m.content
        .filter((p) => p.type === "tool_call" && p.toolCall)
        .map((p) => ({
          id: p.toolCall?.id ?? "",
          type: "function" as const,
          function: {
            name: p.toolCall?.name ?? "",
            arguments: JSON.stringify(p.toolCall?.args ?? {}),
          },
        }));

      const msg: Record<string, unknown> = {
        role: "assistant",
        content: text || null,
      };

      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }

      result.push(msg);
    }
  }

  return result;
};

/** Convert tools to OpenAI format */
const toOpenAiTools = (
  tools: ToolDefinition[],
): Array<{ type: "function"; function: Record<string, unknown> }> => {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: { type: "object", ...t.parameters },
    },
  }));
};

/** OpenAI tool call shape */
interface OaiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OaiChoice {
  message?: {
    content?: string | null;
    tool_calls?: OaiToolCall[];
  };
  finish_reason?: "stop" | "tool_calls" | "length";
}

interface OaiResponse {
  choices?: OaiChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export const createOpenRouterProvider = (opts: OpenRouterOptions = {}): Provider => {
  const baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";

  return {
    name: "openrouter",
    supportsImages: true,
    supportsThinking: false,

    async *stream(
      messages: ProviderMessage[],
      streamOpts: StreamOptions,
    ): AsyncIterable<StreamEvent> {
      const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        yield { type: "error", error: "OPENROUTER_API_KEY is missing" };
        return;
      }

      const body: Record<string, unknown> = {
        model: streamOpts.model,
        messages: toOpenAiMessages(messages),
        stream: false,
        temperature: streamOpts.temperature,
        max_tokens: streamOpts.maxTokens,
      };

      if (streamOpts.tools && streamOpts.tools.length > 0) {
        body.tools = toOpenAiTools(streamOpts.tools);
      }

      const timeoutMs = streamOpts.timeoutMs ?? 120_000;

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            "x-title": "Hairy Agent",
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
          error: `openrouter unreachable: ${error instanceof Error ? error.message : "request failed"}`,
        };
        return;
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "unknown");
        yield {
          type: "error",
          error: `openrouter ${response.status}: ${errorBody}`,
        };
        return;
      }

      const payload = (await response.json()) as OaiResponse;

      // Emit usage
      if (payload.usage) {
        yield {
          type: "usage",
          usage: {
            input: payload.usage.prompt_tokens ?? 0,
            output: payload.usage.completion_tokens ?? 0,
            costUsd: 0,
          },
        };
      }

      const choice = payload.choices?.[0];
      if (!choice?.message) {
        yield { type: "stop", reason: "end" };
        return;
      }

      // Emit text content
      if (choice.message.content) {
        yield { type: "text_delta", text: choice.message.content };
      }

      // Emit tool calls
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          const callId = tc.id ?? "";
          const name = tc.function?.name ?? "";
          const argsStr = tc.function?.arguments ?? "{}";

          yield {
            type: "tool_call_start",
            toolCallId: callId,
            toolName: name,
          };
          yield {
            type: "tool_call_delta",
            toolCallId: callId,
            toolArgsDelta: argsStr,
          };
          yield {
            type: "tool_call_end",
            toolCallId: callId,
          };
        }
      }

      const hasToolCalls = choice.message.tool_calls && choice.message.tool_calls.length > 0;
      yield {
        type: "stop",
        reason: hasToolCalls ? "tool_use" : "end",
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      return [];
    },
  };
};
