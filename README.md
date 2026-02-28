# Hairy

Autonomous, long-running, self-growing agent framework.

## What It Does

Hairy is a persistent AI agent daemon that:
- Connects to users via **Telegram**, **WhatsApp**, **webhooks**, or **CLI**
- Reasons with **Anthropic**, **OpenRouter**, and **Ollama** (multimodal)
- Takes **initiative** — scheduled briefings, anomaly alerts, proactive help
- **Learns** from interactions — skill registry, prompt versioning, reflection
- **Extends** with **Rust/Go sidecar** binaries for compute-heavy tasks
- Runs 24/7 with graceful restart, health checks, and cost tracking

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Configure (minimum viable)
export ANTHROPIC_API_KEY=sk-ant-...
export TELEGRAM_BOT_TOKEN=123456:ABC...
export TELEGRAM_CHAT_IDS=your_chat_id

# Run
pnpm dev
```

See [docs/getting-started.md](docs/getting-started.md) for full setup.

## Architecture

```
Channel Adapters (Telegram, WhatsApp, Webhook, CLI)
        ↓
Orchestrator (message queue → planner → executor)
        ↓
Provider Gateway (Anthropic, OpenRouter, Ollama + fallback)
        ↓
Tool Registry (built-in + Rust/Go sidecars)
        ↓
Memory (conversation + semantic + episodic)
        ↓
Growth Engine (skills + prompts + reflection + initiative)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## Packages

| Package | Description |
|---------|-------------|
| `apps/hairy-agent` | Main daemon entry point |
| `packages/core` | Orchestrator, task queue, scheduler |
| `packages/providers` | LLM provider gateway |
| `packages/channels` | Channel adapters |
| `packages/tools` | Tool registry + sidecar protocol |
| `packages/memory` | Conversation, semantic, episodic memory |
| `packages/growth` | Skill registry, prompt versioning, initiative |
| `packages/observability` | Logging, metrics, tracing |

## Extending with Rust/Go

Write a sidecar binary that speaks JSON-RPC 2.0 over stdio, drop it in `sidecars/`, and Hairy auto-discovers it.

See [docs/sidecars.md](docs/sidecars.md) for details.

## Ancestry

Evolved from [Moni](https://github.com/maddefientist/pi-mono) (persistent Telegram trading agent).
Built on patterns from [@mariozechner/pi-agent-core](https://github.com/badlogic/pi-mono).

## License

MIT
