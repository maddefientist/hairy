# Providers

Providers implement the `Provider` interface from `packages/providers/src/types.ts`.

## Built-in providers
- Anthropic (`createAnthropicProvider`)
- OpenRouter (`createOpenRouterProvider`)
- Ollama (`createOllamaProvider`)
- Optional pi-ai bridge (`createPiAiBridgeProvider`)

## Adding a provider
1. Create `packages/providers/src/<name>.ts`
2. Implement `stream()` and `listModels()`
3. Export from `packages/providers/src/index.ts`
4. Register in `apps/hairy-agent/src/main.ts`

## Routing
`ProviderGateway` + `ModelRouter` use routing config from TOML to pick provider/model and fallback chain.
