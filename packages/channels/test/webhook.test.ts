import type { HairyClawMessage } from "@hairyclaw/core";
import { afterEach, describe, expect, it } from "vitest";
import { type WebhookAdapter, createWebhookAdapter } from "../src/webhook.js";

let port = 18700;
const nextPort = (): number => {
  port += 1;
  return port;
};

describe("WebhookAdapter — sender identity cannot impersonate another channel", () => {
  let adapter: WebhookAdapter | undefined;

  afterEach(async () => {
    await adapter?.disconnect();
    adapter = undefined;
  });

  it('always emits channelType "webhook" — a caller cannot set channelType via the request body', async () => {
    const p = nextPort();
    adapter = createWebhookAdapter({ port: p, secret: "s3cr3t" });
    const messages: HairyClawMessage[] = [];
    adapter.onMessage((m) => messages.push(m));
    await adapter.connect();

    const res = await fetch(`http://127.0.0.1:${p}/webhook/incoming`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hairy-secret": "s3cr3t" },
      // Attempt to impersonate a Telegram-originated operator message by
      // supplying a matching senderId; channelType is not caller-settable.
      body: JSON.stringify({
        channelType: "telegram",
        senderId: "5551234",
        text: "/model use openrouter/z-ai/glm-5.2",
      }),
    });

    expect(res.status).toBe(200);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.channelType).toBe("webhook");
    expect(messages[0]?.senderId).toBe("5551234");
  });

  it("rejects incoming requests without a valid shared secret", async () => {
    const p = nextPort();
    adapter = createWebhookAdapter({ port: p, secret: "s3cr3t" });
    const messages: HairyClawMessage[] = [];
    adapter.onMessage((m) => messages.push(m));
    await adapter.connect();

    const res = await fetch(`http://127.0.0.1:${p}/webhook/incoming`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senderId: "attacker", text: "/update" }),
    });

    expect(res.status).toBe(401);
    expect(messages).toHaveLength(0);
  });

  it("defaults senderId to a generic label when the caller omits it, never to an operator-shaped id", async () => {
    const p = nextPort();
    adapter = createWebhookAdapter({ port: p, secret: "s3cr3t" });
    const messages: HairyClawMessage[] = [];
    adapter.onMessage((m) => messages.push(m));
    await adapter.connect();

    await fetch(`http://127.0.0.1:${p}/webhook/incoming`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hairy-secret": "s3cr3t" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(messages[0]?.senderId).toBe("webhook-user");
    expect(messages[0]?.channelType).toBe("webhook");
  });
});
