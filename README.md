# Hairy

> An autonomous, long-running, self-growing agent framework.

Hairy is a reusable TypeScript template for building persistent AI agents that:
- Run 24/7 as daemon processes
- Connect to users through multiple channels (CLI, Telegram, WhatsApp, webhooks)
- Reason with multimodal LLMs (Anthropic Claude, Google Gemini, OpenRouter, Ollama)
- Take initiative through scheduled tasks and proactivity rules
- Learn from interactions and versioning their own prompts
- Extend themselves with Rust/Go sidecar binaries
- Provide structured observability (logging, metrics, trace IDs)

**Use cases:** automated customer support, personal productivity assistants, autonomous research agents, scheduled task runners with AI reasoning.

---

## What is Hairy?

Hairy is not a pre-built agent. It's a **framework** — a starting template with:
- A monorepo structure (7 packages + 1 app)
- Pluggable LLM providers (Anthropic, Google Gemini, OpenRouter, Ollama)
- Multi-channel adapters (Telegram, WhatsApp, webhooks, CLI)
- Tool execution with sandboxing and permission checks
- Memory subsystem (short-term context, long-term semantic, episodic logs)
- Self-improvement primitives (skill registry, prompt versions, eval scores)
- Sidecar protocol for compute-heavy extensions (Rust/Go)

You customize it by:
1. Editing `apps/hairy-agent/src/main.ts` to wire your providers, channels, and tools
2. Adding custom skills and system prompts in `data/memory/`
3. Writing Rust/Go sidecars to handle specialized work
4. Configuring rules in TOML files

---

## How Onboarding Works

### Step 1: Prerequisites

