import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSuperGrokProvider } from "../src/supergrok.js";

const collect = async (stream: AsyncIterable<unknown>): Promise<unknown[]> => {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

describe("createSuperGrokProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses protected OAuth state and preserves structured tool calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hairy-supergrok-"));
    const authFile = join(directory, "auth.json");
    await writeFile(
      authFile,
      JSON.stringify({
        supergrok: {
          type: "oauth",
          access: "access-test",
          refresh: "refresh-test",
          expires: Date.now() + 600_000,
        },
      }),
      { mode: 0o600 },
    );

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer access-test");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("grok-4.6");
      expect(body.tools).toBeDefined();
      return new Response(
        JSON.stringify({
          model: "grok-4.6",
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "call-1", function: { name: "status", arguments: '{"scope":"bot"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createSuperGrokProvider({ authFile });
    const events = await collect(
      provider.stream([{ role: "user", content: [{ type: "text", text: "check" }] }], {
        model: "grok-4.6",
        tools: [
          {
            name: "status",
            description: "check status",
            parameters: { properties: { scope: { type: "string" } } },
          },
        ],
      }),
    );

    expect(events).toContainEqual({
      type: "tool_call_start",
      toolCallId: "call-1",
      toolName: "status",
    });
    expect(events).toContainEqual({
      type: "tool_call_delta",
      toolCallId: "call-1",
      toolArgsDelta: '{"scope":"bot"}',
    });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
  });

  it("refreshes expired OAuth credentials without exposing token material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hairy-supergrok-refresh-"));
    const authFile = join(directory, "auth.json");
    await writeFile(
      authFile,
      JSON.stringify({
        supergrok: {
          type: "oauth",
          access: "expired-access",
          refresh: "refresh-test",
          expires: Date.now() - 1,
        },
      }),
      { mode: 0o600 },
    );

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.includes(".well-known")) {
        return new Response(JSON.stringify({ token_endpoint: "https://auth.x.ai/oauth2/token" }), {
          status: 200,
        });
      }
      if (value.includes("oauth2/token")) {
        expect(String(init?.body)).toContain("refresh_token=refresh-test");
        return new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "fresh-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer fresh-access");
      return new Response(
        JSON.stringify({
          model: "grok-4.6",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createSuperGrokProvider({ authFile });
    const events = await collect(
      provider.stream([{ role: "user", content: [{ type: "text", text: "hello" }] }], {
        model: "grok-4.6",
      }),
    );
    expect(events).toContainEqual({ type: "text_delta", text: "ok" });

    const stored = JSON.parse(await readFile(authFile, "utf8")) as {
      supergrok: { access: string; refresh: string };
    };
    expect(stored.supergrok.access).toBe("fresh-access");
    expect(stored.supergrok.refresh).not.toContain("fresh-refresh");
    expect(stored.supergrok.refresh.startsWith("xai:")).toBe(true);
  });

  it("fails closed when xAI reports a different model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hairy-supergrok-mismatch-"));
    const authFile = join(directory, "auth.json");
    await writeFile(
      authFile,
      JSON.stringify({
        supergrok: {
          type: "oauth",
          access: "access-test",
          refresh: "refresh-test",
          expires: Date.now() + 600_000,
        },
      }),
      { mode: 0o600 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "grok-other",
              choices: [{ message: { content: "unexpected" }, finish_reason: "stop" }],
            }),
            { status: 200 },
          ),
      ),
    );

    const provider = createSuperGrokProvider({ authFile });
    const events = await collect(
      provider.stream([{ role: "user", content: [{ type: "text", text: "hello" }] }], {
        model: "grok-4.6",
      }),
    );
    expect(events).toEqual([
      {
        type: "error",
        error: "SuperGrok model mismatch: requested grok-4.6, received grok-other",
      },
    ]);
  });
});
