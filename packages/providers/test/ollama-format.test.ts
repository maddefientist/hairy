import { describe, expect, it, vi } from "vitest";
import { createOllamaProvider } from "../src/ollama.js";
import type { ProviderMessage } from "../src/types.js";

describe("createOllamaProvider", () => {
  it("yields error when fetch throws (server unreachable)", async () => {
    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434" });
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "llama3.1" },
    )) {
      events.push(e);
    }

    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain("ollama unreachable");
  });

  it("yields error on non-200 response", async () => {
    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal error",
    });

    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "llama3.1" },
    )) {
      events.push(e);
    }

    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain("500");
  });

  it("yields text_delta and stop for plain text response", async () => {
    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: { role: "assistant", content: "Hello from Ollama!" },
        done: true,
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    });

    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      { model: "llama3.1" },
    )) {
      events.push(e);
    }

    expect(events.find((e) => e.type === "text_delta")?.text).toBe("Hello from Ollama!");
    expect(events.find((e) => e.type === "stop")?.reason).toBe("end");
    expect(events.find((e) => e.type === "usage")?.usage?.input).toBe(10);
    expect(events.find((e) => e.type === "usage")?.usage?.output).toBe(5);
  });

  it("emits tool_call events for tool-using response", async () => {
    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              type: "function",
              function: { name: "bash", arguments: { command: "ls -la" } },
            },
          ],
        },
        done: true,
      }),
    });

    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "list files" }] }],
      {
        model: "llama3.1",
        tools: [{ name: "bash", description: "run shell", parameters: {} }],
      },
    )) {
      events.push(e);
    }

    expect(events.find((e) => e.type === "tool_call_start")?.toolName).toBe("bash");
    // arguments serialised to JSON string
    expect(events.find((e) => e.type === "tool_call_delta")?.toolArgsDelta).toContain("ls -la");
    expect(events.find((e) => e.type === "tool_call_end")).toBeTruthy();
    expect(events.find((e) => e.type === "stop")?.reason).toBe("tool_use");
  });

  it("sends /api/chat (not /api/generate)", async () => {
    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434" });
    let capturedUrl = "";
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          message: { role: "assistant", content: "ok" },
          done: true,
        }),
      };
    });

    for await (const _ of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "llama3.1" },
    )) {
      // drain
    }

    expect(capturedUrl).toContain("/api/chat");
    expect(capturedUrl).not.toContain("/api/generate");
  });

  it("sends tool results as 'tool' role with tool_name", async () => {
    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434" });
    let capturedBody: Record<string, unknown> = {};
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          message: { role: "assistant", content: "done" },
          done: true,
        }),
      };
    });

    const messages: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "run something" }] },
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

    for await (const _ of provider.stream(messages, { model: "llama3.1" })) {
      // drain
    }

    const sent = capturedBody.messages as Array<Record<string, unknown>>;
    const toolMsg = sent.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect(toolMsg?.tool_name).toBe("bash");
    expect(toolMsg?.content).toBe("hi\n");
  });

  it("includes system prompt as system message", async () => {
    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434" });
    let capturedBody: Record<string, unknown> = {};
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          message: { role: "assistant", content: "sure" },
          done: true,
        }),
      };
    });

    for await (const _ of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "llama3.1", systemPrompt: "You are a helpful assistant." },
    )) {
      // drain
    }

    const sent = capturedBody.messages as Array<{ role: string; content: string }>;
    const sysMsg = sent.find((m) => m.role === "system");
    expect(sysMsg?.content).toBe("You are a helpful assistant.");
  });

  it("listModels returns empty array on fetch error", async () => {
    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434" });
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const models = await provider.listModels?.();
    expect(models).toEqual([]);
  });

  it("listModels parses model list", async () => {
    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: "llama3.1:latest" }, { name: "qwen2.5:7b" }, { name: "llava:13b" }],
      }),
    });

    const models = await provider.listModels?.();
    expect(models.length).toBe(3);
    expect(models[0]?.id).toBe("llama3.1:latest");
    expect(models[2]?.supportsImages).toBe(true); // llava has "llava" in name
  });
});
