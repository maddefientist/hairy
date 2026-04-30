import type { Context } from "hono";
import type { WebDatabase } from "../db.js";
import { escape, layout, ts } from "../layout.js";

export function dashboardHandler(db: WebDatabase) {
  return (c: Context) => {
    const sessionCount = db.getSessionCount();
    const msgToday = db.getMessageCountToday();
    const toolsToday = db.getToolCallCountToday();
    const errorsToday = db.getErrorCountToday();
    const avgDuration = db.getAvgToolDuration();
    const recent = db.getRecentMessages(10);

    const statsHtml = `
      <div class="grid grid-4">
        <div class="card stat-card">
          <div class="stat-value">${sessionCount}</div>
          <div class="stat-label">Total Sessions</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${msgToday}</div>
          <div class="stat-label">Messages Today</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${toolsToday}</div>
          <div class="stat-label">Tool Calls Today</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value" style="color:${errorsToday > 0 ? "var(--red)" : "var(--green)"}">${errorsToday}</div>
          <div class="stat-label">Errors Today</div>
        </div>
      </div>`;

    const recentHtml = recent.length === 0
      ? '<div class="empty">No messages yet.</div>'
      : `<table>
          <thead><tr><th>Time</th><th>Channel</th><th>Role</th><th>Content</th></tr></thead>
          <tbody>
          ${recent
            .map(
              (m) => `<tr>
            <td class="ts">${ts(m.timestamp)}</td>
            <td><span class="tag">${escape(m.channel_id)}</span></td>
            <td><span class="badge badge-${m.role}">${m.role}</span></td>
            <td class="truncate">${escape(m.content.slice(0, 120))}</td>
          </tr>`,
            )
            .join("")}
          </tbody>
        </table>`;

    const body = `
      <h1>Dashboard</h1>
      <div class="section">${statsHtml}</div>
      <div class="section">
        <h2>Recent Activity</h2>
        <div class="card">${recentHtml}</div>
      </div>
      <div class="section">
        <div class="card" style="display:flex;gap:24px;align-items:center;">
          <div>
            <div style="color:var(--muted);font-size:11px;">AVG TOOL DURATION</div>
            <div style="font-size:20px;color:var(--accent)">${avgDuration}ms</div>
          </div>
        </div>
      </div>`;

    return c.html(layout("Dashboard", body));
  };
}
