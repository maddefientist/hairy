# Providers

Providers implement the `Provider` interface from `packages/providers/src/types.ts`. The `ProviderGateway` sits in front of all providers and owns routing, failover, and resilience.

## Built-in providers
- **Anthropic** — `createAnthropicProvider` (Claude family, native tool use)
- **Google Gemini** — `createGeminiProvider` (supports Gemini CLI OAuth via auth profiles)
- **OpenRouter** — `createOpenRouterProvider` (gateway to many models)
- **Ollama** — `createOllamaProvider` (local models, no API key)
- **pi-ai bridge** — `createPiAiBridgeProvider` (optional)

## Routing

`ModelRouter` maps an *intent* to a `(provider, model)` pair using rules from `config/providers.toml`:

```toml
[routing.rules]
simple_text = { provider = "ollama", model = "llama3" }
image_input = { provider = "ollama", model = "llava" }
long_context = { provider = "openrouter", model = "..." }
complex = { provider = "anthropic", model = "claude-sonnet-4-20250514" }

[routing]
default_provider = "anthropic"
fallback_chain = ["anthropic", "openrouter", "gemini", "ollama"]
```

The gateway tries the routed provider first, then walks the fallback chain on failure.

## Resilience

Three modules wrap each provider call:

### Circuit breaker (`circuit-breaker.ts`)
Tracks failure count per provider/profile. After N failures within a window, the breaker opens and the gateway skips that provider for a cooldown period. Half-open probes restore service on recovery.

### Rate-limit tracker (`rate-limit-tracker.ts`)
Parses `Retry-After` headers and provider-specific quota signals. Suppresses calls until the rate-limit window clears, avoiding burning through quota on doomed retries.

### Error classifier (`error-classifier.ts`)
Distinguishes:
- **Retryable** — 429, 5xx, network timeouts → retry with backoff
- **Terminal** — 401, 403, quota exhausted → fail over to next provider, don't retry the same one
- **User errors** — 400, schema mismatches → surface to caller, don't retry

The failover loop in `failover.ts` uses the classifier to decide whether to retry, fall over, or fail the request.

## Auth profiles

A single provider can have multiple auth profiles (e.g. several Anthropic keys, or a personal-OAuth + service-account pair for Gemini). Profiles are stored in `auth-profiles.json` with per-profile usage stats.

The gateway:
- Picks the healthiest profile per call (lowest recent error rate, not currently rate-limited)
- Rotates across profiles to spread quota
- Marks a profile *unhealthy* when its circuit opens; clears state when the breaker closes

This is especially useful for OAuth-based providers whose tokens expire frequently — the gateway routes around an expired profile while you re-authenticate.

## Adding a provider

1. Create `packages/providers/src/<name>.ts`
2. Implement the `Provider` interface (`stream()`, `listModels()`, capability declarations)
3. Surface rate-limit headers in your error objects so the tracker can use them
4. Export from `packages/providers/src/index.ts`
5. Register in `apps/hairy-agent/src/main.ts`
6. Add routing rules in `config/providers.toml`
