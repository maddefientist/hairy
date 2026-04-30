import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Metrics } from "@hairyclaw/observability";
import { describe, expect, it, vi } from "vitest";
import { AuthProfileManager } from "../src/auth-profiles.js";
import { classifyError } from "../src/error-classifier.js";
import { ProviderGateway } from "../src/gateway.js";
import type { Provider, StreamEvent, StreamOptions } from "../src/types.js";

const streamEvents = async (gateway: ProviderGateway): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const event of gateway.stream(
    [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    { model: "ignored" },
  )) {
    out.push(event);
  }
  return out;
};

const createProvider = (
  name: string,
  streamImpl: (opts: StreamOptions) => AsyncIterable<StreamEvent>,
): Provider & { stream: ReturnType<typeof vi.fn> } => ({
  name,
  supportsImages: false,
  supportsThinking: false,
  stream: vi.fn(async function* (_messages, opts: StreamOptions) {
    for await (const event of streamImpl(opts)) {
      yield event;
    }
  }),
  listModels: async () => [],
});

const buildGateway = (providers: Provider[], overrides?: { authProfiles?: AuthProfileManager }) =>
  new ProviderGateway({
    providers,
    metrics: new Metrics(),
    routingConfig: {
      defaultProvider: providers[0]?.name ?? "anthropic",
      fallbackChain: providers.map((p) => p.name),
      modelFallbackChain: providers.map((p, index) => ({ provider: p.name, model: `m-${index}` })),
    },
    ...(overrides?.authProfiles ? { authProfiles: overrides.authProfiles } : {}),
  });

const makeProfiles = (): AuthProfileManager =>
  new AuthProfileManager({ filePath: join(tmpdir(), `hairy-auth-${randomUUID()}.json`) });

