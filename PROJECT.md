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
packages/core/             — Orchestrator, agent loop, task queue, scheduler, plugins
packages/providers/        — LLM provider gateway (Anthropic, Gemini, OpenRouter, Ollama)
packages/channels/         — Channel adapters (Telegram, WhatsApp, webhook, CLI)
packages/tools/            — Tool registry + built-in tools + sidecar protocol + MCP client
packages/memory/           — Conversation, semantic, structured, episodic, uploads
packages/sandbox/          — Sandboxed execution (local + Docker stub)
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
- 2026-03-28: DeerFlow-inspired upgrade — 8 new subsystems, 423 tests across 9 packages
  - Loop detection plugin (warn at 3 repeats, hard stop at 5)
  - Context summarization plugin (compress old messages when context too long)
  - Parallel sub-agent executor (concurrent execution, semaphore, timeout enforcement)
  - Sandbox package (virtual path mapping, local provider, Docker stub)
  - Structured memory with fact extraction (categories, confidence, deduplication)
  - Guardrail plugin (tool call policy enforcement, allowlist provider)
  - MCP server integration (stdio transport, tool bridge, namespaced registration)
  - File upload pipeline (document conversion, thread isolation, prompt injection)
- 2026-02-28: Initial architecture, scaffold, agent loop, provider implementations
- 2026-02-28: Memory backend abstraction (`MemoryBackend` interface, local + hive backends)
- 2026-02-28: Added Google Gemini provider (native REST, tool calling)
- 2026-02-28: Rewrote Ollama provider (`/api/chat`, tool calling, proper message format)
- 2026-02-28: Renamed tools to backend-agnostic names (`memory_recall`, `memory_ingest`)
- 2026-02-28: 121 tests across 13 test files, all passing

## Plugins (packages/core/src/plugins/)
| Plugin | Hook | Purpose |
|--------|------|---------|
| `loop-detection` | afterModel, onRunEnd | Detect and break repetitive tool call loops |
| `summarization` | beforeModel | Compress old context when approaching token limit |
| `guardrails` | beforeTool | Enforce tool call policies before execution |
| `uploads` | beforeModel | Inject uploaded file list into system prompt |
| `cost-guard` | beforeModel, onRunEnd | Daily spend tracking and budget enforcement |
| `content-safety` | afterModel | Block secret leaks and unsafe content |
| `trace-logger` | all hooks | Write JSONL trace logs per run |

## Next Steps
- Wire new plugins into main.ts startup (config-driven plugin loading)
- Docker sandbox provider implementation
- MCP SSE/HTTP transport (currently stdio only)
- LLM-powered fact extraction (upgrade from rule-based)
- CI pipeline (GitHub Actions)
- Eval-driven skill auto-promotion
