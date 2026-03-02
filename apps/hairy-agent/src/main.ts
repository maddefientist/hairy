import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type ChannelAdapter,
  createCliAdapter,
  createTelegramAdapter,
  createWebhookAdapter,
  createWhatsAppAdapter,
} from "@hairy/channels";
import {
  type AgentLoopMessage,
  type AgentLoopToolDef,
  Orchestrator,
  type ScheduledTask,
  Scheduler,
  TaskQueue,
  runAgentLoop,
} from "@hairy/core";
import { EvalHarness, InitiativeEngine, PromptVersionManager, SkillRegistry } from "@hairy/growth";
import {
  ConversationMemory,
  EpisodicMemory,
  ReflectionEngine,
  SemanticMemory,
} from "@hairy/memory";
import { Metrics, createLogger } from "@hairy/observability";
import {
  type Provider,
  ProviderGateway,
  createAnthropicProvider,
  createGeminiProvider,
  createOllamaProvider,
  createOpenRouterProvider,
} from "@hairy/providers";
import {
  SidecarManager,
  type Tool,
  ToolRegistry,
  createBashTool,
  createEditTool,
  createReadTool,
  createWebSearchTool,
  createWriteTool,
} from "@hairy/tools";
import { loadHairyConfig } from "./config.js";
import { HealthServer } from "./health.js";
import { buildSystemPrompt } from "./identity.js";

const logger = createLogger("hairy-agent");

