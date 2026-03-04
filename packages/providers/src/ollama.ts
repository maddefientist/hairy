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

interface OllamaToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
  tool_name?: string;
}

interface OllamaChunk {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

const toObjectOrString = (value: unknown): unknown => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
};

const toOllamaMessages = (
  messages: ProviderMessage[],
  systemPrompt?: string,
): OllamaChatMessage[] => {
  const result: OllamaChatMessage[] = [];

  if (systemPrompt && systemPrompt.trim().length > 0) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const message of messages) {
    const text = message.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();

    const toolResults = message.content.filter(
      (part): part is { type: "tool_result"; toolResult: { id: string; content: string } } =>
        part.type === "tool_result" && part.toolResult !== undefined,
    );

    const toolCalls = message.content
      .filter(
        (
          part,
        ): part is { type: "tool_call"; toolCall: { id: string; name: string; args: unknown } } =>
          part.type === "tool_call" && part.toolCall !== undefined,
      )
      .map((part) => ({
        id: part.toolCall.id,
        type: "function",
        function: {
          name: part.toolCall.name,
          arguments: toObjectOrString(part.toolCall.args),
        },
      }));

    if (toolResults.length > 0) {
      for (const toolResult of toolResults) {
        result.push({
          role: "tool",
          content: toolResult.toolResult.content,
          tool_call_id: toolResult.toolResult.id,
          tool_name: toolResult.toolResult.id,
        });
      }
    }

    if (message.role === "assistant") {
      result.push({
        role: "assistant",
        ...(text ? { content: text } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (message.role === "system" || message.role === "user") {
      if (text.length > 0) {
        result.push({ role: message.role, content: text });
      }
      continue;
    }

    if (message.role === "tool" && text.length > 0) {
      result.push({ role: "tool", content: text });
    }
  }

  return result;
};

const toOllamaTools = (
  tools: ToolDefinition[],
): Array<{ type: "function"; function: Record<string, unknown> }> => {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        ...tool.parameters,
      },
    },
  }));
};

const emitChunk = (
  chunk: OllamaChunk,
  emit: (event: StreamEvent) => void,
  nextToolCallId: () => string,
): void => {
  const msg = chunk.message;
  if (!msg) {
    return;
  }

  if (typeof msg.thinking === "string" && msg.thinking.length > 0) {
    emit({ type: "thinking", text: msg.thinking });
  }

  if (typeof msg.content === "string" && msg.content.length > 0) {
    emit({ type: "text_delta", text: msg.content });
  }

  for (const toolCall of msg.tool_calls ?? []) {
    const callId = toolCall.id ?? nextToolCallId();
    const toolName = toolCall.function?.name ?? "unknown_tool";
    const argsRaw = toolCall.function?.arguments;
    const args = typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw ?? {});

    emit({ type: "tool_call_start", toolCallId: callId, toolName });
    emit({ type: "tool_call_delta", toolCallId: callId, toolArgsDelta: args });
    emit({ type: "tool_call_end", toolCallId: callId });
  }
};

const parseDoneReason = (chunk: OllamaChunk): string => {
  const reason = chunk.done_reason;
  if (reason === "tool_calls" || reason === "tool_call") return "tool_use";
  if ((chunk.message?.tool_calls?.length ?? 0) > 0) return "tool_use";
  return "end";
};

export const createOllamaProvider = (opts: OllamaOptions = {}): Provider => {
  const baseUrl = opts.baseUrl ?? "http://localhost:11434";

  return {
    name: "ollama",
    supportsImages: true,
    supportsThinking: true,

    async *stream(
      messages: ProviderMessage[],
      streamOpts: StreamOptions,
    ): AsyncIterable<StreamEvent> {
      const requestBody: Record<string, unknown> = {
        model: streamOpts.model,
        messages: toOllamaMessages(messages, streamOpts.systemPrompt),
        stream: true,
        options: {
          temperature: streamOpts.temperature,
          num_predict: streamOpts.maxTokens,
        },
      };

      if (streamOpts.thinkingLevel && streamOpts.thinkingLevel !== "off") {
        requestBody.think = streamOpts.thinkingLevel;
      }

      if (streamOpts.tools && streamOpts.tools.length > 0) {
        requestBody.tools = toOllamaTools(streamOpts.tools);
      }

      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody),
        });
      } catch (error: unknown) {
        yield {
          type: "error",
          error: `ollama unreachable: ${error instanceof Error ? error.message : "request failed"}`,
        };
        return;
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "unknown");
        yield {
          type: "error",
          error: `ollama request failed with ${response.status}: ${errorBody}`,
        };
        return;
      }

      let toolCounter = 0;
      const nextToolCallId = (): string => {
        toolCounter += 1;
        return `ollama-call-${toolCounter}`;
      };

      const queuedEvents: StreamEvent[] = [];
      const emit = (event: StreamEvent): void => {
        queuedEvents.push(event);
      };

      let stopEmitted = false;

      const consumeChunk = (chunk: OllamaChunk): void => {
        emitChunk(chunk, emit, nextToolCallId);

        if (chunk.done) {
          emit({
            type: "usage",
            usage: {
              input: chunk.prompt_eval_count ?? 0,
              output: chunk.eval_count ?? 0,
              costUsd: 0,
            },
          });
          emit({ type: "stop", reason: parseDoneReason(chunk) });
          stopEmitted = true;
        }
      };

      if (!response.body) {
        const payload = (await response.json()) as OllamaChunk;
        consumeChunk(payload);
        while (queuedEvents.length > 0) {
          yield queuedEvents.shift() as StreamEvent;
        }
        if (!stopEmitted) {
          yield { type: "stop", reason: "end" };
        }
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const rawLine = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          if (rawLine.length > 0) {
            const normalized = rawLine.startsWith("data:")
              ? rawLine.slice("data:".length).trim()
              : rawLine;

            if (normalized !== "[DONE]") {
              try {
                const chunk = JSON.parse(normalized) as OllamaChunk;
                consumeChunk(chunk);
              } catch {
                // Ignore malformed chunk and continue streaming.
              }
            }
          }

          while (queuedEvents.length > 0) {
            yield queuedEvents.shift() as StreamEvent;
          }

          newlineIdx = buffer.indexOf("\n");
        }
      }

      const trailing = buffer.trim();
      if (trailing.length > 0 && trailing !== "[DONE]") {
        try {
          const chunk = JSON.parse(trailing) as OllamaChunk;
          consumeChunk(chunk);
          while (queuedEvents.length > 0) {
            yield queuedEvents.shift() as StreamEvent;
          }
        } catch {
          // Ignore trailing malformed chunk.
        }
      }

      if (!stopEmitted) {
        yield { type: "stop", reason: "end" };
      }
    },

    async listModels(): Promise<ModelInfo[]> {
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`);
        if (!response.ok) {
          return [];
        }

        const payload = (await response.json()) as unknown;
        if (typeof payload !== "object" || payload === null) {
          return [];
        }

        const models = (payload as { models?: Array<{ name?: string }> }).models ?? [];
        return models
          .filter((model): model is { name: string } => typeof model.name === "string")
          .map((model) => ({
            id: model.name,
            name: model.name,
            provider: "ollama",
            contextWindow: 8192,
            supportsImages: true,
            supportsThinking: true,
          }));
      } catch {
        return [];
      }
    },
  };
};
