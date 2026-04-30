import type { Context } from "hono";
import type { WebDatabase } from "../db.js";
import { escape, layout, ts } from "../layout.js";

export function initiativesHandler(db: WebDatabase) {
  return (c: Context) => {
    const runs = db.getInitiativeRuns(50);

    const tableHtml = runs.length === 0
      ? '<div class="empty">No initiative runs recorded yet.</div>'
      : `<table>
          <thead><tr><th>Time</th><th>Rule ID</th><th>Outcome</th></tr></thead>
          <tbody>
          ${runs
            .map(
              (r) => `<tr>
            <td class="ts">${ts(r.timestamp)}</td>
            <td><code>${escape(r.rule_id)}</code></td>
            <td>${r.outcome ? `<span class="truncate" style="display:block">${escape(r.outcome.slice(0, 120))}</span>` : '<span class="ts">—</span>'}</td>
          </tr>`,
            )
            .join("")}
          </tbody>
        </table>`;

    const body = `
      <h1>Initiative Runs</h1>
      <div class="card">${tableHtml}</div>`;

    return c.html(layout("Initiatives", body));
  };
}
