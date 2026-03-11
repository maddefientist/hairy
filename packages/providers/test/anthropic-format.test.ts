/**
 * Tests for Anthropic message/tool formatting logic.
 * We test the observable behaviour (what gets sent to the API and what
 * comes back) without making real HTTP calls.
 */
import { describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../src/anthropic.js";
import type { ProviderMessage } from "../src/types.js";

describe("createAnthropicProvider", () => {
  it("yields error event when API key is missing", async () => {
    // Pass an explicit empty string — the provider checks for falsy keys
    const provider = createAnthropicProvider({ apiKey: "" });

    const events = [];
    for await (const event of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "claude-test" },
    )) {
      events.push(event);
    }

    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain("ANTHROPIC_API_KEY");
  });

  it("yields error event when API returns non-200", async () => {
    const provider = createAnthropicProvider({ apiKey: "test-key" });

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });

    const events = [];
    for await (const event of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "claude-test" },
    )) {
      events.push(event);
    }

    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain("429");
  });

  it("yields timeout error when request is aborted", async () => {
    const provider = createAnthropicProvider({ apiKey: "test-key" });
    global.fetch = vi.fn().mockRejectedValue(new Error("timeout while waiting for response"));

    const events = [];
    for await (const event of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "claude-test", timeoutMs: 1234 },
    )) {
      events.push(event);
    }

    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toContain("request timed out after 1234ms");
  });

  it("yields text_delta and stop for plain text response", async () => {
    const provider = createAnthropicProvider({ apiKey: "test-key" });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Hello from Claude!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });

    const events = [];
    for await (const event of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { model: "claude-test" },
    )) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === "text_delta");
    const stopEvent = events.find((e) => e.type === "stop");
    const usageEvent = events.find((e) => e.type === "usage");

    expect(textEvents[0]?.text).toBe("Hello from Claude!");
    expect(stopEvent?.reason).toBe("end");
    expect(usageEvent?.usage?.input).toBe(10);
    expect(usageEvent?.usage?.output).toBe(5);
  });

  it("emits tool_call events when API returns tool_use block", async () => {
    const provider = createAnthropicProvider({ apiKey: "test-key" });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "tool_use",
            id: "toolu_01ABC",
            name: "bash",
            input: { command: "echo hello" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 20, output_tokens: 10 },
      }),
    });

    const events = [];
    for await (const event of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "run echo" }] }],
      {
        model: "claude-test",
        tools: [
          {
            name: "bash",
            description: "Execute shell commands",
            parameters: { properties: { command: { type: "string" } } },
          },
        ],
      },
    )) {
      events.push(event);
    }

    const startEvent = events.find((e) => e.type === "tool_call_start");
    const deltaEvent = events.find((e) => e.type === "tool_call_delta");
    const endEvent = events.find((e) => e.type === "tool_call_end");
    const stopEvent = events.find((e) => e.type === "stop");

    expect(startEvent?.toolCallId).toBe("toolu_01ABC");
    expect(startEvent?.toolName).toBe("bash");
    expect(deltaEvent?.toolArgsDelta).toContain("echo hello");
    expect(endEvent?.toolCallId).toBe("toolu_01ABC");
    expect(stopEvent?.reason).toBe("tool_use");
  });

  it("includes tools in the request body when provided", async () => {
    const provider = createAnthropicProvider({ apiKey: "test-key" });

    let capturedBody: Record<string, unknown> = {};
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
      };
    });

    for await (const _ of provider.stream(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      {
        model: "claude-test",
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: { properties: { path: { type: "string" } } },
          },
        ],
      },
    )) {
      // drain
    }

    expect(Array.isArray(capturedBody.tools)).toBe(true);
    const tools = capturedBody.tools as Array<{
      name: string;
      input_schema: unknown;
    }>;
    expect(tools[0]?.name).toBe("read");
    expect(tools[0]?.input_schema).toBeDefined();
  });

  it("converts tool results correctly in messages", async () => {
    const provider = createAnthropicProvider({ apiKey: "test-key" });

    let capturedBody: Record<string, unknown> = {};
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
        }),
      };
    });

    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "run bash" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolCall: {
              id: "call_1",
              name: "bash",
              args: { command: "echo hi" },
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolResult: {
              id: "call_1",
              content: "hi",
              isError: false,
            },
          },
        ],
      },
    ];

    for await (const _ of provider.stream(messages, {
      model: "claude-test",
    })) {
      // drain
    }

    const sentMessages = capturedBody.messages as Array<{
      role: string;
      content: unknown;
    }>;

    // Should have user, assistant (with tool_use), user (with tool_result)
    expect(sentMessages.length).toBe(3);
    expect(sentMessages[0]?.role).toBe("user");
    expect(sentMessages[1]?.role).toBe("assistant");
    expect(sentMessages[2]?.role).toBe("user");

    // Assistant message should have a tool_use block
    const assistantContent = sentMessages[1]?.content as Array<{
      type: string;
    }>;
    expect(Array.isArray(assistantContent)).toBe(true);
    expect(assistantContent[0]?.type).toBe("tool_use");

    // User message should have a tool_result block
    const userContent = sentMessages[2]?.content as Array<{
      type: string;
    }>;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent[0]?.type).toBe("tool_result");
  });

  it("lists available models", async () => {
    const provider = createAnthropicProvider({ apiKey: "test-key" });
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty("id");
    expect(models[0]).toHaveProperty("provider", "anthropic");
  });
});