describe("ProviderGateway model fallback", () => {
  it("tries model fallback entries in order", async () => {
    const calls: string[] = [];

    const first = createProvider("anthropic", async function* () {
      calls.push("anthropic");
      yield { type: "error", error: "first failed" };
    });
    const second = createProvider("gemini", async function* () {
      calls.push("gemini");
      yield { type: "text_delta", text: "ok" };
      yield { type: "stop", reason: "end" };
    });

    const gateway = new ProviderGateway({
      providers: [first, second],
      metrics: new Metrics(),
      routingConfig: {
        defaultProvider: "anthropic",
        fallbackChain: ["anthropic", "gemini"],
        modelFallbackChain: [
          { provider: "anthropic", model: "claude" },
          { provider: "gemini", model: "gemini-2.5" },
        ],
      },
    });

    const events = await streamEvents(gateway);

    expect(calls).toEqual(["anthropic", "gemini"]);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });

  it("skips provider when auth profile is in cooldown", async () => {
    const manager = makeProfiles();
    manager.addProfile({
      id: "p1",
      provider: "anthropic",
      type: "api_key",
      credential: "k1",
    });
    manager.addProfile({
      id: "p2",
      provider: "openrouter",
      type: "api_key",
      credential: "k2",
    });
    manager.reportFailure("p1", "rate_limit");

    const first = createProvider("anthropic", async function* () {
      yield { type: "text_delta", text: "should-not-run" };
    });
    const second = createProvider("openrouter", async function* () {
      yield { type: "text_delta", text: "fallback" };
      yield { type: "stop", reason: "end" };
    });

    const gateway = new ProviderGateway({
      providers: [first, second],
      metrics: new Metrics(),
      authProfiles: manager,
      routingConfig: {
        defaultProvider: "anthropic",
        fallbackChain: ["anthropic", "openrouter"],
        modelFallbackChain: [
          { provider: "anthropic", model: "claude" },
          { provider: "openrouter", model: "openai/gpt-4o-mini" },
        ],
      },
    });

    const events = await streamEvents(gateway);

    expect(first.stream).not.toHaveBeenCalled();
    expect(second.stream).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === "text_delta")?.text).toBe("fallback");
  });

  it("reports failure to auth profile manager", async () => {
    const manager = makeProfiles();
    manager.addProfile({
      id: "anthropic-primary",
      provider: "anthropic",
      type: "api_key",
      credential: "key",
    });

    const anth = createProvider("anthropic", async function* () {
      yield { type: "error", error: "429 too many requests" };
    });

    const gateway = new ProviderGateway({
      providers: [anth],
      metrics: new Metrics(),
      authProfiles: manager,
      routingConfig: {
        defaultProvider: "anthropic",
        fallbackChain: ["anthropic"],
        modelFallbackChain: [{ provider: "anthropic", model: "claude" }],
      },
    });

    await streamEvents(gateway);

    const health = manager.getHealthSnapshot().get("anthropic-primary");
    expect(health?.failureCounts.rate_limit).toBe(1);
    expect((health?.consecutiveErrors ?? 0) > 0).toBe(true);
  });

  it("reports success to auth profile manager", async () => {
    const manager = makeProfiles();
    manager.addProfile({
      id: "openrouter-primary",
      provider: "openrouter",
      type: "api_key",
      credential: "key",
    });

    const provider = createProvider("openrouter", async function* () {
      yield { type: "text_delta", text: "ok" };
      yield { type: "stop", reason: "end" };
    });

    const gateway = new ProviderGateway({
      providers: [provider],
      metrics: new Metrics(),
      authProfiles: manager,
      routingConfig: {
        defaultProvider: "openrouter",
        fallbackChain: ["openrouter"],
        modelFallbackChain: [{ provider: "openrouter", model: "openai/gpt-4o-mini" }],
      },
    });

    await streamEvents(gateway);

    const health = manager.getHealthSnapshot().get("openrouter-primary");
    expect(typeof health?.lastSuccess).toBe("number");
    expect(health?.consecutiveErrors).toBe(0);
  });

  it("times out long running provider attempt", async () => {
    const slow = createProvider("ollama", async function* () {
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield { type: "text_delta", text: "late" };
    });

    const gateway = new ProviderGateway({
      providers: [slow],
      metrics: new Metrics(),
      routingConfig: {
        defaultProvider: "ollama",
        fallbackChain: ["ollama"],
        modelFallbackChain: [{ provider: "ollama", model: "llama3.2", timeoutMs: 10 }],
      },
    });

    const events = await streamEvents(gateway);
    const last = events[events.length - 1];

    expect(last?.type).toBe("error");
    expect(last?.error).toContain("all models failed");
    expect(last?.error).toContain("request timed out after 10ms");
  });

  it("yields aggregate error after all model attempts fail", async () => {
    const p1 = createProvider("anthropic", async function* () {
      yield { type: "error", error: "401 unauthorized" };
    });
    const p2 = createProvider("gemini", async function* () {
      yield { type: "error", error: "500 backend down" };
    });

    const gateway = new ProviderGateway({
      providers: [p1, p2],
      metrics: new Metrics(),
      routingConfig: {
        defaultProvider: "anthropic",
        fallbackChain: ["anthropic", "gemini"],
        modelFallbackChain: [
          { provider: "anthropic", model: "claude" },
          { provider: "gemini", model: "gemini-2.5" },
        ],
      },
    });

    const events = await streamEvents(gateway);
    const last = events[events.length - 1];

    expect(last?.type).toBe("error");
    expect(last?.error).toContain("all models failed");
    expect(last?.error).toContain("anthropic/claude");
    expect(last?.error).toContain("gemini/gemini-2.5");
  });

  it("falls back to legacy provider chain when modelFallbackChain is absent", async () => {
    const first = createProvider("anthropic", async function* () {
      yield { type: "error", error: "boom" };
    });
    const second = createProvider("openrouter", async function* () {
      yield { type: "text_delta", text: "legacy-ok" };
      yield { type: "stop", reason: "end" };
    });

    const gateway = new ProviderGateway({
      providers: [first, second],
      metrics: new Metrics(),
      routingConfig: {
        defaultProvider: "anthropic",
        fallbackChain: ["openrouter"],
      },
    });

    const events: StreamEvent[] = [];
    for await (const event of gateway.stream(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      { model: "model-x" },
    )) {
      events.push(event);
    }

    expect(first.stream).toHaveBeenCalledTimes(1);
    expect(second.stream).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === "text_delta")?.text).toBe("legacy-ok");
  });

  it("supports mixed providers in model fallback chain", async () => {
    const ollama = createProvider("ollama", async function* () {
      yield { type: "error", error: "local model missing" };
    });
    const anthropic = createProvider("anthropic", async function* () {
      yield { type: "error", error: "429" };
    });
    const gemini = createProvider("gemini", async function* () {
      yield { type: "text_delta", text: "gemini answer" };
      yield { type: "stop", reason: "end" };
    });

    const gateway = new ProviderGateway({
      providers: [ollama, anthropic, gemini],
      metrics: new Metrics(),
      routingConfig: {
        defaultProvider: "ollama",
        fallbackChain: ["ollama", "anthropic", "gemini"],
        modelFallbackChain: [
          { provider: "ollama", model: "llama3.2" },
          { provider: "anthropic", model: "claude-sonnet" },
          { provider: "gemini", model: "gemini-2.5-flash" },
        ],
      },
    });

    const events = await streamEvents(gateway);

    expect(ollama.stream).toHaveBeenCalledTimes(1);
    expect(anthropic.stream).toHaveBeenCalledTimes(1);
    expect(gemini.stream).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === "text_delta")?.text).toBe("gemini answer");
  });

  it("passes per-model timeout override to provider stream options", async () => {
    const provider = createProvider("gemini", async function* (opts) {
      yield { type: "text_delta", text: String(opts.timeoutMs) };
      yield { type: "stop", reason: "end" };
    });

    const gateway = new ProviderGateway({
      providers: [provider],
      metrics: new Metrics(),
      routingConfig: {
        defaultProvider: "gemini",
        fallbackChain: ["gemini"],
        modelFallbackChain: [{ provider: "gemini", model: "gemini-2.5", timeoutMs: 4321 }],
      },
    });

    const events = await streamEvents(gateway);

    expect(provider.stream).toHaveBeenCalledTimes(1);
    const args = provider.stream.mock.calls[0]?.[1] as StreamOptions | undefined;
    expect(args?.timeoutMs).toBe(4321);
    expect(events.find((event) => event.type === "text_delta")?.text).toBe("4321");
  });

  it("classifies errors by reason and retryability", () => {
    expect(classifyError(new Error("request timed out after 10ms")).reason).toBe("timeout");
    expect(classifyError(new Error("HTTP 429 from provider")).reason).toBe("rate_limit");
    expect(classifyError(new Error("401 unauthorized")).reason).toBe("auth_failure");
    expect(classifyError(new Error("something else")).reason).toBe("unknown");
    expect(classifyError(new Error("context length exceeded")).reason).toBe("context_length_exceeded");
  });

  it("returns provider unavailable error when no attempts can be built", async () => {
    const gateway = new ProviderGateway({
      providers: [],
      metrics: new Metrics(),
      routingConfig: {
        defaultProvider: "anthropic",
        fallbackChain: [],
      },
    });

    const events: StreamEvent[] = [];
    for await (const event of gateway.stream(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      {},
    )) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "error", error: "provider or model unavailable" });
  });

  it("buildGateway helper composes default model fallback for convenience", async () => {
    const provider = createProvider("openrouter", async function* () {
      yield { type: "text_delta", text: "ok" };
      yield { type: "stop", reason: "end" };
    });

    const gateway = buildGateway([provider]);
    const events = await streamEvents(gateway);

    expect(events.find((event) => event.type === "text_delta")?.text).toBe("ok");
  });
});