You need:
- **Node.js 22+** ([nodejs.org](https://nodejs.org))
- **pnpm 9+** (install with `npm install -g pnpm`)
- **Optional:** Rust (if building Rust sidecars), Go (if building Go sidecars)

### Step 2: Clone & Install

```bash
git clone <your-hairy-fork> hairy
cd hairy
pnpm install
```

This installs all workspace dependencies. The monorepo structure means every package is built in dependency order.

### Step 3: Choose Your Providers

Hairy can use different LLMs. At least one provider API key is required.

**Option A: Anthropic Claude (recommended for best reasoning)**
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```
Get a key: https://console.anthropic.com/keys

**Option B: OpenRouter (access to many models)**
```bash
export OPENROUTER_API_KEY="sk-or-..."
```
Get a key: https://openrouter.ai/keys

**Option C: Google Gemini**
```bash
export GEMINI_API_KEY="..."
```
Get a key: https://aistudio.google.com/apikey

**Option D: Local Ollama (free, runs on your machine)**
- Install Ollama: https://ollama.ai
- Run: `ollama serve`
- Models auto-detect; no API key needed

You can mix providers — Hairy will fallback if one fails.

### Step 4: Choose Your Channels

Channels are how users talk to Hairy.

**Option A: CLI (easiest for testing)**
Already enabled. Just run `pnpm dev` and type messages into the terminal.

**Option B: Telegram (bot mode)**
```bash
export TELEGRAM_MODE="bot"
export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_CHAT_IDS="123,456"  # Comma-separated chat IDs
```
Create a bot: [@BotFather](https://t.me/botfather) on Telegram.

**Option C: Telegram (MTProto user mode)**
```bash
export TELEGRAM_MODE="mtproto"
export TELEGRAM_API_ID="123456"
export TELEGRAM_API_HASH="..."
export TELEGRAM_PHONE_NUMBER="+15551234567"
export TELEGRAM_SESSION_FILE="./data/telegram/session.txt"
pnpm telegram:session  # one-time login bootstrap
```

**Option D: WhatsApp**
```bash
export WHATSAPP_SESSION_DIR="./data/whatsapp-session"
```
Will prompt for QR code on first connect.

**Option E: Webhooks (for custom integrations)**
```bash
export WEBHOOK_SECRET="my-secret-key"
# Listening on http://localhost:8080/webhook/incoming
```

You can enable multiple channels at once.

### Step 5: Configure the Agent

Edit `config/default.toml` to customize:
- Agent name, data directory, context window limits
- Health check port
- Which channels are enabled
- Default provider and fallback chain
- Tool permissions (bash, write, sidecar limits)

For most use cases, defaults are fine.

### Step 6: Create an Identity File

Hairy reads `data/memory/identity.md` to understand who it is.

Create it:
```bash
mkdir -p data/memory
cat > data/memory/identity.md << 'EOF'
# Who I Am

I am Hairy, a helpful assistant built with the Hairy framework.

## Core Traits
- I answer questions clearly and directly
- I ask for clarification if a request is ambiguous
- I break complex problems into steps
- I can run bash commands, read/write files, and search the web

## Boundaries
- I don't execute destructive commands without explicit confirmation
- I don't access sensitive files
- I don't make irreversible changes without asking first
EOF
```

(Optional) Add knowledge file:
```bash
cat > data/memory/knowledge.md << 'EOF'
# Domain Knowledge

Add facts, context, or documentation that should be available to the agent.
This might include:
- Company policies
- API documentation
- Standard workflows
- Known solutions to common problems
EOF
```

### Step 7: First Run

```bash
pnpm dev
```

You should see:
```
info: hairy-agent started
```

Then:
- If CLI is enabled: type a message
- If Telegram is enabled: send a message to the bot
- If webhook is enabled: POST to `http://localhost:8080/webhook/incoming`

Try:
```
> What can you do?
```

Hairy will use the provider gateway to pick the best LLM, send your message, and stream the response.

### Step 8: Health Checks & Metrics

Open another terminal:
```bash
curl http://localhost:9090/health | jq
```

You'll see:
```json
{
  "status": "ok",
  "uptime": 42.5,
  "channels": [
    { "type": "cli", "connected": true }
  ],
  "providers": ["anthropic"],
  "sidecars": []
}
```

---

## Core Concepts

### Messages & Channels

A `HairyMessage` is:
```typescript
{
  id: string;
  channelId: string;
  channelType: "cli" | "telegram" | "whatsapp" | "webhook";
  senderId: string;
  senderName: string;
  content: {
    text?: string;
    images?: { url | path, mimeType }[];
    documents?: { path, fileName }[];
  };
  timestamp: string;
}
```

Channels translate external platforms (Telegram API, stdin, HTTP) into this format.

### Providers & Routing

The `ProviderGateway` routes requests to LLMs based on intent:
- **simple_text**: Fast, cheap (Ollama)
- **image_input**: Supports vision (Ollama llava)
- **long_context**: Big context (OpenRouter)
- **complex**: Best reasoning (Anthropic)

Routing rules live in `config/providers.toml`. If the primary provider fails, it tries the fallback chain.

### Tools

Tools are functions Hairy can call:
- **bash**: Execute shell commands (`ls`, `git`, etc.)
- **read**: Read files and images
- **write**: Create/write files
- **edit**: Find-and-replace edits
- **web-search**: Query the web via DuckDuckGo
- **delegate**: Send a task to the executor model (orchestrator mode only)
- **memory_recall**: Semantic search in long-term memory
- **memory_ingest**: Store knowledge in long-term memory
- **identity_evolve**: Self-modify identity file with changelog
- **sidecars**: Custom Rust/Go binaries

All tool inputs are validated with Zod. All executions are logged with trace IDs.

### Agent Modes

#### Unified (default)
Single model handles everything — reasoning and tool execution. Best when your model is reliable at tool-calling (e.g., Claude, GPT-4).

#### Orchestrator/Executor
Two-model split for when your primary model is strong at reasoning but unreliable at tool-calling (e.g., cloud models via Ollama proxy that 500-error on tool calls).

```
Primary model (orchestrator) → thinks, plans, responds
  └─ delegate tool ──→ Fallback model (executor) → runs tools, follows instructions
```

Configure in `config/default.toml` or `config/local.toml`:
```toml
[agent]
mode = "orchestrator"

[providers.ollama]
default_model = "glm-5:cloud"      # Orchestrator (reasoning)
fallback_model = "qwen3.5:9b"      # Executor (tool-calling)
```

Or via env var: `HAIRY_AGENT_MODE=orchestrator`

The orchestrator gets: `delegate`, `memory_recall`, `memory_ingest`, `identity_evolve`
The executor gets: `bash`, `read`, `write`, `edit`, `web-search`

### Memory

Memory has three layers:

1. **Conversation** (`context.jsonl`): Recent messages — auto-windowed to fit context limits
2. **Semantic** (pluggable backend): Long-term facts, tagged and searchable
3. **Episodic** (`episodic/*.jsonl`): Daily logs of runs, tool calls, events

After each run, **reflection** extracts learnings and stores them in semantic memory.

#### Memory Backends

Semantic memory uses a pluggable `MemoryBackend` interface:

- **Local** (default): JSON file + keyword scoring. Zero deps, works immediately on `git clone`.
- **Hive** (optional): Connects to [agentssot](https://github.com/maddefientist/agentssot) for embedding-based semantic search. Set `HARI_HIVE_URL` to activate.
- **Bring your own**: Implement the `MemoryBackend` interface for ChromaDB, Qdrant, Pinecone, etc.

```bash
# Local backend (default — no config needed)
pnpm dev

# Hive backend (auto-detected from env)
export HARI_HIVE_URL=http://localhost:8088
export HARI_HIVE_API_KEY=your-key
export HARI_HIVE_NAMESPACE=my-agent
pnpm dev
```

### Skills & Versioning

A **skill** is a reusable behavior:
- Name, description, system prompt fragment
- Status: draft → testing → candidate → promoted → archived

Skills are stored in `data/skills/`. When promoted, their prompt fragments are included in the system prompt.

**Prompt versions** are versioned with hashes and timestamps, allowing rollback if a change breaks things.

### Initiative

The **initiative engine** fires scheduled tasks and proactive actions:
- **Schedule trigger**: cron expressions (e.g., "8am daily")
- **Event trigger**: when something happens (tool result, message received)
- **Anomaly trigger**: when a metric exceeds threshold
- **Silence trigger**: when user hasn't responded in N hours

Rules can require approval before acting on the user.

### Sidecars

For compute-heavy work, Hairy spawns external binaries (Rust/Go) that speak JSON-RPC 2.0 over stdio:

```
Agent → stdin: {"jsonrpc":"2.0","id":1,"method":"hash_file","params":{"path":"/tmp/file"}}
Sidecar → stdout: {"jsonrpc":"2.0","id":1,"result":{"sha256":"abc..."}}
```

Each sidecar declares tools in its `manifest.json`. The `SidecarManager`:
- Reads manifests
- Builds missing binaries
- Starts processes
- Registers tool shims
- Performs health checks

See `sidecars/example-rust/` and `sidecars/example-go/` for templates.

---

## Common Workflows

### Add a New Tool

Tools live in `packages/tools/src/builtin/` or as sidecars.

**Built-in tool example:**
```typescript
// packages/tools/src/builtin/my-tool.ts
import { z } from "zod";
import type { Tool } from "../types.js";

export const createMyTool = (): Tool => ({
  name: "my_tool",
  description: "Does something useful",
  parameters: z.object({
    input: z.string()
  }),
  async execute(args, ctx) {
    const { input } = args;
    // Do work...
    return { content: "result here" };
  }
});
```

Register in `apps/hairy-agent/src/main.ts`:
```typescript
registry.register(createMyTool());
```

### Create a Skill

1. Create `data/skills/<skill-id>/SKILL.md` with description
2. Edit `apps/hairy-agent/src/main.ts` to include prompt fragment
3. Mark as "promoted" in skill registry when ready

### Build a Rust Sidecar

Copy `sidecars/example-rust/` and modify:
```rust
// sidecars/my-rust-tool/src/main.rs
fn main() {
  let stdin = io::stdin();
  for line in stdin.lock().lines() {
    let request: Request = serde_json::from_str(&line)?;
    match request.method.as_str() {
      "my_method" => { /* handle */ }
      _ => { /* error */ }
    }
  }
}
```

Create `manifest.json`:
```json
{
  "name": "my-rust-tool",
  "binary": "./target/release/my-rust-tool",
  "build_cmd": "cargo build --release",
  "tools": [
    {
      "name": "my_method",
      "description": "...",
      "parameters": { "type": "object", "properties": {...} }
    }
  ]
}
```

### Deploy with Docker

```bash
docker-compose -f docker/docker-compose.yml build
docker-compose -f docker/docker-compose.yml up
```

Env vars from `.env`:
```
ANTHROPIC_API_KEY=...
TELEGRAM_BOT_TOKEN=...
```

---

## Architecture Overview

### Unified Mode (default)
```
┌─────────────────────────────────────┐
│   Channel Adapters (CLI, TG, WA)   │ ← User messages
├─────────────────────────────────────┤
│   Orchestrator (main run loop)      │
│   - queue, scheduler, execute       │
├─────────────────────────────────────┤
│   Provider Gateway (LLM routing)    │
├─────────────────────────────────────┤
│   Tool Registry + Sidecars          │
├─────────────────────────────────────┤
│   Memory (conversation + semantic)  │
├─────────────────────────────────────┤
│   Growth (skills, reflection)       │
└─────────────────────────────────────┘
```

### Orchestrator Mode (brain/hands split)
```
┌─────────────────────────────────────┐
│   Channel Adapters (CLI, TG, WA)   │ ← User messages
├─────────────────────────────────────┤
│   Orchestrator (main run loop)      │
│   ┌───────────────────────────┐     │
│   │ Primary Model (reasoning) │     │
│   │  └─ delegate, memory,    │     │
│   │     identity tools        │     │
│   └──────────┬────────────────┘     │
│              │ delegate             │
│   ┌──────────▼────────────────┐     │
│   │ Fallback Model (executor) │     │
│   │  └─ bash, read, write,   │     │
│   │     edit, web-search      │     │
│   └───────────────────────────┘     │
├─────────────────────────────────────┤
│   Provider Gateway + Model Fallback │
├─────────────────────────────────────┤
│   Memory (conversation + semantic)  │
├─────────────────────────────────────┤
│   Growth (skills, reflection)       │
└─────────────────────────────────────┘
```

Full details: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Project Structure

```
apps/hairy-agent/              # Main daemon
packages/
  observability/               # Logging, metrics, tracing
  core/                        # Queue, scheduler, orchestrator
  providers/                   # LLM gateway + routing
  channels/                    # Adapters (Telegram, CLI, etc.)
  tools/                       # Tool registry + sidecars
  memory/                      # Conversation + semantic memory
  growth/                      # Skills, versioning, reflection
sidecars/
  example-rust/                # Rust template
  example-go/                  # Go template
config/
  default.toml                 # Base config
  providers.toml               # Routing rules
  tools.toml                   # Permissions
docker/                        # Dockerfile + compose
docs/                          # Getting started, guides
data/                          # Runtime: context, skills, memories (created on first run)
```

---

## Configuration Deep Dive

### `config/default.toml`

```toml
[agent]
name = "Hairy"
data_dir = "./data"
max_iterations_per_run = 25
max_context_tokens = 100000
# mode = "unified"        # Single model does everything (default)
# mode = "orchestrator"   # Brain/hands split with delegate tool

[health]
port = 9090

[channels.cli]
enabled = true

[channels.telegram]
enabled = false
mode = "bot"
session_file = "./data/telegram/session.txt"

[providers.anthropic]
enabled = true
default_model = "claude-sonnet-4-20250514"

[providers.ollama]
enabled = false
base_url = "http://localhost:11434"
default_model = "llama3.2"
# fallback_model = "llama3.2:3b"  # Executor model in orchestrator mode

[routing]
default_provider = "anthropic"
fallback_chain = ["anthropic", "openrouter", "ollama"]
```

### `config/local.toml` (gitignored, per-deployment overrides)

Create this file for deployment-specific settings that shouldn't be tracked:
```toml
[agent]
name = "MyAgent"
mode = "orchestrator"

[providers.ollama]
enabled = true
default_model = "glm-5:cloud"
fallback_model = "qwen3.5:9b"
```

Merge order: `default.toml` → `local.toml` → env vars.

Override with env vars:
```bash
export HAIRY_HEALTH_PORT=8080
export HAIRY_AGENT_MODE=orchestrator
export ANTHROPIC_API_KEY=sk-ant-...
export OLLAMA_MODEL=glm-5:cloud
export OLLAMA_FALLBACK_MODEL=qwen3.5:9b
```

### `config/providers.toml`

Route tasks to different models:
```toml
[routing.rules]
simple_text = { provider = "anthropic", model = "claude-sonnet-4-20250514" }
image_input = { provider = "ollama", model = "llava" }
complex = { provider = "anthropic", model = "claude-sonnet-4-20250514" }
```

### `config/tools.toml`

Restrict what tools can do:
```toml
[permissions.bash]
allowed_commands = ["ls", "grep", "git"]
blocked_commands = ["sudo", "rm -rf"]
require_approval_for = ["npm install"]

[permissions.write]
allowed_paths = ["./data/", "./config/"]
blocked_paths = ["/etc/", "~/.ssh/"]
```

---

## Troubleshooting

### "ANTHROPIC_API_KEY is missing"
Set your provider key:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
pnpm dev
```

### "Listening on CLI but no response"
Check logs for errors. Health endpoint:
```bash
curl http://localhost:9090/health
```

### Telegram not responding
Bot mode:
```bash
export TELEGRAM_MODE="bot"
export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_CHAT_IDS="123"
```

MTProto mode:
```bash
export TELEGRAM_MODE="mtproto"
export TELEGRAM_API_ID="123456"
export TELEGRAM_API_HASH="..."
export TELEGRAM_PHONE_NUMBER="+15551234567"
export TELEGRAM_SESSION_FILE="./data/telegram/session.txt"
pnpm telegram:session
```

### Messages are being ignored
Check that a channel is connected:
```bash
curl http://localhost:9090/health | jq .channels
```

If `connected: false`, check logs for connection errors.

### Need to extend functionality?
1. **Add a tool**: `packages/tools/src/builtin/` + register in main.ts
2. **Add a provider**: `packages/providers/src/<name>.ts` + register in main.ts
3. **Add a sidecar**: `sidecars/<name>/` + manifest.json
4. **Create a skill**: `data/skills/` + prompt fragment

---

## Next Steps

1. **Complete setup:** Run through Steps 1–7 above
2. **Experiment:** Send messages via CLI and watch logs
3. **Customize:** Edit `data/memory/identity.md` to change personality
4. **Add tools:** Implement custom tools for your use case
5. **Deploy:** Use `docker-compose.yml` to run 24/7

---

## References

- **Getting Started:** [docs/getting-started.md](docs/getting-started.md)
- **Full Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Providers:** [docs/providers.md](docs/providers.md)
- **Channels:** [docs/channels.md](docs/channels.md)
- **Sidecars:** [docs/sidecars.md](docs/sidecars.md)
- **Growth/Skills:** [docs/growth.md](docs/growth.md)
- **Security:** [docs/security.md](docs/security.md)

---

## License

MIT

---

**Built with:**
- TypeScript + Node.js 22+
- pnpm workspaces
- Zod validation
- Pino logging
- Hono HTTP
- Anthropic/OpenRouter/Ollama APIs
