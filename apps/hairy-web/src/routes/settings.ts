import { lstat, open, readFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Context } from "hono";
import { escape, layout } from "../layout.js";

// Keys the GUI is allowed to read and write. Anything not in this list is invisible to the web layer.
const EDITABLE_ENV_KEYS = [
  "OLLAMA_MODEL",
  "OLLAMA_BASE_URL",
  "ORCHESTRATOR_MODEL",
  "EXECUTOR_MODEL",
] as const;

type EditableKey = (typeof EDITABLE_ENV_KEYS)[number];

const EDITABLE_ENV_SET: ReadonlySet<string> = new Set(EDITABLE_ENV_KEYS);

// Known error codes passed via redirect query param — never render free-form user text
const ERROR_MESSAGES: Record<string, string> = {
  invalid: "Invalid value — no newlines, max 500 chars",
  write: "Write failed — check file permissions",
};

function parseEnv(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    map.set(key, val);
  }
  return map;
}

function patchEnv(raw: string, updates: Record<string, string>): string {
  // Defensive: reject any key not in the allowlist — catches future callers
  for (const k of Object.keys(updates)) {
    if (!EDITABLE_ENV_SET.has(k)) throw new Error(`refusing to write unallowed key: ${k}`);
  }

  const patched = new Set<string>();
  const lines = raw.split("\n").map((line) => {
    const eq = line.indexOf("=");
    if (eq < 0) return line;
    const key = line.slice(0, eq).trim();
    if (Object.hasOwn(updates, key)) {
      patched.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [key, val] of Object.entries(updates)) {
    if (!patched.has(key)) lines.push(`${key}=${val}`);
  }

  return lines.join("\n");
}

async function atomicWriteEnv(envPath: string, content: string): Promise<void> {
  // Refuse to write through a symlink at the destination
  const stat = await lstat(envPath).catch(() => null);
  if (stat?.isSymbolicLink()) throw new Error("refusing to write through symlink");

  // Keep tmp on the same filesystem as envPath so rename() is guaranteed atomic (no EXDEV)
  const tmp = join(dirname(envPath), `.${basename(envPath)}.${process.pid}.${Date.now()}.tmp`);
  const fh = await open(tmp, "wx", 0o600); // O_CREAT | O_EXCL — fails if tmp already exists
  try {
    await fh.writeFile(content, "utf8");
  } finally {
    await fh.close();
  }
  await rename(tmp, envPath);
}

function isValidValue(val: string): boolean {
  return val.length <= 500 && !/[\n\r\0]/.test(val);
}

function keyLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function settingsHandler() {
  return async (c: Context) => {
    const envPath = process.env.ENV_FILE_PATH ?? join(process.cwd(), ".env");
    const agentHealthUrl = process.env.AGENT_HEALTH_URL ?? "";

    let envValues = new Map<string, string>();
    let envReadError = "";
    try {
      envValues = parseEnv(await readFile(envPath, "utf8"));
    } catch {
      envReadError = `Cannot read ${envPath}`;
    }

    const saved = c.req.query("saved") === "1";
    const errCode = c.req.query("error") ?? "";
    const errMsg = ERROR_MESSAGES[errCode] ?? "";

    const flashHtml = saved
      ? `<div class="badge badge-ok" style="padding:8px 14px;margin-bottom:20px;display:inline-block;">Saved — restart hairyclaw.service to apply changes</div>`
      : errMsg
        ? `<div class="badge badge-error" style="padding:8px 14px;margin-bottom:20px;display:inline-block;">${escape(errMsg)}</div>`
        : "";

    const envErrorHtml = envReadError
      ? `<div class="badge badge-error" style="padding:8px 14px;margin-bottom:20px;display:inline-block;">${escape(envReadError)}</div>`
      : "";

    const modelForm = `
      <form method="POST" action="/settings/env" style="display:flex;flex-direction:column;gap:14px;">
        ${EDITABLE_ENV_KEYS.map(
          (key: EditableKey) => `
          <label style="display:flex;flex-direction:column;gap:5px;">
            <span style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;">${keyLabel(key)}</span>
            <input type="text" name="${key}" value="${escape(envValues.get(key) ?? "")}" style="font-family:var(--font);font-size:12px;" />
          </label>`,
        ).join("")}
        <div style="margin-top:4px;">
          <button type="submit" style="background:var(--accent);color:#fff;border:none;padding:8px 16px;border-radius:var(--radius);cursor:pointer;font-family:var(--font);font-size:12px;">Save</button>
        </div>
      </form>`;

    const healthPanel = agentHealthUrl
      ? `<div hx-get="/settings/health" hx-trigger="load, every 30s" hx-swap="innerHTML">
           <div class="empty">Loading…</div>
         </div>`
      : `<div class="empty">Set <code>AGENT_HEALTH_URL</code> env var to enable (e.g. http://localhost:8080).</div>`;

    const body = `
      <h1>Settings</h1>
      ${flashHtml}${envErrorHtml}

      <div class="section">
        <h2>Model Config</h2>
        <div class="card">${modelForm}</div>
      </div>

      <div class="section">
        <h2>Provider Health</h2>
        <div class="card">${healthPanel}</div>
      </div>`;

    return c.html(layout("Settings", body));
  };
}

export function settingsEnvHandler() {
  return async (c: Context) => {
    const envPath = process.env.ENV_FILE_PATH ?? join(process.cwd(), ".env");
    const form = await c.req.parseBody();

    const updates: Record<string, string> = {};
    for (const key of EDITABLE_ENV_KEYS) {
      const val = form[key];
      if (typeof val !== "string") continue;
      if (!isValidValue(val)) {
        return c.redirect("/settings?error=invalid", 303);
      }
      updates[key] = val;
    }

    try {
      const existing = await readFile(envPath, "utf8").catch(() => "");
      await atomicWriteEnv(envPath, patchEnv(existing, updates));
    } catch (err) {
      console.error("[settings] env write failed:", err instanceof Error ? err.message : String(err));
      return c.redirect("/settings?error=write", 303);
    }

    return c.redirect("/settings?saved=1", 303);
  };
}

export function settingsHealthHandler() {
  return async (c: Context) => {
    const agentUrl = process.env.AGENT_HEALTH_URL ?? "";
    if (!agentUrl) {
      return c.html(`<div class="empty">AGENT_HEALTH_URL not configured.</div>`);
    }

    try {
      const res = await fetch(new URL("/health", agentUrl).toString(), {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Cap response to 64 KB to prevent DoS via large payloads
      const text = await res.text();
      const data = JSON.parse(text.slice(0, 65_536)) as Record<string, unknown>;

      const rows = Object.entries(data)
        .slice(0, 50)
        .map(([k, v]) => {
          const display =
            typeof v === "object"
              ? `<pre style="margin:0;font-size:10px;white-space:pre-wrap;">${escape(JSON.stringify(v, null, 2))}</pre>`
              : escape(String(v));
          return `<tr><td style="white-space:nowrap;">${escape(k)}</td><td>${display}</td></tr>`;
        })
        .join("");

      return c.html(`
        <table>
          <thead><tr><th>Field</th><th>Value</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`);
    } catch (err) {
      return c.html(
        `<div class="empty" style="color:var(--yellow)">Agent unreachable: ${escape(err instanceof Error ? err.message : String(err))}</div>`,
      );
    }
  };
}
