import type { Context } from "hono";
import { escape, layout, ts } from "../layout.js";

interface HiveEntry {
  id: string;
  content?: string;
  snippet?: string;
  tags: string[];
  createdAt?: string;
  created_at?: string;
  score: number;
  memory_type?: string;
}

interface HiveResponse {
  items?: HiveEntry[];
  results?: HiveEntry[];
}

const MEMORY_TYPES = [
  "fact",
  "decision",
  "preference",
  "skill",
  "reference",
  "correction",
  "session_summary",
];

async function searchHive(
  hiveUrl: string,
  query: string,
  memoryType?: string,
  topK = 30,
): Promise<HiveEntry[]> {
  const body: Record<string, unknown> = {
    namespace: process.env.HARI_HIVE_NAMESPACE ?? "default",
    scope: "all",
    query_text: query,
    top_k: topK,
  };
  if (memoryType) body.memory_type = memoryType;

  const apiKey = process.env.HARI_HIVE_API_KEY ?? process.env.HARI_HIVE_READ_API_KEY ?? "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${hiveUrl}/recall`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as HiveResponse;
  return data.items ?? data.results ?? [];
}

export function memoryHandler() {
  return async (c: Context) => {
    const hiveUrl = process.env.HARI_HIVE_URL;

    if (!hiveUrl) {
      return c.html(
        layout(
          "Memory",
          `<h1>Memory Browser</h1><div class="card"><div class="empty">HARI_HIVE_URL env var not configured.</div></div>`,
        ),
      );
    }

    const query = c.req.query("q") ?? "";
    const memoryType = c.req.query("type") ?? "";

    let entries: HiveEntry[] = [];
    let errorMsg = "";

    if (query.trim().length > 0) {
      try {
        entries = await searchHive(hiveUrl, query, memoryType || undefined);
      } catch (err) {
        console.error("[memory] hive search failed:", err instanceof Error ? err.message : String(err));
        errorMsg = "Hive unreachable — check HARI_HIVE_URL";
      }
    }

    const filterBar = `
      <form class="filter-bar" hx-get="/memory" hx-target="body" hx-push-url="true">
        <input type="text" name="q" value="${escape(query)}" placeholder="Search memories…" style="flex:1;min-width:220px;" />
        <select name="type">
          <option value="">All types</option>
          ${MEMORY_TYPES.map((t) => `<option value="${t}" ${t === memoryType ? "selected" : ""}>${t}</option>`).join("")}
        </select>
        <button type="submit" style="background:var(--accent);color:#fff;border:none;padding:6px 12px;border-radius:var(--radius);cursor:pointer;font-family:var(--font);font-size:12px;">Search</button>
      </form>`;

    let resultsHtml: string;

    if (!query.trim()) {
      resultsHtml = `<div class="empty">Enter a query to search memories.</div>`;
    } else if (errorMsg) {
      resultsHtml = `<div class="empty" style="color:var(--red)">Error: ${escape(errorMsg)}</div>`;
    } else if (entries.length === 0) {
      resultsHtml = `<div class="empty">No memories found for "${escape(query)}".</div>`;
    } else {
      const rows = entries
        .map((e) => {
          const content = e.content ?? e.snippet ?? "";
          const rawDate = e.createdAt ?? e.created_at;
          const created = rawDate ? ts(new Date(rawDate).getTime()) : "—";
          const score = typeof e.score === "number" ? e.score.toFixed(3) : "—";
          const tags = (e.tags ?? [])
            .map((t) => `<span class="tag">${escape(t)}</span>`)
            .join(" ");
          const typeBadge = e.memory_type
            ? `<span class="badge" style="background:rgba(124,58,237,0.15);color:#a78bfa;">${escape(e.memory_type)}</span>`
            : `<span class="ts">—</span>`;
          const feedback = `<span style="display:flex;gap:4px;">
            <button class="fb-btn" hx-post="/memory/feedback" hx-vals="${escape(JSON.stringify({ id: e.id, signal: "useful" }))}" hx-swap="none" title="Useful">👍</button>
            <button class="fb-btn" hx-post="/memory/feedback" hx-vals="${escape(JSON.stringify({ id: e.id, signal: "wrong" }))}" hx-swap="none" title="Wrong">👎</button>
          </span>`;
          return `<tr>
            <td class="ts" style="white-space:nowrap;">${score}</td>
            <td>${typeBadge}</td>
            <td style="max-width:420px;word-break:break-word;white-space:pre-wrap;">${escape(content)}</td>
            <td class="ts" style="max-width:160px;">${tags || "—"}</td>
            <td class="ts" style="white-space:nowrap;">${created}</td>
            <td>${feedback}</td>
          </tr>`;
        })
        .join("");

      resultsHtml = `
        <style>.fb-btn{background:none;border:1px solid var(--border);border-radius:var(--radius);padding:2px 6px;cursor:pointer;font-size:12px;}.fb-btn:hover{border-color:var(--accent);}</style>
        <p class="ts" style="margin-bottom:10px;">${entries.length} result${entries.length === 1 ? "" : "s"}</p>
        <table>
          <thead><tr><th>Score</th><th>Type</th><th>Content</th><th>Tags</th><th>Created</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    return c.html(
      layout("Memory", `<h1>Memory Browser</h1>${filterBar}<div class="card">${resultsHtml}</div>`),
    );
  };
}

export function memoryFeedbackHandler() {
  return async (c: Context) => {
    const hiveUrl = process.env.HARI_HIVE_URL;
    if (!hiveUrl) return c.body(null, 204);

    const VALID_SIGNALS = new Set(["useful", "noted", "wrong"]);

    const form = await c.req.parseBody();
    const id = typeof form["id"] === "string" ? form["id"] : "";
    const signal = typeof form["signal"] === "string" ? form["signal"] : "";
    if (!id || id.length > 128 || !VALID_SIGNALS.has(signal)) return c.body(null, 204);

    const apiKey = process.env.HARI_HIVE_API_KEY ?? process.env.HARI_HIVE_READ_API_KEY ?? "";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    await fetch(`${hiveUrl}/feedback`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id, signal }),
    }).catch((err: unknown) => {
      console.warn("[memory] feedback write failed:", err instanceof Error ? err.message : String(err));
    });

    return c.body(null, 204);
  };
}
