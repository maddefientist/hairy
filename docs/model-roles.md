# Role-aware model selection (brain / hands)

Hairy supports two agent execution modes, configured with `[agent].mode` in
`config/default.toml` (or `AGENT_MODE`):

- **`unified`** (default) — one model handles conversation, planning, and
  every tool call. Existing deployments are unaffected by anything in this
  document.
- **`orchestrator`** (also called **brain_hands** mode) — two independently
  configured model *roles*:
  - **brain** — the fast conversational controller/planner. Minimal tool
    surface: `delegate` + memory tools by default (`[orchestrator].tools`).
    Brain never silently inherits the full execution tool surface — technical
    work is an explicit delegation decision, made by calling `delegate`, not
    an implicit fallback.
  - **hands** — the technical executor for coding, system design, debugging,
    and explicitly delegated machine exploration. Gets the configured
    technical tool profile (`[executor].tools`: `bash`, `read`, `write`,
    `edit`, `web-search`, `web-fetch` by default; legacy `web_search` /
    `web_fetch` spellings in config are still accepted and canonicalized).

Simple chat always runs on brain. Technical work only ever reaches hands
through an explicit `delegate` tool call from brain. A provider failure
inside one role's fallback chain is handled entirely within that role — it
never causes the agent to silently switch roles (e.g. a failing hands
provider does not fall back to running technical work on brain's model).

## Configuration

```toml
[agent]
mode = "orchestrator"   # "unified" (default) | "orchestrator" (brain_hands)

[orchestrator]
model = "openrouter/example-brain-model"   # provider/model — brain's configured default
fallback_models = ["ollama/example-brain-fallback:cloud"]
tools = ["delegate", "memory_recall", "memory_ingest"]
temperature = 0.7
max_tokens = 4096
thinking_level = "off"   # optional — explicit non-thinking brain (see below)

[executor]
model = "ollama/example-hands-coder:cloud" # provider/model — hands' configured default
fallback_models = ["ollama/example-hands-fallback:cloud"]
tools = ["bash", "read", "write", "edit", "web-search", "web-fetch"]
temperature = 0.1
max_tokens = 4096
max_iterations = 15
```

### Recommended sanitized routing (this deployment's `config/default.toml`)

```toml
[orchestrator]
model = "supergrok/grok-4.20-0309-non-reasoning"
fallback_models = ["ollama/glm-5.2:cloud", "ollama/minimax-m3:cloud"]
thinking_level = "off"

[executor]
model = "supergrok/grok-4.6"
fallback_models = ["ollama/glm-5.2:cloud", "ollama/deepseek-v4-flash:cloud", "ollama/qwen3.8:27b"]
```

Brain runs the fast, non-reasoning Grok 4.20 variant with `thinking_level =
"off"`, falling back only to non-Anthropic Ollama-routed models. Hands runs
Grok 4.6, falling back to a non-Anthropic coding model then a local model as
a last resort. `supergrok/grok-4.20-0309-reasoning` is also catalogued for
deployments that want a reasoning-capable brain fallback instead.

### Explicit per-role thinking control

`[orchestrator].thinking_level` / `[executor].thinking_level` (optional,
`"off" | "low" | "medium" | "high"`) control the `thinkingLevel` sent to the
model for that role. Left unset by default for hands — the deliberate,
careful executor policy is unchanged unless a deployment opts in explicitly.
For Ollama-routed models, an explicit `"off"` is always sent as `think:
false` (never omitted), since Ollama enables thinking by default for models
that support it.

### Configured tool name validation

`[orchestrator].tools` / `[executor].tools` are validated against the actual
registered tool names at startup. Legacy underscore spellings (`web_search`,
`web_fetch`) are still accepted and canonicalized to the registered
hyphenated names (`web-search`, `web-fetch`); any other unrecognized tool
name fails startup with an explicit error rather than being silently
dropped.

`[orchestrator].model` / `[executor].model` (or the `ORCHESTRATOR_MODEL` /
`EXECUTOR_MODEL` env vars) are **seed values only**. They set the durable
brain/hands primary the first time a deployment runs in `orchestrator` mode.
After that, the durably-persisted role selections (mutable at runtime via
`/model brain ...` / `/model hands ...`, see below) are the source of truth —
config changes to `[orchestrator].model` / `[executor].model` do not silently
override an operator's live selection on restart.

Role fallbacks seed independently from `fallback_models` or the
`ORCHESTRATOR_FALLBACK_CHAIN` / `EXECUTOR_FALLBACK_CHAIN` environment
variables. If a role-specific chain is empty, the legacy shared
`MODEL_FALLBACK_CHAIN` remains the backward-compatible seed. Durable role
state still wins after first startup.

If a configured model isn't in the model catalog for this deployment (wrong
provider name, provider not constructed/provisioned, unrecognized model id),
the role is seeded from the shared safe default instead — startup never
silently treats an unprovisioned or experimental model as a real default. A
warning is logged in that case.

