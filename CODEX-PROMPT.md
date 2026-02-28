# Codex Implementation Prompt — Hairy Agent Framework

## Context

You are building **Hairy**, an autonomous, long-running, self-growing agentic framework in TypeScript (Node.js) with Rust/Go sidecar support. It is a reusable template for building persistent AI agents that connect to users via Telegram, WhatsApp, and webhooks, reason with multimodal LLMs, take initiative, and extend themselves.

Read `ARCHITECTURE.md` in this directory for the full system design before starting.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 5.7+ (ESM, strict mode) |
| Runtime | Node.js 22+ |
| Package manager | pnpm 9+ with workspaces |
| Build | tsgo (TypeScript Go compiler) with project references |
| Lint/Format | Biome |
| Test | Vitest |
| Telegram | grammY 1.x |
| WhatsApp | @whiskeysockets/baileys 6.x (or whatsapp-web.js as fallback) |
| HTTP | Node built-in fetch + Hono for health/webhook endpoints |
| Scheduling | croner |
| Schema validation | Zod |
| Config | TOML (via @iarna/toml) |
| Logging | pino |
| Sidecar protocol | JSON-RPC 2.0 over stdio (custom, no external dep) |
| Sidecar languages | Rust (example), Go (example) |
| LLM providers | Anthropic SDK, OpenAI SDK (for OpenRouter), Ollama REST |
| Optional bridge | @mariozechner/pi-ai (unified provider from pi-mono) |

## Repository Setup

Initialize a pnpm workspace monorepo at the root:

```
hairy/
├── pnpm-workspace.yaml       # packages: ["apps/*", "packages/*"]
├── package.json               # workspace root scripts
├── tsconfig.base.json         # shared compiler options
├── biome.json                 # formatting + linting
├── .gitignore
├── .github/
│   └── workflows/
│       └── ci.yml             # lint, typecheck, test, build sidecars
├── apps/
│   └── hairy-agent/
├── packages/
│   ├── core/
│   ├── providers/
│   ├── channels/
│   ├── tools/
│   ├── memory/
│   ├── growth/
│   └── observability/
├── sidecars/
│   ├── example-rust/
│   └── example-go/
├── config/
├── docker/
├── docs/
├── scripts/
├── PROJECT.md
├── AGENTS.md
├── README.md
└── LICENSE (MIT)
```

## Implementation Order

Build in this exact order. Each step must compile and pass `pnpm check` before moving to the next.

### Phase 1: Foundation

#### Step 1: Workspace scaffold
Create the monorepo structure with all package.json files, tsconfig files, biome.json, and pnpm-workspace.yaml.

Root `package.json` scripts:
```json
{
  "scripts": {
    "build": "pnpm -r run build",
    "check": "biome check . && pnpm -r run typecheck",
    "test": "pnpm -r run test",
    "dev": "pnpm --filter hairy-agent run dev",
    "clean": "pnpm -r run clean"
  }
}
```

Each package `package.json`:
- `"type": "module"`
- `"main": "./dist/index.js"`
- `"types": "./dist/index.d.ts"`
- Scripts: `build`, `clean`, `typecheck`, `test`
- Build command: `tsgo -p tsconfig.build.json`

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

#### Step 2: packages/observability
Implement first — everything else depends on logging.

`src/logger.ts`:
```typescript
// Wrapper around pino with structured JSON output
// Export: createLogger(name: string, opts?: LoggerOpts) => Logger
// Logger interface: info, warn, error, debug, child(bindings)
// All log entries include: timestamp, level, name, traceId (optional), msg, ...data
```

`src/metrics.ts`:
```typescript
// Simple in-process metrics counter
// Export: Metrics class
// Methods: increment(name, value?, labels?), gauge(name, value, labels?), getAll()
// Tracks: llm_requests, llm_tokens_in, llm_tokens_out, llm_cost_usd, tool_calls, tool_errors, messages_in, messages_out
```

`src/tracer.ts`:
```typescript
// Conversation trace ID generator and context
// Export: createTrace() => TraceContext
// TraceContext: { traceId: string, span(name): SpanContext, end(): TraceSummary }
// SpanContext: { spanId, start, end(), duration }
```

#### Step 3: packages/core
The orchestrator, task queue, and scheduler.

