# Hairy Robustness Upgrade — Full Codex Execution Plan

> **Goal**: Make Hairy at least as robust as OpenClaw, incorporating ADK lifecycle patterns, and ready to replace the OpenClaw deployment on `aghari`.
>
> **Repo**: `/Users/admin/agenticharnes/hairy`
> **Current state**: 7,666 LOC (src), 2,616 LOC (tests), 121 tests passing, clean build.
> **Execution**: Each task is a standalone Codex agent run. Tasks within the same phase have no file overlap and can run in parallel.

---

## Phase 0 — Provider Resilience (the thing that just broke)

### TASK-01: Auth Profile Manager
**Package**: `packages/providers/`
**New files**: `src/auth-profiles.ts`, `test/auth-profiles.test.ts`
**Touches**: nothing existing yet

Create an `AuthProfileManager` class that tracks per-profile health state and handles credential lifecycle.

```typescript
// src/auth-profiles.ts

interface AuthProfile {
  id: string;                        // e.g. "ollama:local", "anthropic:sk-abc"
  provider: string;                  // e.g. "ollama", "anthropic"
  type: "api_key" | "oauth" | "none";
  credential: string;                // API key or access token
  refreshToken?: string;             // for OAuth profiles
  expiresAt?: number;                // ms epoch, undefined = never expires
}

interface ProfileHealth {
  lastUsed?: number;
  lastSuccess?: number;
  lastFailureAt?: number;
  errorCount: number;
  consecutiveErrors: number;
  cooldownUntil?: number;            // ms epoch
  failureCounts: Record<string, number>; // "timeout" | "rate_limit" | "auth" | "server"
}

interface AuthProfileManagerOptions {
  /** Path to persist profile state (JSON) */
  filePath: string;
  /** Base cooldown duration in ms (default: 15000). Doubles on each consecutive failure, capped at maxCooldownMs. */
  baseCooldownMs?: number;
  /** Max cooldown duration in ms (default: 300000 = 5 min) */
  maxCooldownMs?: number;
  /** Number of consecutive errors before cooldown kicks in (default: 1) */
  cooldownThreshold?: number;
  logger?: HairyLogger;
}

class AuthProfileManager {
  // Register a profile
  addProfile(profile: AuthProfile): void;
  // Remove a profile
  removeProfile(id: string): void;
  // Get a usable profile for a provider, skipping cooldowns. Returns null if all exhausted.
  getAvailable(provider: string): AuthProfile | null;
  // Report success for a profile — resets consecutive error count
  reportSuccess(profileId: string): void;
  // Report failure — increments counters, may trigger cooldown
  reportFailure(profileId: string, reason: "timeout" | "rate_limit" | "auth" | "server"): void;
  // Clear cooldown for a specific profile or all profiles of a provider
  clearCooldown(profileIdOrProvider: string): void;
  // Check if a specific profile is currently in cooldown
  isInCooldown(profileId: string): boolean;
  // Get health snapshot for observability
  getHealthSnapshot(): Map<string, ProfileHealth>;
  // Persist state to disk
  save(): Promise<void>;
  // Load state from disk
  load(): Promise<void>;
}
```

**Cooldown formula**: `cooldownMs = min(baseCooldownMs * 2^(consecutiveErrors - cooldownThreshold), maxCooldownMs)`

**Tests** (at least 15):
- Add/remove profiles
- `getAvailable` returns profile when healthy
- `getAvailable` skips profiles in cooldown
- `getAvailable` returns null when all in cooldown
- `reportFailure` increments counters
- `reportFailure` triggers cooldown after threshold
- `reportSuccess` resets consecutive errors
- `clearCooldown` makes profile available again
- Exponential backoff calculation
- Max cooldown cap
- Persistence round-trip (save + load)
- Multiple profiles per provider — failover within provider
- Expired OAuth profile skipped unless refresh token present
- `getHealthSnapshot` returns correct state
- Concurrent `getAvailable` calls don't return same profile (optional: best-effort)

---

### TASK-02: Per-Model Fallback Chain in ProviderGateway
**Package**: `packages/providers/`
**Modifies**: `src/gateway.ts`, `src/types.ts`
**New files**: `test/gateway-fallback.test.ts`

Replace the current provider-level fallback with a model-level fallback chain. The gateway should try specific `provider/model` pairs in order, using the AuthProfileManager to get credentials per attempt.

**Changes to `src/types.ts`**:
```typescript
// Add to RoutingConfig:
interface RoutingConfig {
  defaultProvider: string;
  fallbackChain: string[];              // existing: provider-level
  modelFallbackChain?: ModelFallback[]; // NEW: ordered list of provider/model pairs
  rules?: Record<string, { provider: string; model: string }>;
}

interface ModelFallback {
  provider: string;
  model: string;
  /** Optional: max timeout for this specific model (ms) */
  timeoutMs?: number;
}
```

**Changes to `src/gateway.ts`**:

The `stream()` method should:
1. If `modelFallbackChain` is configured, iterate through it in order.
2. For each entry, get a provider instance and an auth profile via `AuthProfileManager`.
3. Wrap the provider stream call in an `AbortSignal.timeout(entry.timeoutMs ?? 120_000)`.
4. On success → `authProfiles.reportSuccess(profileId)`, yield events, return.
5. On error → `authProfiles.reportFailure(profileId, classifyError(error))`, continue to next.
6. If all fail → yield `{ type: "error", error: "all models failed: ..." }` with per-model failure reasons (same format OpenClaw uses).

