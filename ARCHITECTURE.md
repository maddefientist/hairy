# Hairy — Architecture Specification

## What This Is

Hairy is a self-growing, autonomous, long-running agentic framework.
It runs as a persistent daemon, connects to users via Telegram/WhatsApp,
reasons with multimodal LLMs (Ollama, OpenRouter, Anthropic), takes initiative,
and extends itself with Rust/Go sidecar binaries for compute-heavy work.

## Design Principles

1. **Always-on** — daemon process with graceful restart, health checks, watchdog
2. **Proactive** — scheduled reflection, anomaly detection, initiative engine
3. **Self-growing** — learns from interactions, promotes proven skills, versions its own prompts
4. **Multimodal** — text, images, audio, video, documents across providers
5. **Multi-channel** — Telegram, WhatsApp, HTTP webhook, CLI — same agent core
6. **Extensible** — Rust/Go sidecar binaries via FFI or subprocess protocol
7. **Observable** — structured logging, metrics, trace IDs per conversation

## System Layers

```
┌─────────────────────────────────────────────────────────┐
│                    Channel Adapters                      │
│  Telegram │ WhatsApp │ HTTP/Webhook │ CLI │ (future)     │
├─────────────────────────────────────────────────────────┤
│                   Orchestrator Core                      │
│  Message Router → Planner → Executor → Response Builder  │
│  Task Queue │ Priority │ Retry │ Checkpoint              │
├─────────────────────────────────────────────────────────┤
│                   Provider Gateway                       │
│  Ollama │ OpenRouter │ Anthropic │ (pluggable)           │
│  Model routing │ Fallback │ Cost tracking                │
├─────────────────────────────────────────────────────────┤
│                    Tool Registry                         │
│  Built-in: bash, read, write, edit, web-search           │
│  Sidecar: Rust/Go binaries via subprocess protocol       │
│  Dynamic: agent-created tools with approval gates        │
├─────────────────────────────────────────────────────────┤
│                    Memory Layer                          │
│  Short-term: conversation context (JSONL)                │
│  Long-term: semantic search (hari-hive / local vector)   │
│  Episodic: run logs, tool results, reflections           │
├─────────────────────────────────────────────────────────┤
│                   Growth Engine                          │
│  Reflection loop │ Skill registry │ Prompt versioning    │
│  Eval harness │ Behavior promotion │ Self-monitoring     │
├─────────────────────────────────────────────────────────┤
│                   Sidecar Runtime                        │
│  Rust/Go binaries │ Subprocess protocol (JSON-RPC stdio) │
│  Health checks │ Auto-restart │ Resource limits          │
├─────────────────────────────────────────────────────────┤
│                   Observability                          │
│  Structured logs │ Metrics │ Trace IDs │ Cost tracking   │
│  Health endpoint │ Alerting via channels                 │
└─────────────────────────────────────────────────────────┘
```

## Package Layout

