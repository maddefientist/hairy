import { describe, expect, it, vi } from "vitest";
import { createOpenRouterProvider } from "../src/openrouter.js";
import type { ProviderMessage } from "../src/types.js";

describe("createOpenRouterProvider", () => {
  it("yields error when API key is missing", async () => {
    const provider = createOpenRouterProvider({ apiKey: "" });
    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "gpt-4o" },
    )) {
      events.push(e);
    }
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain("OPENROUTER_API_KEY");
  });

  it("yields error on non-200 response", async () => {
    const provider = createOpenRouterProvider({ apiKey: "test-key" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "service unavailable",
    });

    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "gpt-4o" },
    )) {
      events.push(e);
    }
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain("503");
  });

  it("yields timeout error when request is aborted", async () => {
    const provider = createOpenRouterProvider({ apiKey: "test-key" });
    global.fetch = vi.fn().mockRejectedValue(new Error("operation timeout"));

    const events = [];
    for await (const event of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "gpt-4o", timeoutMs: 42 },
    )) {
      events.push(event);
    }

    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain("request timed out after 42ms");
  });

  it("yields text_delta and stop for a plain text response", async () => {
    const provider = createOpenRouterProvider({ apiKey: "test-key" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hello from OpenRouter!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      }),
    });

    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "gpt-4o" },
    )) {
      events.push(e);
    }

    const text = events.find((e) => e.type === "text_delta");
    const stop = events.find((e) => e.type === "stop");
    const usage = events.find((e) => e.type === "usage");

    expect(text?.text).toBe("Hello from OpenRouter!");
    expect(stop?.reason).toBe("end");
    expect(usage?.usage?.input).toBe(8);
    expect(usage?.usage?.output).toBe(4);
  });

  it("emits tool_call events when response has tool_calls", async () => {
    const provider = createOpenRouterProvider({ apiKey: "test-key" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: { name: "bash", arguments: '{"command":"ls"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    });

    const events = [];
    for await (const e of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "list files" }] }],
      {
        model: "gpt-4o",
        tools: [{ name: "bash", description: "run shell", parameters: {} }],
      },
    )) {
      events.push(e);
    }

    expect(events.find((e) => e.type === "tool_call_start")?.toolName).toBe("bash");
    expect(events.find((e) => e.type === "tool_call_delta")?.toolArgsDelta).toContain("ls");
    expect(events.find((e) => e.type === "tool_call_end")?.toolCallId).toBe("call_abc");
    expect(events.find((e) => e.type === "stop")?.reason).toBe("tool_use");
  });

  it("formats tool results as 'tool' role messages", async () => {
    const provider = createOpenRouterProvider({ apiKey: "test-key" });

    let capturedBody: Record<string, unknown> = {};
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "done" }, finish_reason: "stop" }],
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
            toolResult: { id: "c1", content: "hi\n", isError: false },
          },
        ],
      },
    ];

    for await (const _ of provider.stream(messages, { model: "gpt-4o" })) {
      // drain
    }

    const sent = capturedBody.messages as Array<{ role: string; content: unknown }>;
    // user, assistant (tool_calls), tool (result)
    expect(sent.length).toBe(3);
    expect(sent[2]?.role).toBe("tool");
  });

  it("includes tools in OpenAI format", async () => {
    const provider = createOpenRouterProvider({ apiKey: "test-key" });
    let capturedBody: Record<string, unknown> = {};
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      };
    });

    for await (const _ of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      {
        model: "gpt-4o",
        tools: [{ name: "read", description: "Read file", parameters: {} }],
      },
    )) {
      // drain
    }

    const tools = capturedBody.tools as Array<{ type: string; function: { name: string } }>;
    expect(tools[0]?.type).toBe("function");
    expect(tools[0]?.function.name).toBe("read");
  });
});
