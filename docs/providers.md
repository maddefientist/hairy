# Providers

Providers implement the `Provider` interface from `packages/providers/src/types.ts`.

## Built-in providers
- **Anthropic** (`createAnthropicProvider`) — Claude models
- **OpenRouter** (`createOpenRouterProvider`) — Multi-model gateway
- **Gemini** (`createGeminiProvider`) — Google Gemini models
- **Ollama** (`createOllamaProvider`) — Local or LAN models via `/api/chat`
- **pi-ai bridge** (`createPiAiBridgeProvider`) — Optional pi-ai integration

## Adding a provider
1. Create `packages/providers/src/<name>.ts`
2. Implement `stream()` and `listModels()`
3. Export from `packages/providers/src/index.ts`
4. Register in `apps/hairy-agent/src/main.ts`

## Routing & Fallback

`ProviderGateway` + `ModelRouter` use routing config from TOML to pick provider/model and fallback chain.

### Provider-level fallback
If the primary provider fails (500, timeout, rate limit), the gateway tries the next provider in `fallback_chain`:
```toml
[routing]
fallback_chain = ["anthropic", "openrouter", "ollama"]
```

### Model-level fallback (same provider, different model)
When `fallback_model` is set on a provider, a second provider instance (`ollama-fallback`) is created with the same URL but different model. The gateway uses a `modelMap` to pick the correct model for each provider during fallback.

```toml
[providers.ollama]
default_model = "glm-5:cloud"      # Primary
fallback_model = "qwen3.5:9b"      # Fallback (registered as ollama-fallback)

[routing]
fallback_chain = ["ollama", "ollama-fallback"]
```

This is useful when:
- Cloud models via Ollama proxy are unreliable for tool-calling
- You want a fast local model as fallback without changing providers
- Different tasks need different model sizes

## Orchestrator/Executor Mode

Set `agent.mode = "orchestrator"` to split reasoning and execution across two models:

- **Primary model** (orchestrator): Gets `delegate`, `memory_recall`, `memory_ingest`, `identity_evolve`
- **Fallback model** (executor): Gets `bash`, `read`, `write`, `edit`, `web-search`

The `delegate` tool runs a mini agent loop with the executor model. The orchestrator sends focused instructions, the executor runs tools, and results flow back.

See `packages/tools/src/builtin/delegate.ts` for the implementation.