```
hairy/
├── apps/
│   └── hairy-agent/              # Main daemon entry point
│       ├── src/
│       │   ├── main.ts           # Process lifecycle, signal handling
│       │   ├── config.ts         # Env + file config loading
│       │   └── health.ts         # HTTP health endpoint
│       └── package.json
├── packages/
│   ├── core/                     # Orchestrator, planner, executor
│   │   ├── src/
│   │   │   ├── orchestrator.ts   # Message routing + run loop
│   │   │   ├── planner.ts        # Intent classification + plan generation
│   │   │   ├── executor.ts       # Tool execution with retry/checkpoint
│   │   │   ├── task-queue.ts     # Priority queue with persistence
│   │   │   ├── scheduler.ts      # Cron/interval/once task scheduling
│   │   │   └── types.ts          # Core type definitions
│   │   └── package.json
│   ├── providers/                # LLM provider gateway
│   │   ├── src/
│   │   │   ├── gateway.ts        # Unified provider interface
│   │   │   ├── router.ts         # Model selection + fallback logic
│   │   │   ├── ollama.ts         # Ollama provider (local, multimodal)
│   │   │   ├── openrouter.ts     # OpenRouter provider
│   │   │   ├── anthropic.ts      # Anthropic provider (direct API)
│   │   │   ├── pi-ai-bridge.ts   # Bridge to @mariozechner/pi-ai for all its providers
│   │   │   └── types.ts          # Provider types, model metadata
│   │   └── package.json
│   ├── channels/                 # Channel adapters
│   │   ├── src/
│   │   │   ├── adapter.ts        # Base adapter interface
│   │   │   ├── telegram.ts       # Telegram via grammY
│   │   │   ├── whatsapp.ts       # WhatsApp via Cloud API / Baileys
│   │   │   ├── webhook.ts        # Generic HTTP webhook adapter
│   │   │   ├── cli.ts            # Local CLI adapter for dev/testing
│   │   │   └── types.ts          # Channel message types
│   │   └── package.json
│   ├── tools/                    # Tool registry + built-in tools
│   │   ├── src/
│   │   │   ├── registry.ts       # Tool registration, permissions, discovery
│   │   │   ├── builtin/          # bash, read, write, edit, web-search
│   │   │   ├── sidecar/          # Sidecar protocol handler
│   │   │   │   ├── protocol.ts   # JSON-RPC over stdio
│   │   │   │   ├── manager.ts    # Sidecar lifecycle (start/stop/health)
│   │   │   │   └── types.ts      # Sidecar manifest types
│   │   │   └── types.ts          # Tool definition types
│   │   └── package.json
│   ├── memory/                   # Memory subsystem
│   │   ├── src/
│   │   │   ├── conversation.ts   # Short-term context (JSONL)
│   │   │   ├── semantic.ts       # Long-term semantic search
│   │   │   ├── episodic.ts       # Run logs, tool results
│   │   │   ├── reflection.ts     # Post-run reflection extraction
│   │   │   └── types.ts
│   │   └── package.json
│   ├── growth/                   # Self-improvement engine
│   │   ├── src/
│   │   │   ├── skill-registry.ts # Skill CRUD, versioning, promotion
│   │   │   ├── prompt-version.ts # Prompt versioning + A/B
│   │   │   ├── eval-harness.ts   # Evaluate skill/prompt effectiveness
│   │   │   ├── initiative.ts     # Proactivity rules engine
│   │   │   └── types.ts
│   │   └── package.json
│   └── observability/            # Logging, metrics, tracing
│       ├── src/
│       │   ├── logger.ts         # Structured JSON logger
│       │   ├── metrics.ts        # Cost, latency, token counters
│       │   ├── tracer.ts         # Conversation trace IDs
│       │   └── types.ts
│       └── package.json
├── sidecars/                     # Rust/Go extension binaries
│   ├── example-rust/             # Example Rust sidecar
│   │   ├── Cargo.toml
│   │   ├── src/main.rs           # JSON-RPC stdio server
│   │   └── manifest.json         # Tool declarations
│   ├── example-go/               # Example Go sidecar
│   │   ├── go.mod
│   │   ├── main.go               # JSON-RPC stdio server
│   │   └── manifest.json         # Tool declarations
│   └── README.md                 # How to write a sidecar
├── config/                       # Default configuration
│   ├── default.toml              # Base config
│   ├── providers.toml            # Provider routing rules
│   └── tools.toml                # Tool permissions + timeouts
├── docker/
│   ├── Dockerfile                # Production image
│   ├── Dockerfile.dev            # Dev image with hot reload
│   └── docker-compose.yml        # Agent + deps (redis, etc.)
├── docs/
│   ├── getting-started.md
│   ├── architecture.md           # This file (expanded)
│   ├── providers.md              # Adding providers
│   ├── channels.md               # Adding channels
│   ├── sidecars.md               # Writing Rust/Go extensions
│   ├── growth.md                 # Self-improvement system
│   └── security.md               # Permission model, sandboxing
├── scripts/
│   ├── build-sidecars.sh         # Build all sidecar binaries
│   └── dev.sh                    # Start dev environment
├── package.json                  # Workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
├── PROJECT.md
├── AGENTS.md
├── README.md
└── LICENSE
```

## Sidecar Protocol (Rust/Go Extensions)

Sidecars are standalone binaries that communicate via JSON-RPC 2.0 over stdio.

### Manifest (manifest.json)
```json
{
  "name": "image-processor",
  "version": "0.1.0",
  "binary": "./target/release/image-processor",
  "build_cmd": "cargo build --release",
  "tools": [
    {
      "name": "resize_image",
      "description": "Resize an image to target dimensions",
      "parameters": {
        "type": "object",
        "properties": {
          "input_path": { "type": "string" },
          "width": { "type": "number" },
          "height": { "type": "number" }
        },
        "required": ["input_path", "width", "height"]
      }
    }
  ],
  "health_check": { "method": "health", "interval_ms": 30000 },
  "resource_limits": {
    "max_memory_mb": 512,
    "timeout_ms": 60000
  }
}
```

