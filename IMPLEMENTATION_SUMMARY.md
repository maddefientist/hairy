# Hairy Framework — Implementation Summary

**Status:** ✅ Phase 1–2 scaffolding complete (77 source files, 8 packages, full wiring)

---

## What Was Built

### The App: Hairy

**Hairy** is a **reusable TypeScript template** for building autonomous agents that:
- Run 24/7 as daemons
- Connect via multiple channels (CLI, Telegram, WhatsApp, webhooks)
- Reason with LLMs (Anthropic Claude, OpenRouter, Ollama)
- Take initiative with scheduled tasks
- Learn and improve themselves over time
- Extend via Rust/Go sidecars
- Log everything with structured observability

**Not** a pre-built chatbot — you customize it for your needs.

---

## Onboarding: 8 Steps

### 1. Install Prerequisites
- Node.js 22+
- pnpm 9+
- (Optional) Rust/Go for sidecars

### 2. Clone & Install
```bash
git clone ... hairy
cd hairy
pnpm install
```

### 3. Choose an LLM Provider
Pick at least one:
- **Anthropic:** `export ANTHROPIC_API_KEY="sk-ant-..."`
- **OpenRouter:** `export OPENROUTER_API_KEY="sk-or-..."`
- **Ollama (local):** Run `ollama serve`

### 4. Choose Channels
Users connect via:
- **CLI:** Default, no setup needed
- **Telegram:** Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_IDS`
- **WhatsApp:** Set `WHATSAPP_SESSION_DIR`
- **Webhooks:** Set `WEBHOOK_SECRET`

### 5. Configure (Optional)
Edit `config/default.toml` to customize names, ports, permissions.

### 6. Create an Identity
Write `data/memory/identity.md`:
```markdown
# Who I Am
I am Hairy...
## Core Traits
- I answer questions clearly
...
## Boundaries
- I don't execute destructive commands
...
```

### 7. Run
```bash
pnpm dev
```

You'll see:
```
info: hairy-agent started
```

### 8. Test
```bash
# CLI: type a message
> What can you do?

# Check health:
curl http://localhost:9090/health | jq
```

---

## Architecture at a Glance

```
User Messages (CLI/Telegram/WhatsApp/HTTP)
         ↓
   Channel Adapters
         ↓
   Orchestrator (main loop)
    - Queue messages by priority
    - Load conversation context
    - Send to provider gateway
         ↓
   Provider Gateway (LLM routing)
    - Route by intent (simple/complex/image)
    - Fallback chain on error
         ↓
   Tool Registry
    - bash, read, write, edit, web-search
    - Sidecars (Rust/Go)
    - All inputs validated, logged
         ↓
   Memory Layer
    - Conversation: JSONL windowed
    - Semantic: searchable facts
    - Episodic: run logs
         ↓
   Growth Engine
    - Skills (draft→testing→promoted)
    - Prompt versions with rollback
    - Reflection & learning
         ↓
   Response to user
```

---

## What Each Package Does

| Package | Purpose | Key Classes |
|---------|---------|-------------|
| **observability** | Logging, metrics, traces | `Logger`, `Metrics`, `TraceContext` |
| **core** | Message queues, scheduling, main loop | `TaskQueue`, `Scheduler`, `Orchestrator` |
| **providers** | LLM gateway with routing | `ProviderGateway`, `ModelRouter` |
| **channels** | User-facing adapters | `ChannelAdapter`, `TelegramAdapter`, `CLIAdapter` |
| **tools** | Function registry + sidecars | `ToolRegistry`, `SidecarManager` |
| **memory** | Multi-layer memory | `ConversationMemory`, `SemanticMemory`, `ReflectionEngine` |
| **growth** | Self-improvement | `SkillRegistry`, `PromptVersionManager`, `InitiativeEngine` |

---

## How to Extend

### Add a Tool
```typescript
// packages/tools/src/builtin/my-tool.ts
export const createMyTool = (): Tool => ({
  name: "my_tool",
  description: "Does X",
  parameters: z.object({ input: z.string() }),
  async execute(args, ctx) {
    return { content: "result" };
  }
});

