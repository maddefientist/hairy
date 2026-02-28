import type { AgentResponse } from "@hairy/core";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { BaseAdapter } from "./adapter.js";

export interface WebhookOpts {
  port: number;
  secret: string;
}

interface NodeServerHandle {
  close: (callback?: (err?: Error) => void) => void;
}

export class WebhookAdapter extends BaseAdapter {
  readonly channelType = "webhook";
  private server: NodeServerHandle | null = null;

  constructor(private readonly opts: WebhookOpts) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const app = new Hono();

    app.post("/webhook/incoming", async (c) => {
      const secret = c.req.header("x-hairy-secret");
      if (secret !== this.opts.secret) {
        return c.json({ error: "unauthorized" }, 401);
      }

      const body = (await c.req.json()) as { channelId?: string; senderId?: string; text?: string };
      this.emitMessage({
        channelId: body.channelId ?? "webhook",
        channelType: "webhook",
        senderId: body.senderId ?? "webhook-user",
        senderName: "Webhook User",
        content: { text: body.text ?? "" },
      });

      return c.json({ ok: true });
    });

    app.post("/webhook/outgoing", async (c) => {
      const secret = c.req.header("x-hairy-secret");
      if (secret !== this.opts.secret) {
        return c.json({ error: "unauthorized" }, 401);
      }
      return c.json({ ok: true });
    });

    this.server = serve({ fetch: app.fetch, port: this.opts.port }) as unknown as NodeServerHandle;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });

    this.server = null;
    this.connected = false;
  }

  async sendMessage(_channelId: string, _response: AgentResponse): Promise<void> {}
}

export const createWebhookAdapter = (opts: WebhookOpts): WebhookAdapter => {
  return new WebhookAdapter(opts);
};
