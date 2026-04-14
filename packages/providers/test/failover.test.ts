import type { HairyClawLogger } from "@hairyclaw/observability";
import { describe, expect, it, vi } from "vitest";
import { createFailoverProvider } from "../src/failover.js";
import type { FailoverConfig } from "../src/failover.js";
import type {
  ModelInfo,
  Provider,
  ProviderMessage,
  StreamEvent,
  StreamOptions,
} from "../src/types.js";

const mockLogger: HairyClawLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

/** Create a mock provider that yields given events */
const makeProvider = (name: string, events: StreamEvent[]): Provider => ({
  name,
  supportsImages: true,
  supportsThinking: true,
  async *stream(_messages: ProviderMessage[], _opts: StreamOptions): AsyncIterable<StreamEvent> {
    for (const event of events) {
      yield event;
    }
  },
  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: `${name}-model`,
        name: `${name} model`,
        provider: name,
        contextWindow: 128000,
        supportsImages: true,
        supportsThinking: true,
      },
    ];
  },
});

/** Create a provider that throws */
const makeThrowingProvider = (name: string, error: Error): Provider => ({
  name,
  supportsImages: true,
  supportsThinking: true,
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "error", error: error.message };
  },
  async listModels(): Promise<ModelInfo[]> {
    return [];
  },
});

const defaultMessages: ProviderMessage[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];
const defaultOpts: StreamOptions = { model: "test-model" };

const collectEvents = async (
  provider: Provider,
  messages: ProviderMessage[],
  opts: StreamOptions,
): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(messages, opts)) {
    events.push(event);
  }
  return events;
};

describe("createFailoverProvider", () => {
  it("yields events from the first provider on success", async () => {
    const providerA = makeProvider("a", [
      { type: "text_delta", text: "hello" },
      { type: "stop", reason: "end_turn" },
    ]);

    const config: FailoverConfig = {
      chain: [{ provider: "a", model: "a-model" }],
    };

    const failover = createFailoverProvider({
      providers: new Map([["a", providerA]]),
      config,
      logger: mockLogger,
    });

    const events = await collectEvents(failover, defaultMessages, defaultOpts);
    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "stop", reason: "end_turn" },
    ]);
  });

  it("failovers to next provider on error", async () => {
    const providerA = makeProvider("a", [{ type: "error", error: "server error" }]);
    const providerB = makeProvider("b", [
      { type: "text_delta", text: "from b" },
      { type: "stop", reason: "end_turn" },
    ]);

    const config: FailoverConfig = {
      chain: [
        { provider: "a", model: "a-model" },
        { provider: "b", model: "b-model" },
      ],
      backoffBaseMs: 0, // no delay in tests
    };

    const failover = createFailoverProvider({
      providers: new Map([
        ["a", providerA],
        ["b", providerB],
      ]),
      config,
      logger: mockLogger,
    });

    const events = await collectEvents(failover, defaultMessages, defaultOpts);
    expect(events).toEqual([
      { type: "text_delta", text: "from b" },
      { type: "stop", reason: "end_turn" },
    ]);
  });

  it("stops retrying on auth failure", async () => {
    const providerA = makeProvider("a", [{ type: "error", error: "unauthorized" }]);

    const config: FailoverConfig = {
      chain: [{ provider: "a", model: "a-model" }],
      maxRetriesPerProvider: 3,
      backoffBaseMs: 0,
    };

    const failover = createFailoverProvider({
      providers: new Map([["a", providerA]]),
      config,
      logger: mockLogger,
    });

    const events = await collectEvents(failover, defaultMessages, defaultOpts);
    // Should exhaust all providers and return the "all failed" error
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
  });

  it("returns context_length_exceeded immediately", async () => {
    const providerA = makeProvider("a", [{ type: "error", error: "context length exceeded" }]);
    const providerB = makeProvider("b", [{ type: "text_delta", text: "should not reach" }]);

    const config: FailoverConfig = {
      chain: [
        { provider: "a", model: "a-model" },
        { provider: "b", model: "b-model" },
      ],
      backoffBaseMs: 0,
    };

    const failover = createFailoverProvider({
      providers: new Map([
        ["a", providerA],
        ["b", providerB],
      ]),
      config,
      logger: mockLogger,
    });

    const events = await collectEvents(failover, defaultMessages, defaultOpts);
    expect(events).toEqual([{ type: "error", error: "context_length_exceeded" }]);
  });

  it("returns all-providers-failed error when all fail", async () => {
    const providerA = makeProvider("a", [{ type: "error", error: "server error" }]);
    const providerB = makeProvider("b", [{ type: "error", error: "timeout" }]);

    const config: FailoverConfig = {
      chain: [
        { provider: "a", model: "a-model" },
        { provider: "b", model: "b-model" },
      ],
      maxRetriesPerProvider: 1,
      backoffBaseMs: 0,
    };

    const failover = createFailoverProvider({
      providers: new Map([
        ["a", providerA],
        ["b", providerB],
      ]),
      config,
      logger: mockLogger,
    });

    const events = await collectEvents(failover, defaultMessages, defaultOpts);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
    expect((events[0] as { error: string }).error).toContain("All providers failed");
  });

  it("handles thrown exceptions from provider stream", async () => {
    const providerA = makeThrowingProvider("a", new Error("ECONNREFUSED"));
    const providerB = makeProvider("b", [
      { type: "text_delta", text: "recovered" },
      { type: "stop", reason: "end_turn" },
    ]);

    const config: FailoverConfig = {
      chain: [
        { provider: "a", model: "a-model" },
        { provider: "b", model: "b-model" },
      ],
      backoffBaseMs: 0,
    };

    const failover = createFailoverProvider({
      providers: new Map([
        ["a", providerA],
        ["b", providerB],
      ]),
      config,
      logger: mockLogger,
    });

    const events = await collectEvents(failover, defaultMessages, defaultOpts);
    expect(events).toEqual([
      { type: "text_delta", text: "recovered" },
      { type: "stop", reason: "end_turn" },
    ]);
  });

  it("aggregates models from all providers in listModels", async () => {
    const providerA = makeProvider("a", []);
    const providerB = makeProvider("b", []);

    const config: FailoverConfig = {
      chain: [
        { provider: "a", model: "a-model" },
        { provider: "b", model: "b-model" },
      ],
    };

    const failover = createFailoverProvider({
      providers: new Map([
        ["a", providerA],
        ["b", providerB],
      ]),
      config,
      logger: mockLogger,
    });

    const models = await failover.listModels();
    expect(models.length).toBe(2);
    expect(models.map((m) => m.provider).sort()).toEqual(["a", "b"]);
  });

  it("skips provider not found in map", async () => {
    const providerB = makeProvider("b", [
      { type: "text_delta", text: "from b" },
      { type: "stop", reason: "end_turn" },
    ]);

    const config: FailoverConfig = {
      chain: [
        { provider: "missing", model: "missing-model" },
        { provider: "b", model: "b-model" },
      ],
    };

    const failover = createFailoverProvider({
      providers: new Map([["b", providerB]]),
      config,
      logger: mockLogger,
    });

    const events = await collectEvents(failover, defaultMessages, defaultOpts);
    expect(events).toEqual([
      { type: "text_delta", text: "from b" },
      { type: "stop", reason: "end_turn" },
    ]);
  });
});