**Error classification function**:
```typescript
function classifyError(error: unknown): "timeout" | "rate_limit" | "auth" | "server" {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("timeout") || msg.includes("aborted")) return "timeout";
  if (msg.includes("429") || msg.includes("rate")) return "rate_limit";
  if (msg.includes("401") || msg.includes("403") || msg.includes("auth")) return "auth";
  return "server";
}
```

**Tests** (at least 10):
- Model fallback chain tries entries in order
- Skips model whose provider profile is in cooldown
- Reports failure to AuthProfileManager on error
- Reports success on successful stream
- Timeout aborts long-running stream
- Falls through all models and yields aggregate error
- Legacy provider-level fallback still works when `modelFallbackChain` is not set
- Mixed providers in chain (ollama model → anthropic model → gemini model)
- Per-model timeout override respected
- Error classification maps correctly

---

### TASK-03: Request Timeout & AbortController in All Providers
**Package**: `packages/providers/`
**Modifies**: `src/ollama.ts`, `src/anthropic.ts`, `src/gemini.ts`, `src/openrouter.ts`
**New files**: none (test additions to existing test files)

Add `timeoutMs` to `StreamOptions`:
```typescript
// In src/types.ts, add to StreamOptions:
timeoutMs?: number; // default: 120_000
```

In every provider's `stream()` method:
1. Create `AbortSignal.timeout(streamOpts.timeoutMs ?? 120_000)`.
2. Pass `{ signal }` to the `fetch()` call.
3. Catch `AbortError` / timeout and yield `{ type: "error", error: "request timed out after Xms" }`.

This prevents the 600-second hang that cascaded into the OpenClaw failure.

**Tests**: At least 2 per provider (timeout triggers error event, normal request completes).

---

## Phase 1 — Plugin / Middleware System (ADK Lifecycle Hooks)

### TASK-04: Plugin Interface & Plugin Runner
**Package**: `packages/core/`
**New files**: `src/plugin.ts`, `test/plugin.test.ts`
**Touches**: nothing existing yet (wiring happens in TASK-05)

Define the plugin system inspired by ADK's 7-hook lifecycle, adapted for Hairy's architecture.

```typescript
// src/plugin.ts

/** Context passed to every hook */
interface PluginContext {
  traceId: string;
  channelType: string;
  channelId: string;
  senderId: string;
  state: Map<string, unknown>;  // mutable run state (ADK session state pattern)
  logger: HairyLogger;
}

/**
 * Plugin interface — implement any subset of hooks.
 * Hooks run in registration order. Return null/undefined to pass through.
 * Returning a modified value replaces it for subsequent plugins.
 */
interface HairyPlugin {
  name: string;
  priority?: number; // lower = runs first, default 100

  // ── Message lifecycle ─────────────────────────────────────────
  /** Inspect/modify/block incoming user message. Return null to block. */
  onUserMessage?(msg: HairyMessage, ctx: PluginContext): Promise<HairyMessage | null>;

  // ── Model lifecycle ───────────────────────────────────────────
  /** Modify messages/options before LLM call. Use for prompt injection, guardrails. */
  beforeModel?(
    messages: ProviderMessage[],
    opts: StreamOptions,
    ctx: PluginContext,
  ): Promise<{ messages: ProviderMessage[]; opts: StreamOptions } | null>;

  /** Inspect/modify LLM response text. Return null to force retry (up to 1 retry). */
  afterModel?(
    responseText: string,
    toolCalls: ToolCallRecord[],
    ctx: PluginContext,
  ): Promise<string | null>;

  /** Called when LLM returns an error. Can return replacement text or null to propagate. */
  onModelError?(error: Error, ctx: PluginContext): Promise<string | null>;

  // ── Tool lifecycle ────────────────────────────────────────────
  /** Inspect/modify tool args before execution. Return null to block tool call. */
  beforeTool?(
    toolName: string,
    args: unknown,
    ctx: PluginContext,
  ): Promise<{ args: unknown } | null>;

  /** Inspect/modify tool result after execution. */
  afterTool?(
    toolName: string,
    result: string,
    isError: boolean,
    ctx: PluginContext,
  ): Promise<{ result: string; isError: boolean }>;

  /** Called when tool execution errors. Can return replacement result or null. */
  onToolError?(
    toolName: string,
    error: Error,
    ctx: PluginContext,
  ): Promise<{ result: string; isError: boolean } | null>;

  // ── Response lifecycle ────────────────────────────────────────
  /** Final chance to modify response before it's sent to the channel. Return null to suppress. */
  beforeSend?(
    response: AgentResponse,
    ctx: PluginContext,
  ): Promise<AgentResponse | null>;

  // ── Run lifecycle ─────────────────────────────────────────────
  /** Called at the start of an orchestrator run. */
  onRunStart?(ctx: PluginContext): Promise<void>;
  /** Called at the end of an orchestrator run (success or failure). */
  onRunEnd?(ctx: PluginContext, result?: RunResult, error?: Error): Promise<void>;
}

/**
 * PluginRunner — executes hooks across all registered plugins.
 */
class PluginRunner {
  constructor(plugins: HairyPlugin[]);

  // For each hook type, run all plugins in priority order.
  // Chain pattern: output of plugin N becomes input to plugin N+1.
  runOnUserMessage(msg: HairyMessage, ctx: PluginContext): Promise<HairyMessage | null>;
  runBeforeModel(messages: ProviderMessage[], opts: StreamOptions, ctx: PluginContext): Promise<{ messages: ProviderMessage[]; opts: StreamOptions } | null>;
  runAfterModel(text: string, toolCalls: ToolCallRecord[], ctx: PluginContext): Promise<string | null>;
  runOnModelError(error: Error, ctx: PluginContext): Promise<string | null>;
  runBeforeTool(name: string, args: unknown, ctx: PluginContext): Promise<{ args: unknown } | null>;
  runAfterTool(name: string, result: string, isError: boolean, ctx: PluginContext): Promise<{ result: string; isError: boolean }>;
  runOnToolError(name: string, error: Error, ctx: PluginContext): Promise<{ result: string; isError: boolean } | null>;
  runBeforeSend(response: AgentResponse, ctx: PluginContext): Promise<AgentResponse | null>;
  runOnRunStart(ctx: PluginContext): Promise<void>;
  runOnRunEnd(ctx: PluginContext, result?: RunResult, error?: Error): Promise<void>;
}
```

