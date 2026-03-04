# Betki Deployment Plan — Isolated Lifestyle Agent on Hairy

**Agent Name:** Betki  
**Platform:** Hairy (TypeScript agentic harness)  
**Target VM:** hiveagent (Ubuntu 25.04, 4 cores, 4GB RAM, 62GB free)  
**Channel:** WhatsApp (Baileys/Web mode, QR pairing)  
**Provider:** Ollama → kimi-k2.5:cloud at 192.168.1.225:11434  
**Isolation:** Fully isolated — separate data dir, separate hive namespace, no shared state  
**Personality:** Self-developing through conversation  

---

## Phase 0: Pre-flight Fixes (Local, Before Deploy)

These are code changes needed in the Hairy repo before deploying. The framework is 70% done — the gaps that matter for Betki are specific and bounded.

### 0.1 — Fix `config.ts` to support Ollama provider (no API key required)

**File:** `apps/hairy-agent/src/config.ts`

**Problem:** Current config demands `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` — throws if neither is set. Ollama needs no API key.

**Change:** 
- Add `ollama` to `runtimeSchema` with optional `baseUrl`
- Read `OLLAMA_BASE_URL` env var (default: `http://localhost:11434`)
- Remove the hard `hasProvider` check — instead validate that at least one provider is configured (including ollama)
- Add `ollamaBaseUrl` to `HairyRuntimeConfig`

### 0.2 — Wire Ollama provider into `main.ts`

**File:** `apps/hairy-agent/src/main.ts`

**Problem:** `buildProviders()` only creates Anthropic and OpenRouter providers. Ollama is imported nowhere in main.

**Change:**
- Import `createOllamaProvider` from `@hairy/providers`
- Add to `buildProviders()`: if `OLLAMA_BASE_URL` is set or ollama is configured, create the provider
- Set as first in fallback chain when it's the default

### 0.3 — Fix Ollama provider to use `/api/chat` with tool support

**File:** `packages/providers/src/ollama.ts`

**Problem:** Current implementation uses `/api/generate` with a flattened prompt string. This loses:
- Message roles (system/user/assistant)
- Tool definitions and tool calling
- Streaming

**Change:**
- Switch from `/api/generate` to `/api/chat` endpoint
- Send messages as proper `{ role, content }` array
- Add `system` message support (for system prompt)
- Pass `tools` array when `streamOpts.tools` is provided (Ollama supports OpenAI-compatible tool format)
- Parse `tool_calls` from response and emit `tool_call_start`/`tool_call_end` events
- Enable streaming (`stream: true`) and yield `text_delta` events per chunk
- Emit proper `usage` events with token counts from Ollama's response

**Reference:** Ollama `/api/chat` accepts:
```json
{
  "model": "kimi-k2.5:cloud",
  "messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}],
  "tools": [{"type": "function", "function": {"name": "...", "description": "...", "parameters": {...}}}],
  "stream": true
}
```

### 0.4 — Wire WhatsApp into config properly

**File:** `apps/hairy-agent/src/config.ts`  

**Problem:** WhatsApp is gated on `WHATSAPP_ENABLED=true` env var but not part of the config schema or TOML config.

**Change:**
- Add `whatsapp` to channels config schema: `{ enabled, sessionDir, allowedJids }`
- Read from TOML config AND env vars (env takes precedence)
- Add `WHATSAPP_SESSION_DIR` env var support

### 0.5 — Ensure Baileys dependency is installed

**File:** `packages/channels/package.json`

**Verify:** `@whiskeysockets/baileys` is in dependencies. If not, add it.  
**Also verify:** `@hapi/boom` is available (used for disconnect reason typing).

### 0.6 — Add `hive_recall` and `hive_ingest` as built-in tools

**Files:** 
- `packages/tools/src/builtin/hive-recall.ts` (new)
- `packages/tools/src/builtin/hive-ingest.ts` (new)
- `packages/tools/src/index.ts` (add exports)

**Purpose:** Give Betki the ability to store and retrieve knowledge in its own Hive namespace.

**hive-recall tool:**
```typescript
// Parameters: { query: string, top_k?: number }
// Calls: POST ${HARI_HIVE_URL}/api/v1/recall
// Headers: Authorization: Bearer ${HARI_HIVE_API_KEY}
// Body: { query, top_k, namespace: HARI_HIVE_NAMESPACE }
// Returns: formatted results
```

**hive-ingest tool:**
```typescript
// Parameters: { content: string, tags?: string[], source?: string }
// Calls: POST ${HARI_HIVE_URL}/api/v1/knowledge
// Headers: Authorization: Bearer ${HARI_HIVE_API_KEY}
// Body: { content, tags, source, namespace: HARI_HIVE_NAMESPACE }
// Returns: confirmation with ingested count
```

