import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChannelAdapter,
  DeliveryQueue,
  createCliAdapter,
  createOnboardingManager,
  createTelegramAdapter,
  createWebhookAdapter,
  createWhatsAppAdapter,
} from "@hairyclaw/channels";
import {
  type AgentLoopContent,
  type AgentLoopMessage,
  type AgentLoopStreamOptions,
  type AgentLoopToolDef,
  CHILD_MAX_ITERATIONS,
  type CircuitStateSummary,
  CommandRouter,
  type HairyClawPlugin,
  MAX_PROVIDER_RETRIES_PER_ATTEMPT,
  type ModelCatalogEntrySummary,
  type ModelCommandResult,
  type ModelRole,
  type ModelStatusSnapshot,
  Orchestrator,
  PRIMARY_MAX_ITERATIONS,
  PluginRunner,
  type RoleModelStatusSnapshot,
  type ScheduledTask,
  Scheduler,
  TaskQueue,
  runAgentLoop,
} from "@hairyclaw/core";
import {
  EvalHarness,
  InitiativeEngine,
  type InitiativeRule,
  PromptVersionManager,
  SkillRegistry,
} from "@hairyclaw/growth";
import {
  type ConversationEntry,
  ConversationMemory,
  EpisodicMemory,
  type MemoryEvent,
  ReflectionEngine,
  SemanticMemory,
  createMemoryBackend,
  createMemoryPreloadPlugin,
} from "@hairyclaw/memory";
import {
  DiagnosticsRecorder,
  type HairyClawLogger,
  Metrics,
  createLogger,
} from "@hairyclaw/observability";
import {
  AuthProfileManager,
  DEFAULT_MODEL_CATALOG,
  ModelCatalog,
  ModelSelectionStore,
  type Provider,
  ProviderGateway,
  RoleModelSelectionStore,
  createGeminiProvider,
  createOllamaProvider,
  createOpenRouterProvider,
  createSuperGrokProvider,
  reconcileCatalogWithProviders,
  resolveModelChain,
} from "@hairyclaw/providers";
import {
  ApprovalGate,
  DEFAULT_APPROVAL_POLICY,
  SidecarManager,
  type Tool,
  ToolRegistry,
  buildChildProfile,
  checkReminders,
  createBashTool,
  createBrowserTool,
  createChainTool,
  createEditTool,
  createIdentityEvolveTool,
  createMemoryIngestTool,
  createMemoryRecallTool,
  createPdfExtractTool,
  createReadTool,
  createReminderTool,
  createSshExecTool,
  createSubAgentTool,
  createVideoDownloadTool,
  createVideoExtractTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  failClosedApprovalHandler,
  primaryOperatorProfile,
  setReminderCallback,
  toolParametersToJsonSchema,
} from "@hairyclaw/tools";
import { z } from "zod";
import { loadHairyClawConfig } from "./config.js";
import { AgentDatabase } from "./database.js";
import { HealthServer } from "./health.js";
import { buildSystemPrompt } from "./identity.js";

const logger = createLogger("hairyclaw");

type ProviderName = "supergrok" | "openrouter" | "gemini" | "ollama";

export const buildProviders = (
  config: Awaited<ReturnType<typeof loadHairyClawConfig>>,
): Provider[] => {
  const providers: Provider[] = [];

  if (config.providers.supergrok.enabled && config.providers.supergrok.authFile) {
    providers.push(
      createSuperGrokProvider({
        authFile: config.providers.supergrok.authFile,
        baseUrl: config.providers.supergrok.baseUrl,
      }),
    );
  }

  if (config.providers.openrouter.enabled && config.providers.openrouter.apiKey) {
    providers.push(createOpenRouterProvider({ apiKey: config.providers.openrouter.apiKey }));
  }

  if (config.providers.gemini.enabled && config.providers.gemini.apiKey) {
    providers.push(createGeminiProvider({ apiKey: config.providers.gemini.apiKey }));
  }

  if (config.providers.ollama.enabled) {
    providers.push(
      createOllamaProvider({
        baseUrl: config.providers.ollama.baseUrl,
        contextWindow: config.providers.ollama.contextWindow,
      }),
    );
  }

  return providers;
};

export const defaultModelForProvider = (
  config: Awaited<ReturnType<typeof loadHairyClawConfig>>,
  provider: string,
): string => {
  const name = provider as ProviderName;
  if (name === "supergrok") return config.providers.supergrok.defaultModel;
  if (name === "openrouter") return config.providers.openrouter.defaultModel;
  if (name === "gemini") return config.providers.gemini.defaultModel;
  return config.providers.ollama.defaultModel;
};

export const resolveRouting = (
  config: Awaited<ReturnType<typeof loadHairyClawConfig>>,
  providerNames: string[],
): {
  defaultProvider: string;
  fallbackChain: string[];
  modelFallbackChain: Array<{ provider: string; model: string }>;
} => {
  const available = new Set(providerNames);
  const defaultProvider = available.has(config.routing.defaultProvider)
    ? config.routing.defaultProvider
    : (providerNames[0] ?? "ollama");

  const fallbackChain: string[] = [];
  for (const candidate of [defaultProvider, ...config.routing.fallbackChain, ...providerNames]) {
    if (!available.has(candidate)) continue;
    if (!fallbackChain.includes(candidate)) {
      fallbackChain.push(candidate);
    }
  }

  const modelFallbackChain = config.routing.modelFallbackChain
    .map((entry) => {
      const separator = entry.indexOf("/");
      if (separator <= 0) {
        return null;
      }

      const provider = entry.slice(0, separator).trim();
      const model = entry.slice(separator + 1).trim();
      if (!provider || !model || !available.has(provider)) {
        return null;
      }

      return { provider, model };
    })
    .filter((entry): entry is { provider: string; model: string } => entry !== null);

  return { defaultProvider, fallbackChain, modelFallbackChain };
};

/**
 * Build the operator authorization check used by mutating commands
 * (/model use|fallback|test|rollback, /update, /clear, /approve).
 *
 * Fail-closed by construction:
 *  - The "webhook" channel is never authorized, regardless of allowlist
 *    contents — a webhook sender id is caller-supplied JSON, not an
 *    identity the shared secret authenticates, so it can never stand in for
 *    a real operator identity.
 *  - All other channels are checked against a channel-scoped identifier
 *    ("<channelType>:<senderId>"), never a bare sender id — this is what
 *    prevents a sender id valid on one channel from being replayed/matched
 *    on a different channel.
 *  - An empty allowlist denies everyone.
 */
export const buildOperatorAuthorizer = (
  operatorAllowlist: string[],
): ((channelType: string, senderId: string) => boolean) => {
  const allowlist = new Set(operatorAllowlist);
  return (channelType: string, senderId: string): boolean => {
    if (channelType === "webhook") {
      return false;
    }
    if (allowlist.size === 0) {
      return false;
    }
    return allowlist.has(`${channelType}:${senderId}`);
  };
};

/**
 * Resolve the safe-default model id used when the durably-selected primary
 * is unknown/unavailable. Never hard-pins a model id that may not exist for
 * this deployment: prefers the currently configured Ollama model when Ollama
 * is enabled and constructed, otherwise the first constructed provider's own
 * configured default model. Throws an actionable error if no provisioned
 * provider has an available catalog entry — there is no implicit fallback to
 * an unavailable id.
 */
export const resolveSafeDefaultModelId = (opts: {
  catalog: ModelCatalog;
  ollamaEnabled: boolean;
  ollamaDefaultModel: string;
  /** Constructed providers in preference order (main.ts: the `providers` array). */
  constructedProviderOrder: string[];
  /** provider name -> that provider's currently configured default model */
  providerDefaultModels: Map<string, string>;
}): string => {
  const constructed = new Set(opts.constructedProviderOrder);

  if (opts.ollamaEnabled && constructed.has("ollama")) {
    const id = `ollama/${opts.ollamaDefaultModel}`;
    if (opts.catalog.isSelectable(id)) {
      return id;
    }
  }

  for (const provider of opts.constructedProviderOrder) {
    const model = opts.providerDefaultModels.get(provider);
    if (!model) continue;
    const id = `${provider}/${model}`;
    if (opts.catalog.isSelectable(id)) {
      return id;
    }
  }

  throw new Error(
    "No model is available: no constructed provider has a provisioned, catalog-available model. " +
      "Enable and configure at least one provider (SuperGrok, Ollama, OpenRouter, or Gemini) with valid credentials.",
  );
};

/** Convert a Tool (Zod schema) → AgentLoopToolDef (JSON schema) for the LLM. */
const toolToDefinition = (tool: Tool): AgentLoopToolDef => ({
  name: tool.name,
  description: tool.description,
  parameters: toolParametersToJsonSchema(tool.parameters, tool.name),
});

const initiativeRuleSchema = z.array(
  z.object({
    id: z.string().min(1),
    trigger: z.enum(["schedule", "event", "anomaly", "silence"]),
    condition: z.string().min(1),
    action: z.string().min(1),
    confidence_threshold: z.number().min(0).max(1),
    risk_level: z.enum(["low", "medium", "high"]),
    requires_approval: z.boolean(),
    cooldown_ms: z.number().int().nonnegative(),
  }),
);

const loadInitiativeRules = async (path: string): Promise<InitiativeRule[]> => {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return initiativeRuleSchema.parse(parsed);
  } catch {
    return [];
  }
};

const parseCsvEnv = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

/** Parse a non-empty model spec. Bare model names use defaultProvider. */
export const parseModelSpec = (
  spec: string,
  defaultProvider: string,
): { provider: string; model: string } => {
  const normalized = spec.trim();
  if (!normalized) {
    throw new Error('model spec must be non-empty (expected "provider/model" or "model")');
  }
  const slashIdx = normalized.indexOf("/");
  if (slashIdx < 0) {
    return { provider: defaultProvider, model: normalized };
  }
  const provider = normalized.slice(0, slashIdx).trim();
  const model = normalized.slice(slashIdx + 1).trim();
  if (!provider || !model) {
    throw new Error(`invalid model spec "${spec}" (expected "provider/model")`);
  }
  return { provider, model };
};

/** Build a structured executor system prompt that small/local models can follow reliably. */
const buildExecutorSystemPrompt = (toolDefs: AgentLoopToolDef[], context?: string): string => {
  const toolList = toolDefs.map((t) => `  - ${t.name}: ${t.description}`).join("\n");

  const sections = [
    "# ROLE",
    "You are an executor agent. You receive one instruction and execute it using your tools.",
    "",
    "# RULES",
    "1. Follow the instruction EXACTLY. Do not improvise or add extra steps.",
    "2. Use the MINIMUM number of tool calls needed. One tool call per step.",
    "3. NEVER ask questions. If something is unclear, make a reasonable assumption and proceed.",
    "4. After completing the work, respond with a SHORT summary of what you did and the results.",
    "5. If a tool call fails, try ONE alternative approach. If that also fails, report the error.",
    "6. Do NOT explain your reasoning. Just do the work and report results.",
    "",
    "# YOUR TOOLS",
    toolList,
    "",
    "# OUTPUT FORMAT",
    "When done, respond with:",
    "- RESULT: [what you found/did]",
    "- FILES: [any files created or modified, if applicable]",
    "- ERROR: [any errors encountered, if applicable]",
  ];

  if (context) {
    sections.push("", "# CONTEXT", context);
  }

  return sections.join("\n");
};