### Protocol
```
Agent → Sidecar (stdin):  {"jsonrpc":"2.0","id":1,"method":"resize_image","params":{...}}
Sidecar → Agent (stdout): {"jsonrpc":"2.0","id":1,"result":{...}}
Sidecar → Agent (stderr): log lines (forwarded to observability)
```

### Lifecycle
1. Agent reads `sidecars/*/manifest.json` on startup
2. Builds if binary missing (`build_cmd`)
3. Spawns process, registers tools in tool registry
4. Periodic health checks; auto-restart on failure
5. Graceful shutdown via `{"method":"shutdown"}` message

## Provider Gateway

### Routing Policy
```toml
[routing]
default = "anthropic"

[routing.rules]
# Use local Ollama for simple tasks and image understanding
simple_text = { provider = "ollama", model = "llama3.2" }
image_input = { provider = "ollama", model = "llava" }

# Use OpenRouter for cost-effective long context
long_context = { provider = "openrouter", model = "anthropic/claude-sonnet-4-20250514" }

# Use Anthropic direct for complex reasoning
complex = { provider = "anthropic", model = "claude-sonnet-4-20250514" }

[routing.fallback]
chain = ["anthropic", "openrouter", "ollama"]
retry_on = ["rate_limit", "server_error", "timeout"]
max_retries = 3

[routing.cost]
track = true
daily_budget_usd = 10.0
alert_threshold_pct = 80
```

## Initiative / Proactivity Engine

The agent doesn't just respond — it acts when it should.

### Initiative Rules
```typescript
interface InitiativeRule {
  id: string;
  trigger: "schedule" | "event" | "anomaly" | "silence";
  condition: string;           // Natural language or code predicate
  action: string;              // What to do
  confidence_threshold: number; // 0-1, minimum confidence to act
  risk_level: "low" | "medium" | "high";
  requires_approval: boolean;  // If true, ask user before executing
  cooldown_ms: number;         // Min time between activations
}
```

### Examples
- **Morning briefing**: schedule trigger, 8am daily, summarize overnight events
- **Anomaly alert**: event trigger, when monitored metric exceeds threshold
- **Proactive help**: silence trigger, if user hasn't responded to a question in 4h, send a nudge
- **Self-maintenance**: schedule trigger, weekly, review and clean up old logs/data

## Growth Engine

### Skill Lifecycle
```
Draft → Testing → Candidate → Promoted → Archived
```

1. **Draft**: Agent creates a new skill (prompt + optional script)
2. **Testing**: Skill runs in shadow mode alongside existing behavior
3. **Candidate**: Skill runs live but with extra logging
4. **Promoted**: Skill is in the active set
5. **Archived**: Deprecated, kept for history

### Prompt Versioning
- Every system prompt change is versioned
- A/B testing between prompt versions using eval scores
- Rollback if new version scores lower over N runs

### Reflection Cycle
After each significant run:
1. Extract: what tools were used, what worked, what failed
2. Score: was the user satisfied? Was the output correct?
3. Learn: create/update skill if pattern is reusable
4. Store: episodic memory with embeddings for future retrieval

## Security Model

### Tool Permissions
```toml
[permissions.bash]
allowed_commands = ["ls", "cat", "grep", "find", "curl", "git"]
blocked_commands = ["rm -rf", "sudo", "chmod 777"]
require_approval_for = ["pip install", "npm install", "apt"]
max_output_bytes = 1048576

[permissions.write]
allowed_paths = ["data/", "config/", "skills/"]
blocked_paths = ["/etc/", "/usr/", "~/.ssh/", "~/.aws/"]

[permissions.sidecar]
max_memory_mb = 512
max_cpu_pct = 50
network_access = false
```

### Sandboxing
- Sidecar binaries run with resource limits (memory, CPU, timeout)
- No network access by default for sidecars
- File access restricted to declared paths
- All tool calls logged with trace ID

## Data Persistence

### File-based (default, no external deps)
```
data/
├── conversations/          # Archived conversation JSONL
├── memory/                 # Identity, strategy, knowledge files
├── skills/                 # Skill definitions + scripts
├── reflections/            # Post-run reflection logs
├── metrics/                # Daily cost/usage rollups
├── sidecars/               # Sidecar state/cache
├── context.jsonl           # Current conversation context
├── log.jsonl               # Message history
└── tasks.json              # Scheduled tasks
```

### Optional upgrades (future)
- SQLite for structured queries
- Redis/Valkey for pub/sub between sidecars
- ChromaDB/Qdrant for local vector search
