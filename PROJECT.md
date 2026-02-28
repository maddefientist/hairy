# Hairy — Project Context

## Summary
Hairy is a reusable, autonomous, long-running agent framework. It runs as a persistent daemon, connects to users via Telegram/WhatsApp/webhooks, reasons with multimodal LLMs (Anthropic, OpenRouter, Ollama), takes initiative, extends itself with Rust/Go sidecars, and learns from interactions.

## Stack
- **Language**: TypeScript 5.7+ (ESM, strict)
- **Runtime**: Node.js 22+
- **Package Manager**: pnpm 9+ (workspaces)
- **Build**: tsgo (TypeScript Go compiler)
- **Lint/Format**: Biome
- **Test**: Vitest
- **Telegram**: grammY
- **WhatsApp**: Baileys
- **HTTP**: Hono
- **Scheduling**: croner
- **Validation**: Zod
- **Config**: TOML
- **Logging**: pino
- **Sidecar Protocol**: JSON-RPC 2.0 over stdio
- **Sidecar Languages**: Rust, Go

## Structure
```
apps/hairy-agent/          — Main daemon entry point
packages/core/             — Orchestrator, task queue, scheduler
packages/providers/        — LLM provider gateway (Anthropic, OpenRouter, Ollama)
packages/channels/         — Channel adapters (Telegram, WhatsApp, webhook, CLI)
packages/tools/            — Tool registry + built-in tools + sidecar protocol
packages/memory/           — Conversation, semantic, episodic memory
packages/growth/           — Skill registry, prompt versioning, initiative engine
packages/observability/    — Structured logging, metrics, tracing
sidecars/example-rust/     — Example Rust sidecar extension
sidecars/example-go/       — Example Go sidecar extension
config/                    — Default TOML configuration
docker/                    — Dockerfile + docker-compose
docs/                      — Documentation
```

## How to Run
```bash
pnpm install
pnpm build
# Configure env vars (see config/default.toml for reference)
export ANTHROPIC_API_KEY=...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_IDS=...
pnpm dev
```

## Ancestry
Evolved from `packages/moni` in the pi-mono fork (maddefientist/pi-mono).
Built on patterns from `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`.

## Recent Changes
- 2026-02-28: Initial architecture spec and Codex implementation prompt created
- 2026-02-28: Scaffolded pnpm workspace monorepo with core packages, app wiring, sidecar examples, Docker, CI, and docs

## Next Steps
- Flesh out Telegram and WhatsApp adapters beyond stubs
- Add robust provider streaming/tool-call handling
- Add comprehensive unit tests for core queue/scheduler/orchestrator paths
- Integrate real initiative scheduling flows
- Harden sidecar sandbox/resource enforcement