`src/types.ts`:
```typescript
// Core types used across all packages

export interface HairyMessage {
  id: string;
  channelId: string;
  channelType: "telegram" | "whatsapp" | "webhook" | "cli";
  senderId: string;
  senderName: string;
  content: MessageContent;
  timestamp: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface MessageContent {
  text?: string;
  images?: MediaAttachment[];
  audio?: MediaAttachment[];
  video?: MediaAttachment[];
  documents?: DocumentAttachment[];
}

export interface MediaAttachment {
  url?: string;
  path?: string;
  buffer?: Buffer;
  mimeType: string;
  caption?: string;
}

export interface DocumentAttachment {
  path: string;
  fileName: string;
  mimeType: string;
}

export interface AgentResponse {
  text: string;
  attachments?: MediaAttachment[];
  silent?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RunResult {
  traceId: string;
  response: AgentResponse;
  stopReason: string;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  durationMs: number;
}

export interface ToolCallRecord {
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
  durationMs: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { input: number; output: number; total: number };
}

export interface ScheduledTask {
  id: string;
  prompt: string;
  scheduleType: "cron" | "interval" | "once";
  scheduleValue: string;
  status: "active" | "paused" | "completed";
  nextRun: string | null;
  lastRun: string | null;
  silent: boolean;
  createdAt: string;
}
```

`src/task-queue.ts`:
```typescript
// Priority queue for incoming messages and scheduled tasks
// User messages get priority over scheduled tasks
// Persists queue to disk on enqueue (crash recovery)
// Export: TaskQueue class
// Methods: enqueue(item, priority), dequeue(), peek(), size, drain()
// Priorities: "urgent" > "user" > "task" > "background"
```

`src/scheduler.ts`:
```typescript
// Task scheduler using croner for cron expressions
// Port from pi-mono/packages/moni/src/scheduler.ts but generalized
// Support: cron, interval (ms), once (ISO datetime)
// Methods: createTask, pauseTask, resumeTask, cancelTask, listTasks, getActiveTasks
// Persist tasks.json to dataDir
// Constructor takes onTaskDue callback
```

`src/orchestrator.ts`:
```typescript
// Main run loop
// 1. Receives HairyMessage from channel adapter
// 2. Enqueues in TaskQueue
// 3. Processes sequentially (one at a time)
// 4. For each message:
//    a. Load/update conversation context from memory
//    b. Build system prompt (identity + context + tools + skills)
//    c. Send to provider gateway
//    d. Execute tool calls via tool registry
//    e. Loop until stop or max iterations
//    f. Post-run: trigger reflection, update memory
//    g. Return AgentResponse to channel adapter
// Export: Orchestrator class
// Constructor: { providers, tools, memory, growth, channels, config }
// Methods: handleMessage(msg), start(), stop()
```

`src/config.ts`:
```typescript
// Load and validate configuration from TOML files + env vars
// Config sources (in priority order): env vars > config/*.toml > defaults
// Export: loadConfig(configDir?: string) => HairyConfig
// HairyConfig includes: providers, channels, tools, growth, observability settings
// Use Zod for validation
```

#### Step 4: packages/providers
LLM provider gateway with routing and fallback.

`src/types.ts`:
```typescript
export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ProviderContent[];
}

export interface ProviderContent {
  type: "text" | "image" | "tool_call" | "tool_result" | "thinking";
  text?: string;
  image?: { data: Buffer; mimeType: string } | { url: string };
  toolCall?: { id: string; name: string; args: unknown };
  toolResult?: { id: string; content: string; isError?: boolean };
}

export interface StreamEvent {
  type: "text_delta" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "thinking" | "usage" | "stop" | "error";
  // fields vary by type
}

export interface Provider {
  name: string;
  stream(messages: ProviderMessage[], opts: StreamOptions): AsyncIterable<StreamEvent>;
  listModels(): Promise<ModelInfo[]>;
  supportsImages: boolean;
  supportsThinking: boolean;
}

export interface StreamOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  supportsImages: boolean;
  supportsThinking: boolean;
  costPer1kInput?: number;
  costPer1kOutput?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}
```

`src/ollama.ts`:
```typescript
// Ollama provider via REST API (default: http://localhost:11434)
// Supports: text generation, multimodal (llava, etc.)
// Streaming via /api/chat with stream: true
// Image support: base64 in messages
// No tool calling natively — implement via prompt-based tool use
// Export: createOllamaProvider(opts: { baseUrl?: string }) => Provider
```

