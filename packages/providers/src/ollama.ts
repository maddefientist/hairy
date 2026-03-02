/**
 * Ollama provider — uses /api/chat (not the legacy /api/generate).
 * Supports tool calling for models that implement it (llama3.1+, qwen2.5+, etc.)
 */
import type {
  ModelInfo,
  Provider,
  ProviderMessage,
  StreamEvent,
  StreamOptions,
  ToolDefinition,
} from "./types.js";

interface OllamaOptions {
  baseUrl?: string;
}

// ─── Conversion helpers ────────────────────────────────────────────────────

/** Ollama tool format (same shape as OpenAI function tools) */
const toOllamaTools = (
  tools: ToolDefinition[],
): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> =>
  tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: { type: "object", ...t.parameters },
    },
  }));

/** Convert our ProviderMessage[] to Ollama chat messages */
const toOllamaMessages = (messages: ProviderMessage[]): Array<Record<string, unknown>> => {
  const result: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (m.role === "system") {
      // Ollama accepts a system role in the messages array
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");
      if (text) result.push({ role: "system", content: text });
      continue;
    }

    if (m.role === "assistant") {
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");

      const toolCalls = m.content
        .filter((p) => p.type === "tool_call" && p.toolCall)
        .map((p) => ({
          type: "function",
          function: {
            name: p.toolCall?.name,
            arguments: p.toolCall?.args, // Ollama wants object, not string
          },
        }));

      const msg: Record<string, unknown> = {
        role: "assistant",
        content: text || "",
      };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      result.push(msg);
      continue;
    }

    // user role — may contain text or tool results
    const toolResults = m.content.filter((p) => p.type === "tool_result" && p.toolResult);

    if (toolResults.length > 0) {
      // Ollama tool results: one message per result, role "tool" + tool_name
      for (const p of toolResults) {
        if (!p.toolResult) continue;
        result.push({
          role: "tool",
          tool_name: p.toolResult.id, // Ollama uses tool_name not tool_call_id
          content: p.toolResult.content,
        });
      }
    } else {
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");
      if (text) result.push({ role: "user", content: text });
    }
  }

  return result;
};

// ─── Response types ─────────────────────────────────────────────────────────

interface OllamaToolCall {
  type?: string;
  function?: {
    index?: number;
    name?: string;
    arguments?: unknown; // object, not string!
  };
}

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ─── Provider ───────────────────────────────────────────────────────────────

export const createOllamaProvider = (opts: OllamaOptions = {}): Provider => {
  const baseUrl = opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

  return {
    name: "ollama",
    supportsImages: true,
    supportsThinking: false,

    async *stream(
      messages: ProviderMessage[],
      streamOpts: StreamOptions,
    ): AsyncIterable<StreamEvent> {
      const body: Record<string, unknown> = {
        model: streamOpts.model,
        messages: toOllamaMessages(messages),
        stream: false,
        options: {
          temperature: streamOpts.temperature,
          num_predict: streamOpts.maxTokens,
        },
      };

      if (streamOpts.systemPrompt) {
        // Prepend system message if not already in messages
        const existing = body.messages as Array<{ role: string }>;
        if (!existing.some((m) => m.role === "system")) {
          (body.messages as Array<unknown>).unshift({
            role: "system",
            content: streamOpts.systemPrompt,
          });
        }
      }

      if (streamOpts.tools && streamOpts.tools.length > 0) {
        body.tools = toOllamaTools(streamOpts.tools);
      }

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "network error";
        yield { type: "error", error: `ollama unreachable: ${msg}` };
        return;
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        yield { type: "error", error: `ollama ${response.status}: ${errBody}` };
        return;
      }

      const payload = (await response.json()) as OllamaChatResponse;

      // Emit usage
      if (payload.prompt_eval_count !== undefined || payload.eval_count !== undefined) {
        yield {
          type: "usage",
          usage: {
            input: payload.prompt_eval_count ?? 0,
            output: payload.eval_count ?? 0,
            costUsd: 0, // local, free
          },
        };
      }

      const msg = payload.message;
      if (!msg) {
        yield { type: "stop", reason: "end" };
        return;
      }

      // Text content
      if (msg.content) {
        yield { type: "text_delta", text: msg.content };
      }

      // Tool calls — Ollama arguments are already objects
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (let i = 0; i < msg.tool_calls.length; i++) {
          const tc = msg.tool_calls[i];
          if (!tc) continue;
          const callId = `ollama_call_${i}`;
          const name = tc.function?.name ?? "";
          const args = tc.function?.arguments ?? {};

          yield { type: "tool_call_start", toolCallId: callId, toolName: name };
          yield {
            type: "tool_call_delta",
            toolCallId: callId,
            toolArgsDelta: JSON.stringify(args),
          };
          yield { type: "tool_call_end", toolCallId: callId };
        }
        yield { type: "stop", reason: "tool_use" };
        return;
      }

      yield { type: "stop", reason: "end" };
    },

    async listModels(): Promise<ModelInfo[]> {
      try {
        const response = await fetch(`${baseUrl}/api/tags`);
        if (!response.ok) return [];

        const payload = (await response.json()) as unknown;
        if (typeof payload !== "object" || payload === null) return [];

        const models =
          (payload as { models?: Array<{ name?: string; details?: { parameter_size?: string } }> })
            .models ?? [];

        return models
          .filter((m): m is { name: string } => typeof m.name === "string")
          .map((m) => ({
            id: m.name,
            name: m.name,
            provider: "ollama",
            contextWindow: 8192,
            supportsImages: m.name.includes("llava") || m.name.includes("vision"),
            supportsThinking: false,
          }));
      } catch {
        return [];
      }
    },
  };
};
