import type { Context } from "hono";
import type { WebDatabase } from "../db.js";
import { escape, layout, ts } from "../layout.js";

export function conversationsHandler(db: WebDatabase) {
  return (c: Context) => {
    const sessions = db.getSessions(30);

    const sessionListHtml = sessions.length === 0
      ? '<div class="empty">No sessions yet.</div>'
      : `<div class="channel-list">
          ${sessions
            .map(
              (s) => `
            <div class="channel-item"
              hx-get="/conversations/${encodeURIComponent(s.channel_id)}"
              hx-target="#thread-pane"
              hx-swap="innerHTML">
              <div>
                <div>${escape(s.channel_id)}</div>
                <div class="ts">${ts(s.last_active_at)}</div>
              </div>
              <span class="tag">${escape(s.channel_type)}</span>
            </div>`,
            )
            .join("")}
        </div>`;

    const body = `
      <h1>Conversations</h1>
      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <h2>Channels</h2>
          ${sessionListHtml}
        </div>
        <div class="card" id="thread-pane">
          <div class="empty">Select a channel to view messages.</div>
        </div>
      </div>`;

    return c.html(layout("Conversations", body));
  };
}

export function threadHandler(db: WebDatabase) {
  return (c: Context) => {
    const channelId = decodeURIComponent(c.req.param("channelId") ?? "");
    const messages = db.getMessagesByChannel(channelId, 100);

    if (messages.length === 0) {
      return c.html('<div class="empty">No messages in this channel.</div>');
    }

    const html = `
      <h2>${escape(channelId)}</h2>
      <div class="chat-wrap">
        ${messages
          .map(
            (m) => `
          <div>
            <div class="ts" style="text-align:${m.role === "user" ? "right" : "left"}">${m.role} · ${ts(m.timestamp)}</div>
            <div class="chat-bubble bubble-${m.role}">${escape(m.content)}</div>
          </div>`,
          )
          .join("")}
      </div>`;

    return c.html(html);
  };
}
