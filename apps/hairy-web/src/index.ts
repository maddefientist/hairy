import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebDatabase } from "./db.js";
import { conversationsHandler, threadHandler } from "./routes/conversations.js";
import { dashboardHandler } from "./routes/dashboard.js";
import { initiativesHandler } from "./routes/initiatives.js";
import { memoryFeedbackHandler, memoryHandler } from "./routes/memory.js";
import { settingsEnvHandler, settingsHandler, settingsHealthHandler } from "./routes/settings.js";
import { toolLogsHandler } from "./routes/tools.js";

const port = Number(process.env.WEB_PORT ?? 3000);
const dbPath = process.env.AGENT_DB_PATH ?? join(process.cwd(), "data", "agent.db");
const webToken = process.env.WEB_TOKEN ?? "";

if (!existsSync(dbPath)) {
  console.error(`[hairy-web] agent.db not found at ${dbPath}. Set AGENT_DB_PATH env var.`);
  process.exit(1);
}

const db = new WebDatabase(dbPath);
const app = new Hono();

// Simple bearer token auth — skip if WEB_TOKEN is not set (LAN-only dev mode)
if (webToken) {
  app.use("*", async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    const cookie = c.req.header("Cookie") ?? "";
    const hasBearer = auth === `Bearer ${webToken}`;
    const hasCookie = cookie.includes(`htoken=${webToken}`);

    if (!hasBearer && !hasCookie) {
      // Check query param for browser-friendly login
      const q = new URL(c.req.url).searchParams.get("token");
      if (q === webToken) {
        const res = await next();
        c.header("Set-Cookie", `htoken=${webToken}; Path=/; SameSite=Strict; HttpOnly`);
        return res;
      }
      return c.text("Unauthorized", 401);
    }
    return next();
  });
}

// Serve vendored htmx
const htmxPath = join(import.meta.dirname ?? process.cwd(), "..", "public", "htmx.min.js");
app.get("/htmx.min.js", (c) => {
  if (!existsSync(htmxPath)) {
    return c.text("htmx not found", 404);
  }
  const content = readFileSync(htmxPath, "utf8");
  c.header("Content-Type", "application/javascript");
  c.header("Cache-Control", "public, max-age=86400");
  return c.text(content);
});

app.get("/", dashboardHandler(db));
app.get("/conversations", conversationsHandler(db));
app.get("/conversations/:channelId", threadHandler(db));
app.get("/tools", toolLogsHandler(db));
app.get("/initiatives", initiativesHandler(db));
app.get("/memory", memoryHandler());
app.post("/memory/feedback", memoryFeedbackHandler());
app.get("/settings", settingsHandler());
app.post("/settings/env", settingsEnvHandler());
app.get("/settings/health", settingsHealthHandler());

app.get("/health", (c) => c.json({ ok: true, db: dbPath }));

serve({ fetch: app.fetch, port }, () => {
  console.log(`[hairy-web] listening on http://0.0.0.0:${port}`);
});