/** Create a "delegate" tool that spawns an executor (hands) agent loop with a different model. */
const createDelegateTool = (deps: {
  /**
   * Resolved at invocation time (not tool-construction time) so that a
   * "/model hands use ..." switch takes effect on the very next delegate
   * call without rebuilding this tool. Mirrors spawn_agent/run_chain's
   * pattern for the brain role.
   */
  getHandsGateway: () => ProviderGateway;
  getHandsModel: () => string;
  executorTools: Tool[];
  executorToolDefs: AgentLoopToolDef[];
  executorTemperature: number;
  executorMaxTokens: number;
  executorMaxIterations: number;
  executorSystemPromptOverride: string;
  registry: ToolRegistry;
  logger: HairyClawLogger;
  dataDir: string;
  maxDurationMs: number;
}): Tool => ({
  name: "delegate",
  description: [
    "Delegate a task to the executor agent who has system tools (bash, read, write, edit, web-search).",
    "",
    "IMPORTANT — write your instruction as a SPECIFIC, STEP-BY-STEP command:",
    "  GOOD: 'Read the file at /path/to/file.ts and tell me the name of the exported function on line 15'",
    "  GOOD: 'Run `ls -la /tmp` and report the output'",
    "  GOOD: 'Create a file at /tmp/hello.txt with the content: Hello World'",
    "  BAD:  'Look into the project and see what you find'",
    "  BAD:  'Help me understand the codebase'",
    "",
    "The executor is a FAST, LITERAL tool-runner — not a thinker. Give it exact commands.",
  ].join("\n"),
  parameters: z.object({
    instruction: z
      .string()
      .min(1)
      .describe(
        "Step-by-step instruction for the executor. Be specific: name exact files, commands, paths, and expected output format.",
      ),
    context: z
      .string()
      .optional()
      .describe("Background info the executor needs (file contents, variable values, etc.)"),
  }),
  // Keep the registry deadline beyond the agent loop's own bounded deadline
  // plus one maximum in-flight provider/tool operation. This prevents the
  // registry from returning a timeout while the executor continues unseen.
  timeout_ms: deps.maxDurationMs + 130_000,
  async execute(args, ctx) {
    const input = z
      .object({
        instruction: z.string().min(1),
        context: z.string().optional(),
      })
      .parse(args);

    const systemPrompt = deps.executorSystemPromptOverride
      ? deps.executorSystemPromptOverride
      : buildExecutorSystemPrompt(deps.executorToolDefs, input.context);

    const loopMessages: AgentLoopMessage[] = [
      { role: "user", content: [{ type: "text", text: input.instruction }] },
    ];

    const handsModel = deps.getHandsModel();

    try {
      const result = await runAgentLoop(loopMessages, {
        provider: {
          stream: (msgs, streamOpts) =>
            deps.getHandsGateway().stream(msgs, {
              ...streamOpts,
              model: handsModel,
            }),
        },
        executor: async (name, toolArgs, _callId) => {
          const execution = await deps.registry.execute(name, toolArgs, {
            traceId: ctx.traceId,
            cwd: process.cwd(),
            dataDir: deps.dataDir,
            logger: deps.logger,
            channelId: ctx.channelId,
            // Defense-in-depth: the executor arm can only call tools it was
            // explicitly configured with (config.executor.tools), enforced
            // here even if a future bug widens deps.executorTools upstream.
            allowedTools: deps.executorTools.map((tool) => tool.name),
          });
          return {
            content: execution.content,
            isError: execution.isError ?? false,
            isValidationError: execution.isValidationError,
          };
        },
        streamOpts: {
          model: handsModel,
          systemPrompt,
          tools: deps.executorToolDefs,
          temperature: deps.executorTemperature,
          maxTokens: deps.executorMaxTokens,
        },
        logger: deps.logger,
        maxIterations: deps.executorMaxIterations,
        maxDurationMs: deps.maxDurationMs,
      });

      return {
        content: result.text || "Executor completed but produced no output.",
        metadata: {
          iterations: result.iterations,
          toolCalls: result.toolCalls.length,
          usage: result.totalUsage,
        },
      };
    } catch (error: unknown) {
      return {
        content: `Executor failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
});

const MAINTENANCE_PREFIX = "__maintenance__:";

interface MaintenanceDeps {
  conversation: ConversationMemory;
  semantic: SemanticMemory;
  dataDir: string;
  logger: HairyClawLogger;
  agentName: string;
  hiveUrl?: string;
  hiveApiKey?: string;
  hiveNamespace?: string;
}

const maintenanceLogPath = (dataDir: string): string =>
  join(dataDir, "memory", "maintenance-log.md");

const appendMaintenanceLog = async (
  dataDir: string,
  title: string,
  body: string,
): Promise<void> => {
  const memoryDir = join(dataDir, "memory");
  const filePath = maintenanceLogPath(dataDir);
  await mkdir(memoryDir, { recursive: true });

  let existing = "# Maintenance Log\n";
  try {
    existing = await readFile(filePath, "utf8");
  } catch {
    // start new log
  }

  const entry = [`## ${new Date().toISOString()} — ${title}`, body.trim()].join("\n\n");
  const next = `${existing.trimEnd()}\n\n${entry}\n`;
  await writeFile(filePath, next, "utf8");
};

const extractEntryText = (entry: ConversationEntry): string => {
  if ("content" in entry) {
    return entry.content.text ?? "";
  }
  return entry.text ?? "";
};

const keywordSummary = (text: string, topN: number): string[] => {
  const stopWords = new Set([
    "the",
    "and",
    "that",
    "with",
    "this",
    "from",
    "have",
    "your",
    "just",
    "what",
    "when",
    "where",
    "about",
    "would",
    "there",
    "which",
    "they",
    "them",
    "were",
    "been",
    "into",
    "also",
    "will",
    "could",
    "should",
    "hairyclaw",
    "assistant",
  ]);

  const counts = new Map<string, number>();
  for (const token of text
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)) {
    if (token.length < 4 || stopWords.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([token]) => token);
};

const summarizeConversationWindow = (history: ConversationEntry[]): string => {
  const recent = history.slice(-80);
  const userLines = recent
    .filter((entry) => "content" in entry)
    .map((entry) => extractEntryText(entry))
    .filter((line) => line.length > 0)
    .slice(-8);

  const assistantLines = recent
    .filter((entry) => !("content" in entry))
    .map((entry) => extractEntryText(entry))
    .filter((line) => line.length > 0)
    .slice(-8);

  const keywordText = recent.map((entry) => extractEntryText(entry)).join("\n");
  const keywords = keywordSummary(keywordText, 8);

  const lines = [
    `Compacted ${history.length} conversation entries into a rolling summary.`,
    keywords.length > 0
      ? `Top recurring themes: ${keywords.join(", ")}.`
      : "Top themes unavailable.",
  ];

  if (userLines.length > 0) {
    lines.push("Recent user intents:");
    lines.push(...userLines.slice(-5).map((line) => `- ${line.slice(0, 220)}`));
  }

  if (assistantLines.length > 0) {
    lines.push("Recent assistant focus:");
    lines.push(...assistantLines.slice(-5).map((line) => `- ${line.slice(0, 220)}`));
  }

  return lines.join("\n");
};

const parseMemoryEventLine = (line: string): MemoryEvent | null => {
  try {
    return JSON.parse(line) as MemoryEvent;
  } catch {
    return null;
  }
};

const loadRecentEpisodicEvents = async (dataDir: string, days = 7): Promise<MemoryEvent[]> => {
  const episodicDir = join(dataDir, "episodic");

  let files: string[] = [];
  try {
    files = await readdir(episodicDir);
  } catch {
    return [];
  }

  const jsonlFiles = files
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .slice(-days);

  const events: MemoryEvent[] = [];
  for (const file of jsonlFiles) {
    try {
      const raw = await readFile(join(episodicDir, file), "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        const parsed = parseMemoryEventLine(line);
        if (parsed) events.push(parsed);
      }
    } catch {
      // ignore unreadable file
    }
  }

  return events;
};

const runMaintenanceCommand = async (command: string, deps: MaintenanceDeps): Promise<void> => {
  if (command === "compact") {
    const history = await deps.conversation.getHistory(200);
    if (history.length < 40) {
      deps.logger.info(
        { entries: history.length },
        "maintenance compact skipped: insufficient history",
      );
      return;
    }

    const summary = summarizeConversationWindow(history);
    await deps.conversation.compact(summary);
    await deps.semantic.store(summary, ["maintenance", "compaction", "conversation"]);
    await appendMaintenanceLog(deps.dataDir, "Conversation compaction", summary);

    deps.logger.info({ entriesBefore: history.length }, "maintenance compact completed");
    return;
  }

  if (command === "debug_postmortem") {
    const events = await loadRecentEpisodicEvents(deps.dataDir, 7);
    const messageEvents = events.filter((event) => event.type === "message");

    const durations = messageEvents
      .map((event) => event.payload.durationMs)
      .filter((value): value is number => typeof value === "number");
    const avgDuration =
      durations.length > 0
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : 0;

    const lowEvalCount = messageEvents.filter((event) => {
      const score = event.payload.evalScore;
      return typeof score === "number" && score < 0.7;
    }).length;

    const highToolCount = messageEvents.filter((event) => {
      const toolCalls = event.payload.toolCalls;
      return typeof toolCalls === "number" && toolCalls >= 4;
    }).length;

    const longRunCount = durations.filter((duration) => duration >= 20000).length;

    const postmortem = [
      "Weekly debug postmortem summary:",
      `- Events analyzed (7d): ${events.length}`,
      `- Message runs analyzed: ${messageEvents.length}`,
      `- Average run duration: ${avgDuration} ms`,
      `- Low eval runs (<0.7): ${lowEvalCount}`,
      `- High tool-call runs (>=4): ${highToolCount}`,
      `- Slow runs (>=20s): ${longRunCount}`,
      "- Recommendation: monitor high tool-call and slow-run clusters for prompt/tool routing refinements.",
    ].join("\n");

    await deps.semantic.store(postmortem, ["maintenance", "debug", "postmortem"]);
    await appendMaintenanceLog(deps.dataDir, "Weekly debug postmortem", postmortem);

    deps.logger.info(
      { eventCount: events.length, messageRuns: messageEvents.length },
      "maintenance debug postmortem completed",
    );
    return;
  }

  if (command === "hive_compact") {
    if (!deps.hiveUrl || !deps.hiveApiKey || !deps.hiveNamespace) {
      deps.logger.warn("maintenance hive_compact skipped: hive config incomplete");
      return;
    }

    const response = await fetch(`${deps.hiveUrl.replace(/\/$/, "")}/summarize_clear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": deps.hiveApiKey,
      },
      body: JSON.stringify({
        namespace: deps.hiveNamespace,
        session_id: `${deps.agentName.toLowerCase().replace(/\s+/g, "-")}-maintenance`,
        max_events: 500,
      }),
    });

    if (!response.ok) {
      deps.logger.warn({ status: response.status }, "maintenance hive_compact failed");
      return;
    }

    const payload = (await response.json()) as {
      archived_events?: number;
      summary_knowledge_item_id?: string;
    };

    const note = `Hive summarize_clear completed for namespace ${deps.hiveNamespace}. Archived events: ${payload.archived_events ?? 0}. Summary ID: ${payload.summary_knowledge_item_id ?? "n/a"}.`;
    await appendMaintenanceLog(deps.dataDir, "Hive summarize_clear", note);
    deps.logger.info(
      { archivedEvents: payload.archived_events ?? 0 },
      "maintenance hive_compact completed",
    );
    return;
  }

  deps.logger.warn({ command }, "unknown maintenance command");
};

/**
 * Bounded, redacted transcription outcome. Never carries raw provider error
 * bodies, file paths, or transcript content beyond what the caller already
 * has — /debug and logs should be able to report the `stage` alone without
 * leaking message content or credentials.
 */
export type TranscriptionOutcome =
  | { stage: "ok"; provider: string; text: string }
  | { stage: "no_provider" }
  | { stage: "read_error" }
  | { stage: "http_error"; provider: string; status: number }
  | { stage: "exception"; provider: string }
  | { stage: "empty_transcript"; provider: string };

const transcribeAudioFile = async (
  filePath: string,
  mimeType: string,
): Promise<TranscriptionOutcome> => {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.VOICE_TOOLS_OPENAI_KEY;
  const fallbackUrl = process.env.WHISPER_FALLBACK_URL;
  if (!groqKey && !openaiKey && !fallbackUrl) return { stage: "no_provider" };

  const fileBuffer = await readFile(filePath).catch(() => null);
  if (!fileBuffer) return { stage: "read_error" };

  // OpenAI-compatible /audio/transcriptions call. Each provider gets its own
  // FormData (Blob can be consumed only once across separate fetch calls).
  const tryProvider = async (
    provider: string,
    url: string,
    model: string,
    auth?: string,
  ): Promise<TranscriptionOutcome> => {
    try {
      const form = new FormData();
      form.append("file", new Blob([fileBuffer], { type: mimeType }), basename(filePath));
      form.append("model", model);
      const res = await fetch(url, {
        method: "POST",
        headers: auth ? { Authorization: `Bearer ${auth}` } : {},
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return { stage: "http_error", provider, status: res.status };
      const data = (await res.json()) as { text?: string };
      const text = data.text?.trim();
      if (!text) return { stage: "empty_transcript", provider };
      return { stage: "ok", provider, text };
    } catch {
      return { stage: "exception", provider };
    }
  };

  const attempts: TranscriptionOutcome[] = [];

  if (groqKey) {
    const groqBaseUrl = process.env.GROQ_API_BASE_URL ?? "https://api.groq.com";
    const outcome = await tryProvider(
      "groq",
      `${groqBaseUrl.replace(/\/$/, "")}/openai/v1/audio/transcriptions`,
      "whisper-large-v3-turbo",
      groqKey,
    );
    if (outcome.stage === "ok") return outcome;
    attempts.push(outcome);
  }

  if (openaiKey) {
    const outcome = await tryProvider(
      "openai",
      "https://api.openai.com/v1/audio/transcriptions",
      "whisper-1",
      openaiKey,
    );
    if (outcome.stage === "ok") return outcome;
    attempts.push(outcome);
  }

  if (fallbackUrl) {
    const fallbackModel = process.env.WHISPER_FALLBACK_MODEL ?? "Systran/faster-whisper-large-v3";
    const fallbackKey = process.env.WHISPER_FALLBACK_KEY;
    const outcome = await tryProvider(
      "fallback",
      `${fallbackUrl.replace(/\/$/, "")}/v1/audio/transcriptions`,
      fallbackModel,
      fallbackKey,
    );
    if (outcome.stage === "ok") return outcome;
    attempts.push(outcome);
  }

  // Report the last attempted provider's failure stage (most specific available).
  return attempts[attempts.length - 1] ?? { stage: "no_provider" };
};

const main = async (): Promise<void> => {
  const config = await loadHairyClawConfig();
  const workspaceCwd = process.env.HAIRYCLAW_WORKSPACE_DIR ?? process.cwd();
  const metrics = new Metrics();

  if (config.providers.supergrok.enabled && !config.providers.supergrok.authFile) {
    logger.warn("SuperGrok enabled but no OAuth credential file is configured; provider disabled");
  }
  if (config.providers.openrouter.enabled && !config.providers.openrouter.apiKey) {
    logger.warn("OpenRouter enabled but OPENROUTER_API_KEY is missing; provider disabled");
  }
  if (config.providers.gemini.enabled && !config.providers.gemini.apiKey) {
    logger.warn("Gemini enabled but GEMINI_API_KEY is missing; provider disabled");
  }

  let initiative: InitiativeEngine | null = null;
  let runMaintenanceForTask: ((task: ScheduledTask) => Promise<boolean>) | null = null;

  // ── Data stores ─────────────────────────────────────────────────────────
  const queue = new TaskQueue(join(config.dataDir, "tasks", "queue.json"));
  const scheduler = new Scheduler({
    dataPath: join(config.dataDir, "tasks", "tasks.json"),
    onTaskDue: async (task: ScheduledTask) => {
      metrics.increment("scheduled_tasks_due");
      logger.info({ taskId: task.id, prompt: task.prompt }, "scheduled task due");

      if (runMaintenanceForTask && (await runMaintenanceForTask(task))) {
        return;
      }

      if (initiative?.handleDueTask(task)) {
        return;
      }
    },
  });
  await scheduler.load();

  // ── Database ─────────────────────────────────────────────────────────────
  const agentDb = new AgentDatabase(config.dataDir);

  // ── Memory ───────────────────────────────────────────────────────────────
  const conversation = new ConversationMemory({
    filePath: join(config.dataDir, "context.jsonl"),
  });
  const memoryBackend = createMemoryBackend({
    filePath: join(config.dataDir, "memory", "semantic.json"),
  });
  logger.info({ backend: memoryBackend.name }, "memory backend selected");

  const semantic = new SemanticMemory({
    filePath: join(config.dataDir, "memory", "semantic.json"),
    backend: memoryBackend,
  });
  const episodic = new EpisodicMemory({ dataDir: config.dataDir });
  const reflection = new ReflectionEngine(semantic);

  runMaintenanceForTask = async (task: ScheduledTask): Promise<boolean> => {
    const prompt = task.prompt.trim();
    if (!prompt.startsWith(MAINTENANCE_PREFIX)) {
      return false;
    }

    const command = prompt.slice(MAINTENANCE_PREFIX.length).trim().toLowerCase();

    try {
      await runMaintenanceCommand(command, {
        conversation,
        semantic,
        dataDir: config.dataDir,
        logger,
        agentName: config.agentName,
        hiveUrl: process.env.HARI_HIVE_URL,
        hiveApiKey: process.env.HARI_HIVE_WRITE_API_KEY ?? process.env.HARI_HIVE_API_KEY,
        hiveNamespace: process.env.HARI_HIVE_WRITE_NAMESPACE ?? process.env.HARI_HIVE_NAMESPACE,
      });
    } catch (error: unknown) {
      logger.error({ err: error, command }, "maintenance command failed");
    }

    return true;
  };

  // ── Growth ───────────────────────────────────────────────────────────────
  const skills = new SkillRegistry({ dataDir: config.dataDir });
  const evalHarness = new EvalHarness();
  const promptVersions = new PromptVersionManager({
    filePath: join(config.dataDir, "memory", "prompt-versions.json"),
  });
  let lastPromptHash = "";

  // ── Diagnostics (bounded, redacted; feeds /debug and /health) ─────────────
  const diagnostics = new DiagnosticsRecorder();
  const recordDiagnostic = (
    category: string,
    stage: string,
    meta?: Record<string, string | number | boolean>,
  ): void => diagnostics.record(category, stage, meta);

  // ── Tools ────────────────────────────────────────────────────────────────
  // Full registry — all tools registered here, mode determines which the LLM sees.
  // ApprovalGate activated with a fail-closed handler: HairyClaw does not yet
  // have a real async /approve token exchange, so high-impact tool calls that
  // match DEFAULT_APPROVAL_POLICY (destructive bash, config/system writes,
  // network installs, etc.) are denied rather than faked as approved. See
  // packages/tools/src/approval.ts for the documented limitation.
  const registry = new ToolRegistry({
    logger,
    approvalGate: new ApprovalGate(DEFAULT_APPROVAL_POLICY, failClosedApprovalHandler, logger),
  });
  registry.register(
    createBashTool({
      allowShellOperators: true,
      blockedCommands: ["shutdown", "reboot", "mkfs", "dd"],
    }),
  );
  registry.register(createReadTool());
  registry.register(createWriteTool());
  registry.register(createEditTool());
  registry.register(createWebSearchTool());
  registry.register(createWebFetchTool());
  registry.register(createBrowserTool());
  registry.register(createReminderTool({ agentName: config.agentName }));
  registry.register(createPdfExtractTool());
  const sshAllowedHosts = process.env.SSH_ALLOWED_HOSTS
    ? process.env.SSH_ALLOWED_HOSTS.split(",")
        .map((h) => h.trim())
        .filter(Boolean)
    : [];
  registry.register(createSshExecTool({ allowedHosts: sshAllowedHosts }));
  registry.register(createVideoDownloadTool());
  registry.register(createVideoExtractTool());
  registry.register(createMemoryRecallTool(memoryBackend));
  registry.register(createMemoryIngestTool(memoryBackend));
  registry.register(createIdentityEvolveTool());

  // Tool defs are finalized after providers are set up (orchestrator mode needs buildGatewayForModel).
  // Placeholder — populated below after provider setup.
  let toolDefs: AgentLoopToolDef[] = [];
  let orchestratorModel = "";
  let orchestratorProvider = "";
  let executorModel = "";
  let executorProvider = "";
  // Role-aware (brain_hands / orchestrator mode) durable model selection.
  // null in unified mode — unified mode is unaffected and keeps using
  // modelSelectionStore/primaryGateway below exactly as before.
  let roleModelStore: RoleModelSelectionStore | null = null;
  let brainGateway: ProviderGateway | null = null;
  let handsGateway: ProviderGateway | null = null;

  // ── Providers ────────────────────────────────────────────────────────────
  const providers = buildProviders(config);
  if (providers.length === 0) {
    throw new Error("No providers available after config resolution.");
  }

  const routing = resolveRouting(
    config,
    providers.map((provider) => provider.name),
  );

  const providerDefaultModels = new Map<string, string>();
  for (const provider of providers) {
    providerDefaultModels.set(provider.name, defaultModelForProvider(config, provider.name));
  }

  // Parsed here (not just inside the orchestrator tool-wiring block below) so
  // the configured brain/hands model strings can be added to the catalog
  // before it's constructed — otherwise a deployment-specific model id would
  // never be selectable and role seeding would silently fall back to the
  // shared safe default.
  const isOrchestratorMode = config.agentMode === "orchestrator";
  const orchSpecForCatalog =
    isOrchestratorMode && config.orchestratorConfig.model.trim()
      ? parseModelSpec(config.orchestratorConfig.model, config.routing.defaultProvider)
      : null;
  const execSpecForCatalog =
    isOrchestratorMode && config.executorConfig.model.trim()
      ? parseModelSpec(config.executorConfig.model, config.routing.defaultProvider)
      : null;

  // ── Model catalog + durable selection ───────────────────────────────────
  // Availability is derived from the providers actually constructed above,
  // never from catalog text alone. Grok is selectable only when the exact
  // SuperGrok OAuth provider is configured and constructed.
  const constructedProviderNames = providers.map((provider) => provider.name);
  const extraCatalogEntries = [orchSpecForCatalog, execSpecForCatalog]
    .filter((spec): spec is { provider: string; model: string } => Boolean(spec?.model))
    .map((spec) => ({
      id: `${spec.provider}/${spec.model}`,
      provider: spec.provider,
      model: spec.model,
      label: `${spec.provider}/${spec.model} (configured brain_hands role default)`,
      available: true,
    }));
  const modelCatalog = new ModelCatalog(
    reconcileCatalogWithProviders({
      entries: [...DEFAULT_MODEL_CATALOG, ...extraCatalogEntries],
      constructedProviders: constructedProviderNames,
      providerDefaultModels,
    }),
  );
  // No hard-pinned safe default: prefer the configured Ollama model when
  // Ollama is enabled/constructed, otherwise the first constructed
  // provider's own configured default model. Throws (failing startup with an
  // actionable message) if no constructed provider has an available model.
  const SAFE_DEFAULT_MODEL_ID = resolveSafeDefaultModelId({
    catalog: modelCatalog,
    ollamaEnabled: config.providers.ollama.enabled,
    ollamaDefaultModel: config.providers.ollama.defaultModel,
    constructedProviderOrder: constructedProviderNames,
    providerDefaultModels,
  });
  const configuredFallbackIds = routing.modelFallbackChain
    .map((entry) => `${entry.provider}/${entry.model}`)
    .filter((id) => id !== SAFE_DEFAULT_MODEL_ID && modelCatalog.isSelectable(id));
  const modelSelectionStore = new ModelSelectionStore({
    filePath: join(config.dataDir, "providers", "model-selection.json"),
    defaultPrimaryId: SAFE_DEFAULT_MODEL_ID,
    defaultFallbackIds: configuredFallbackIds,
    logger,
  });
  await modelSelectionStore.load();

  const isOperator = buildOperatorAuthorizer(config.operatorAllowlist);

  const resolveActiveChain = () => {
    const current = modelSelectionStore.getCurrent();
    return resolveModelChain({
      catalog: modelCatalog,
      requestedPrimaryId: current.primaryId,
      fallbackIds: current.fallbackIds,
      safeDefaultId: SAFE_DEFAULT_MODEL_ID,
    });
  };

  /**
   * Role-aware equivalent of resolveActiveChain, only meaningful once
   * roleModelStore is constructed (isOrchestratorMode). Resolution never
   * crosses roles: brain's chain only ever contains brain's own configured
   * primary/fallbacks (and the shared safe default), never hands', and
   * vice versa.
   */
  const resolveActiveChainForRole = (role: ModelRole) => {
    if (!roleModelStore) {
      throw new Error("resolveActiveChainForRole called outside brain_hands/orchestrator mode");
    }
    const current = roleModelStore.getCurrent(role);
    return resolveModelChain({
      catalog: modelCatalog,
      requestedPrimaryId: current.primaryId,
      fallbackIds: current.fallbackIds,
      safeDefaultId: SAFE_DEFAULT_MODEL_ID,
    });
  };

  const authProfiles = new AuthProfileManager({
    filePath: join(config.dataDir, "providers", "auth-profiles.json"),
    baseCooldownMs: config.resilience.cooldownBaseMs,
    maxCooldownMs: config.resilience.cooldownMaxMs,
    cooldownThreshold: config.resilience.cooldownThreshold,
    logger,
  });
  await authProfiles.load();

  if (config.providers.openrouter.enabled && config.providers.openrouter.apiKey) {
    authProfiles.addProfile({
      id: "openrouter:env",
      provider: "openrouter",
      type: "api_key",
      credential: config.providers.openrouter.apiKey,
    });
  }

  if (config.providers.gemini.enabled && config.providers.gemini.apiKey) {
    authProfiles.addProfile({
      id: "gemini:env",
      provider: "gemini",
      type: "api_key",
      credential: config.providers.gemini.apiKey,
    });
  }

  if (config.providers.ollama.enabled) {
    authProfiles.addProfile({
      id: "ollama:local",
      provider: "ollama",
      type: "none",
      credential: "local",
    });
  }

  await authProfiles.save();

  const buildGatewayForModel = (provider: string, model: string): ProviderGateway => {
    const fallbackChain = [
      provider,
      ...routing.fallbackChain.filter((entry) => entry !== provider),
    ];

    const configuredModelFallback =
      routing.modelFallbackChain.length > 0
        ? [
            { provider, model, timeoutMs: config.resilience.requestTimeoutMs },
            ...routing.modelFallbackChain.filter(
              (entry) => !(entry.provider === provider && entry.model === model),
            ),
          ]
        : undefined;

    return new ProviderGateway({
      providers,
      routingConfig: {
        defaultProvider: provider,
        fallbackChain,
        ...(configuredModelFallback ? { modelFallbackChain: configuredModelFallback } : {}),
      },
      metrics,
      authProfiles,
      maxCredentialRefreshes: MAX_PROVIDER_RETRIES_PER_ATTEMPT,
    });
  };

  /**
   * Build a gateway from an explicit, already-ordered {provider, model} chain
   * (as produced by resolveModelChain from the catalog + durable selection
   * store). chain[0] is always attempt zero; entries are never re-paired
   * across providers.
   */
  const buildGatewayForChain = (
    chain: Array<{ provider: string; model: string }>,
  ): ProviderGateway => {
    const primary = chain[0];
    const fallbackChain = [
      primary.provider,
      ...routing.fallbackChain.filter((entry) => entry !== primary.provider),
    ];

    return new ProviderGateway({
      providers,
      routingConfig: {
        defaultProvider: primary.provider,
        fallbackChain,
        modelFallbackChain: chain.map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          timeoutMs: config.resilience.requestTimeoutMs,
        })),
      },
      metrics,
      authProfiles,
      maxCredentialRefreshes: MAX_PROVIDER_RETRIES_PER_ATTEMPT,
    });
  };

  // The primary interactive gateway is long-lived (rebuilt only when the
  // model selection changes) so its circuit breaker / rate-limit state is
  // meaningful across messages instead of resetting on every turn.
  let primaryGateway = buildGatewayForChain(resolveActiveChain().chain);
  const rebuildPrimaryGateway = (): void => {
    primaryGateway = buildGatewayForChain(resolveActiveChain().chain);
  };

  // Role gateways are rebuilt independently per role: switching brain's
  // model never rebuilds (and never resets the circuit-breaker/rate-limit
  // state of) hands' gateway, and vice versa.
  const rebuildBrainGateway = (): void => {
    brainGateway = buildGatewayForChain(resolveActiveChainForRole("brain").chain);
  };
  const rebuildHandsGateway = (): void => {
    handsGateway = buildGatewayForChain(resolveActiveChainForRole("hands").chain);
  };

  // ── Finalize tool defs (after providers + gateway are ready) ───────────
  if (isOrchestratorMode) {
    const orchSpec = parseModelSpec(
      config.orchestratorConfig.model,
      config.routing.defaultProvider,
    );
    const execSpec = parseModelSpec(config.executorConfig.model, config.routing.defaultProvider);
    orchestratorProvider = orchSpec.provider;
    orchestratorModel = orchSpec.model;
    executorProvider = execSpec.provider;
    executorModel = execSpec.model;

    if (!orchestratorModel || !executorModel) {
      throw new Error(
        "Orchestrator (brain_hands) mode requires both [orchestrator].model and [executor].model to be set. " +
          'Format: "provider/model" (e.g. "openrouter/glm-5:cloud")',
      );
    }

    // If the configured brain/hands model isn't a catalogued+available id
    // (e.g. it isn't in DEFAULT_MODEL_CATALOG, or its provider isn't
    // constructed), the role is seeded from SAFE_DEFAULT_MODEL_ID instead —
    // never from a hard-pinned id that might not exist for this deployment.
    const brainConfiguredId = `${orchestratorProvider}/${orchestratorModel}`;
    const handsConfiguredId = `${executorProvider}/${executorModel}`;
    const brainDefaultId = modelCatalog.isSelectable(brainConfiguredId)
      ? brainConfiguredId
      : SAFE_DEFAULT_MODEL_ID;
    const handsDefaultId = modelCatalog.isSelectable(handsConfiguredId)
      ? handsConfiguredId
      : SAFE_DEFAULT_MODEL_ID;
    const resolveRoleFallbackDefaults = (ids: string[], role: ModelRole): string[] => {
      const primaryId = role === "brain" ? brainDefaultId : handsDefaultId;
      const selected: string[] = [];
      for (const id of ids) {
        if (id === primaryId || selected.includes(id)) continue;
        if (!modelCatalog.isSelectable(id)) {
          logger.warn(
            { role, configuredFallbackId: id },
            "configured role fallback is unknown or unavailable; skipping",
          );
          continue;
        }
        selected.push(id);
      }
      return selected;
    };
    const brainFallbackDefaults = resolveRoleFallbackDefaults(
      config.orchestratorConfig.fallbackModels.length > 0
        ? config.orchestratorConfig.fallbackModels
        : configuredFallbackIds,
      "brain",
    );
    const handsFallbackDefaults = resolveRoleFallbackDefaults(
      config.executorConfig.fallbackModels.length > 0
        ? config.executorConfig.fallbackModels
        : configuredFallbackIds,
      "hands",
    );
    if (brainDefaultId === SAFE_DEFAULT_MODEL_ID && brainConfiguredId !== SAFE_DEFAULT_MODEL_ID) {
      logger.warn(
        { configured: brainConfiguredId, using: SAFE_DEFAULT_MODEL_ID },
        "configured [orchestrator].model is not in the catalog/provisioned; brain role seeded from the safe default instead",
      );
    }
    if (handsDefaultId === SAFE_DEFAULT_MODEL_ID && handsConfiguredId !== SAFE_DEFAULT_MODEL_ID) {
      logger.warn(
        { configured: handsConfiguredId, using: SAFE_DEFAULT_MODEL_ID },
        "configured [executor].model is not in the catalog/provisioned; hands role seeded from the safe default instead",
      );
    }

    // Durable, role-aware selection. Config values above are used only to
    // seed defaults on first run (or migrate a legacy unified selection into
    // "brain") — after that, durable role selections (mutable via
    // /model brain|hands ...) are the runtime source of truth.
    roleModelStore = new RoleModelSelectionStore({
      dataDir: join(config.dataDir, "providers"),
      legacyFilePath: join(config.dataDir, "providers", "model-selection.json"),
      defaultPrimaryId: { brain: brainDefaultId, hands: handsDefaultId },
      defaultFallbackIds: { brain: brainFallbackDefaults, hands: handsFallbackDefaults },
      logger,
    });
    await roleModelStore.load();
    if (roleModelStore.didMigrateLegacy()) {
      logger.info(
        { role: "brain" },
        "migrated legacy unified-mode model selection into the brain role",
      );
    }

    brainGateway = buildGatewayForChain(resolveActiveChainForRole("brain").chain);
    handsGateway = buildGatewayForChain(resolveActiveChainForRole("hands").chain);

    const executorToolNames = new Set(config.executorConfig.tools);
    const executorTools = registry.list().filter((tool) => executorToolNames.has(tool.name));
    const executorToolDefs = executorTools.map(toolToDefinition);

    const delegateTool = createDelegateTool({
      getHandsGateway: () => {
        if (!handsGateway) throw new Error("hands gateway not initialized");
        return handsGateway;
      },
      getHandsModel: () => resolveActiveChainForRole("hands").primary.model,
      executorTools,
      executorToolDefs,
      executorTemperature: config.executorConfig.temperature,
      executorMaxTokens: config.executorConfig.maxTokens,
      executorMaxIterations: config.executorConfig.maxIterations,
      executorSystemPromptOverride: config.executorConfig.systemPrompt,
      registry,
      logger,
      dataDir: config.dataDir,
      maxDurationMs: 300_000,
    });
    registry.register(delegateTool);

    // Brain (controller) tool exposure is intentionally minimal — the tools
    // named in [orchestrator].tools (delegate + memory by default). Brain
    // never silently inherits the full execution tool surface: technical
    // work is an explicit delegation decision (the "delegate" tool call
    // above), not an implicit fallback.
    const orchestratorToolNames = new Set(config.orchestratorConfig.tools);
    toolDefs = registry
      .list()
      .filter((tool) => orchestratorToolNames.has(tool.name))
      .map(toolToDefinition);

    logger.info(
      {
        mode: "orchestrator",
        brain: resolveActiveChainForRole("brain").chain[0],
        hands: resolveActiveChainForRole("hands").chain[0],
        orchestratorTools: toolDefs.map((t) => t.name),
        executorTools: executorToolDefs.map((t) => t.name),
      },
      "brain_hands (orchestrator) mode configured",
    );
  } else {
    // Child tool profile: strictly narrower than the primary operator's full
    // registry — bash/ssh_exec/browser/identity_evolve/delegate/spawn_agent/
    // run_chain are removed by default so a spawned child can never invoke a
    // hidden tool by name. Enforced at ToolRegistry.execute, not just here.
    const allToolNames = registry.list().map((tool) => tool.name);
    const childProfile = buildChildProfile(allToolNames);
    const spawnTools = registry
      .list()
      .filter((tool) => childProfile.allowedTools.includes(tool.name));
    const childToolExecutor = async (
      name: string,
      toolArgs: unknown,
      toolCallId?: string,
    ): Promise<{ content: string; isError: boolean; isValidationError?: boolean }> => {
      const t0 = Date.now();
      const execution = await registry.execute(name, toolArgs, {
        traceId: toolCallId || "child",
        cwd: workspaceCwd,
        dataDir: config.dataDir,
        logger,
        allowedTools: childProfile.allowedTools,
      });
      agentDb.logToolExecution(
        toolCallId || "child",
        "child",
        name,
        toolArgs,
        execution.content,
        Date.now() - t0,
        execution.isError ?? false,
      );
      return {
        content: execution.content,
        isError: execution.isError ?? false,
        isValidationError: execution.isValidationError,
      };
    };

    const spawnAgentTool = createSubAgentTool({
      name: "spawn_agent",
      description:
        "Spawn an autonomous sub-agent to complete a self-contained task. " +
        "Use this when a task requires many sequential steps, file operations, or extended research " +
        "that would clutter the main conversation. Returns the agent's final answer. " +
        "The sub-agent has a restricted tool set (no shell/ssh/browser/identity/delegation tools).",
      systemPrompt:
        "You are a focused autonomous partner-agent. Complete the given task step by step using your available tools: file edits, web research, reminders, media/pdf tools, and memory. Be concise but do the work; return final result plus any important changed files.",
      // Resolve the durable primary at invocation time (not startup): after
      // an operator runs /model use, spawn_agent must pick up the new
      // selection on its very next call. Streams through the same long-lived
      // primaryGateway used by the main loop (rebuilt on model change) so
      // circuit-breaker/rate-limit state is shared and meaningful.
      provider: {
        stream: (msgs, streamOpts) => {
          const current = resolveActiveChain().primary;
          return primaryGateway.stream(msgs, { ...streamOpts, model: current.model });
        },
      },
      tools: spawnTools,
      executor: childToolExecutor,
      maxIterations: CHILD_MAX_ITERATIONS,
      timeoutMs: 180_000,
      logger,
    });
    registry.register(spawnAgentTool);

    // ── Agent chains (build / design / document / implement / qlt) ───────────
    const chainTools = registry
      .list()
      .filter((tool) => tool.name !== "run_chain" && childProfile.allowedTools.includes(tool.name));
    const chainTool = createChainTool({
      // Resolve the durable primary at invocation time (not startup), same
      // reasoning as spawn_agent above.
      defaultModel: () => resolveActiveChain().primary.model,
      providerFactory: (model, thinking) => ({
        stream: (msgs, streamOpts) => {
          const current = resolveActiveChain().primary;
          return buildGatewayForModel(current.provider, model).stream(msgs, {
            ...streamOpts,
            model,
            thinkingLevel: thinking,
          });
        },
      }),
      tools: chainTools,
      executor: childToolExecutor,
      logger,
      modelOverrides: {
        // build: scout+reviewer on glm, planner+coder on kimi
        "build.scout": "glm-5.1:cloud",
        "build.planner": "kimi-k2.6:cloud",
        "build.coder": "kimi-k2.6:cloud",
        "build.reviewer": "glm-5.1:cloud",
        // design: scout+reviewer on glm/gemma, planner+designer on kimi
        "design.scout": "glm-5.1:cloud",
        "design.planner": "kimi-k2.6:cloud",
        "design.designer": "kimi-k2.6:cloud",
        "design.reviewer": "gemma4:31b-cloud",
        // document: glm for structure, gemma for prose
        "document.planner": "glm-5.1:cloud",
        "document.writer": "gemma4:31b-cloud",
        "document.reviewer": "glm-5.1:cloud",
        // implement: kimi codes, glm reviews
        "implement.coder": "kimi-k2.6:cloud",
        "implement.reviewer": "glm-5.1:cloud",
        // qlt: kimi analyses, glm reports
        "qlt.analyst": "kimi-k2.6:cloud",
        "qlt.reviewer": "glm-5.1:cloud",
      },
    });
    registry.register(chainTool);

    toolDefs = registry.list().map(toolToDefinition);
  }

  // ── Channels ─────────────────────────────────────────────────────────────
  const channelAdapters: ChannelAdapter[] = [];

  if (config.channels.cli.enabled) {
    channelAdapters.push(createCliAdapter());
  }

  if (config.channels.telegram.enabled) {
    if (config.channels.telegram.mode === "bot") {
      if (!config.channels.telegram.botToken) {
        logger.warn("Telegram bot mode enabled but TELEGRAM_BOT_TOKEN is missing");
      } else {
        channelAdapters.push(
          createTelegramAdapter({
            mode: "bot",
            botToken: config.channels.telegram.botToken,
            allowedChatIds: config.channels.telegram.allowedChatIds,
            logger,
          }),
        );
      }
    } else {
      if (!config.channels.telegram.apiId || !config.channels.telegram.apiHash) {
        logger.warn("Telegram MTProto mode enabled but TELEGRAM_API_ID/HASH are missing");
      } else {
        channelAdapters.push(
          createTelegramAdapter({
            mode: "mtproto",
            apiId: config.channels.telegram.apiId,
            apiHash: config.channels.telegram.apiHash,
            phoneNumber: config.channels.telegram.phoneNumber,
            phoneCode: config.channels.telegram.phoneCode,
            password: config.channels.telegram.password,
            sessionString: config.channels.telegram.sessionString,
            sessionFile: config.channels.telegram.sessionFile,
            allowedChatIds: config.channels.telegram.allowedChatIds,
            logger,
          }),
        );
      }
    }
  }

  if (config.channels.webhook.enabled) {
    if (!config.channels.webhook.secret) {
      logger.warn("Webhook channel enabled but WEBHOOK_SECRET is missing");
    } else {
      channelAdapters.push(
        createWebhookAdapter({
          port: config.channels.webhook.port,
          secret: config.channels.webhook.secret,
        }),
      );
    }
  }

  if (config.channels.whatsapp.enabled) {
    channelAdapters.push(
      createWhatsAppAdapter({
        sessionDir: config.channels.whatsapp.sessionDir,
        allowedJids:
          config.channels.whatsapp.allowedJids.length > 0
            ? config.channels.whatsapp.allowedJids
            : undefined,
        pairPhone: config.channels.whatsapp.pairPhone,
        logger,
      }),
    );
  }

  if (channelAdapters.length === 0) {
    logger.warn("No channels enabled; falling back to CLI channel");
    channelAdapters.push(createCliAdapter());
  }

  // ── Onboarding ────────────────────────────────────────────────────────
  const onboarding = createOnboardingManager({
    dataDir: config.dataDir,
    logger,
    agentName: config.agentName,
  });

  // ── Delivery queue ─────────────────────────────────────────────────────
  const deliveryQueue = new DeliveryQueue({
    filePath: join(config.dataDir, "delivery", "queue.json"),
    maxAttempts: config.delivery.maxAttempts,
    baseRetryMs: config.delivery.baseRetryMs,
    maxRetryMs: config.delivery.maxRetryMs,
    logger,
  });
  await deliveryQueue.load();

  const getChannelAdapter = (channelType: string): ChannelAdapter | undefined =>
    channelAdapters.find((adapter) => adapter.channelType === channelType);

  const sendWithDeliveryQueue = async (
    channelType: string,
    channelId: string,
    response: { text: string },
  ): Promise<void> => {
    const targetChannel = getChannelAdapter(channelType);
    if (!targetChannel) {
      logger.warn({ channelType }, "no channel adapter available for response delivery");
      await deliveryQueue.enqueue(channelType, channelId, response);
      return;
    }

    try {
      await targetChannel.sendMessage(channelId, response);
    } catch (error: unknown) {
      logger.error(
        {
          channelType,
          channelId,
          error: error instanceof Error ? error.message : String(error),
        },
        "send failed; queued for retry",
      );
      await deliveryQueue.enqueue(channelType, channelId, response);
    }
  };

  const deliveryRetryInterval = setInterval(() => {
    void deliveryQueue.processDue(async (channelType, channelId, response) => {
      const targetChannel = getChannelAdapter(channelType);
      if (!targetChannel) {
        throw new Error(`no channel adapter for ${channelType}`);
      }

      await targetChannel.sendMessage(channelId, response);
    });
  }, 10_000);

  // ── Plugins + commands ────────────────────────────────────────────────
  const runtimePlugins: HairyClawPlugin[] = [];
  if (config.memory.autoPreload) {
    runtimePlugins.push(
      createMemoryPreloadPlugin({
        backend: memoryBackend,
        topK: config.memory.preloadTopK,
        minScore: config.memory.preloadMinScore,
        maxChars: config.memory.preloadMaxChars,
        logger,
      }),
    );
  }

  const pluginRunner = new PluginRunner(runtimePlugins);
  const commandRouter = new CommandRouter(logger);

  const clearAllCooldowns = (): void => {
    for (const provider of providers) {
      authProfiles.clearCooldown(provider.name);
    }
  };

  const metricSnapshot = (): Record<string, number> => {
    const output: Record<string, number> = {};
    const all = metrics.getAll();

    for (const entry of [...all.counters, ...all.gauges]) {
      const labels = Object.entries(entry.labels)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(",");
      const metricKey = labels.length > 0 ? `${entry.name}{${labels}}` : entry.name;
      output[metricKey] = entry.value;
    }

    return output;
  };

  // Legacy (role-less) /model use|fallback|test|rollback and /status are the
  // unified/brain alias: in unified mode they operate on modelSelectionStore
  // + primaryGateway exactly as before; in brain_hands (orchestrator) mode
  // they operate on the "brain" role so existing operator habits/scripts
  // keep working unchanged.
  const legacyResolveChain = () =>
    isOrchestratorMode && roleModelStore
      ? resolveActiveChainForRole("brain")
      : resolveActiveChain();
  const legacyGateway = (): ProviderGateway =>
    isOrchestratorMode && brainGateway ? brainGateway : primaryGateway;
  const legacyRebuildGateway = (): void => {
    if (isOrchestratorMode && roleModelStore) rebuildBrainGateway();
    else rebuildPrimaryGateway();
  };

  const modelInfoFromChain = (): { primary: string; fallbacks: string[] } => {
    const resolved = legacyResolveChain();
    return {
      primary: `${resolved.primary.provider}/${resolved.primary.model}`,
      fallbacks: resolved.chain.slice(1).map((entry) => `${entry.provider}/${entry.model}`),
    };
  };

  /** Shared canary logic for both the legacy /model test and role-scoped /model brain|hands test. */
  const testModelId = async (id: string): Promise<ModelCommandResult> => {
    const entry = modelCatalog.get(id);
    if (!entry) return { ok: false, message: `"${id}" is not in the model catalog.` };
    if (!entry.available) {
      return {
        ok: false,
        message: `"${id}" is catalogued but unavailable (${entry.unavailableReason ?? "unavailable"}).`,
      };
    }
    const testGateway = buildGatewayForChain([{ provider: entry.provider, model: entry.model }]);
    try {
      let sawText = false;
      for await (const event of testGateway.stream(
        [{ role: "user", content: [{ type: "text", text: "Reply with the single word: pong" }] }],
        { model: entry.model, maxTokens: 16, timeoutMs: 20_000 },
      )) {
        if (event.type === "text_delta" && event.text) sawText = true;
        if (event.type === "error") {
          return { ok: false, message: `Canary failed for ${id}: ${event.error}` };
        }
      }
      return sawText
        ? { ok: true, message: `Canary succeeded for ${id}.` }
        : { ok: false, message: `Canary for ${id} produced no output.` };
    } catch (error: unknown) {
      return {
        ok: false,
        message: `Canary threw for ${id}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  /** Bounded, redacted per-role summary for /debug: role, resolved chain, last-success + latency, circuits. Never prompts/credentials/chat ids. */
  const debugRoleSummary = (role: ModelRole): Record<string, unknown> | undefined => {
    if (!roleModelStore) return undefined;
    const gateway = role === "brain" ? brainGateway : handsGateway;
    if (!gateway) return undefined;
    const current = roleModelStore.getCurrent(role);
    const resolved = resolveActiveChainForRole(role);
    const lastSuccess = gateway.getLastSuccessfulAttempt();
    return {
      configuredPrimaryId: current.primaryId,
      configuredFallbackIds: current.fallbackIds,
      resolvedChain: resolved.chain.map((entry) => `${entry.provider}/${entry.model}`),
      lastSuccessfulModel: lastSuccess ? `${lastSuccess.provider}/${lastSuccess.model}` : null,
      lastSuccessLatencyMs: lastSuccess?.latencyMs ?? null,
      circuits: gateway.getCircuitState(),
    };
  };

  const commandRuntime = {
    isOperator,
    getModelInfo: modelInfoFromChain,
    getProviderHealth: () => authProfiles.getHealthSnapshot(),
    clearCooldowns: clearAllCooldowns,
    getUptime: () => process.uptime(),
    getMetrics: metricSnapshot,
    getQueueStats: () => deliveryQueue.stats(),
    getDebugSnapshot: (): Record<string, unknown> => {
      const gateway = legacyGateway();
      const current =
        isOrchestratorMode && roleModelStore
          ? roleModelStore.getCurrent("brain")
          : modelSelectionStore.getCurrent();
      const resolved = legacyResolveChain();
      const lastSuccess = gateway.getLastSuccessfulAttempt();
      const roleDiagnostics =
        isOrchestratorMode && roleModelStore
          ? {
              // Bounded, redacted per-role diagnostics: role, resolved chain,
              // last-success provider/model + latency, and circuit/rate-limit
              // state only — never prompts, credentials, chat ids, or
              // message content.
              brain: debugRoleSummary("brain"),
              hands: debugRoleSummary("hands"),
            }
          : undefined;
      return {
        mode: config.agentMode,
        // Never a single ambiguous "model" field: configured selection,
        // resolved attempt chain, and last actually-successful model are
        // reported separately so /debug can't mislabel configured state as
        // provider-effective.
        model: {
          configuredPrimaryId: current.primaryId,
          configuredFallbackIds: current.fallbackIds,
          resolvedChain: resolved.chain.map((entry) => `${entry.provider}/${entry.model}`),
          resolvedWarnings: resolved.warnings,
          lastSuccessfulModel: lastSuccess ? `${lastSuccess.provider}/${lastSuccess.model}` : null,
          lastSuccessLatencyMs: lastSuccess?.latencyMs ?? null,
        },
        ...(roleDiagnostics ? { roles: roleDiagnostics } : {}),
        circuits: gateway.getCircuitState(),
        rateLimits: gateway.getRateLimitState(),
        lastAttemptFailures: gateway.getLastAttemptFailures().map((failure) => ({
          provider: failure.provider,
          model: failure.model,
          reason: failure.reason,
          advanced: failure.advanced,
          at: failure.at,
        })),
        channels: channelAdapters.map((ch) => ({
          type: ch.channelType,
          connected: ch.isConnected(),
        })),
        queue: deliveryQueue.stats(),
        diagnostics: diagnostics.snapshot(),
        diagnosticCounts: diagnostics.counts(),
      };
    },
    listModelCatalog: (): ModelCatalogEntrySummary[] =>
      modelCatalog.list().map((entry) => ({
        id: entry.id,
        label: entry.label,
        available: entry.available,
        ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}),
      })),
    getModelStatus: (): ModelStatusSnapshot => {
      const current =
        isOrchestratorMode && roleModelStore
          ? roleModelStore.getCurrent("brain")
          : modelSelectionStore.getCurrent();
      const resolved = legacyResolveChain();
      const gateway = legacyGateway();
      const circuits = gateway.getCircuitState() as Record<string, CircuitStateSummary>;
      const lastSuccess = gateway.getLastSuccessfulAttempt();
      return {
        configuredPrimaryId: current.primaryId,
        configuredFallbackIds: current.fallbackIds,
        resolvedChain: resolved.chain.map((entry) => `${entry.provider}/${entry.model}`),
        resolvedWarnings: resolved.warnings,
        lastSuccessfulModel: lastSuccess
          ? `${lastSuccess.provider}/${lastSuccess.model}`
          : undefined,
        updatedAt: current.updatedAt,
        updatedBy: current.updatedBy,
        circuits,
        rateLimits: gateway.getRateLimitState(),
      };
    },
    useModel: async (id: string, actor: string): Promise<ModelCommandResult> => {
      if (!modelCatalog.isSelectable(id)) {
        const entry = modelCatalog.get(id);
        const reason = !entry
          ? "not in the model catalog"
          : `catalogued but unavailable (${entry.unavailableReason ?? "unavailable"})`;
        return { ok: false, message: `Cannot switch to "${id}": ${reason}.` };
      }
      if (isOrchestratorMode && roleModelStore) {
        await roleModelStore.setPrimary("brain", id, actor);
      } else {
        await modelSelectionStore.setPrimary(id, actor);
      }
      legacyRebuildGateway();
      return { ok: true, message: `Primary model switched to ${id}.` };
    },
    setModelFallbacks: async (ids: string[], actor: string): Promise<ModelCommandResult> => {
      const invalid = ids.filter((id) => !modelCatalog.isSelectable(id));
      if (invalid.length > 0) {
        return {
          ok: false,
          message: `Not setting fallbacks: unknown or unavailable model id(s): ${invalid.join(", ")}.`,
        };
      }
      if (isOrchestratorMode && roleModelStore) {
        await roleModelStore.setFallbacks("brain", ids, actor);
      } else {
        await modelSelectionStore.setFallbacks(ids, actor);
      }
      legacyRebuildGateway();
      return { ok: true, message: `Fallback chain set to: ${ids.join(", ") || "(none)"}.` };
    },
    testModel: async (id: string): Promise<ModelCommandResult> => testModelId(id),
    rollbackModel: async (actor: string): Promise<ModelCommandResult> => {
      const previous =
        isOrchestratorMode && roleModelStore
          ? await roleModelStore.rollback("brain", actor)
          : await modelSelectionStore.rollback(actor);
      if (!previous) {
        return { ok: false, message: "No previous model selection to roll back to." };
      }
      legacyRebuildGateway();
      return { ok: true, message: `Rolled back to primary=${previous.primaryId}.` };
    },

    // ── Role-aware model selection (brain_hands / orchestrator mode) ──────
    isRoleAwareModelSelectionEnabled: () => isOrchestratorMode && roleModelStore !== null,
    getModelStatusForRole: (role: ModelRole): RoleModelStatusSnapshot => {
      if (!roleModelStore) {
        throw new Error("role-aware model selection is not enabled in this runtime");
      }
      const current = roleModelStore.getCurrent(role);
      const resolved = resolveActiveChainForRole(role);
      const gateway = role === "brain" ? brainGateway : handsGateway;
      if (!gateway) {
        throw new Error(`${role} gateway not initialized`);
      }
      const circuits = gateway.getCircuitState() as Record<string, CircuitStateSummary>;
      const lastSuccess = gateway.getLastSuccessfulAttempt();
      return {
        role,
        configuredPrimaryId: current.primaryId,
        configuredFallbackIds: current.fallbackIds,
        resolvedChain: resolved.chain.map((entry) => `${entry.provider}/${entry.model}`),
        resolvedWarnings: resolved.warnings,
        lastSuccessfulModel: lastSuccess
          ? `${lastSuccess.provider}/${lastSuccess.model}`
          : undefined,
        lastSuccessLatencyMs: lastSuccess?.latencyMs,
        updatedAt: current.updatedAt,
        updatedBy: current.updatedBy,
        circuits,
        rateLimits: gateway.getRateLimitState(),
      };
    },
    useModelForRole: async (
      role: ModelRole,
      id: string,
      actor: string,
    ): Promise<ModelCommandResult> => {
      if (!roleModelStore) {
        return { ok: false, message: "Role-aware model selection is not enabled in this runtime." };
      }
      if (!modelCatalog.isSelectable(id)) {
        const entry = modelCatalog.get(id);
        const reason = !entry
          ? "not in the model catalog"
          : `catalogued but unavailable (${entry.unavailableReason ?? "unavailable"})`;
        return { ok: false, message: `Cannot switch ${role} to "${id}": ${reason}.` };
      }
      await roleModelStore.setPrimary(role, id, actor);
      if (role === "brain") rebuildBrainGateway();
      else rebuildHandsGateway();
      return { ok: true, message: `${role} primary model switched to ${id}.` };
    },
    setModelFallbacksForRole: async (
      role: ModelRole,
      ids: string[],
      actor: string,
    ): Promise<ModelCommandResult> => {
      if (!roleModelStore) {
        return { ok: false, message: "Role-aware model selection is not enabled in this runtime." };
      }
      const invalid = ids.filter((id) => !modelCatalog.isSelectable(id));
      if (invalid.length > 0) {
        return {
          ok: false,
          message: `Not setting ${role} fallbacks: unknown or unavailable model id(s): ${invalid.join(", ")}.`,
        };
      }
      await roleModelStore.setFallbacks(role, ids, actor);
      if (role === "brain") rebuildBrainGateway();
      else rebuildHandsGateway();
      return { ok: true, message: `${role} fallback chain set to: ${ids.join(", ") || "(none)"}.` };
    },
    testModelForRole: async (_role: ModelRole, id: string): Promise<ModelCommandResult> =>
      testModelId(id),
    rollbackModelForRole: async (role: ModelRole, actor: string): Promise<ModelCommandResult> => {
      if (!roleModelStore) {
        return { ok: false, message: "Role-aware model selection is not enabled in this runtime." };
      }
      const previous = await roleModelStore.rollback(role, actor);
      if (!previous) {
        return { ok: false, message: `No previous ${role} model selection to roll back to.` };
      }
      if (role === "brain") rebuildBrainGateway();
      else rebuildHandsGateway();
      return { ok: true, message: `${role} rolled back to primary=${previous.primaryId}.` };
    },
    getVersion: () => {
      try {
        const subject = String(execSync("git log --oneline -1", { cwd: workspaceCwd })).trim();
        const branch = String(execSync("git branch --show-current", { cwd: workspaceCwd })).trim();
        return `${subject} (${branch})`;
      } catch {
        return "version unknown (not a git repo)";
      }
    },
    selfUpdate: async () => {
      try {
        const output = String(
          execSync("bash deploy/update.sh true", {
            cwd: workspaceCwd,
            timeout: 120_000,
            env: { ...process.env, PATH: process.env.PATH },
          }),
        ).trim();

        // Parse the last line as JSON
        const lines = output.split("\n");
        const jsonLine = lines[lines.length - 1] ?? "{}";
        const result = JSON.parse(jsonLine) as {
          success: boolean;
          previousVersion: string;
          currentVersion: string;
          changes: string;
          error?: string;
        };

        return {
          success: result.success,
          previousVersion: result.previousVersion,
          currentVersion: result.currentVersion,
          changes: result.changes,
          error: result.error,
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        let prevVersion = "unknown";
        try {
          prevVersion = String(
            execSync("git rev-parse --short HEAD", { cwd: workspaceCwd }),
          ).trim();
        } catch {
          // ignore
        }
        return {
          success: false,
          previousVersion: prevVersion,
          currentVersion: prevVersion,
          changes: "",
          error: msg,
        };
      }
    },
  };

  // ── Orchestrator ─────────────────────────────────────────────────────────
  const orchestrator = new Orchestrator({
    logger,
    metrics,
    queue,
    plugins: pluginRunner,
    handleRun: async (message, traceId, pluginCtx) => {
      const sourceChannel = getChannelAdapter(message.channelType);
      sourceChannel?.startTyping(message.channelId);

      const senderJid = message.senderId || message.channelId;
      const pushName = message.senderName || senderJid.split("@")[0];
      const userProfile = await onboarding.getOrCreateProfile(senderJid, pushName);
      const onboardingCtx = onboarding.getOnboardingPrompt(
        userProfile,
        message.content.text ?? "",
        message.channelType,
      );

      const commandText = message.content.text ?? "";
      const commandResponse = await commandRouter.route(commandText, {
        channelType: message.channelType,
        channelId: message.channelId,
        senderId: message.senderId,
        runtime: commandRuntime,
      });

      if (commandResponse !== null) {
        const preppedCommandResponse = await pluginRunner.runBeforeSend(
          { text: commandResponse },
          pluginCtx,
        );

        if (preppedCommandResponse) {
          await sendWithDeliveryQueue(
            message.channelType,
            message.channelId,
            preppedCommandResponse,
          );
        }

        sourceChannel?.stopTyping(message.channelId);
        return preppedCommandResponse ?? { text: "" };
      }

      await conversation.append(message);

      const skillFragments = await skills.getPromptFragments();
      const systemPrompt = await buildSystemPrompt({
        dataDir: config.dataDir,
        agentName: config.agentName,
        toolDescriptions: toolDefs.map((t) => `- ${t.name}: ${t.description}`),
        skillFragments,
        channel: message.channelType,
        onboardingContext: onboardingCtx ?? undefined,
        userName: userProfile.name,
        userPreferences: userProfile.onboarded ? userProfile.preferences : undefined,
      });

      const currentHash = createHash("sha256").update(systemPrompt).digest("hex");
      if (currentHash !== lastPromptHash) {
        lastPromptHash = currentHash;
        const saved = await promptVersions.save(systemPrompt);
        logger.debug({ versionId: saved.id }, "new prompt version saved");
      }

      const userContent: AgentLoopContent[] = [];
      if (message.content.text) {
        userContent.push({ type: "text", text: message.content.text });
      }
      for (const img of message.content.images ?? []) {
        if (img.buffer) {
          userContent.push({ type: "image", image: { data: img.buffer, mimeType: img.mimeType } });
        } else if (img.url) {
          userContent.push({ type: "image", image: { url: img.url } });
        }
      }
      for (const vid of message.content.video ?? []) {
        const ref = vid.path ?? vid.url ?? "video";
        userContent.push({ type: "text", text: `[video attached: ${ref}]` });
      }
      let transcriptionFailed = false;
      for (const aud of message.content.audio ?? []) {
        if (aud.path) {
          const outcome = await transcribeAudioFile(aud.path, aud.mimeType);
          recordDiagnostic("audio_transcription", outcome.stage);
          if (outcome.stage === "ok") {
            userContent.push({ type: "text", text: `[Voice message: ${outcome.text}]` });
          } else {
            transcriptionFailed = true;
            // Bounded, redacted: stage + provider name only, never file paths or content.
            logger.warn(
              {
                channelId: message.channelId,
                mimeType: aud.mimeType,
                stage: outcome.stage,
                provider: "provider" in outcome ? outcome.provider : undefined,
                httpStatus: "status" in outcome ? outcome.status : undefined,
              },
              "voice transcription failed",
            );
          }
        } else if (aud.url) {
          userContent.push({ type: "text", text: `[audio attached: ${aud.url}]` });
        }
      }
      // If the only thing in this message was a voice memo and transcription
      // failed, surface a plain error to the user and skip the orchestrator.
      // Feeding a synthetic "set GROQ_API_KEY" prompt into the agent loop
      // makes the model burn iterations trying to self-repair its own env.
      if (transcriptionFailed && userContent.length === 0) {
        sourceChannel?.stopTyping(message.channelId);
        return {
          text:
            "Sorry — voice transcription is unavailable right now. " +
            "Please send a text message, or try again shortly.",
        };
      }
      if (userContent.length === 0) {
        userContent.push({ type: "text", text: "" });
      }
      const dbSession = agentDb.getOrCreateSession(message.channelId, message.channelType);
      const recentHistory = agentDb.getRecentMessages(message.channelId, 50);
      const historyMessages: AgentLoopMessage[] = recentHistory.map((m) => ({
        role: m.role,
        content: [{ type: "text" as const, text: m.content }],
      }));
      const loopMessages: AgentLoopMessage[] = [
        ...historyMessages,
        { role: "user", content: userContent },
      ];

      let streamHandle: Awaited<
        ReturnType<Exclude<ChannelAdapter["sendStreamStart"], undefined>>
      > | null = null;
      if (sourceChannel?.sendStreamStart) {
        try {
          streamHandle = await sourceChannel.sendStreamStart(message.channelId, "⏳");
        } catch (error: unknown) {
          logger.warn(
            {
              channelType: message.channelType,
              channelId: message.channelId,
              error: error instanceof Error ? error.message : String(error),
            },
            "failed to start streaming response",
          );
        }
      }

      const startedAt = Date.now();

      // In brain_hands (orchestrator) mode, the interactive conversation loop
      // always runs on the brain role's durable selection (switchable live
      // via "/model brain use" or the legacy "/model use" alias) — never
      // hands', and never a static config-time model. In unified mode, use
      // the durable primary model selection (catalog + ModelSelectionStore,
      // switched via /model use). Both gateways are long-lived so
      // circuit-breaker/rate-limit state persists across turns and never
      // crosses the brain/hands role boundary.
      let activeProvider: string;
      let activeModel: string;
      let activeGateway: ProviderGateway;
      if (isOrchestratorMode && roleModelStore && brainGateway) {
        const resolved = resolveActiveChainForRole("brain");
        activeProvider = resolved.primary.provider;
        activeModel = resolved.primary.model;
        activeGateway = brainGateway;
      } else {
        const resolved = resolveActiveChain();
        activeProvider = resolved.primary.provider;
        activeModel = resolved.primary.model;
        activeGateway = primaryGateway;
      }
      let streamedText = "";

      const result = await runAgentLoop(loopMessages, {
        provider: {
          stream: (msgs, streamOpts) =>
            activeGateway.stream(msgs, {
              ...streamOpts,
              model: activeModel,
              route: { intent: "complex" },
              timeoutMs: config.resilience.requestTimeoutMs,
            }),
        },
        executor: async (name, args, _callId) => {
          const t0 = Date.now();
          const execution = await registry.execute(name, args, {
            traceId,
            cwd: workspaceCwd,
            dataDir: config.dataDir,
            logger,
            channelId: message.channelId,
            // Enforce the same tool profile the active model was shown. In
            // orchestrator mode this is the narrow brain/controller set; in
            // unified mode toolDefs contains the full intended primary set.
            allowedTools: toolDefs.map((tool) => tool.name),
          });
          if (execution.isError) {
            recordDiagnostic(
              "tool_error",
              execution.isValidationError ? "schema_error" : "execution_error",
              { toolName: name },
            );
          }
          agentDb.logToolExecution(
            traceId,
            message.channelId,
            name,
            args,
            execution.content,
            Date.now() - t0,
            execution.isError ?? false,
          );
          return {
            content: execution.content,
            isError: execution.isError ?? false,
            isValidationError: execution.isValidationError,
          };
        },
        streamOpts: {
          model: activeModel,
          systemPrompt,
          tools: toolDefs,
          temperature: isOrchestratorMode ? config.orchestratorConfig.temperature : undefined,
          maxTokens: isOrchestratorMode ? config.orchestratorConfig.maxTokens : 4096,
          timeoutMs: config.resilience.requestTimeoutMs,
        },
        logger,
        metrics,
        plugins: pluginRunner,
        pluginCtx,
        maxIterations: config.maxIterationsPerRun,
        contextWindow: config.providers.ollama.contextWindow ?? config.maxContextTokens,
        onTextDelta: (delta) => {
          if (!streamHandle) {
            return;
          }
          streamedText += delta;
          void streamHandle.update(streamedText).catch((error: unknown) => {
            logger.debug(
              {
                channelType: message.channelType,
                channelId: message.channelId,
                error: error instanceof Error ? error.message : String(error),
              },
              "streaming update failed",
            );
          });
        },
      });

      for (const failure of activeGateway.getLastAttemptFailures()) {
        recordDiagnostic("provider_attempt", failure.reason, {
          provider: failure.provider,
          advanced: failure.advanced,
        });
      }

      const responseText = result.text || "I could not produce a response.";
      const prepared = await pluginRunner.runBeforeSend({ text: responseText }, pluginCtx);
      const response = prepared ?? { text: "" };
      const durationMs = Date.now() - startedAt;

      // Persist this turn to SQLite
      const userText = message.content.text ?? "";
      if (userText) agentDb.saveMessage(dbSession, message.channelId, "user", userText);
      agentDb.saveMessage(dbSession, message.channelId, "assistant", responseText);

      const evalScore = evalHarness.score({
        traceId,
        response,
        stopReason: "completed",
        toolCalls: result.toolCalls,
        usage: {
          input: result.totalUsage.input,
          output: result.totalUsage.output,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, total: result.totalUsage.costUsd },
        },
        durationMs,
      });

      logger.info(
        {
          traceId,
          evalScore: evalScore.score,
          iterations: result.iterations,
          model: `${activeProvider}/${activeModel}`,
        },
        "run scored",
      );

      await conversation.append({
        role: "assistant",
        text: response.text,
        timestamp: new Date().toISOString(),
      });
      await episodic.logEvent({
        type: "message",
        timestamp: new Date().toISOString(),
        payload: {
          traceId,
          channelId: message.channelId,
          toolCalls: result.toolCalls.length,
          iterations: result.iterations,
          evalScore: evalScore.score,
          durationMs,
        },
      });

      if (config.growth.reflectionEnabled) {
        await reflection.reflect({
          runResult: {
            traceId,
            response,
            stopReason: "completed",
            toolCalls: result.toolCalls,
            usage: {
              input: result.totalUsage.input,
              output: result.totalUsage.output,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { input: 0, output: 0, total: result.totalUsage.costUsd },
            },
            durationMs,
          },
          userMessage: message,
        });
      }

      if (!userProfile.onboarded) {
        if (userProfile.onboardStep >= 1) {
          await onboarding.completeOnboarding(senderJid);
          logger.info({ jid: senderJid, name: userProfile.name }, "user onboarding completed");
        } else {
          await onboarding.advanceStep(senderJid);
        }
      }

      if (prepared) {
        if (streamHandle) {
          try {
            await streamHandle.finalize(response.text);
          } catch (error: unknown) {
            logger.warn(
              {
                channelType: message.channelType,
                channelId: message.channelId,
                error: error instanceof Error ? error.message : String(error),
              },
              "stream finalize failed; enqueueing final response",
            );
            await deliveryQueue.enqueue(message.channelType, message.channelId, response);
          }
        } else {
          await sendWithDeliveryQueue(message.channelType, message.channelId, response);
        }
      } else if (streamHandle) {
        try {
          await streamHandle.finalize("Response suppressed.");
        } catch {
          // best effort
        }
      }

      sourceChannel?.stopTyping(message.channelId);
      return response;
    },
  });

  // ── Initiative engine ────────────────────────────────────────────────────
  const initiativeRules = config.growth.initiativeEnabled
    ? await loadInitiativeRules(join(config.dataDir, "tasks", "initiative-rules.json"))
    : [];

  initiative = new InitiativeEngine({
    rules: initiativeRules,
    scheduler,
    channels: channelAdapters,
    logger,
  });

  initiative.onProactiveMessage((msg) => {
    void orchestrator.handleMessage(msg);
  });

  // ── Connect channels ─────────────────────────────────────────────────────
  for (const channel of channelAdapters) {
    channel.onMessage((msg) => {
      void orchestrator.handleMessage(msg);
    });
    await channel.connect();
  }

  // ── Sidecars ─────────────────────────────────────────────────────────────
  const sidecars = new SidecarManager({
    logger,
    registry,
    autoBuild: config.tools.sidecarAutoBuild,
  });
  await sidecars.loadAll(join(process.cwd(), "sidecars"));

  // ── Health server ─────────────────────────────────────────────────────────
  const health = new HealthServer({
    port: config.healthPort,
    metrics,
    getStatus: () => ({
      uptime: process.uptime(),
      channels: channelAdapters.map((ch) => ({
        type: ch.channelType,
        connected: ch.isConnected(),
      })),
      providers: providers.map((provider) => provider.name),
      sidecars: sidecars.health(),
      eval: evalHarness.getScores().slice(-10),
    }),
  });

  await orchestrator.start();
  await initiative.start();
  await health.start();

  // ── Reminder check loop ──────────────────────────────────────────────────
  setReminderCallback((reminder) => {
    const targetChannel = channelAdapters.find((ch) => ch.isConnected());
    if (targetChannel && reminder.channelId) {
      void sendWithDeliveryQueue(targetChannel.channelType, reminder.channelId, {
        text: `⏰ Reminder: ${reminder.message}`,
      });
      logger.info({ reminderId: reminder.id, channelId: reminder.channelId }, "reminder fired");
    }
  });
  const reminderInterval = setInterval(checkReminders, 30_000);

  // ── Shutdown ──────────────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    logger.info("shutting down hairyclaw agent");
    clearInterval(reminderInterval);
    clearInterval(deliveryRetryInterval);
    await deliveryQueue.save();
    await authProfiles.save();
    for (const channel of channelAdapters) {
      await channel.disconnect();
    }
    await scheduler.stopAll();
    await initiative.stop();
    await sidecars.stopAll();
    await health.stop();
    await orchestrator.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  logger.info(
    {
      agentName: config.agentName,
      mode: config.agentMode,
      model:
        isOrchestratorMode && roleModelStore
          ? {
              configuredBrain: `${orchestratorProvider}/${orchestratorModel}`,
              configuredHands: `${executorProvider}/${executorModel}`,
              resolvedBrain: `${resolveActiveChainForRole("brain").primary.provider}/${resolveActiveChainForRole("brain").primary.model}`,
              resolvedHands: `${resolveActiveChainForRole("hands").primary.provider}/${resolveActiveChainForRole("hands").primary.model}`,
            }
          : modelInfoFromChain().primary,
      tools: toolDefs.map((tool) => tool.name),
      providers: providers.map((provider) => provider.name),
      channels: channelAdapters.map((channel) => channel.channelType),
      initiativeRules: initiativeRules.length,
    },
    "hairyclaw agent started",
  );
};

// Guard the top-level auto-run so this module can be imported (for its
// exported pure helpers) by tests without starting the full agent — only run
// main() when this file is executed directly (dev/production entrypoint).
export const isEntrypointModule = (moduleUrl: string, argvPath: string | undefined): boolean => {
  try {
    if (!argvPath) return false;
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argvPath));
  } catch {
    return false;
  }
};

const isMainModule = (): boolean => isEntrypointModule(import.meta.url, process.argv[1]);

if (isMainModule()) {
  void main().catch((error: unknown) => {
    logger.error({ err: error }, "fatal startup error");
    process.exit(1);
  });
}
