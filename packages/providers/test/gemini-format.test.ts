import { describe, expect, it, vi } from "vitest";
import { createGeminiProvider } from "../src/gemini.js";
import type { ProviderMessage } from "../src/types.js";

describe("createGeminiProvider", () => {
  it("yields error when API key is empty string", async () => {
    // Empty string is falsy — treated as missing, no network call made
    const provider = createGeminiProvider({ apiKey: "" });
    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "gemini-2.0-flash" },
    )) {
      events.push(e);
    }

    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain("GEMINI_API_KEY");
  });

  it("yields error when fetch throws", async () => {
    const provider = createGeminiProvider({ apiKey: "test-key" });
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "gemini-2.0-flash" },
    )) {
      events.push(e);
    }

    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain("gemini unreachable");
  });

  it("yields error on non-200 response", async () => {
    const provider = createGeminiProvider({ apiKey: "test-key" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "API key invalid",
    });

    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "gemini-2.0-flash" },
    )) {
      events.push(e);
    }

    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain("401");
  });

  it("yields text_delta and stop for plain text response", async () => {
    const provider = createGeminiProvider({ apiKey: "test-key" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "The capital of France is Paris." }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
      }),
    });

    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "Capital of France?" }] }],
      { model: "gemini-2.0-flash" },
    )) {
      events.push(e);
    }

    expect(events.find((e) => e.type === "text_delta")?.text).toBe(
      "The capital of France is Paris.",
    );
    expect(events.find((e) => e.type === "stop")?.reason).toBe("end");
    expect(events.find((e) => e.type === "usage")?.usage?.input).toBe(12);
    expect(events.find((e) => e.type === "usage")?.usage?.output).toBe(7);
  });

  it("emits tool_call events when response has functionCall part", async () => {
    const provider = createGeminiProvider({ apiKey: "test-key" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "bash",
                    args: { command: "ls -la" },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
    });

    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "list files" }] }],
      {
        model: "gemini-2.0-flash",
        tools: [{ name: "bash", description: "run shell", parameters: {} }],
      },
    )) {
      events.push(e);
    }

    expect(events.find((e) => e.type === "tool_call_start")?.toolName).toBe("bash");
    expect(events.find((e) => e.type === "tool_call_delta")?.toolArgsDelta).toContain("ls -la");
    expect(events.find((e) => e.type === "tool_call_end")).toBeTruthy();
    expect(events.find((e) => e.type === "stop")?.reason).toBe("tool_use");
  });

  it("sends request with correct URL including API key", async () => {
    const provider = createGeminiProvider({ apiKey: "my-secret-key" });
    let capturedUrl = "";
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }],
        }),
      };
    });

    for await (const _ of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "gemini-2.0-flash" },
    )) {
      // drain
    }

    expect(capturedUrl).toContain("gemini-2.0-flash:generateContent");
    expect(capturedUrl).toContain("key=my-secret-key");
  });

  it("sends systemInstruction when system prompt provided", async () => {
    const provider = createGeminiProvider({ apiKey: "test-key" });
    let capturedBody: Record<string, unknown> = {};
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: "model", parts: [{ text: "sure" }] } }],
        }),
      };
    });

    for await (const _ of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "gemini-2.0-flash", systemPrompt: "You are a pirate." },
    )) {
      // drain
    }

    const sysInstruction = capturedBody.systemInstruction as {
      parts: Array<{ text: string }>;
    };
    expect(sysInstruction?.parts[0]?.text).toBe("You are a pirate.");
  });

  it("converts tool results to functionResponse parts", async () => {
    const provider = createGeminiProvider({ apiKey: "test-key" });
    let capturedBody: Record<string, unknown> = {};
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: "model", parts: [{ text: "done" }] } }],
        }),
      };
    });

    const messages: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "run bash" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolCall: { id: "c1", name: "bash", args: { command: "echo hi" } },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolResult: { id: "bash", content: "hi\n", isError: false },
          },
        ],
      },
    ];

    for await (const _ of provider.stream(messages, { model: "gemini-2.0-flash" })) {
      // drain
    }

    const contents = capturedBody.contents as Array<{
      role: string;
      parts: Array<{ functionResponse?: unknown; functionCall?: unknown; text?: string }>;
    }>;

    // Should have user, model (functionCall), user (functionResponse)
    const lastUserTurn = [...contents].reverse().find((c) => c.role === "user");
    const fnResponse = lastUserTurn?.parts.find((p) => p.functionResponse);
    expect(fnResponse).toBeTruthy();
    expect((fnResponse?.functionResponse as { name?: string })?.name).toBe("bash");
  });

  it("sends tools in functionDeclarations format", async () => {
    const provider = createGeminiProvider({ apiKey: "test-key" });
    let capturedBody: Record<string, unknown> = {};
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
        }),
      };
    });

    for await (const _ of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      {
        model: "gemini-2.0-flash",
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      },
    )) {
      // drain
    }

    const tools = capturedBody.tools as Array<{
      functionDeclarations: Array<{ name: string }>;
    }>;
    expect(tools[0]?.functionDeclarations[0]?.name).toBe("read_file");
  });

  it("listModels returns static known models", async () => {
    const provider = createGeminiProvider({ apiKey: "test-key" });
    const models = await provider.listModels?.();
    expect(models.length).toBeGreaterThan(0);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("gemini-2.0-flash");
    expect(ids).toContain("gemini-2.5-pro");
  });
});
