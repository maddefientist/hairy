import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  type AgentLoopMessage,
  type AgentLoopToolDef,
  CommandRouter,
  type HairyClawPlugin,
  Orchestrator,
  PluginRunner,
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
import { type HairyClawLogger, Metrics, createLogger } from "@hairyclaw/observability";
import {
  AuthProfileManager,
  type Provider,
  ProviderGateway,
  createAnthropicProvider,
  createGeminiProvider,
  createOllamaProvider,
  createOpenRouterProvider,
} from "@hairyclaw/providers";
import {
  SidecarManager,
  type Tool,
  ToolRegistry,
  checkReminders,
  createBashTool,
  createBrowserTool,
  createEditTool,
  createIdentityEvolveTool,
  createMemoryIngestTool,
  createMemoryRecallTool,
  createPdfExtractTool,
  createReadTool,
  createReminderTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  setReminderCallback,
} from "@hairyclaw/tools";
import { z } from "zod";
import { loadHairyClawConfig } from "./config.js";
import { HealthServer } from "./health.js";
import { buildSystemPrompt } from "./identity.js";

const logger = createLogger("hairyclaw");

type ProviderName = "anthropic" | "openrouter" | "gemini" | "ollama";

const buildProviders = (config: Awaited<ReturnType<typeof loadHairyClawConfig>>): Provider[] => {
  const providers: Provider[] = [];

  if (config.providers.anthropic.enabled && config.providers.anthropic.apiKey) {
    providers.push(createAnthropicProvider({ apiKey: config.providers.anthropic.apiKey }));
  }

  if (config.providers.openrouter.enabled && config.providers.openrouter.apiKey) {
    providers.push(createOpenRouterProvider({ apiKey: config.providers.openrouter.apiKey }));
  }

  if (config.providers.gemini.enabled && config.providers.gemini.apiKey) {
    providers.push(createGeminiProvider({ apiKey: config.providers.gemini.apiKey }));
  }

  if (config.providers.ollama.enabled) {
    providers.push(createOllamaProvider({ baseUrl: config.providers.ollama.baseUrl }));
  }

  return providers;
};

const defaultModelForProvider = (
  config: Awaited<ReturnType<typeof loadHairyClawConfig>>,
  provider: string,
): string => {
  const name = provider as ProviderName;
  if (name === "anthropic") return config.providers.anthropic.defaultModel;
  if (name === "openrouter") return config.providers.openrouter.defaultModel;
  if (name === "gemini") return config.providers.gemini.defaultModel;
  return config.providers.ollama.defaultModel;
};