### Generic coding-oriented catalog entries

The model catalog includes generic, provider-bound entries for Ollama-routed
coding models, useful as `hands` candidates:

- `ollama/deepseek-v4-flash:cloud` — DeepSeek V4 Flash (fast coding)
- `ollama/deepseek-v4-pro:cloud` — DeepSeek V4 Pro (deep coding/reasoning)
- `ollama/kimi-k2.6:cloud` — Kimi K2.6

Like every other catalog entry, these are only ever selectable when the
`ollama` provider is actually constructed for this deployment (real base URL,
enabled in config) — reconciliation marks them `unavailable` otherwise, and
the model-selection commands below fail closed on an unavailable id rather
than pretending it works.

Provider construction does not prove that a particular Ollama endpoint serves
every catalogued model. Run `/model <role> test <id>` before switching, and
verify `/model <role> status` afterward. A future provider inventory probe can
make that admission automatic; this release does not claim that live model
listing is enforced at catalog reconciliation time.

## Commands

All model commands are available under `/model` (alias `/m`). Sub-commands
that mutate durable state require operator authorization (the existing
channel-scoped operator allowlist — unchanged from unified mode).

### Legacy / unified / brain alias (unchanged, always available)

```
/model                          — show current status (brain in orchestrator mode)
/model list                     — show the full model catalog + availability
/model status                   — same as /model with no args
/model use <provider/model>     — switch the primary model      [operator]
/model fallback <id1,id2,...>   — replace the fallback chain     [operator]
/model test <provider/model>    — send a canary "pong" request   [operator]
/model rollback                 — revert to the previous selection [operator]
```

In `unified` mode these operate on the single durable model selection exactly
as before. In `orchestrator` mode they are aliases for the **brain** role, so
existing operator habits, scripts, and bot commands keep working unchanged
after switching a deployment from unified to brain_hands mode.

### Role-scoped commands (orchestrator/brain_hands mode only)

```
/model brain [status|use <id>|fallback <ids>|test <id>|rollback]
/model hands [status|use <id>|fallback <ids>|test <id>|rollback]
```

Examples:

```
/model brain use openrouter/example-brain-model
/model hands use ollama/deepseek-v4-pro:cloud
/model hands fallback ollama/deepseek-v4-flash:cloud,ollama/kimi-k2.6:cloud
/model hands test ollama/kimi-k2.6:cloud
/model hands rollback
```

`/model brain status` and `/model hands status` are open (no operator
required) — same policy as the shared `/model list` / `/model status`. All
mutating sub-commands (`use`, `fallback`, `test`, `rollback`) require operator
authorization, for both the legacy alias and every new role-scoped command —
no new command relaxes the existing operator gate.

Outside `orchestrator` mode, `/model brain ...` / `/model hands ...` report
that role-aware model selection is not enabled, rather than silently no-op'ing
or falling back to the unified selection.

## Status & diagnostics

`/model brain status` / `/model hands status` report, per role:

- **Configured primary/fallbacks** — the durable selection (what `/model
  <role> use|fallback` last set)
- **Resolved attempt chain** — what would actually be attempted right now
  given current catalog availability (may differ from configured if a model
  just became unavailable — with a resolution warning explaining why)
- **Last successful provider/model + latency** — the actual last request that
  completed successfully on that role's own gateway, with round-trip latency
  in milliseconds; distinct from "configured", since a role's configured
  primary may never have been successfully attempted yet