`src/openrouter.ts`:
```typescript
// OpenRouter provider via OpenAI-compatible API
// Base URL: https://openrouter.ai/api/v1
// Auth: Authorization: Bearer $OPENROUTER_API_KEY
// Headers: X-Title: Hairy Agent
// Supports all OpenAI chat completion features
// Export: createOpenRouterProvider(opts: { apiKey?: string }) => Provider
// API key from opts.apiKey || process.env.OPENROUTER_API_KEY
```

`src/anthropic.ts`:
```typescript
// Anthropic provider via official SDK (@anthropic-ai/sdk)
// Supports: text, images (base64 + URL), thinking, tool use
// Extended thinking with thinkingLevel mapping to budget_tokens
// Export: createAnthropicProvider(opts: { apiKey?: string }) => Provider
// API key from opts.apiKey || process.env.ANTHROPIC_API_KEY
```

`src/pi-ai-bridge.ts`:
```typescript
// Bridge to @mariozechner/pi-ai for access to all its providers
// (Google, Bedrock, Mistral, etc.) without reimplementing
// This is optional — only used if pi-ai is installed
// Export: createPiAiBridgeProvider(api: string, opts: Record<string, unknown>) => Provider
```

`src/gateway.ts`:
```typescript
// Unified provider gateway
// Registers providers, routes requests based on routing policy
// Implements fallback chain on errors
// Tracks cost and usage metrics
// Export: ProviderGateway class
// Constructor: { providers: Provider[], routingConfig, metrics }
// Methods: stream(messages, opts), selectProvider(intent), getUsage()
```

`src/router.ts`:
```typescript
// Model/provider selection logic
// Input: task complexity, content type, cost constraints
// Output: provider + model to use
// Rules loaded from config/providers.toml
// Export: ModelRouter class
// Methods: route(request: RouteRequest) => { provider, model }
```

#### Step 5: packages/channels
Channel adapters with a shared interface.

`src/adapter.ts`:
```typescript
// Base channel adapter interface
export interface ChannelAdapter {
  readonly channelType: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(channelId: string, response: AgentResponse): Promise<void>;
  onMessage(handler: (msg: HairyMessage) => void): void;
  startTyping(channelId: string): void;
  stopTyping(channelId: string): void;
  isConnected(): boolean;
}
```

`src/telegram.ts`:
```typescript
// Telegram adapter using grammY
// Port and generalize from pi-mono/packages/moni/src/telegram.ts
// Support: text, photos, videos, documents, voice (with whisper transcription), stickers
// Download media to data/attachments/
// Handle /ping, /chatid commands
// Reconnect with exponential backoff on 409 conflicts
// Support multiple allowed chat IDs (not just one)
// Export: createTelegramAdapter(opts: TelegramOpts) => ChannelAdapter
```

`src/whatsapp.ts`:
```typescript
// WhatsApp adapter using Baileys (multi-device)
// Support: text, images, documents, voice notes
// QR code auth flow (print to terminal on first connect)
// Session persistence to data/whatsapp-session/
// Export: createWhatsAppAdapter(opts: WhatsAppOpts) => ChannelAdapter
```

`src/webhook.ts`:
```typescript
// Generic HTTP webhook adapter using Hono
// POST /webhook/incoming — receive messages
// POST /webhook/outgoing — send messages (internal use)
// Auth via shared secret header
// Export: createWebhookAdapter(opts: WebhookOpts) => ChannelAdapter
```

`src/cli.ts`:
```typescript
// Local CLI adapter for development and testing
// Reads from stdin, writes to stdout
// No external dependencies
// Export: createCliAdapter() => ChannelAdapter
```

#### Step 6: packages/tools
Tool registry and built-in tools.

`src/registry.ts`:
```typescript
// Central tool registry
// Register tools with permissions, timeouts, and scope
// Tools can be: built-in (TS), sidecar (Rust/Go subprocess), or dynamic (agent-created)
// Export: ToolRegistry class
// Methods: register(tool), unregister(name), get(name), list(), execute(name, args, ctx)
// Each tool execution is logged with trace ID and duration
```

`src/types.ts`:
```typescript
export interface Tool {
  name: string;
  description: string;
  parameters: ZodSchema;          // Zod schema for args validation
  permissions?: ToolPermissions;
  timeout_ms?: number;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  traceId: string;
  cwd: string;
  dataDir: string;
  logger: Logger;
  channelId?: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolPermissions {
  allowedPaths?: string[];
  blockedPaths?: string[];
  allowedCommands?: string[];
  blockedCommands?: string[];
  requireApproval?: boolean;
  networkAccess?: boolean;
}
```

