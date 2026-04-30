export function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — Hairy</title>
  <script src="/htmx.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0d0d0d;
      --surface: #141414;
      --border: #222;
      --accent: #7c3aed;
      --accent-dim: #4c1d95;
      --text: #e2e2e2;
      --muted: #666;
      --green: #22c55e;
      --red: #ef4444;
      --yellow: #eab308;
      --radius: 6px;
      --font: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    }

    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      line-height: 1.6;
      display: flex;
      min-height: 100vh;
    }

    nav {
      width: 200px;
      min-width: 200px;
      background: var(--surface);
      border-right: 1px solid var(--border);
      padding: 20px 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    nav .brand {
      padding: 0 16px 16px;
      font-size: 15px;
      font-weight: 700;
      color: var(--accent);
      border-bottom: 1px solid var(--border);
      margin-bottom: 8px;
    }

    nav a {
      display: block;
      padding: 8px 16px;
      color: var(--muted);
      text-decoration: none;
      border-left: 3px solid transparent;
      transition: all 0.1s;
    }

    nav a:hover, nav a.active {
      color: var(--text);
      background: rgba(124,58,237,0.1);
      border-left-color: var(--accent);
    }

    main {
      flex: 1;
      padding: 24px;
      overflow-y: auto;
    }

    h1 { font-size: 18px; margin-bottom: 20px; }
    h2 { font-size: 14px; margin-bottom: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }

    .grid { display: grid; gap: 16px; }
    .grid-4 { grid-template-columns: repeat(4, 1fr); }
    .grid-2 { grid-template-columns: repeat(2, 1fr); }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
    }

    .stat-card {
      text-align: center;
    }

    .stat-value {
      font-size: 32px;
      font-weight: 700;
      color: var(--accent);
    }

    .stat-label {
      color: var(--muted);
      font-size: 11px;
      margin-top: 4px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th, td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }

    th {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,0.02); }

    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
    }

    .badge-error { background: rgba(239,68,68,0.15); color: var(--red); }
    .badge-ok { background: rgba(34,197,94,0.15); color: var(--green); }
    .badge-user { background: rgba(124,58,237,0.15); color: #a78bfa; }
    .badge-assistant { background: rgba(234,179,8,0.15); color: var(--yellow); }

    .chat-bubble {
      padding: 10px 14px;
      border-radius: var(--radius);
      max-width: 80%;
      margin-bottom: 8px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .bubble-user {
      background: var(--accent-dim);
      align-self: flex-end;
      margin-left: auto;
    }

    .bubble-assistant {
      background: var(--surface);
      border: 1px solid var(--border);
    }

    .chat-wrap {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 16px;
    }

    .ts {
      font-size: 10px;
      color: var(--muted);
    }

    .filter-bar {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      align-items: center;
    }

    select, input {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 10px;
      border-radius: var(--radius);
      font-family: var(--font);
      font-size: 12px;
    }

    select:focus, input:focus { outline: 2px solid var(--accent); }

    .truncate {
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .section { margin-bottom: 32px; }

    .channel-list { display: flex; flex-direction: column; gap: 4px; }

    .channel-item {
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .channel-item:hover { border-color: var(--accent); background: rgba(124,58,237,0.05); }

    .empty { color: var(--muted); padding: 24px; text-align: center; }

    .tag {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      background: rgba(255,255,255,0.05);
      color: var(--muted);
    }
  </style>
</head>
<body>
  <nav>
    <div class="brand">⬡ hairy</div>
    <a href="/" ${title === "Dashboard" ? 'class="active"' : ""}>Dashboard</a>
    <a href="/conversations" ${title === "Conversations" ? 'class="active"' : ""}>Conversations</a>
    <a href="/tools" ${title === "Tool Logs" ? 'class="active"' : ""}>Tool Logs</a>
    <a href="/initiatives" ${title === "Initiatives" ? 'class="active"' : ""}>Initiatives</a>
    <a href="/memory" ${title === "Memory" ? 'class="active"' : ""}>Memory</a>
    <a href="/settings" ${title === "Settings" ? 'class="active"' : ""}>Settings</a>
  </nav>
  <main>
    ${body}
  </main>
</body>
</html>`;
}

export function ts(epoch: number): string {
  return new Date(epoch).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