- **Circuit breaker state** and **rate limits**, per provider, scoped to that
  role's gateway only

`/debug` (operator-facing structured diagnostics) includes a `roles` field in
`orchestrator` mode with the same bounded, redacted per-role summary
(configured/resolved chain, last-success model + latency, circuit state).
Diagnostics never include prompts, credentials, chat/channel identifiers, or
message content — only provider names, model ids, timestamps, and numeric
counters/latencies.

## Independent gateways, circuits, and fallback chains

Brain and hands each get their own long-lived `ProviderGateway` instance, so:

- Switching brain's model (`/model brain use ...`) never rebuilds or resets
  hands' gateway, and vice versa.
- Circuit-breaker and rate-limit state are tracked per role, not shared — a
  hands provider tripping its circuit breaker has no effect on brain's
  circuit state.
- Fallback chains are independent: `/model hands fallback ...` only ever
  affects hands' attempt chain, never brain's.
- A provider failure within hands' fallback chain is retried across *hands'*
  configured fallbacks only. It never causes the agent to fall back to
  running the failed technical work on brain's model — that would silently
  cross the role boundary that this system exists to keep explicit.

## Migration from unified mode

Switching an existing unified-mode deployment to `orchestrator` mode migrates
its selection state automatically and atomically:

1. On first `orchestrator`-mode startup, if `data/providers/model-selection.json`
   (the pre-existing unified selection file) exists and no brain-role file
   exists yet, the legacy state (primary, fallbacks, and the fact that it
   existed) is copied into `data/providers/model-selection-brain.json` via a
   temp-file-plus-atomic-rename write — the same pattern the rest of Hairy's
   durable stores use, so a crash mid-migration can never leave a
   partially-written brain file.
2. `hands` always starts from its own configured/safe default — the legacy
   unified selection was never running as a technical-executor role, so it is
   never assumed to be a valid hands default.
3. Migration runs exactly once: once `model-selection-brain.json` exists (from
   migration or from `/model brain ...` usage), the legacy file is never
   read again.
4. Switching a deployment back to `unified` mode leaves
   `model-selection-brain.json` / `model-selection-hands.json` untouched and
   continues to use the original unified `model-selection.json` unchanged —
   the migration is additive, not destructive.

## Rollback

Rollback history is independent per role, with the same bounded (default 20
entries), atomically-persisted history that unified mode already uses:

```
/model brain rollback    — revert brain to its previous primary/fallback selection
/model hands rollback    — revert hands to its previous primary/fallback selection
/model rollback          — legacy alias; rolls back brain in orchestrator mode,
                            the single unified selection in unified mode
```

## Sanitized deployment example

```bash
# deploy/hairyclaw.env (do not commit real values)
AGENT_MODE=orchestrator

# Seed values only — see "Configuration" above for why these are not the
# runtime source of truth after the first startup.
ORCHESTRATOR_MODEL=openrouter/example-brain-model
ORCHESTRATOR_FALLBACK_CHAIN=ollama/example-brain-fallback:cloud
EXECUTOR_MODEL=ollama/example-hands-coder:cloud
EXECUTOR_FALLBACK_CHAIN=ollama/example-hands-fallback:cloud

OLLAMA_ENABLED=true
OLLAMA_BASE_URL=http://localhost:11434
OPENROUTER_API_KEY=

OPERATOR_ALLOWLIST=telegram:REPLACE_WITH_OPERATOR_ID
```

```toml
# config/default.toml (excerpt)
[agent]
mode = "orchestrator"

[orchestrator]
model = ""   # left empty here on purpose — set via ORCHESTRATOR_MODEL env var
fallback_models = []
tools = ["delegate", "memory_recall", "memory_ingest"]

[executor]
model = ""   # left empty here on purpose — set via EXECUTOR_MODEL env var
fallback_models = []
tools = ["bash", "read", "write", "edit", "web-search", "web-fetch"]
```

Replace every placeholder above (`example-brain-model`,
`example-hands-coder:cloud`, hostnames, operator ids) with values specific to
your own deployment before use.