**Environment variables consumed:**
- `HARI_HIVE_URL` — e.g. `http://192.168.1.225:8088`
- `HARI_HIVE_API_KEY` — the ssot key
- `HARI_HIVE_NAMESPACE` — `betki` (NOT claude-shared)

### 0.7 — Add self-identity evolution tool

**File:** `packages/tools/src/builtin/identity-evolve.ts` (new)

**Purpose:** Let Betki update its own identity.md based on learnings from conversations.

**Tool: `identity_evolve`**
```typescript
// Parameters: { section: string, content: string, reason: string }
// Reads current data/memory/identity.md
// Appends or updates the named section
// Appends change log entry to data/memory/identity-changelog.md with timestamp + reason
// Returns confirmation of what changed
```

### 0.8 — Register new tools in main.ts

**File:** `apps/hairy-agent/src/main.ts`

**Change:** After existing tool registrations, add:
```typescript
registry.register(createHiveRecallTool());
registry.register(createHiveIngestTool());
registry.register(createIdentityEvolveTool());
```

### 0.9 — Fix Node version requirement

**File:** `package.json` (root)

**Problem:** Requires Node >= 22, but hiveagent has Node 20. 

**Options (in order of preference):**
1. Update Node on hiveagent to 22+ via nvm: `nvm install 22 && nvm alias default 22`
2. If that fails, check if Hairy actually uses Node 22 features — if not, relax to `>=20`

**Decision:** Go with option 1. Install Node 22 on hiveagent.

---

## Phase 1: VM Infrastructure Setup

All commands run via `ssh hiveagent`.

### 1.1 — Install Node 22 + pnpm

```bash
# Node 22 via existing nvm
source ~/.nvm/nvm.sh
nvm install 22
nvm alias default 22
nvm use 22

# pnpm
npm install -g pnpm@9
```

### 1.2 — Create Betki instance directory

```bash
mkdir -p /root/betki
```

This is the deployment root. Hairy repo gets cloned/copied here. Fully separate from zeroclaw.

### 1.3 — Clone Hairy repo to hiveagent

**Option A (preferred):** Push hairy to GitHub, clone on VM
```bash
# From MacBook:
cd /Users/admin/agenticharnes/hairy
git remote add origin git@github.com:maddefientist/hairy.git
git push -u origin main

# On hiveagent:
cd /root/betki
git clone git@github.com:maddefientist/hairy.git .
```

**Option B (if no remote yet):** rsync from MacBook
```bash
# From MacBook:
rsync -avz --exclude node_modules --exclude .git --exclude dist \
  /Users/admin/agenticharnes/hairy/ hiveagent:/root/betki/
```

### 1.4 — Install dependencies

```bash
cd /root/betki
pnpm install
pnpm build
```

---

## Phase 2: Betki Configuration

### 2.1 — Create Betki config overlay

**File:** `/root/betki/config/default.toml`

Replace the default config with Betki-specific configuration:

```toml
[agent]
name = "Betki"
data_dir = "/root/betki/data"
max_iterations_per_run = 20
max_context_tokens = 100000

[health]
port = 9091

[channels.cli]
enabled = false

[channels.whatsapp]
enabled = true
session_dir = "/root/betki/data/whatsapp-session"
# allowed_jids populated via env var WHATSAPP_ALLOWED_JIDS

[channels.telegram]
enabled = false

[channels.webhook]
enabled = false

[providers.ollama]
enabled = true
base_url = "http://192.168.1.225:11434"
default_model = "kimi-k2.5:cloud"

[providers.anthropic]
enabled = false

[providers.openrouter]
enabled = false

[routing]
default_provider = "ollama"
fallback_chain = ["ollama"]

[routing.cost]
track = true
daily_budget_usd = 5.0
alert_threshold_pct = 80

[growth]
reflection_enabled = true
initiative_enabled = true
skill_auto_promote = false

[tools.bash]
timeout_ms = 30000
max_output_bytes = 1048576

[tools.sidecar]
auto_build = false
health_check_interval_ms = 60000
```

### 2.2 — Create environment file

**File:** `/root/betki/.env`

```bash
# Provider
OLLAMA_BASE_URL=http://192.168.1.225:11434

# WhatsApp
WHATSAPP_ENABLED=true
WHATSAPP_SESSION_DIR=/root/betki/data/whatsapp-session
# WHATSAPP_ALLOWED_JIDS=  # Set after pairing, or leave empty for all

# Hive (isolated namespace)
HARI_HIVE_URL=http://192.168.1.225:8088
HARI_HIVE_API_KEY=<SET_HARI_HIVE_API_KEY>
HARI_HIVE_NAMESPACE=betki
HARI_HIVE_DEVICE=betki-agent

# Health
HAIRY_HEALTH_PORT=9091

# No anthropic/openrouter needed
```

