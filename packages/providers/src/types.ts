export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ProviderContent[];
}

export interface ProviderContent {
  type: "text" | "image" | "tool_call" | "tool_result" | "thinking";
  text?: string;
  image?: { data: Buffer; mimeType: string } | { url: string };
  toolCall?: { id: string; name: string; args: unknown };
  toolResult?: { id: string; content: string; isError?: boolean };
}

export interface StreamEvent {
  type:
    | "text_delta"
    | "tool_call_start"
    | "tool_call_delta"
    | "tool_call_end"
    | "thinking"
    | "usage"
    | "stop"
    | "error"
    | "rate_limit_headers";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgsDelta?: string;
  usage?: { input: number; output: number; costUsd: number };
  reason?: string;
  error?: string;
  /** Populated on rate_limit_headers events — used by gateway for preemptive routing */
  rateLimitRemaining?: number;
  rateLimitResetAtMs?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StreamOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  timeoutMs?: number;
  /** Injected by gateway for profile-based auth — takes precedence over env var */
  credential?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  supportsImages: boolean;
  supportsThinking: boolean;
  costPer1kInput?: number;
  costPer1kOutput?: number;
}

export interface Provider {
  name: string;
  stream(messages: ProviderMessage[], opts: StreamOptions): AsyncIterable<StreamEvent>;
  listModels(): Promise<ModelInfo[]>;
  supportsImages: boolean;
  supportsThinking: boolean;
}

export interface RouteRequest {
  intent?: "simple_text" | "image_input" | "long_context" | "complex";
  hasImages?: boolean;
  maxCostUsd?: number;
}

export interface ModelFallback {
  provider: string;
  model: string;
  timeoutMs?: number;
}

export interface RoutingConfig {
  defaultProvider: string;
  fallbackChain: string[];
  modelFallbackChain?: ModelFallback[];
  rules?: Record<string, { provider: string; model: string }>;
}