const buildProviders = (
  keys: { anthropic?: string; openrouter?: string; gemini?: string },
  ollamaBaseUrl?: string,
): Provider[] => {
  const providers: Provider[] = [];
  if (keys.anthropic) providers.push(createAnthropicProvider({ apiKey: keys.anthropic }));
  if (keys.openrouter) providers.push(createOpenRouterProvider({ apiKey: keys.openrouter }));
  if (keys.gemini) providers.push(createGeminiProvider({ apiKey: keys.gemini }));
  // Ollama always available — fails gracefully if unreachable
  providers.push(createOllamaProvider({ baseUrl: ollamaBaseUrl }));
  return providers;
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

const main = async (): Promise<void> => {
  const config = await loadHairyConfig();
  const metrics = new Metrics();

  // ── Data stores ─────────────────────────────────────────────────────────
  const queue = new TaskQueue(join(config.dataDir, "tasks", "queue.json"));
  const scheduler = new Scheduler({
    dataPath: join(config.dataDir, "tasks", "tasks.json"),
    onTaskDue: async (task: ScheduledTask) => {
      metrics.increment("scheduled_tasks_due");
      logger.info({ taskId: task.id, prompt: task.prompt }, "scheduled task due");
      // Initiative-generated tasks are dispatched via the engine below
    },
  });
  await scheduler.load();

  // ── Memory ───────────────────────────────────────────────────────────────
  const conversation = new ConversationMemory({
    filePath: join(config.dataDir, "context.jsonl"),
  });
  const semantic = new SemanticMemory({
    filePath: join(config.dataDir, "memory", "semantic.json"),
    hiveApiUrl: process.env.HARI_HIVE_URL,
  });
  const episodic = new EpisodicMemory({ dataDir: config.dataDir });
  const reflection = new ReflectionEngine(semantic);

  // ── Growth ───────────────────────────────────────────────────────────────
  const skills = new SkillRegistry({ dataDir: config.dataDir });
  const evalHarness = new EvalHarness();
  const promptVersions = new PromptVersionManager({
    filePath: join(config.dataDir, "memory", "prompt-versions.json"),
  });
  /** Track last-saved hash so we only persist when the prompt changes */
  let lastPromptHash = "";

  // ── Tools ────────────────────────────────────────────────────────────────
  const registry = new ToolRegistry({ logger });
  registry.register(createBashTool());
  registry.register(createReadTool());
  registry.register(createWriteTool());
  registry.register(createEditTool());
  registry.register(createWebSearchTool());

  const toolDefs = registry.list().map(toolToDefinition);

  // ── Providers ────────────────────────────────────────────────────────────
  const providers = buildProviders(config.providerApiKeys, config.ollamaBaseUrl);
  const gateway = new ProviderGateway({
    providers,
    routingConfig: {
      defaultProvider: providers[0]?.name ?? "anthropic",
      fallbackChain: providers.map((p) => p.name),
    },
    metrics,
  });

  // ── Channels ─────────────────────────────────────────────────────────────
  const channelAdapters: ChannelAdapter[] = [createCliAdapter()];

  if (config.channels.telegramToken) {
    channelAdapters.push(
      createTelegramAdapter({
        botToken: config.channels.telegramToken,
        allowedChatIds: process.env.TELEGRAM_CHAT_IDS?.split(",") ?? [],
        logger,
      }),
    );
  }

  if (config.channels.webhookSecret) {
    channelAdapters.push(
      createWebhookAdapter({
        port: Number(process.env.WEBHOOK_PORT ?? 8080),
        secret: config.channels.webhookSecret,
      }),
    );
  }

  if (process.env.WHATSAPP_ENABLED === "true") {
    channelAdapters.push(
      createWhatsAppAdapter({
        sessionDir: join(config.dataDir, "whatsapp-session"),
        allowedJids: process.env.WHATSAPP_ALLOWED_JIDS?.split(",").map((j) => j.trim()),
        logger,
      }),
    );
  }

  // ── Orchestrator ─────────────────────────────────────────────────────────
  const orchestrator = new Orchestrator({
    logger,
    metrics,
    queue,
    handleRun: async (message, traceId) => {
      await conversation.append(message);

      // Build system prompt with active (promoted) skill fragments
      const skillFragments = await skills.getPromptFragments();
      const systemPrompt = await buildSystemPrompt({
        dataDir: config.dataDir,
        toolDescriptions: toolDefs.map((t) => `- ${t.name}: ${t.description}`),
        skillFragments,
        channel: message.channelType,
      });

      // Persist the system prompt whenever it changes (deduped by hash)
      const currentHash = createHash("sha256").update(systemPrompt).digest("hex");
      if (currentHash !== lastPromptHash) {
        lastPromptHash = currentHash;
        const saved = await promptVersions.save(systemPrompt);
        logger.debug({ versionId: saved.id }, "new prompt version saved");
      }

      const loopMessages: AgentLoopMessage[] = [
        { role: "user", content: [{ type: "text", text: message.content.text ?? "" }] },
      ];

      const startedAt = Date.now();
      const result = await runAgentLoop(loopMessages, {
        provider: {
          stream: (msgs, streamOpts) =>
            gateway.stream(msgs, { ...streamOpts, route: { intent: "complex" } }),
        },
        executor: async (name, args, _callId) => {
          const r = await registry.execute(name, args, {
            traceId,
            cwd: process.cwd(),
            dataDir: config.dataDir,
            logger,
            channelId: message.channelId,
          });
          return { content: r.content, isError: r.isError ?? false };
        },
        streamOpts: {
          model: "claude-sonnet-4-20250514",
          systemPrompt,
          tools: toolDefs,
          maxTokens: 4096,
        },
        logger,
        metrics,
        maxIterations: 10,
      });

      const responseText = result.text || "I could not produce a response.";
      const response = { text: responseText };
      const durationMs = Date.now() - startedAt;

      // Score the run for eval / skill promotion
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
        { traceId, evalScore: evalScore.score, iterations: result.iterations },
        "run scored",
      );

      // Update memory
      await conversation.append({
        role: "assistant",
        text: responseText,
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

      return response;
    },
  });

  // ── Initiative engine ────────────────────────────────────────────────────
  const initiative = new InitiativeEngine({
    rules: [],
    scheduler,
    channels: channelAdapters,
    logger,
  });

  // Give the initiative engine a dispatch path into the orchestrator
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
  const sidecars = new SidecarManager({ logger, registry, autoBuild: true });
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
      providers: providers.map((p) => p.name),
      sidecars: sidecars.health(),
      eval: evalHarness.getScores().slice(-10),
    }),
  });

  await orchestrator.start();
  await initiative.start();
  await health.start();

  // ── Shutdown ──────────────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    logger.info("shutting down hairy-agent");
    for (const ch of channelAdapters) await ch.disconnect();
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
      tools: toolDefs.map((t) => t.name),
      providers: providers.map((p) => p.name),
      channels: channelAdapters.map((ch) => ch.channelType),
    },
    "hairy-agent started",
  );
};

void main().catch((error: unknown) => {
  logger.error({ err: error }, "fatal startup error");
  process.exit(1);
});