### 2.3 — Create Betki data directory structure

```bash
mkdir -p /root/betki/data/{memory,skills,conversations,episodic,tasks,whatsapp-session,reflections,metrics}
```

---

## Phase 3: Betki Identity (Seed)

### 3.1 — Create seed identity

**File:** `/root/betki/data/memory/identity.md`

```markdown
# Betki

## Who I Am
I am Betki, a personal lifestyle and general assistant. I help with advice, planning, thinking through problems, and day-to-day life. I communicate via WhatsApp.

## How I Grow
- I develop my personality and expertise through our conversations
- I remember what matters to you and adapt my style over time
- I can store important things I learn using my memory tools
- I version my own identity — every evolution is intentional and logged

## Core Principles
- Be genuinely helpful, not performatively helpful
- Give real advice, not hedged non-answers
- Be direct and honest
- Remember context across conversations
- Ask good questions when I need clarity
- Learn from every interaction

## Boundaries
- I don't execute destructive system commands
- I maintain my own identity separate from other agents
- I store my knowledge in my own namespace, not shared systems
- I'm transparent about what I know and don't know

## Style
- Conversational but substantive
- Adapt tone to the situation (casual for casual, focused for serious)
- No corporate speak, no AI slop
- Developing — this section evolves as I learn your preferences
```

### 3.2 — Create seed knowledge

**File:** `/root/betki/data/memory/knowledge.md`

```markdown
# Knowledge Base

## About My Operator
- Communicates via WhatsApp
- Preferences: still learning

## Things I've Learned
(This section grows as I learn from conversations)
```

### 3.3 — Create identity changelog

**File:** `/root/betki/data/memory/identity-changelog.md`

```markdown
# Identity Changelog

## 2026-03-01 — Genesis
- Initial seed identity created
- Core principles established
- Style section marked as "developing"
- Boundaries defined for isolation
```

---

## Phase 4: Systemd Service (Always-On)

### 4.1 — Create systemd service unit

**File:** `/etc/systemd/system/betki.service`

```ini
[Unit]
Description=Betki — WhatsApp Lifestyle Agent (Hairy Framework)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/betki
EnvironmentFile=/root/betki/.env
ExecStart=/root/.nvm/versions/node/v22.x.x/bin/node apps/hairy-agent/dist/main.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=betki

# Resource limits — don't let it eat the VM
MemoryMax=1G
CPUQuota=100%

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/root/betki/data
ProtectHome=false

[Install]
WantedBy=multi-user.target
```

**Note:** Replace `v22.x.x` with actual Node 22 version path from `nvm which 22`.

### 4.2 — Enable and start

```bash
systemctl daemon-reload
systemctl enable betki.service

# First run: do NOT start via systemd yet — run manually for QR pairing
cd /root/betki
source .env
node apps/hairy-agent/dist/main.js
# → Scan QR code with WhatsApp on phone
# → Once connected, Ctrl+C and then:
systemctl start betki.service
systemctl status betki.service
```

### 4.3 — Verify

```bash
# Check health
curl -s http://127.0.0.1:9091/health | jq

# Check logs
journalctl -u betki -f

# Send a WhatsApp message to the paired number
# Verify response comes back
```

---

## Phase 5: Growth Engine Activation

### 5.1 — Create initial initiative rules

**File:** `/root/betki/data/tasks/initiative-rules.json`

```json
[
  {
    "id": "daily-reflection",
    "trigger": "schedule",
    "condition": "0 23 * * *",
    "action": "Review today's conversations. What did I learn? What patterns do I see? Update my knowledge if anything is worth remembering.",
    "confidence_threshold": 0.8,
    "risk_level": "low",
    "requires_approval": false,
    "cooldown_ms": 82800000
  },
  {
    "id": "weekly-identity-review",
    "trigger": "schedule",
    "condition": "0 10 * * 0",
    "action": "Review my identity.md and identity-changelog.md. Am I evolving in a useful direction? Should I update my style, knowledge areas, or approach based on the past week's interactions?",
    "confidence_threshold": 0.9,
    "risk_level": "low",
    "requires_approval": false,
    "cooldown_ms": 604800000
  }
]
```

### 5.2 — Wire initiative rules into main.ts

**File:** `apps/hairy-agent/src/main.ts`

**Change:** Load initiative rules from `data/tasks/initiative-rules.json` and pass to `InitiativeEngine` constructor instead of empty `rules: []`.

---

## Phase 6: Isolation Verification Checklist

After deployment, verify these isolation guarantees:

