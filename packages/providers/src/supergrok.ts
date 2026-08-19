import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ModelInfo,
  Provider,
  ProviderMessage,
  StreamEvent,
  StreamOptions,
  ToolDefinition,
} from "./types.js";

interface SuperGrokOptions {
  authFile: string;
  baseUrl?: string;
  discoveryUrl?: string;
}

interface OAuthCredentials {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
}

type StoredAuth = Record<string, OAuthCredentials | undefined>;

interface TokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

interface ChatCompletion {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const REFRESH_SKEW_MS = 120_000;
const REFRESH_PREFIX = "xai:";

const validateXaiUrl = (value: string, label: string): string => {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
    throw new Error(`${label} must use an x.ai HTTPS origin`);
  }
  return parsed.toString();
};

const parseRefresh = (value: string): { refreshToken: string; tokenEndpoint?: string } => {
  if (!value.startsWith(REFRESH_PREFIX)) {
    return { refreshToken: value };
  }

  try {
    const decoded = Buffer.from(value.slice(REFRESH_PREFIX.length), "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    return {
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : "",
      tokenEndpoint: typeof parsed.tokenEndpoint === "string" ? parsed.tokenEndpoint : undefined,
    };
  } catch {
    return { refreshToken: "" };
  }
};

const packRefresh = (refreshToken: string, tokenEndpoint: string): string => {
  const payload = Buffer.from(JSON.stringify({ refreshToken, tokenEndpoint }), "utf8").toString(
    "base64url",
  );
  return `${REFRESH_PREFIX}${payload}`;
};

const jwtExpiry = (token: string): number | undefined => {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof decoded.exp === "number" && Number.isFinite(decoded.exp)
      ? decoded.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
};

const atomicWriteAuth = async (path: string, auth: StoredAuth): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
};

const readAuth = async (path: string): Promise<StoredAuth> => {
  const parsed = JSON.parse(await readFile(path, "utf8")) as StoredAuth;
  return parsed;
};

const discoverTokenEndpoint = async (discoveryUrl: string): Promise<string> => {
  const response = await fetch(validateXaiUrl(discoveryUrl, "OAuth discovery URL"), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`SuperGrok OAuth discovery failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { token_endpoint?: unknown };
  if (typeof payload.token_endpoint !== "string" || !payload.token_endpoint) {
    throw new Error("SuperGrok OAuth discovery omitted token_endpoint");
  }
  return validateXaiUrl(payload.token_endpoint, "OAuth token endpoint");
};

const refreshCredentials = async (
  authFile: string,
  auth: StoredAuth,
  providerKey: "supergrok" | "xai",
  current: OAuthCredentials,
  discoveryUrl: string,
): Promise<OAuthCredentials> => {
  const refresh = parseRefresh(current.refresh ?? "");
  if (!refresh.refreshToken) {
    throw new Error("SuperGrok OAuth refresh token is missing; authenticate with pi-supergrok");
  }
  const tokenEndpoint = refresh.tokenEndpoint
    ? validateXaiUrl(refresh.tokenEndpoint, "OAuth token endpoint")
    : await discoverTokenEndpoint(discoveryUrl);

  const startedAt = Date.now();
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_CLIENT_ID,
      refresh_token: refresh.refreshToken,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`SuperGrok OAuth refresh failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as TokenPayload;
  const access = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  const refreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : refresh.refreshToken;
  if (!access) {
    throw new Error("SuperGrok OAuth refresh omitted access_token");
  }
  const expiresIn =
    typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in * 1000
      : undefined;
  const updated: OAuthCredentials = {
    type: "oauth",
    access,
    refresh: packRefresh(refreshToken, tokenEndpoint),
    expires: expiresIn ? startedAt + expiresIn : (jwtExpiry(access) ?? startedAt + 3_600_000),
  };
  auth[providerKey] = updated;
  await atomicWriteAuth(authFile, auth);
  return updated;
};

const getAccessToken = async (authFile: string, discoveryUrl: string): Promise<string> => {
  const auth = await readAuth(authFile);
  const providerKey = auth.supergrok ? "supergrok" : auth.xai ? "xai" : undefined;
  if (!providerKey) {
    throw new Error("SuperGrok OAuth credentials are not provisioned");
  }
  let credentials = auth[providerKey];
  if (
    credentials?.type !== "oauth" ||
    typeof credentials.access !== "string" ||
    typeof credentials.refresh !== "string"
  ) {
    throw new Error("SuperGrok OAuth credential file is invalid");
  }
  if (!credentials.expires || credentials.expires <= Date.now() + REFRESH_SKEW_MS) {
    credentials = await refreshCredentials(authFile, auth, providerKey, credentials, discoveryUrl);
  }
  if (!credentials.access) {
    throw new Error("SuperGrok OAuth access token is missing");
  }
  return credentials.access;
};

const textFrom = (message: ProviderMessage): string =>
  message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");

const toOpenAiMessages = (
  messages: ProviderMessage[],
  systemPrompt?: string,
): Array<Record<string, unknown>> => {
  const output: Array<Record<string, unknown>> = [];
  if (systemPrompt?.trim()) output.push({ role: "system", content: systemPrompt.trim() });

  for (const message of messages) {
    const toolResults = message.content.filter(
      (part) => part.type === "tool_result" && part.toolResult,
    );
    for (const part of toolResults) {
      if (!part.toolResult) continue;
      output.push({
        role: "tool",
        tool_call_id: part.toolResult.id,
        content: part.toolResult.content,
      });
    }

    if (message.role === "assistant") {
      const toolCalls = message.content
        .filter((part) => part.type === "tool_call" && part.toolCall)
        .map((part) => ({
          id: part.toolCall?.id ?? "",
          type: "function",
          function: {
            name: part.toolCall?.name ?? "",
            arguments: JSON.stringify(part.toolCall?.args ?? {}),
          },
        }));
      output.push({
        role: "assistant",
        content: textFrom(message) || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const text = textFrom(message);
    if (text && (message.role === "user" || message.role === "system")) {
      output.push({ role: message.role, content: text });
    }
  }
  return output;
};

const toOpenAiTools = (
  tools: ToolDefinition[],
): Array<{ type: "function"; function: Record<string, unknown> }> =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: { type: "object", ...tool.parameters },
    },
  }));