**Tests** (at least 18):
- Plugin with no hooks is a no-op
- `onUserMessage` can modify message text
- `onUserMessage` returning null blocks the message
- Multiple plugins chain in priority order
- `beforeModel` can inject system prompt content
- `beforeModel` returning null skips LLM call
- `afterModel` can modify response text
- `afterModel` returning null triggers retry (test that retry happens once)
- `beforeTool` can modify args
- `beforeTool` returning null blocks tool call
- `afterTool` can modify result
- `onToolError` can provide fallback result
- `onModelError` can provide fallback text
- `beforeSend` can suppress response (return null)
- `beforeSend` can modify response
- `onRunStart` / `onRunEnd` called correctly
- Plugins sorted by priority
- State is shared across hooks within one run
- Error in one plugin doesn't crash the chain (logged, skipped)

---

### TASK-05: Wire Plugins into Agent Loop & Orchestrator
**Package**: `packages/core/`, `apps/hairy-agent/`
**Modifies**: `packages/core/src/agent-loop.ts`, `packages/core/src/orchestrator.ts`, `packages/core/src/index.ts`, `apps/hairy-agent/src/main.ts`

Wire the `PluginRunner` from TASK-04 into the existing agent loop and orchestrator.

**Changes to `agent-loop.ts`**:
1. Add `plugins?: PluginRunner` and `ctx?: PluginContext` to `AgentLoopOptions`.
2. Before streaming to LLM: call `plugins.runBeforeModel(messages, streamOpts, ctx)`. If null, skip iteration.
3. After collecting full response text: call `plugins.runAfterModel(text, toolCalls, ctx)`. If null, retry the LLM call once.
4. On LLM error: call `plugins.runOnModelError(error, ctx)`. If returns string, use as response text.
5. Before executing each tool: call `plugins.runBeforeTool(name, args, ctx)`. If null, skip tool and add error result.
6. After tool execution: call `plugins.runAfterTool(name, result, isError, ctx)`.
7. On tool execution error: call `plugins.runOnToolError(name, error, ctx)`.

**Changes to `orchestrator.ts`**:
1. Add `plugins?: PluginRunner` to `OrchestratorDeps`.
2. In `processLoop`, after dequeuing a message: call `plugins.runOnUserMessage(msg, ctx)`. If null, skip.
3. At start of `handleRun` wrapper: call `plugins.runOnRunStart(ctx)`.
4. At end: call `plugins.runOnRunEnd(ctx, result?, error?)`.
5. Create a `PluginContext` per run with a fresh `state: Map` and the message metadata.

**Changes to `orchestrator.ts` handleRun in `main.ts`**:
1. After getting `responseText`, before sending: call `plugins.runBeforeSend(response, ctx)`. If null, don't send.

**Changes to `index.ts`**:
1. Export `PluginRunner`, `HairyPlugin`, `PluginContext` types.

**Changes to `main.ts`**:
1. Accept `plugins` array in config (empty by default).
2. Instantiate `PluginRunner` and pass it to orchestrator and agent loop.

**Tests**: At least 5 integration tests that verify the wiring:
- Plugin `onUserMessage` blocks a message, orchestrator skips it
- Plugin `beforeModel` modifies system prompt, LLM receives modified prompt
- Plugin `beforeTool` blocks a tool, tool result is error
- Plugin `beforeSend` modifies final response text
- Plugin `onRunStart`/`onRunEnd` called with correct traceId

---

## Phase 2 — Delivery Reliability & Streaming UX

### TASK-06: Delivery Queue with Retry
**Package**: `packages/channels/`
**New files**: `src/delivery-queue.ts`, `test/delivery-queue.test.ts`
**Touches**: nothing existing yet (wiring in TASK-08)

A persistent queue for outbound messages. If `sendMessage` fails, the message is saved and retried with exponential backoff.

```typescript
// src/delivery-queue.ts

interface DeliveryItem {
  id: string;
  channelType: string;
  channelId: string;
  response: AgentResponse;
  attempts: number;
  maxAttempts: number;      // default: 5
  nextRetryAt: number;      // ms epoch
  createdAt: number;
  lastError?: string;
}

interface DeliveryQueueOptions {
  filePath: string;          // persist to JSON for crash recovery
  maxAttempts?: number;      // default: 5
  baseRetryMs?: number;      // default: 5000
  maxRetryMs?: number;       // default: 300000 (5 min)
  logger?: HairyLogger;
}

class DeliveryQueue {
  constructor(opts: DeliveryQueueOptions);

  /** Add a message to the queue */
  enqueue(channelType: string, channelId: string, response: AgentResponse): Promise<void>;

  /** Process due retries. Called on a timer. Returns number of items processed. */
  processDue(send: (channelType: string, channelId: string, response: AgentResponse) => Promise<void>): Promise<number>;

  /** Get items that have exhausted retries (for dead-letter inspection) */
  getDeadLetters(): DeliveryItem[];

  /** Remove a dead letter */
  removeDeadLetter(id: string): Promise<void>;

  /** Get queue stats */
  stats(): { pending: number; deadLetters: number };

  /** Persist to disk */
  save(): Promise<void>;

  /** Load from disk */
  load(): Promise<void>;
}
```

