import type { Metrics } from "@hairyclaw/observability";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

interface HealthServerOptions {
  port: number;
  getStatus: () => Record<string, unknown>;
  metrics: Metrics;
}

interface ServerHandle {
  close: (cb?: () => void) => void;
}

export class HealthServer {
  private server: ServerHandle | null = null;

  constructor(private readonly opts: HealthServerOptions) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const app = new Hono();

    app.get("/health", (c) => {
      return c.json({
        status: "ok",
        ...this.opts.getStatus(),
      });
    });

    app.get("/metrics", (c) => {
      c.header("content-type", "text/plain; version=0.0.4");
      return c.text(this.opts.metrics.toPrometheus());
    });

    this.server = serve({ fetch: app.fetch, port: this.opts.port }) as unknown as ServerHandle;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });

    this.server = null;
  }
}