`src/builtin/bash.ts` — Execute shell commands with output truncation and timeout
`src/builtin/read.ts` — Read file contents (text + images)
`src/builtin/write.ts` — Write/create files
`src/builtin/edit.ts` — Surgical find-and-replace edits
`src/builtin/web-search.ts` — Web search via SearxNG or DuckDuckGo

`src/sidecar/protocol.ts`:
```typescript
// JSON-RPC 2.0 over stdio protocol
// Send requests to sidecar stdin, read responses from stdout
// Forward stderr to logger
// Handle: request/response matching, timeouts, error mapping
// Export: SidecarConnection class
// Methods: call(method, params, timeout?), notify(method, params), close()
```

`src/sidecar/manager.ts`:
```typescript
// Sidecar lifecycle manager
// Read manifest.json from sidecars/*/
// Build binary if missing (run build_cmd)
// Spawn process, wrap in SidecarConnection
// Periodic health checks, auto-restart on failure
// Register sidecar tools in ToolRegistry
// Graceful shutdown
// Export: SidecarManager class
// Methods: loadAll(sidecarsDir), start(name), stop(name), stopAll(), health()
```

#### Step 7: packages/memory
Memory subsystem.

`src/conversation.ts`:
```typescript
// Short-term conversation context
// Stores messages in JSONL format
// Supports context windowing (keep last N messages or tokens)
// Auto-compaction when context exceeds limit
// Export: ConversationMemory class
// Methods: append(msg), getContext(maxTokens?), compact(summary), clear(), getHistory(limit?)
```

`src/semantic.ts`:
```typescript
// Long-term semantic memory
// Two backends:
//   1. hari-hive API (remote, if HIVE_API_URL is set)
//   2. Local JSON file with TF-IDF search (zero-dep fallback)
// Export: SemanticMemory class
// Methods: store(content, tags?), search(query, topK?), feedback(id, signal)
```

`src/episodic.ts`:
```typescript
// Run logs and tool results
// Append-only JSONL per day
// Export: EpisodicMemory class
// Methods: logRun(runResult), logEvent(event), query(filter), getRecentRuns(n)
```

`src/reflection.ts`:
```typescript
// Post-run reflection
// After each significant run, extract:
//   - What tools were used and outcomes
//   - Whether the response was adequate
//   - Patterns worth remembering
// Store reflections in semantic memory
// Export: ReflectionEngine class
// Methods: reflect(runResult), getInsights(topic)
```

#### Step 8: packages/growth
Self-improvement engine.

`src/skill-registry.ts`:
```typescript
// Skill CRUD with lifecycle states: draft → testing → candidate → promoted → archived
// Skills are: name + description + system prompt fragment + optional script
// Store in data/skills/ as directories with SKILL.md + optional scripts/
// Export: SkillRegistry class
// Methods: create(skill), promote(id), archive(id), list(status?), get(id), getPromptFragments()
```

`src/prompt-version.ts`:
```typescript
// Version system prompts
// Each version is stored with timestamp and hash
// Support rollback to previous version
// Export: PromptVersionManager class
// Methods: save(prompt), getCurrent(), rollback(version), history()
```

`src/initiative.ts`:
```typescript
// Proactivity rules engine
// Rules define: trigger, condition, action, confidence_threshold, risk_level, cooldown
// Triggers: schedule (cron), event (tool/channel event), anomaly (metric threshold), silence (no user activity)
// Export: InitiativeEngine class
// Constructor: { rules, scheduler, channels, memory }
// Methods: start(), stop(), addRule(rule), removeRule(id), listRules()
```

`src/eval-harness.ts`:
```typescript
// Evaluate skill and prompt effectiveness
// Score runs on: task completion, tool efficiency, user satisfaction (implicit)
// Track scores over time per skill/prompt version
// Export: EvalHarness class
// Methods: score(runResult), getScores(skillId?), compare(versionA, versionB)
```

### Phase 2: Application

#### Step 9: apps/hairy-agent
The main daemon that wires everything together.

