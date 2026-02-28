import type { ModelInfo, Provider, ProviderMessage, StreamEvent, StreamOptions } from "./types.js";

interface OllamaOptions {
  baseUrl?: string;
}

const toPrompt = (messages: ProviderMessage[]): string => {
  return messages
    .flatMap((message) =>
      message.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => `${message.role.toUpperCase()}: ${part.text ?? ""}`),
    )
    .join("\n");
};

const readTextFromOllamaResponse = (payload: unknown): string => {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }

  const maybe = payload as { message?: { content?: unknown } };
  return typeof maybe.message?.content === "string" ? maybe.message.content : "";
};

export const createOllamaProvider = (opts: OllamaOptions = {}): Provider => {
  const baseUrl = opts.baseUrl ?? "http://localhost:11434";

  return {
    name: "ollama",
    supportsImages: true,
    supportsThinking: false,

    async *stream(
      messages: ProviderMessage[],
      streamOpts: StreamOptions,
    ): AsyncIterable<StreamEvent> {
      const response = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: streamOpts.model,
          prompt: toPrompt(messages),
          stream: false,
          options: {
            temperature: streamOpts.temperature,
            num_predict: streamOpts.maxTokens,
          },
        }),
      });

      if (!response.ok) {
        yield {
          type: "error",
          error: `ollama request failed with ${response.status}`,
        };
        return;
      }

      const payload = (await response.json()) as unknown;
      const text = readTextFromOllamaResponse(payload);
      if (text.length > 0) {
        yield { type: "text_delta", text };
      }
      yield { type: "stop", reason: "end" };
    },

    async listModels(): Promise<ModelInfo[]> {
      try {
        const response = await fetch(`${baseUrl}/api/tags`);
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
            supportsThinking: false,
          }));
      } catch {
        return [];
      }
    },
  };
};