**Retry formula**: `nextRetryAt = now + min(baseRetryMs * 2^attempts, maxRetryMs)`

**Tests** (at least 10):
- Enqueue and processDue delivers message
- Failed delivery increments attempts and schedules retry
- Retry respects exponential backoff timing
- Exhausted retries move to dead letters
- Dead letters retrievable and removable
- Persistence round-trip
- Multiple items processed in order
- `stats()` returns correct counts
- Empty queue processDue returns 0
- Concurrent enqueue during processDue is safe

---

### TASK-07: Telegram Streaming (Edit-in-Place)
**Package**: `packages/channels/`
**Modifies**: `src/telegram.ts`, `src/adapter.ts`, `src/types.ts`
**New files**: `test/telegram-streaming.test.ts`

Add streaming support so Telegram messages update in real-time as tokens arrive (like OpenClaw's `streamMode: "partial"`).

**Changes to `src/types.ts` (ChannelAdapter interface)**:
```typescript
// Add to ChannelAdapter (in adapter.ts / types.ts):
/** Send initial message and return a handle for editing */
sendStreamStart?(channelId: string, initialText: string): Promise<StreamHandle>;

interface StreamHandle {
  /** Update the message content (debounced internally) */
  update(text: string): Promise<void>;
  /** Finalize the message (last edit, stop typing) */
  finalize(text: string): Promise<void>;
  /** Message ID for reference */
  messageId: string;
}
```

**Changes to `src/telegram.ts`**:
1. Implement `sendStreamStart` for bot mode using `ctx.reply()` then `ctx.api.editMessageText()`.
2. Debounce edits to max 1 edit per 1.5 seconds (Telegram rate limit is ~30 edits/min per chat).
3. Track the message ID returned from `reply()`.
4. On `finalize()`, do one last edit and call `stopTyping()`.
5. Handle `GrammyError` 400 "message is not modified" gracefully (skip, not error).

**Changes to `src/adapter.ts`**:
1. Add `sendStreamStart?` as an optional method on `BaseAdapter`.

This is wired in TASK-08 when the orchestrator connects streaming to the channel.

**Tests** (at least 6):
- `sendStreamStart` returns a handle with messageId
- `update()` calls `editMessageText`
- Rapid `update()` calls are debounced
- `finalize()` does final edit and stops typing
- "message is not modified" error is swallowed
- Adapters without `sendStreamStart` fall back to normal `sendMessage`

---

### TASK-08: Wire Delivery Queue & Streaming into Orchestrator
**Package**: `apps/hairy-agent/`
**Modifies**: `apps/hairy-agent/src/main.ts`

1. **Delivery Queue**: Instantiate `DeliveryQueue` in `main.ts`. Wrap the `targetChannel.sendMessage()` call: on failure, enqueue. Start a 10-second interval calling `deliveryQueue.processDue()` with a send function that routes to the correct channel adapter.

2. **Streaming**: In the `handleRun` function, if the target channel supports `sendStreamStart`:
   - Call `sendStreamStart(channelId, "⏳")` at the start.
   - Pass `onTextDelta` to `runAgentLoop` that accumulates text and calls `handle.update(accumulated)`.
   - On completion, call `handle.finalize(fullResponseText)`.
   - If the channel doesn't support streaming, fall back to existing behavior.

3. **Delivery Queue for Streaming Failures**: If `finalize()` fails, enqueue the final text through the delivery queue.

**Tests**: At least 3 integration tests:
- Streaming updates reach the channel handle
- Failed send enqueues to delivery queue
- Delivery queue retry succeeds on second attempt

---

## Phase 3 — Multi-Agent Orchestration (ADK Patterns)

### TASK-09: Workflow Primitives (Sequential / Parallel / Loop)
**Package**: `packages/core/`
**New files**: `src/workflows.ts`, `test/workflows.test.ts`
**Touches**: nothing existing

Implement ADK-inspired deterministic workflow agents. These don't use an LLM for flow control — they compose agent runs in fixed patterns.

```typescript
// src/workflows.ts

/** A unit of work that takes input state and returns output state */
interface WorkflowStep {
  name: string;
  /** Run the step. Receives shared state, returns output to merge into state. */
  run(state: Map<string, unknown>, ctx: PluginContext): Promise<Map<string, unknown>>;
}

/** Run steps A → B → C in order. Each step's output merges into shared state. */
class SequentialFlow implements WorkflowStep {
  name: string;
  constructor(name: string, steps: WorkflowStep[]);
  run(state: Map<string, unknown>, ctx: PluginContext): Promise<Map<string, unknown>>;
}

/** Run steps A, B, C simultaneously. All outputs merge into state (last-write-wins on key conflicts). */
class ParallelFlow implements WorkflowStep {
  name: string;
  constructor(name: string, steps: WorkflowStep[], opts?: { maxConcurrency?: number });
  run(state: Map<string, unknown>, ctx: PluginContext): Promise<Map<string, unknown>>;
}

/** Run a step repeatedly until condition is met or maxIterations reached. */
class LoopFlow implements WorkflowStep {
  name: string;
  constructor(
    name: string,
    step: WorkflowStep,
    opts: {
      until: (state: Map<string, unknown>, iteration: number) => boolean;
      maxIterations: number;
    },
  );
  run(state: Map<string, unknown>, ctx: PluginContext): Promise<Map<string, unknown>>;
}

/**
 * Wrap an agent loop call as a WorkflowStep.
 * This is the bridge between deterministic workflows and LLM reasoning.
 * The LLM receives a prompt (with state interpolation) and its response
 * is stored in state under `outputKey`.
 */
class AgentStep implements WorkflowStep {
  name: string;
  constructor(opts: {
    name: string;
    /** Prompt template. Use {state.keyName} for interpolation. */
    promptTemplate: string;
    /** Key to store the agent's response in state */
    outputKey: string;
    /** Model override for this step */
    model?: string;
    /** Provider override */
    provider?: string;
    /** Tools available to this step (empty = no tools) */
    tools?: AgentLoopToolDef[];
    /** Max iterations for this step's agent loop */
    maxIterations?: number;
  });
  run(state: Map<string, unknown>, ctx: PluginContext): Promise<Map<string, unknown>>;
}

/** Execute a workflow and return final state */
function runWorkflow(
  workflow: WorkflowStep,
  initialState?: Map<string, unknown>,
  ctx?: PluginContext,
): Promise<Map<string, unknown>>;
```

**Tests** (at least 14):
- SequentialFlow runs steps in order
- SequentialFlow passes state between steps
- ParallelFlow runs steps concurrently
- ParallelFlow merges outputs
- ParallelFlow respects maxConcurrency
- LoopFlow repeats until condition
- LoopFlow stops at maxIterations
- LoopFlow state accumulates across iterations
- AgentStep interpolates prompt template from state
- AgentStep stores response under outputKey
- Nested flows (Sequential containing Parallel)
- Empty flow returns input state
- Error in one parallel step doesn't crash others (collected as error in state)
- `runWorkflow` with no initial state uses empty map

---

### TASK-10: SubAgent Tool (Agent-as-Tool Pattern)
**Package**: `packages/tools/`
**New files**: `src/builtin/subagent.ts`, `test/subagent.test.ts`
**Touches**: `src/index.ts` (add export)

Implement the ADK `AgentTool` pattern: wrap a sub-agent as a tool that the main agent can call.

```typescript
// src/builtin/subagent.ts

interface SubAgentToolOptions {
  /** Human-readable name for the tool */
  name: string;
  /** Description shown to the LLM */
  description: string;
  /** System prompt for the sub-agent */
  systemPrompt: string;
  /** Model to use (provider/model format) */
  model?: string;
  /** Tools available to the sub-agent (default: none) */
  tools?: Tool[];
  /** Max iterations for the sub-agent loop */
  maxIterations?: number;
  /** Timeout for the entire sub-agent run (ms) */
  timeoutMs?: number;
}

function createSubAgentTool(opts: SubAgentToolOptions): Tool;
```

The tool's `execute` function:
1. Takes a `{ task: string }` parameter from the calling agent.
2. Runs a fresh `runAgentLoop` with the sub-agent's system prompt, model, and tools.
3. Returns the sub-agent's final response text as the tool result.
4. Respects timeout via AbortController.

**Tests** (at least 6):
- SubAgent tool has correct name and description
- Execute runs agent loop with provided system prompt
- Task parameter is passed as user message
- Timeout aborts the sub-agent run
- Sub-agent tool results returned to parent
- Sub-agent with tools can use them

---

## Phase 4 — Command System & Auto-Memory

### TASK-11: Command Router (Fast-Path Commands)
**Package**: `packages/core/`
**New files**: `src/commands.ts`, `test/commands.test.ts`
**Touches**: nothing existing (wired in TASK-13)

A command router that intercepts `/command` messages before they reach the LLM, providing instant responses for operational commands.

```typescript
// src/commands.ts

interface CommandDef {
  name: string;              // e.g. "model", "status", "help"
  aliases?: string[];        // e.g. ["m"] for /m
  description: string;
  /** If true, don't pass to LLM even if command handler returns null */
  exclusive?: boolean;
  handler: (args: string, ctx: CommandContext) => Promise<string | null>;
}

interface CommandContext {
  channelType: string;
  channelId: string;
  senderId: string;
  /** Access to runtime for status commands */
  runtime: CommandRuntime;
}

interface CommandRuntime {
  getModelInfo(): { primary: string; fallbacks: string[] };
  getProviderHealth(): Map<string, ProfileHealth>;
  getUptime(): number;
  getMetrics(): Record<string, number>;
  getQueueStats(): { pending: number; deadLetters: number };
}

class CommandRouter {
  constructor(logger?: HairyLogger);

  /** Register a command */
  register(command: CommandDef): void;

  /** Try to route a message. Returns response text if handled, null if not a command. */
  route(text: string, ctx: CommandContext): Promise<string | null>;

  /** List all registered commands (for /help) */
  listCommands(): CommandDef[];
}
```

**Built-in commands to register**:
- `/help` — list all commands
- `/status` — uptime, provider health, queue stats, active model
- `/model` — show current model + fallback chain
- `/model <alias>` — switch primary model
- `/health` — provider health snapshot (cooldowns, error counts)
- `/clear` — clear cooldowns on all providers
- `/queue` — show delivery queue stats

**Tests** (at least 10):
- `/help` returns list of commands
- `/status` returns formatted status
- Unknown `/command` returns null (passes to LLM)
- Non-command message returns null
- `/model` with no args shows current model
- `/model <name>` switches model
- `/health` shows provider health
- `/clear` clears cooldowns
- Alias routing works (`/m` → `/model`)
- Command with args parsed correctly

---

### TASK-12: Auto-Memory Preload
**Package**: `packages/memory/`
**New files**: `src/preloader.ts`, `test/preloader.test.ts`
**Touches**: nothing existing (wired in TASK-13)

Automatically inject relevant memories into the system prompt before each LLM call (ADK's `PreloadMemoryTool` pattern, but as a plugin rather than a tool).

```typescript
// src/preloader.ts

interface MemoryPreloaderOptions {
  /** Memory backend to search */
  backend: MemoryBackend;
  /** Max items to inject */
  topK?: number;              // default: 3
  /** Min similarity score to include */
  minScore?: number;          // default: 0.3
  /** Max total characters to inject */
  maxChars?: number;          // default: 2000
  /** Cache TTL — don't re-search if same message within N ms */
  cacheTtlMs?: number;        // default: 5000
  logger?: HairyLogger;
}

/**
 * Creates a HairyPlugin that injects relevant memories into the system prompt.
 * Uses the `beforeModel` hook to prepend a "Relevant memories:" section.
 */
function createMemoryPreloadPlugin(opts: MemoryPreloaderOptions): HairyPlugin;
```

The plugin's `beforeModel` hook:
1. Extract the latest user message text from the messages array.
2. Search the memory backend for relevant items.
3. Filter by `minScore`, cap at `topK` and `maxChars`.
4. If any results, prepend a `\n\n## Relevant Memories\n{memories}\n` block to the system prompt in `opts`.
5. Return modified `{ messages, opts }`.

**Tests** (at least 8):
- No user message → no search, passthrough
- Memories found → injected into system prompt
- No memories found → passthrough (no empty section)
- Min score filter applied
- Max chars truncation works
- Top K limit respected
- Cache prevents duplicate searches for same text
- Plugin implements `beforeModel` hook correctly

---

### TASK-13: Wire Commands, Memory Preload & Config Updates into main.ts
**Package**: `apps/hairy-agent/`
**Modifies**: `apps/hairy-agent/src/main.ts`, `apps/hairy-agent/src/config.ts`, `config/default.toml`

1. **Command Router**: Instantiate `CommandRouter` with built-in commands. In the orchestrator's `handleRun`, before running the agent loop, check `commandRouter.route(message.content.text, ctx)`. If it returns a string, send it directly as the response and skip the LLM.

2. **Memory Preload Plugin**: If hive or semantic memory is configured, create a `MemoryPreloadPlugin` and add it to the plugins array.

3. **Auth Profiles**: Instantiate `AuthProfileManager` with profiles from config. Load on startup. Add profiles for each configured provider. Wire into `ProviderGateway`.

4. **Config updates to `config/default.toml`**:
```toml
[providers.ollama]
enabled = false
base_url = "http://localhost:11434"
default_model = "llama3.2"
# Per-model fallback chain (tried in order, cross-provider)
# Format: "provider/model"
model_fallback_chain = []

[resilience]
# Auth profile cooldown settings
cooldown_base_ms = 15000
cooldown_max_ms = 300000
cooldown_threshold = 1
# Per-request LLM timeout
request_timeout_ms = 120000

[delivery]
# Outbound message retry
max_attempts = 5
base_retry_ms = 5000
max_retry_ms = 300000

[memory]
# Auto-preload relevant memories into system prompt
auto_preload = true
preload_top_k = 3
preload_min_score = 0.3
preload_max_chars = 2000
```

5. **Config schema updates to `packages/core/src/config.ts`**: Add Zod schemas for the new TOML sections (resilience, delivery, memory).

**Tests**: At least 3 integration tests:
- Command intercepts `/status` before LLM
- Memory preload plugin injects context
- Auth profile manager loads and provides profiles

---

## Phase 5 — Media, Browser & Polish

### TASK-14: Inbound Media Extraction (Telegram)
**Package**: `packages/channels/`
**Modifies**: `src/telegram.ts`
**New files**: `test/telegram-media.test.ts`

Extract images, voice messages, documents, and video from incoming Telegram messages and populate the `MessageContent` fields.

For bot mode (grammY):
1. Check `ctx.message.photo` — download highest resolution, set `images[0]`.
2. Check `ctx.message.voice` / `ctx.message.audio` — download, set `audio[0]`.
3. Check `ctx.message.video` / `ctx.message.video_note` — download, set `video[0]`.
4. Check `ctx.message.document` — download, set `documents[0]`.
5. Use `ctx.api.getFile(fileId)` then fetch from `https://api.telegram.org/file/bot{token}/{filePath}`.
6. Store downloaded files in `{dataDir}/media/inbound/{channelId}/{timestamp}-{filename}`.
7. Set `buffer` and `mimeType` on the attachment.

For MTProto mode, use the equivalent GramJS download methods.

**Tests** (at least 6):
- Photo message populates `images` array
- Voice message populates `audio` array
- Document message populates `documents` array
- Caption preserved on media messages
- Text-only message has no attachments
- Multiple media types in one message (photo + caption)

---

### TASK-15: Browser Sidecar
**Package**: `sidecars/browser/`
**New files**: `src/main.ts`, `src/protocol.ts`, `package.json`, `tsconfig.json`
**Also**: `packages/tools/src/builtin/browser.ts`, update `packages/tools/src/index.ts`

Create a browser automation sidecar using Playwright, exposed as tools via the sidecar JSON-RPC protocol.

**Sidecar tools**:
- `browser_navigate(url)` — go to URL, return page title + text content (truncated)
- `browser_screenshot(url?)` — screenshot current page (or navigate first), return base64
- `browser_click(selector)` — click element
- `browser_type(selector, text)` — type into input
- `browser_evaluate(script)` — run JS, return result

**Tool wrapper** (`packages/tools/src/builtin/browser.ts`):
A convenience tool that runs without the sidecar by using Playwright directly (if installed). Falls back to `web-fetch` if Playwright is not available.

```typescript
function createBrowserTool(): Tool;
// Parameters: { action: "navigate" | "screenshot" | "click" | "type" | "evaluate", url?: string, selector?: string, text?: string, script?: string }
```

**Tests** (at least 4):
- Navigate returns page content
- Screenshot returns base64 data
- Invalid URL returns error result
- Graceful fallback when Playwright unavailable

---

### TASK-16: Systemd Service & Deployment Config
**New files (project root)**:
- `deploy/hairy-agent.service` — systemd user unit file
- `deploy/hairy-agent.env.example` — environment variable template
- `deploy/install.sh` — installation script for aghari VM
- `deploy/migrate-openclaw.sh` — migration script that extracts OpenClaw config into Hairy format

**`deploy/hairy-agent.service`**:
```ini
[Unit]
Description=Hairy Agent Daemon
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/aghari/hairy
EnvironmentFile=/home/aghari/hairy/.env
ExecStart=/usr/bin/node apps/hairy-agent/dist/main.js
Restart=on-failure
RestartSec=10
WatchdogSec=120

# Resource limits
MemoryMax=2G
CPUQuota=200%

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hairy-agent

[Install]
WantedBy=default.target
```

**`deploy/hairy-agent.env.example`**:
```bash
# === Providers ===
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=
OLLAMA_ENABLED=true
OLLAMA_BASE_URL=http://192.168.1.225:11434
OLLAMA_MODEL=kimi-k2.5:cloud

# === Channels ===
TELEGRAM_MODE=bot
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_IDS=

# === Memory ===
HARI_HIVE_URL=http://192.168.1.225:8088
HARI_HIVE_API_KEY=
HARI_HIVE_NAMESPACE=claude-shared
```

**`deploy/install.sh`**:
```bash
#!/usr/bin/env bash
# Install Hairy on aghari VM
set -euo pipefail

HAIRY_DIR="/home/aghari/hairy"

# Clone or pull
if [ -d "$HAIRY_DIR" ]; then
  cd "$HAIRY_DIR" && git pull
else
  git clone <repo-url> "$HAIRY_DIR"
fi

cd "$HAIRY_DIR"
npm install -g pnpm
pnpm install
pnpm build

# Copy env if not exists
[ -f .env ] || cp deploy/hairy-agent.env.example .env

# Install systemd service
mkdir -p ~/.config/systemd/user
cp deploy/hairy-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable hairy-agent
echo "Run: systemctl --user start hairy-agent"
```

**`deploy/migrate-openclaw.sh`**:
Script that reads `~/.openclaw/openclaw.json` and generates:
1. A `config/production.toml` with provider settings, model fallback chain, channel config.
2. A `.env` file with secrets (API keys, bot tokens).
3. Copies skill definitions from `~/.openclaw/skills/` to `data/skills/` in Hairy format.

**Tests**: Shell script linting only (`shellcheck`). No runtime tests.

---

## Phase 6 — Built-in Plugins (Guardrails & Observability)

### TASK-17: Cost Guard Plugin
**Package**: `packages/core/`
**New files**: `src/plugins/cost-guard.ts`, `test/plugins/cost-guard.test.ts`

A plugin that tracks LLM spend and blocks requests when budget is exceeded.

```typescript
interface CostGuardOptions {
  dailyBudgetUsd: number;
  alertThresholdPct: number;  // e.g. 80 → alert at 80% of budget
  onAlert?: (currentSpend: number, budget: number) => void;
  onBlock?: (currentSpend: number, budget: number) => void;
}

function createCostGuardPlugin(opts: CostGuardOptions): HairyPlugin;
```

- Uses `onRunEnd` to accumulate cost from `RunResult.usage.cost.total`.
- Uses `beforeModel` to check if daily spend exceeds budget. If so, return null (blocks the LLM call) and call `onBlock`.
- At `alertThresholdPct`, calls `onAlert`.
- Resets daily spend at midnight UTC.

**Tests** (at least 6):
- Under budget → passthrough
- At alert threshold → `onAlert` called, still passes through
- Over budget → `onBlock` called, `beforeModel` returns null
- Daily reset clears spend
- Cost accumulated across multiple runs
- Zero budget blocks everything

---

### TASK-18: Trace Logger Plugin
**Package**: `packages/core/`
**New files**: `src/plugins/trace-logger.ts`, `test/plugins/trace-logger.test.ts`

A plugin that creates structured trace logs for every LLM call and tool execution, written to JSONL files per day.

```typescript
interface TraceLoggerOptions {
  logDir: string;           // e.g. "data/traces"
  /** Log full request/response content (can be large). Default: false */
  includeContent?: boolean;
}

function createTraceLoggerPlugin(opts: TraceLoggerOptions): HairyPlugin;
```

Hooks:
- `onRunStart` — log `{ type: "run_start", traceId, channelType, channelId, timestamp }`
- `beforeModel` — log `{ type: "model_request", traceId, messageCount, model, timestamp }`
- `afterModel` — log `{ type: "model_response", traceId, responseLength, toolCallCount, timestamp }`
- `beforeTool` — log `{ type: "tool_start", traceId, toolName, timestamp }`
- `afterTool` — log `{ type: "tool_end", traceId, toolName, isError, resultLength, timestamp }`
- `onRunEnd` — log `{ type: "run_end", traceId, durationMs, success, timestamp }`

Output: `{logDir}/traces-YYYY-MM-DD.jsonl`

**Tests** (at least 5):
- Run produces trace entries in correct order
- Log file is created with correct date
- Each entry has traceId and timestamp
- `includeContent: true` includes request/response text
- `includeContent: false` (default) omits content

---

### TASK-19: Content Safety Plugin (Output Guardrail)
**Package**: `packages/core/`
**New files**: `src/plugins/content-safety.ts`, `test/plugins/content-safety.test.ts`

A lightweight output guardrail that catches common agent safety issues.

```typescript
interface ContentSafetyOptions {
  /** Block responses containing these regex patterns */
  blockedPatterns?: RegExp[];
  /** Block responses that appear to leak these env var names */
  protectEnvVars?: string[];
  /** Max response length before truncation warning */
  maxResponseLength?: number;
  /** Custom check function */
  customCheck?: (text: string) => { safe: boolean; reason?: string };
}

function createContentSafetyPlugin(opts: ContentSafetyOptions): HairyPlugin;
```

Default behaviors:
- `afterModel` hook checks response text against blocked patterns.
- Scans for accidental secret leaks (API key patterns: `sk-`, `Bearer `, env var values).
- Truncates excessively long responses with `[truncated — full response available via /expand]`.
- If unsafe, replaces response with `"I've filtered my response for safety. Let me try again differently."` and returns null to trigger retry.

**Tests** (at least 8):
- Clean response passes through
- Response with blocked pattern is filtered
- API key pattern detected and blocked
- Env var value detected and blocked
- Long response truncated
- Custom check function called
- Custom check blocks response
- Retry triggered on unsafe content

---

## Execution Summary

| Phase | Tasks | Parallel? | New Files | Modified Files | Est. Tests |
|-------|-------|-----------|-----------|----------------|------------|
| **P0** | TASK-01, 02, 03 | Yes (01∥03, then 02) | 3 src + 3 test | 5 | ~37 |
| **P1** | TASK-04, 05 | Sequential (04 then 05) | 2 src + 2 test | 5 | ~23 |
| **P2** | TASK-06, 07, 08 | Yes (06∥07, then 08) | 3 src + 3 test | 2 | ~19 |
| **P3** | TASK-09, 10 | Yes | 2 src + 2 test | 1 | ~20 |
| **P4** | TASK-11, 12, 13 | Yes (11∥12, then 13) | 3 src + 3 test | 4 | ~21 |
| **P5** | TASK-14, 15, 16 | Yes | 5 src + 2 test + 4 deploy | 2 | ~10 |
| **P6** | TASK-17, 18, 19 | Yes | 6 src + 3 test | 0 | ~19 |
| **Total** | **19 tasks** | | **24 src + 18 test + 4 deploy** | **19** | **~149** |

### Dependency Graph
```
TASK-01 ──┐
TASK-03 ──┤── TASK-02 ──┐
          │              ├── TASK-05 ──── TASK-08 ──── TASK-13
TASK-04 ──┘              │              ╱           ╱
                         │    TASK-06 ─╱           ╱
                         │    TASK-07 ╱           ╱
                         │                       ╱
                         │    TASK-11 ──────────╱
                         │    TASK-12 ─────────╱
                         │
TASK-09 (independent)    │
TASK-10 (independent)    │
TASK-14 (independent)    │
TASK-15 (independent)    │
TASK-16 (independent)    │
TASK-17 (needs TASK-04)  │
TASK-18 (needs TASK-04)  │
TASK-19 (needs TASK-04)  │
```

### Parallel Execution Waves (for Codex)

**Wave 1** (zero file overlap):
- TASK-01: Auth Profile Manager (`packages/providers/src/auth-profiles.ts`)
- TASK-03: Request Timeout in all providers (`src/ollama.ts`, `src/anthropic.ts`, `src/gemini.ts`, `src/openrouter.ts`)
- TASK-04: Plugin Interface (`packages/core/src/plugin.ts`)
- TASK-06: Delivery Queue (`packages/channels/src/delivery-queue.ts`)
- TASK-09: Workflow Primitives (`packages/core/src/workflows.ts`)
- TASK-11: Command Router (`packages/core/src/commands.ts`)
- TASK-14: Telegram Media (`packages/channels/src/telegram.ts` — separate section from TASK-07)

**Wave 2** (depends on Wave 1):
- TASK-02: Per-Model Fallback in Gateway (needs TASK-01, TASK-03)
- TASK-07: Telegram Streaming (needs TASK-06 for failure handling)
- TASK-10: SubAgent Tool (needs TASK-09 concepts)
- TASK-12: Memory Preload Plugin (needs TASK-04)
- TASK-17: Cost Guard Plugin (needs TASK-04)
- TASK-18: Trace Logger Plugin (needs TASK-04)
- TASK-19: Content Safety Plugin (needs TASK-04)

**Wave 3** (integration):
- TASK-05: Wire Plugins into Agent Loop (needs TASK-04)
- TASK-08: Wire Delivery + Streaming (needs TASK-06, TASK-07)
- TASK-13: Wire Commands, Memory, Auth into main.ts (needs TASK-02, TASK-05, TASK-11, TASK-12)
- TASK-15: Browser Sidecar (independent but lower priority)
- TASK-16: Deployment scripts (independent, needs final config shape from TASK-13)
