# Hairy — Project Context

## Summary
Hairy is a reusable, autonomous, long-running agent framework. It runs as a persistent daemon, connects to users via Telegram/WhatsApp/webhooks, reasons with multimodal LLMs (Anthropic, Gemini, OpenRouter, Ollama), takes initiative, extends itself with Rust/Go sidecars, and learns from interactions.

## Stack
- **Language**: TypeScript 5.7+ (ESM, strict)
- **Runtime**: Node.js 22+
- **Package Manager**: pnpm 9+ (workspaces)
- **Build**: tsc (TypeScript compiler)
- **Lint/Format**: Biome
- **Test**: Vitest
- **Telegram**: grammY (Bot API) + GramJS (MTProto user login)
- **WhatsApp**: Baileys
- **HTTP**: Hono
- **Scheduling**: croner
- **Validation**: Zod
- **Config**: TOML
- **Logging**: pino (via HairyLogger interface)
- **Memory**: Pluggable backend (local JSON default, Hive optional)
- **Sidecar Protocol**: JSON-RPC 2.0 over stdio
- **Sidecar Languages**: Rust, Go

## Structure
```
apps/hairy-agent/          — Main daemon entry point
packages/core/             — Orchestrator, agent loop, task queue, scheduler
packages/providers/        — LLM provider gateway (Anthropic, Gemini, OpenRouter, Ollama)
packages/channels/         — Channel adapters (Telegram, WhatsApp, webhook, CLI)
packages/tools/            — Tool registry + built-in tools + sidecar protocol
packages/memory/           — Conversation, semantic (pluggable), episodic memory
packages/growth/           — Skill registry, prompt versioning, initiative engine
packages/observability/    — Structured logging, metrics, tracing
config/                    — Default TOML configuration
docs/                      — Documentation
examples/betki/            — Example: lifestyle agent deployment
```

## How to Run
```bash
pnpm install
pnpm build

# Minimum: one provider
export ANTHROPIC_API_KEY=...
# Or: export GEMINI_API_KEY=...
# Or: just run Ollama locally (no key needed)

pnpm dev
```

## Providers
| Provider | Env Var | Tool Calling | Notes |
|----------|---------|-------------|-------|
| Anthropic | `ANTHROPIC_API_KEY` | ✅ | Best reasoning |
| Gemini | `GEMINI_API_KEY` | ✅ | 2M token context |
| OpenRouter | `OPENROUTER_API_KEY` | ✅ | Access to many models |
| Ollama | `OLLAMA_BASE_URL` | ✅ | Local, free, no key |

## Memory Backends
| Backend | Activation | Search | Dependencies |
|---------|-----------|--------|-------------|
| Local (default) | Always | Keyword scoring | None |
| Hive | `HARI_HIVE_URL` | Embedding similarity | [agentssot](https://github.com/maddefientist/agentssot) |
| Custom | Implement `MemoryBackend` | Your choice | Your choice |

## Recent Changes
- 2026-02-28: Initial architecture, scaffold, agent loop, provider implementations
- 2026-02-28: Memory backend abstraction (`MemoryBackend` interface, local + hive backends)
- 2026-02-28: Added Google Gemini provider (native REST, tool calling)
- 2026-02-28: Rewrote Ollama provider (`/api/chat`, tool calling, proper message format)
- 2026-02-28: Renamed tools to backend-agnostic names (`memory_recall`, `memory_ingest`)
- 2026-02-28: 121 tests across 13 test files, all passing

## Next Steps
- Streaming support for Ollama and Gemini providers
- Additional memory backends (ChromaDB, SQLite+embeddings)
- Docker compose for one-command deployment
- CI pipeline (GitHub Actions)
- Eval-driven skill auto-promotion