const resolveRouting = (
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

/** Convert a Tool (Zod schema) → AgentLoopToolDef (JSON schema) for the LLM */
const toolToDefinition = (tool: Tool): AgentLoopToolDef => {
  let jsonSchema: Record<string, unknown> = {};

  try {
    if ("_def" in tool.parameters) {
      const def = tool.parameters._def as {
        typeName?: string;
        shape?: () => Record<string, { _def?: { typeName?: string; description?: string } }>;
      };
      if (def.typeName === "ZodObject" && typeof def.shape === "function") {
        const shape = def.shape();
        const properties: Record<string, unknown> = {};
        const required: string[] = [];

        for (const [key, fieldSchema] of Object.entries(shape)) {
          const fieldDef = fieldSchema?._def as {
            typeName?: string;
            description?: string;
            innerType?: { _def?: { typeName?: string } };
          };

          let fieldType = "string";
          let isOptional = false;

          if (fieldDef?.typeName === "ZodOptional") {
            isOptional = true;
            const inner = fieldDef.innerType?._def?.typeName;
            if (inner === "ZodNumber") fieldType = "number";
            else if (inner === "ZodBoolean") fieldType = "boolean";
          } else if (fieldDef?.typeName === "ZodNumber") {
            fieldType = "number";
          } else if (fieldDef?.typeName === "ZodBoolean") {
            fieldType = "boolean";
          }

          properties[key] = {
            type: fieldType,
            ...(fieldDef?.description ? { description: fieldDef.description } : {}),
          };
          if (!isOptional) required.push(key);
        }

        jsonSchema = { properties, required };
      }
    }
  } catch {
    jsonSchema = { properties: {} };
  }

  return { name: tool.name, description: tool.description, parameters: jsonSchema };
};

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

const main = async (): Promise<void> => {
  const config = await loadHairyClawConfig();
  const metrics = new Metrics();

  if (config.providers.anthropic.enabled && !config.providers.anthropic.apiKey) {
    logger.warn("Anthropic enabled but ANTHROPIC_API_KEY is missing; provider disabled");
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

  // ── Tools ────────────────────────────────────────────────────────────────
  const registry = new ToolRegistry({ logger });
  registry.register(createBashTool());
  registry.register(createReadTool());
  registry.register(createWriteTool());
  registry.register(createEditTool());
  registry.register(createWebSearchTool());
  registry.register(createWebFetchTool());
  registry.register(createBrowserTool());
  registry.register(createReminderTool({ agentName: config.agentName }));
  registry.register(createPdfExtractTool());
  registry.register(createMemoryRecallTool(memoryBackend));
  registry.register(createMemoryIngestTool(memoryBackend));
  registry.register(createIdentityEvolveTool());

  const toolDefs = registry.list().map(toolToDefinition);

  // ── Providers ────────────────────────────────────────────────────────────
  const providers = buildProviders(config);
  if (providers.length === 0) {
    throw new Error("No providers available after config resolution.");
  }

  const routing = resolveRouting(
    config,
    providers.map((provider) => provider.name),
  );

  const modelAliases = new Set<string>();
  const providerDefaultModels = new Map<string, string>();
  for (const provider of providers) {
    const model = defaultModelForProvider(config, provider.name);
    providerDefaultModels.set(provider.name, model);
    modelAliases.add(`${provider.name}/${model}`);
  }
  for (const candidate of config.routing.modelFallbackChain) {
    modelAliases.add(candidate);
  }

  let activePrimaryModel = `${routing.defaultProvider}/${
    providerDefaultModels.get(routing.defaultProvider) ??
    defaultModelForProvider(config, routing.defaultProvider)
  }`;

  const authProfiles = new AuthProfileManager({
    filePath: join(config.dataDir, "providers", "auth-profiles.json"),
    baseCooldownMs: config.resilience.cooldownBaseMs,
    maxCooldownMs: config.resilience.cooldownMaxMs,
    cooldownThreshold: config.resilience.cooldownThreshold,
    logger,
  });
  await authProfiles.load();

  if (config.providers.anthropic.enabled && config.providers.anthropic.apiKey) {
    authProfiles.addProfile({
      id: "anthropic:env",
      provider: "anthropic",
      type: "api_key",
      credential: config.providers.anthropic.apiKey,
    });
  }

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
    });
  };

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
  const onboarding = createOnboardingManager({ dataDir: config.dataDir, logger, agentName: config.agentName });

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

  const fallbackModelList = (): string[] =>
    routing.modelFallbackChain
      .map((entry) => `${entry.provider}/${entry.model}`)
      .filter((entry) => entry !== activePrimaryModel);

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

  const commandRuntime = {
    getModelInfo: () => ({ primary: activePrimaryModel, fallbacks: fallbackModelList() }),
    setPrimaryModel: (model: string) => {
      const normalized = model.trim();
      if (modelAliases.has(normalized)) {
        activePrimaryModel = normalized;
        return true;
      }

      const providerDefault = providerDefaultModels.get(normalized);
      if (providerDefault) {
        activePrimaryModel = `${normalized}/${providerDefault}`;
        return true;
      }

      return false;
    },
    getProviderHealth: () => authProfiles.getHealthSnapshot(),
    clearCooldowns: clearAllCooldowns,
    getUptime: () => process.uptime(),
    getMetrics: metricSnapshot,
    getQueueStats: () => deliveryQueue.stats(),
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
      const onboardingCtx = onboarding.getOnboardingPrompt(userProfile, message.content.text ?? "", message.channelType);

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

      const loopMessages: AgentLoopMessage[] = [
        { role: "user", content: [{ type: "text", text: message.content.text ?? "" }] },
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
      const [requestedProvider, ...modelParts] = activePrimaryModel.split("/");
      const activeProvider = providerDefaultModels.has(requestedProvider)
        ? requestedProvider
        : routing.defaultProvider;
      const fallbackModel =
        providerDefaultModels.get(activeProvider) ??
        defaultModelForProvider(config, activeProvider);
      const activeModel = modelParts.join("/") || fallbackModel;
      const activeGateway = buildGatewayForModel(activeProvider, activeModel);
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
          const execution = await registry.execute(name, args, {
            traceId,
            cwd: process.cwd(),
            dataDir: config.dataDir,
            logger,
            channelId: message.channelId,
          });
          return { content: execution.content, isError: execution.isError ?? false };
        },
        streamOpts: {
          model: activeModel,
          systemPrompt,
          tools: toolDefs,
          maxTokens: 4096,
          timeoutMs: config.resilience.requestTimeoutMs,
        },
        logger,
        metrics,
        plugins: pluginRunner,
        pluginCtx,
        maxIterations: config.maxIterationsPerRun,
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

      const responseText = result.text || "I could not produce a response.";
      const prepared = await pluginRunner.runBeforeSend({ text: responseText }, pluginCtx);
      const response = prepared ?? { text: "" };
      const durationMs = Date.now() - startedAt;

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
      model: activePrimaryModel,
      tools: toolDefs.map((tool) => tool.name),
      providers: providers.map((provider) => provider.name),
      channels: channelAdapters.map((channel) => channel.channelType),
      initiativeRules: initiativeRules.length,
    },
    "hairyclaw agent started",
  );
};

void main().catch((error: unknown) => {
  logger.error({ err: error }, "fatal startup error");
  process.exit(1);
});
