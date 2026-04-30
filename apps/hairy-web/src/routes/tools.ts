import type { Context } from "hono";
import type { WebDatabase } from "../db.js";
import { escape, layout, ts } from "../layout.js";

export function toolLogsHandler(db: WebDatabase) {
  return (c: Context) => {
    const toolName = c.req.query("tool") ?? "";
    const errorsOnly = c.req.query("errors") === "1";
    const toolNames = db.getDistinctToolNames();

    const logs = db.getToolLogs({
      toolName: toolName || undefined,
      errorsOnly,
      limit: 100,
    });

    const filterBar = `
      <form class="filter-bar" hx-get="/tools" hx-target="body" hx-push-url="true">
        <select name="tool">
          <option value="">All tools</option>
          ${toolNames.map((n) => `<option value="${escape(n)}" ${n === toolName ? "selected" : ""}>${escape(n)}</option>`).join("")}
        </select>
        <label style="display:flex;align-items:center;gap:4px;">
          <input type="checkbox" name="errors" value="1" ${errorsOnly ? "checked" : ""} />
          Errors only
        </label>
        <button type="submit" style="background:var(--accent);color:#fff;border:none;padding:6px 12px;border-radius:var(--radius);cursor:pointer;font-family:var(--font);font-size:12px;">Filter</button>
      </form>`;

    const tableHtml = logs.length === 0
      ? '<div class="empty">No tool logs match the filter.</div>'
      : `<table>
          <thead><tr><th>Time</th><th>Tool</th><th>Duration</th><th>Status</th><th>Channel</th><th>Args</th></tr></thead>
          <tbody>
          ${logs
            .map(
              (l) => `<tr>
            <td class="ts">${ts(l.timestamp)}</td>
            <td><code>${escape(l.tool_name)}</code></td>
            <td>${l.duration_ms != null ? `${l.duration_ms}ms` : "—"}</td>
            <td><span class="badge badge-${l.is_error ? "error" : "ok"}">${l.is_error ? "error" : "ok"}</span></td>
            <td class="ts">${l.channel_id ? escape(l.channel_id) : "—"}</td>
            <td class="truncate ts">${escape(l.args.slice(0, 80))}</td>
          </tr>`,
            )
            .join("")}
          </tbody>
        </table>`;

    const body = `
      <h1>Tool Logs</h1>
      ${filterBar}
      <div class="card">${tableHtml}</div>`;

    return c.html(layout("Tool Logs", body));
  };
}