export const createSuperGrokProvider = (opts: SuperGrokOptions): Provider => {
  const baseUrl = validateXaiUrl(
    opts.baseUrl ?? DEFAULT_BASE_URL,
    "SuperGrok API base URL",
  ).replace(/\/$/, "");
  const discoveryUrl = opts.discoveryUrl ?? DEFAULT_DISCOVERY_URL;

  return {
    name: "supergrok",
    supportsImages: false,
    supportsThinking: true,

    async *stream(
      messages: ProviderMessage[],
      streamOpts: StreamOptions,
    ): AsyncIterable<StreamEvent> {
      let accessToken: string;
      try {
        accessToken = await getAccessToken(opts.authFile, discoveryUrl);
      } catch (error: unknown) {
        yield {
          type: "error",
          error: error instanceof Error ? error.message : "SuperGrok authentication failed",
        };
        return;
      }

      const body: Record<string, unknown> = {
        model: streamOpts.model,
        messages: toOpenAiMessages(messages, streamOpts.systemPrompt),
        stream: false,
        temperature: streamOpts.temperature,
        max_tokens: streamOpts.maxTokens,
      };
      if (streamOpts.tools?.length) body.tools = toOpenAiTools(streamOpts.tools);
      if (streamOpts.thinkingLevel && streamOpts.thinkingLevel !== "off") {
        body.reasoning_effort = streamOpts.thinkingLevel;
      }

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            "x-grok-source": "hairyclaw",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(streamOpts.timeoutMs ?? 120_000),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "request failed";
        yield { type: "error", error: `SuperGrok unreachable: ${message}` };
        return;
      }

      if (!response.ok) {
        yield { type: "error", error: `SuperGrok request failed with HTTP ${response.status}` };
        return;
      }

      const payload = (await response.json()) as ChatCompletion;
      const providerModel = payload.model?.trim();
      if (!providerModel) {
        yield { type: "error", error: "SuperGrok response omitted provider model attribution" };
        return;
      }
      if (providerModel !== streamOpts.model) {
        yield {
          type: "error",
          error: `SuperGrok model mismatch: requested ${streamOpts.model}, received ${providerModel}`,
        };
        return;
      }
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
      const message = choice?.message;
      if (message?.content) yield { type: "text_delta", text: message.content };
      for (const call of message?.tool_calls ?? []) {
        const id = call.id ?? `supergrok-call-${randomUUID()}`;
        yield { type: "tool_call_start", toolCallId: id, toolName: call.function?.name ?? "" };
        yield {
          type: "tool_call_delta",
          toolCallId: id,
          toolArgsDelta: call.function?.arguments ?? "{}",
        };
        yield { type: "tool_call_end", toolCallId: id };
      }
      const usedTool = (message?.tool_calls?.length ?? 0) > 0;
      yield { type: "stop", reason: usedTool ? "tool_use" : "end" };
    },

    async listModels(): Promise<ModelInfo[]> {
      try {
        const accessToken = await getAccessToken(opts.authFile, discoveryUrl);
        const response = await fetch(`${baseUrl}/models`, {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            "x-grok-source": "hairyclaw",
          },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) return [];
        const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
        return (payload.data ?? [])
          .map((model) => String(model.id ?? "").trim())
          .filter((id) => id && !/image|video|multi-agent/i.test(id))
          .map((id) => ({
            id,
            name: id,
            provider: "supergrok",
            contextWindow: 131_072,
            supportsImages: false,
            supportsThinking: true,
          }));
      } catch {
        return [];
      }
    },
  };
};