// Register in apps/hairy-agent/src/main.ts
registry.register(createMyTool());
```

### Add a Skill
1. Create `data/skills/<id>/SKILL.md`
2. Write prompt fragment
3. Mark "promoted" when ready

### Build a Sidecar
Copy `sidecars/example-rust/` or `sidecars/example-go/`, implement your tool as a JSON-RPC server, create `manifest.json`, and it auto-registers.

### Add a Provider
Create `packages/providers/src/<name>.ts` implementing the `Provider` interface, register in main.ts.

### Add a Channel
Create `packages/channels/src/<name>.ts` implementing `ChannelAdapter`, register in main.ts.

---

## Key Design Decisions

1. **Monorepo with pnpm workspaces** — Each package is independently buildable and testable
2. **TypeScript strict mode** — No `any` types; all APIs type-safe with Zod validation
3. **Structured logging** — pino everywhere; every tool call traced
4. **JSON-RPC for sidecars** — Language-agnostic subprocess protocol; no FFI complexity
5. **File-based persistence** — JSONL for conversation/runs, JSON for skills/memory; no external DB required
6. **Provider routing** — LLM selection based on task intent (simple/image/complex) with fallback chain
7. **Memory layers** — Conversation (short), semantic (long-term facts), episodic (logs)
8. **Skill lifecycle** — Draft→testing→candidate→promoted→archived; versioned prompts with rollback
9. **Initiative engine** — Proactive rules: scheduled, event-driven, anomaly-based, silence-based
10. **Permission model** — TOML-configurable restrictions on bash commands, file paths, sidecar resources

---

## Repository Structure

```
/hairy
├── README.md                    # Comprehensive guide (this is it!)
├── ARCHITECTURE.md              # Full system design
├── PROJECT.md                   # Project overview
├── AGENTS.md                    # Development rules
├── CONTEXT.md                   # Session state
├── IMPLEMENTATION_SUMMARY.md    # This file
│
├── package.json                 # Workspace root
├── pnpm-workspace.yaml
├── tsconfig.json & tsconfig.base.json
├── biome.json                   # Lint + format config
│
├── apps/
│   └── hairy-agent/
│       ├── src/
│       │   ├── main.ts          # Daemon lifecycle + wiring
│       │   ├── config.ts        # Config loading
│       │   ├── health.ts        # HTTP health endpoint
│       │   └── identity.ts      # System prompt builder
│       └── package.json
│
├── packages/
│   ├── observability/           # Logging, metrics, tracing
│   ├── core/                    # Queue, scheduler, orchestrator
│   ├── providers/               # LLM gateway + routing
│   ├── channels/                # Channel adapters
│   ├── tools/                   # Tool registry + sidecars
│   ├── memory/                  # Conversation + semantic memory
│   └── growth/                  # Skills, versioning, reflection
│
├── sidecars/
│   ├── example-rust/            # Rust template with JSON-RPC
│   ├── example-go/              # Go template with JSON-RPC
│   └── README.md
│
├── config/
│   ├── default.toml             # Agent + channels + providers
│   ├── providers.toml           # Routing rules
│   └── tools.toml               # Permissions
│
├── docker/
│   ├── Dockerfile               # Multi-stage prod build
│   ├── Dockerfile.dev           # Dev with hot reload
│   └── docker-compose.yml       # Local orchestration
│
├── .github/
│   └── workflows/
│       └── ci.yml               # TypeScript build, lint, test
│
├── docs/
│   ├── getting-started.md
│   ├── providers.md
│   ├── channels.md
│   ├── sidecars.md
│   ├── growth.md
│   ├── security.md
│   └── architecture.md
│
├── scripts/
│   ├── build-sidecars.sh        # Build Rust + Go
│   └── dev.sh                   # Start dev mode
│
├── data/                        # Created at runtime
│   ├── memory/
│   │   ├── identity.md
│   │   ├── knowledge.md
│   │   ├── semantic.json
│   │   └── prompt-versions.json
│   ├── skills/
│   │   └── <skill-id>/
│   │       ├── SKILL.md
│   │       └── skill.json
│   ├── context.jsonl            # Current conversation
│   ├── episodic/                # Run logs
│   └── tasks/
│       ├── queue.json
│       └── tasks.json
│
├── .gitignore
└── LICENSE (MIT)
```

---

## Quick Commands

```bash
# Install
pnpm install

# Type check + lint
pnpm check

# Build all packages
pnpm build

# Run tests
pnpm test

# Start dev daemon
pnpm dev

# Check health
curl http://localhost:9090/health | jq

# Build Rust/Go sidecars
bash scripts/build-sidecars.sh

# Docker
docker-compose -f docker/docker-compose.yml build
docker-compose -f docker/docker-compose.yml up
```

---

## What's Ready

✅ Full monorepo scaffold  
✅ 7 core packages with complete type signatures  
✅ CLI adapter (working)  
✅ Webhook adapter (working)  
✅ Terraform/Hono health endpoint  
✅ Config loading (TOML + env vars)  
✅ Anthropic, OpenRouter, Ollama providers  
✅ Sidecar protocol + manager  
✅ Rust + Go sidecar examples  
✅ Memory system (conversation, semantic, episodic)  
✅ Skill registry with versioning  
✅ Docker build (multi-stage)  
✅ GitHub Actions CI  
✅ Comprehensive README + docs  

---

## What Needs Work (Next Steps)

⚠️ Telegram adapter (scaffolded, not functional)  
⚠️ WhatsApp adapter (scaffolded, not functional)  
⚠️ Provider tool-calling (stream parsing only)  
⚠️ Unit tests (core logic paths)  
⚠️ Integration tests (multi-channel + fallback)  
⚠️ Sidecar resource enforcement  
⚠️ EvalHarness scoring details  
⚠️ Initiative engine rule triggers  

---

## How to Use This

1. **Read `README.md`** — Covers what Hairy is, 8-step onboarding, core concepts, workflows
2. **Explore `ARCHITECTURE.md`** — Full system design and implementation phases
3. **Start developing:** Follow the 8-step onboarding
4. **Extend:** Add tools, skills, sidecars, or providers as needed
5. **Deploy:** Use Docker or host on your infrastructure

---

## Onboarding Checklist

- [ ] Node.js 22+, pnpm 9+ installed
- [ ] `pnpm install` completed
- [ ] API key(s) set (ANTHROPIC_API_KEY or equivalent)
- [ ] Channel(s) configured (at minimum: CLI works)
- [ ] `data/memory/identity.md` created
- [ ] `pnpm dev` starts successfully
- [ ] `curl http://localhost:9090/health` returns 200
- [ ] Message sent via CLI/Telegram/webhook gets response
- [ ] Response comes from the configured LLM provider
- [ ] Logs appear in stdout with trace IDs

---

## License

MIT

---

**Built with TypeScript, pnpm, Zod, Pino, Hono, Croner, and love.**
