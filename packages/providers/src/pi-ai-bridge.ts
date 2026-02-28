import type { ModelInfo, Provider, ProviderMessage, StreamEvent, StreamOptions } from "./types.js";

interface BridgeProvider {
  stream: (
    api: string,
    messages: ProviderMessage[],
    options: StreamOptions,
  ) => AsyncIterable<StreamEvent>;
  listModels: (api: string) => Promise<ModelInfo[]>;
}

const hasBridgeShape = (value: unknown): value is BridgeProvider => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const maybe = value as { stream?: unknown; listModels?: unknown };
  return typeof maybe.stream === "function" && typeof maybe.listModels === "function";
};

const loadBridge = async (): Promise<BridgeProvider | null> => {
  try {
    // Dynamic import — @mariozechner/pi-ai is an optional peer dependency
    const moduleName = "@mariozechner/pi-ai";
    const module = (await import(/* webpackIgnore: true */ moduleName)) as unknown;
    if (hasBridgeShape(module)) {
      return module;
    }
    return null;
  } catch {
    return null;
  }
};

export const createPiAiBridgeProvider = (
  api: string,
  opts: Record<string, unknown> = {},
): Provider => {
  return {
    name: "pi-ai-bridge",
    supportsImages: true,
    supportsThinking: true,
    async *stream(
      messages: ProviderMessage[],
      streamOptions: StreamOptions,
    ): AsyncIterable<StreamEvent> {
      const bridge = await loadBridge();
      if (!bridge) {
        yield {
          type: "error",
          error: "pi-ai bridge is unavailable; install @mariozechner/pi-ai",
        };
        return;
      }

      for await (const event of bridge.stream(api, messages, {
        ...streamOptions,
        ...opts,
      })) {
        yield event;
      }
    },
    async listModels(): Promise<ModelInfo[]> {
      const bridge = await loadBridge();
      if (!bridge) {
        return [];
      }
      return bridge.listModels(api);
    },
  };
};