| Check | How | Expected |
|-------|-----|----------|
| **Data isolation** | `ls /root/betki/data/` — no symlinks to zeroclaw | All files under /root/betki/ |
| **Hive namespace** | Send "recall something" → check hive API call namespace | `betki`, not `claude-shared` |
| **Process isolation** | `ps aux \| grep -E 'zeroclaw\|betki'` | Separate PIDs, no parent-child |
| **Port isolation** | `ss -tlnp \| grep -E '9090\|9091'` | Betki on 9091, zeroclaw on its port |
| **WhatsApp session** | `ls /root/betki/data/whatsapp-session/` | Session files exist here only |
| **No cross-talk** | Message zeroclaw's Telegram, verify Betki doesn't respond | No cross-channel contamination |
| **Memory wall** | Betki's hive_recall returns nothing from claude-shared | Namespace isolation confirmed |

---

## Implementation Order for Codex

Execute in this exact order:

1. **Phase 0.1–0.4**: Config and provider fixes (local, MacBook)
2. **Phase 0.5**: Verify Baileys dependency
3. **Phase 0.6–0.8**: New tools (hive-recall, hive-ingest, identity-evolve) + wire in main.ts
4. **Phase 0.3**: Ollama provider rewrite (critical — current impl won't work for tool calling)
5. `pnpm build` — verify clean build
6. `pnpm test` — verify no regressions
7. **Phase 0.9 + 1.1**: Node 22 + pnpm on hiveagent
8. **Phase 1.2–1.4**: Deploy repo to VM
9. **Phase 2.1–2.3**: Betki config, env, data dirs
10. **Phase 3.1–3.3**: Identity, knowledge, changelog seeds
11. **Phase 5.1–5.2**: Initiative rules + wire
12. `pnpm build` on VM
13. **Phase 4.1**: Systemd unit
14. **Phase 4.2**: Manual first-run for WhatsApp QR pairing
15. **Phase 4.3**: Start service, verify health
16. **Phase 6**: Run isolation checklist
17. Send first WhatsApp message to Betki, verify end-to-end

---

## Files Created/Modified Summary

### New Files
| File | Purpose |
|------|---------|
| `packages/tools/src/builtin/hive-recall.ts` | Hive semantic recall tool |
| `packages/tools/src/builtin/hive-ingest.ts` | Hive knowledge ingest tool |
| `packages/tools/src/builtin/identity-evolve.ts` | Self-identity evolution tool |
| `/root/betki/.env` | Environment config (on VM) |
| `/root/betki/data/memory/identity.md` | Seed identity |
| `/root/betki/data/memory/knowledge.md` | Seed knowledge |
| `/root/betki/data/memory/identity-changelog.md` | Evolution log |
| `/root/betki/data/tasks/initiative-rules.json` | Proactive behavior rules |
| `/etc/systemd/system/betki.service` | Systemd unit |

### Modified Files
| File | Change |
|------|--------|
| `packages/providers/src/ollama.ts` | Rewrite: /api/chat, tool calling, streaming, system prompt |
| `apps/hairy-agent/src/config.ts` | Add Ollama + WhatsApp to config schema, remove API key hard requirement |
| `apps/hairy-agent/src/main.ts` | Wire Ollama provider, new tools, initiative rules loading |
| `apps/hairy-agent/src/identity.ts` | Change default name from "Hairy" to use config agent.name |
| `packages/tools/src/index.ts` | Export new tools |
| `config/default.toml` | Betki-specific defaults (overwritten on VM) |

### Untouched (Working As-Is)
- `packages/channels/src/whatsapp.ts` — Baileys adapter is solid
- `packages/memory/` — All memory systems work
- `packages/growth/` — Skill registry, prompt versioning, reflection all functional
- `packages/core/` — Orchestrator, task queue, scheduler all functional
- `packages/observability/` — Logging works

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Baileys session expires/breaks | Medium | Agent goes offline | Auto-reconnect already coded; re-pair if logged out |
| Ollama tool calling inconsistent | Medium | Degraded autonomy | Fallback to non-tool mode; retry logic in gateway |
| kimi-k2.5:cloud model quality | Low | Poor responses | Can swap model in config without code changes |
| VM memory pressure | Low | OOM kill | MemoryMax=1G in systemd; 4GB VM has headroom |
| Hive API down | Low | No long-term memory | Local JSONL fallback in SemanticMemory already coded |

---

## Success Criteria

1. ✅ Send WhatsApp message → get intelligent response within 30s
2. ✅ Betki uses tools (hive_recall, hive_ingest) during conversations
3. ✅ `curl http://127.0.0.1:9091/health` returns 200 with channel status
4. ✅ No data in `claude-shared` hive namespace from Betki
5. ✅ Betki's identity.md evolves after several conversations
6. ✅ Service survives VM reboot (`systemctl enable`)
7. ✅ ZeroClaw/Brandforge completely unaffected
