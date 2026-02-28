# 🚀 START HERE

Welcome to **Hairy** — an autonomous agent framework. This file is your navigation guide.

---

## 📚 Documentation Index

Read these in order based on your role:

### **For New Developers / Next LLM Handler**

1. **This file** (you're reading it now) — Navigation guide
2. **[README.md](README.md)** (564 lines) — What Hairy is, 8-step onboarding, how to run it
3. **[HANDOVER.md](HANDOVER.md)** (823 lines) ⭐ **MOST IMPORTANT** — Current status, what's done, what's scaffolded, exact next steps
4. **[ARCHITECTURE.md](ARCHITECTURE.md)** — Full system design (200+ lines)

### **For Onboarding Users**

1. **[README.md](README.md)** — 8-step quickstart + core concepts
2. **[docs/getting-started.md](docs/getting-started.md)** — Setup walkthrough

### **For Extending Functionality**

1. **[docs/providers.md](docs/providers.md)** — How to add LLM providers
2. **[docs/channels.md](docs/channels.md)** — How to add user channels (Telegram, WhatsApp, etc.)
3. **[docs/sidecars.md](docs/sidecars.md)** — How to build Rust/Go extensions
4. **[docs/growth.md](docs/growth.md)** — How the self-improvement system works

### **For Deployment**

1. **[docker/docker-compose.yml](docker/docker-compose.yml)** — Local or prod deployment
2. **[docs/security.md](docs/security.md)** — Permission model and sandboxing

### **For Development**

1. **[AGENTS.md](AGENTS.md)** — Code quality rules and standards
2. **[PROJECT.md](PROJECT.md)** — Project overview
3. **[CONTEXT.md](CONTEXT.md)** — Current session state

### **For Quick Reference**

1. **[IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)** — 2-page quick reference
2. **[HANDOVER.md](HANDOVER.md)** — File inventory + next steps checklist

---

## ⚡ Quick Commands

```bash
# Install
pnpm install

# Type check + lint (must pass before commit)
pnpm check

# Build
pnpm build

# Test
pnpm test

# Run daemon
pnpm dev

# Check health
curl http://localhost:9090/health | jq

# Build Rust/Go sidecars
bash scripts/build-sidecars.sh
```

---

## 📋 Project Status (TL;DR)

| Area | Status | Notes |
|------|--------|-------|
| **Monorepo scaffold** | ✅ Done | 7 packages, 77 files, full typing |
| **CLI adapter** | ✅ Works | Use for local testing |
| **Telegram adapter** | ⚠️ Stub | Scaffolded, needs grammY integration |
| **WhatsApp adapter** | ⚠️ Stub | Scaffolded, needs Baileys/Cloud API |
| **Webhook adapter** | ✅ Works | Ready for custom integrations |
| **LLM providers** | ✅ Works | Anthropic, OpenRouter, Ollama routed |
| **Tool calling** | ⚠️ Partial | Text streaming works; native tool calls need parsing |
| **Memory** | ✅ Works | Conversation, semantic, episodic |
| **Skills/versioning** | ✅ Scaffold | CRUD + filesystem; promotion workflow pending |
| **Sidecars** | ✅ Works | JSON-RPC protocol, examples provided |
| **Testing** | ⚠️ Minimal | 2 tests; needs full coverage |
| **Docker** | ✅ Works | Multi-stage build, docker-compose ready |
| **Docs** | ✅ Complete | 8 guides + comprehensive README |

**Overall:** ~70% of Phase 1–2. MVP-ready; needs channel adapters and tool-calling polish.

---

## 🎯 Next Steps (Prioritized)

### Must Do (Priority 1)
1. Implement Telegram adapter (4–6 hours)
2. Implement WhatsApp adapter (6–8 hours)
3. Add provider tool calling (4–8 hours)
4. Write unit tests for core paths (20–40 hours)

### Should Do (Priority 2)
5. Wire Growth engine to scheduler (8–12 hours)
6. Sidecar resource enforcement (6–10 hours)
7. Hari-hive integration (4–6 hours)

### Nice To Have (Priority 3)
8. Integration tests (20–30 hours)
9. Deployment docs (4–6 hours)
10. Performance tuning (ongoing)

**👉 Start with [HANDOVER.md](HANDOVER.md) — it has detailed "next steps" with validation criteria.**

---

## 🏗️ Architecture (30-second version)

```
User Messages (CLI/Telegram/WhatsApp)
         ↓
   Orchestrator (message queue + main loop)
         ↓
   Provider Gateway (LLM routing: Anthropic/OpenRouter/Ollama)
         ↓
   Tool Registry (bash, read, write, sidecars, etc.)
         ↓
   Memory (conversation + semantic + episodic)
         ↓
   Response to user
```

**Full version:** [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 📂 File Structure (Essential Files)

```
hairy/
├── README.md                    ⭐ Read this (564 lines, complete onboarding)
├── HANDOVER.md                  ⭐ Then this (823 lines, next steps)
├── ARCHITECTURE.md              Full design (200+ lines)
├── START_HERE.md                This file
│
├── apps/hairy-agent/src/main.ts ← Main daemon wiring (214 lines)
│
├── packages/
│   ├── observability/           ✅ Logging, metrics
│   ├── core/                    ✅ Queue, scheduler, orchestrator
│   ├── providers/               ⚠️ LLM gateway (tool calling incomplete)
│   ├── channels/                ⚠️ Adapters (CLI + webhook work, TG/WA stub)
│   ├── tools/                   ✅ Registry + bash/read/write/edit/search
│   ├── memory/                  ✅ Conversation + semantic + episodic
│   └── growth/                  ⚠️ Skills (CRUD works, promotion pending)
│
├── config/                      ✅ TOML defaults
├── docker/                      ✅ Multi-stage build
├── docs/                        ✅ 8 detailed guides
├── sidecars/                    ✅ Rust + Go examples
└── scripts/                     ✅ Build and dev helpers
```

---

## 💡 Key Concepts

**HairyMessage** — Unified message format across all channels (text, images, documents)

**ProviderGateway** — Routes tasks to appropriate LLM with fallback chain (Anthropic → OpenRouter → Ollama)

**Tool Registry** — Central registry for all functions (bash, read, write, sidecars). All inputs validated with Zod.

**Memory Layers:**
- **Conversation:** Short-term context (JSONL, auto-windowed)
- **Semantic:** Long-term facts (local JSON or hari-hive)
- **Episodic:** Run logs and metrics (daily JSONL)

**Skills:** Reusable behaviors with versioning and promotion (draft → testing → candidate → promoted → archived)

**Sidecars:** External binaries (Rust/Go) that speak JSON-RPC over stdin/stdout

**Initiative:** Proactive actions triggered by schedule, event, anomaly, or silence

---

## 🔍 Finding Things

| I want to... | Go here |
|--------------|---------|
| Set up for the first time | [README.md](README.md) — Step 1–8 |
| Understand how it works | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Know what's done / what's next | [HANDOVER.md](HANDOVER.md) |
| Add a new tool | [packages/tools/src/builtin/](packages/tools/src/builtin/) + register in [apps/hairy-agent/src/main.ts](apps/hairy-agent/src/main.ts) |
| Integrate Telegram | [packages/channels/src/telegram.ts](packages/channels/src/telegram.ts) (needs grammY) |
| Implement WhatsApp | [packages/channels/src/whatsapp.ts](packages/channels/src/whatsapp.ts) (needs Baileys) |
| Add LLM provider | [packages/providers/src/](packages/providers/src/) (implement Provider interface) |
| Build Rust sidecar | [sidecars/example-rust/](sidecars/example-rust/) (template + JSON-RPC) |
| Build Go sidecar | [sidecars/example-go/](sidecars/example-go/) (template + JSON-RPC) |
| Create a skill | [data/skills/](data/skills/) (created at runtime) |
| Configure permissions | [config/tools.toml](config/tools.toml) |
| Deploy with Docker | [docker/docker-compose.yml](docker/docker-compose.yml) |
| Check code quality standards | [AGENTS.md](AGENTS.md) |

---

## ✅ Onboarding Checklist (For New Users)

- [ ] Read [README.md](README.md) (8-step guide)
- [ ] Install Node.js 22+, pnpm 9+
- [ ] Run `pnpm install`
- [ ] Set ANTHROPIC_API_KEY (or another provider)
- [ ] Create `data/memory/identity.md`
- [ ] Run `pnpm dev`
- [ ] Send a message via CLI
- [ ] Check health: `curl http://localhost:9090/health | jq`
- [ ] Try Telegram / WhatsApp (once adapters are done)

---

## ⚙️ For Next LLM / Developer Handler

1. **Read [HANDOVER.md](HANDOVER.md)** — It has:
   - Detailed status (what's done, what's scaffolded)
   - Known limitations + stubs
   - Exact next steps with time estimates
   - Critical file locations
   - Testing strategy

2. **Understand code quality rules:**
   ```bash
   pnpm check  # Must pass before commit
   ```
   See [AGENTS.md](AGENTS.md) for specifics (no `any`, all inputs validated, structured logging, etc.)

3. **Pick a task from Priority 1:**
   - Telegram adapter (4–6 hours)
   - WhatsApp adapter (6–8 hours)
   - Provider tool calling (4–8 hours)
   - Unit tests (20–40 hours)

4. **Test & validate:**
   ```bash
   pnpm check && pnpm build && pnpm test
   ```

5. **Update HANDOVER.md** as you progress.

---

## 🤝 Questions?

- **What does Hairy do?** → [README.md](README.md)
- **How is it designed?** → [ARCHITECTURE.md](ARCHITECTURE.md)
- **What's left to do?** → [HANDOVER.md](HANDOVER.md)
- **How do I code here?** → [AGENTS.md](AGENTS.md)
- **How do I run it?** → [docs/getting-started.md](docs/getting-started.md)

---

**Go forth and build! 🚀**

*Next Step: Read [README.md](README.md), then [HANDOVER.md](HANDOVER.md)*
