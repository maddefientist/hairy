/**
 * Google Gemini provider — native REST API (no SDK dependency).
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * Supports tool/function calling via `functionDeclarations`.
 * Models: gemini-2.0-flash, gemini-2.5-pro, gemini-1.5-flash, etc.
 */
import type {
  ModelInfo,
  Provider,
  ProviderMessage,
  StreamEvent,
  StreamOptions,
  ToolDefinition,
} from "./types.js";

interface GeminiOptions {
  apiKey?: string;
  baseUrl?: string;
}

// ─── Gemini request/response types ─────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER";
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { code?: number; message?: string };
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ─── Conversion helpers ──────────────────────────────────────────────────────

const toGeminiFunctions = (tools: ToolDefinition[]): GeminiFunctionDeclaration[] =>
  tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: { type: "object", ...t.parameters },
  }));

/** Convert our messages to Gemini `contents` array */
const toGeminiContents = (messages: ProviderMessage[]): GeminiContent[] => {
  const result: GeminiContent[] = [];

  for (const m of messages) {
    // Skip system messages — handled via systemInstruction
    if (m.role === "system") continue;

    if (m.role === "assistant") {
      const parts: GeminiPart[] = [];

      for (const p of m.content) {
        if (p.type === "text" && p.text) {
          parts.push({ text: p.text });
        } else if (p.type === "tool_call" && p.toolCall) {
          parts.push({
            functionCall: {
              name: p.toolCall.name,
              args: p.toolCall.args,
            },
          });
        }
      }

      if (parts.length > 0) {
        result.push({ role: "model", parts });
      }
      continue;
    }

    // user role — may contain text or tool results
    const parts: GeminiPart[] = [];

    for (const p of m.content) {
      if (p.type === "text" && p.text) {
        parts.push({ text: p.text });
      } else if (p.type === "tool_result" && p.toolResult) {
        // Gemini tool results use functionResponse inside user turn
        parts.push({
          functionResponse: {
            name: p.toolResult.id, // We use tool name as id
            response: { result: p.toolResult.content },
          },
        });
      }
    }

    if (parts.length > 0) {
      result.push({ role: "user", parts });
    }
  }

  return result;
};

// ─── Provider ────────────────────────────────────────────────────────────────

export const createGeminiProvider = (opts: GeminiOptions = {}): Provider => {
  const baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";

  return {
    name: "gemini",
    supportsImages: true,
    supportsThinking: false,

    async *stream(
      messages: ProviderMessage[],
      streamOpts: StreamOptions,
    ): AsyncIterable<StreamEvent> {
      const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
      if (!apiKey) {
        yield { type: "error", error: "GEMINI_API_KEY is missing" };
        return;
      }

      // Extract system prompt from messages or streamOpts
      const systemText =
        streamOpts.systemPrompt ??
        (messages
          .filter((m) => m.role === "system")
          .flatMap((m) => m.content)
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("\n") ||
          undefined);

      const body: Record<string, unknown> = {
        contents: toGeminiContents(messages),
        generationConfig: {
          temperature: streamOpts.temperature,
          maxOutputTokens: streamOpts.maxTokens ?? 4096,
        },
      };

      if (systemText) {
        body.systemInstruction = {
          parts: [{ text: systemText }],
        };
      }

      if (streamOpts.tools && streamOpts.tools.length > 0) {
        body.tools = [{ functionDeclarations: toGeminiFunctions(streamOpts.tools) }];
        body.toolConfig = {
          functionCallingConfig: { mode: "AUTO" },
        };
      }

      const url = `${baseUrl}/models/${streamOpts.model}:generateContent?key=${apiKey}`;

      const timeoutMs = streamOpts.timeoutMs ?? 120_000;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
        if (message.includes("abort") || message.includes("timeout")) {
          yield { type: "error", error: `request timed out after ${timeoutMs}ms` };
          return;
        }

        const msg = err instanceof Error ? err.message : "network error";
        yield { type: "error", error: `gemini unreachable: ${msg}` };
        return;
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        yield {
          type: "error",
          error: `gemini ${response.status}: ${errBody}`,
        };
        return;
      }

      const payload = (await response.json()) as GeminiResponse;

      if (payload.error) {
        yield {
          type: "error",
          error: `gemini error ${payload.error.code ?? ""}: ${payload.error.message ?? "unknown"}`,
        };
        return;
      }

      // Emit usage
      if (payload.usageMetadata) {
        yield {
          type: "usage",
          usage: {
            input: payload.usageMetadata.promptTokenCount ?? 0,
            output: payload.usageMetadata.candidatesTokenCount ?? 0,
            costUsd: 0,
          },
        };
      }

      const candidate = payload.candidates?.[0];
      if (!candidate?.content) {
        yield { type: "stop", reason: "end" };
        return;
      }

      let hasToolCalls = false;
      let callIndex = 0;

      for (const part of candidate.content.parts) {
        if (part.text) {
          yield { type: "text_delta", text: part.text };
        } else if (part.functionCall) {
          hasToolCalls = true;
          const callId = `gemini_call_${callIndex++}`;
          yield {
            type: "tool_call_start",
            toolCallId: callId,
            toolName: part.functionCall.name,
          };
          yield {
            type: "tool_call_delta",
            toolCallId: callId,
            toolArgsDelta: JSON.stringify(part.functionCall.args),
          };
          yield { type: "tool_call_end", toolCallId: callId };
        }
      }

      yield {
        type: "stop",
        reason: hasToolCalls ? "tool_use" : "end",
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      return [
        {
          id: "gemini-2.0-flash",
          name: "Gemini 2.0 Flash",
          provider: "gemini",
          contextWindow: 1_048_576,
          supportsImages: true,
          supportsThinking: false,
        },
        {
          id: "gemini-2.5-pro",
          name: "Gemini 2.5 Pro",
          provider: "gemini",
          contextWindow: 2_097_152,
          supportsImages: true,
          supportsThinking: true,
        },
        {
          id: "gemini-1.5-flash",
          name: "Gemini 1.5 Flash",
          provider: "gemini",
          contextWindow: 1_048_576,
          supportsImages: true,
          supportsThinking: false,
        },
      ];
    },
  };
};