`src/main.ts`:
```typescript
// Entry point
// 1. Load config from config/ and env vars
// 2. Initialize observability (logger, metrics, tracer)
// 3. Initialize memory (conversation, semantic, episodic)
// 4. Initialize provider gateway (register configured providers)
// 5. Initialize tool registry (register built-ins)
// 6. Initialize sidecar manager (load and start sidecars)
// 7. Initialize growth engine (skills, initiative, eval)
// 8. Initialize channel adapters (telegram, whatsapp, webhook, cli based on config)
// 9. Create orchestrator, wire everything together
// 10. Start scheduler, initiative engine
// 11. Start channel adapters (begin receiving messages)
// 12. HTTP health endpoint on configured port
// 13. Signal handlers for graceful shutdown
//
// Graceful shutdown order:
//   channels.disconnect → scheduler.stop → initiative.stop →
//   sidecars.stopAll → memory.flush → metrics.flush → exit
```

`src/config.ts`:
```typescript
// Load TOML config files + env var overrides
// Required env vars: at least one channel token + at least one provider API key
// Export: loadHairyConfig() => HairyConfig
// Validate with Zod, fail fast with clear error messages
```

`src/health.ts`:
```typescript
// HTTP health endpoint using Hono
// GET /health — { status, uptime, channels, providers, sidecars, memory, metrics }
// GET /metrics — Prometheus-format metrics
// Port from HAIRY_HEALTH_PORT env var (default 9090)
```

`src/identity.ts`:
```typescript
// Build system prompt from:
//   - data/memory/identity.md (who the agent is)
//   - data/memory/knowledge.md (what it knows)
//   - Active skills (prompt fragments)
//   - Current context (time, active channels, scheduled tasks)
//   - Tool descriptions
//   - Channel-specific formatting rules
// Port and generalize from pi-mono/packages/moni/src/identity.ts
```

### Phase 3: Sidecars

#### Step 10: sidecars/example-rust
```
sidecars/example-rust/
├── Cargo.toml
├── src/main.rs
└── manifest.json
```

`Cargo.toml`:
```toml
[package]
name = "hairy-example-sidecar"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`src/main.rs`:
```rust
// JSON-RPC 2.0 server over stdio
// Implements:
//   - "health" method → { "status": "ok" }
//   - "echo" method → echoes params back
//   - "hash_file" method → SHA256 hash of a file path
//   - "shutdown" method → clean exit
// Read JSON lines from stdin, write JSON lines to stdout
// Log to stderr
```

`manifest.json`:
```json
{
  "name": "example-rust",
  "version": "0.1.0",
  "binary": "./target/release/hairy-example-sidecar",
  "build_cmd": "cargo build --release",
  "tools": [
    {
      "name": "echo",
      "description": "Echo back the input text",
      "parameters": {
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"]
      }
    },
    {
      "name": "hash_file",
      "description": "Compute SHA256 hash of a file",
      "parameters": {
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": ["path"]
      }
    }
  ],
  "health_check": { "method": "health", "interval_ms": 30000 },
  "resource_limits": { "max_memory_mb": 128, "timeout_ms": 10000 }
}
```

#### Step 11: sidecars/example-go
```
sidecars/example-go/
├── go.mod
├── main.go
└── manifest.json
```

`main.go`:
```go
// Same JSON-RPC 2.0 stdio server pattern
// Implements: health, echo, count_words (count words in a file)
// Read JSON lines from stdin, write JSON lines to stdout
// Log to stderr
```

### Phase 4: Infrastructure

#### Step 12: Docker
`docker/Dockerfile`:
```dockerfile
# Multi-stage: build TS + build sidecars + runtime
# Stage 1: Node.js build (pnpm install + build)
# Stage 2: Rust build (cargo build --release)
# Stage 3: Go build (go build)
# Stage 4: Runtime (node:22-slim + compiled artifacts + sidecar binaries)
# ENTRYPOINT ["node", "apps/hairy-agent/dist/main.js"]
```

`docker/docker-compose.yml`:
```yaml
# hairy-agent service with env vars
# Optional: redis for pub/sub (future)
# Optional: chromadb for vector search (future)
# Volume mounts for data/ persistence
```

#### Step 13: CI
`.github/workflows/ci.yml`:
```yaml
# On push/PR to main:
# 1. Install pnpm + Node.js
# 2. pnpm install
# 3. pnpm check (biome + typecheck)
# 4. pnpm test
# 5. Build sidecars (Rust + Go)
# Matrix: ubuntu-latest
```

#### Step 14: Config defaults
`config/default.toml`:
```toml
[agent]
name = "Hairy"
data_dir = "./data"
max_iterations_per_run = 25
max_context_tokens = 100000

[health]
port = 9090

[channels.telegram]
enabled = false
# bot_token from TELEGRAM_BOT_TOKEN env
# chat_ids from TELEGRAM_CHAT_IDS env (comma-separated)

[channels.whatsapp]
enabled = false
# session_dir from WHATSAPP_SESSION_DIR env

[channels.webhook]
enabled = false
port = 8080
secret = ""  # from WEBHOOK_SECRET env

[channels.cli]
enabled = false

[providers.anthropic]
enabled = true
default_model = "claude-sonnet-4-20250514"
# api_key from ANTHROPIC_API_KEY env

[providers.openrouter]
enabled = false
default_model = "anthropic/claude-sonnet-4-20250514"
# api_key from OPENROUTER_API_KEY env

[providers.ollama]
enabled = false
base_url = "http://localhost:11434"
default_model = "llama3.2"

[routing]
default_provider = "anthropic"
fallback_chain = ["anthropic", "openrouter", "ollama"]

[routing.cost]
track = true
daily_budget_usd = 10.0
alert_threshold_pct = 80

[growth]
reflection_enabled = true
initiative_enabled = false
skill_auto_promote = false

[tools.bash]
timeout_ms = 30000
max_output_bytes = 1048576

[tools.sidecar]
auto_build = true
health_check_interval_ms = 30000
```

### Phase 5: Documentation

#### Step 15: docs/
Create these files:
- `docs/getting-started.md` — Quick start guide (env vars, config, first run)
- `docs/providers.md` — How to add a new LLM provider
- `docs/channels.md` — How to add a new channel adapter
- `docs/sidecars.md` — How to write Rust/Go sidecar extensions
- `docs/growth.md` — Self-improvement system explained
- `docs/security.md` — Permission model and sandboxing

#### Step 16: README.md
```markdown
# Hairy

Autonomous, long-running, self-growing agent framework.

## Features
- Multi-channel: Telegram, WhatsApp, webhooks, CLI
- Multi-provider: Anthropic, OpenRouter, Ollama (+ pi-ai bridge)
- Multimodal: text, images, audio, video, documents
- Self-growing: skill learning, prompt versioning, reflection
- Proactive: initiative engine with scheduled actions
- Extensible: Rust/Go sidecar binaries for compute-heavy tasks
- Observable: structured logging, metrics, cost tracking

## Quick Start
[link to getting-started.md]

## Architecture
[link to architecture doc]

## License
MIT
```

#### Step 17: PROJECT.md and AGENTS.md
Create project context files following the templates from the global AGENTS.md.

`PROJECT.md`: Document the project summary, stack, structure, how to run.
`AGENTS.md`: Document code quality rules, testing commands, git rules, style preferences.

## Critical Implementation Rules

1. **No `any` types** unless truly unavoidable. Use `unknown` + type narrowing.
2. **No inline imports** — all imports at top of file.
3. **No classes where functions suffice** — but classes are fine for stateful objects (registry, memory, scheduler).
4. **All configs validated with Zod** — fail fast with clear messages.
5. **All tool inputs validated** — never trust LLM-generated args.
6. **Structured logging everywhere** — no `console.log`.
7. **Error handling**: wrap external calls (LLM, network, subprocess) in try/catch with typed errors.
8. **Graceful shutdown**: every start() must have a corresponding stop() that cleans up.
9. **No hardcoded secrets** — all from env vars or config files.
10. **ESM only** — no CommonJS, no `require()`.
11. **Test each package** — at minimum: type checking passes, core logic has unit tests.
12. **Sidecar binaries compile** — CI must verify Rust and Go examples build.

## What Already Exists (Reference)

The Moni agent in `pi-mono/packages/moni/` is the direct ancestor of this framework.
Key patterns to preserve and generalize:
- Message queue with priority (user > scheduled task)
- Sequential processing (one message at a time)
- Scheduler with cron/interval/once support
- Telegram adapter with reconnect logic
- System prompt built from memory files
- Tool wiring via dependency injection
- JSONL-based conversation persistence
- Graceful shutdown with signal handlers

When in doubt about API shapes, check `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` — Hairy should be compatible with their types where possible, even if it doesn't depend on them directly.
