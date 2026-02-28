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
import { InitiativeEngine } from "@hairy/growth";
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

const buildProviders = (keys: {
  anthropic?: string;
  openrouter?: string;
}): Provider[] => {
  const providers: Provider[] = [];
  if (keys.anthropic) {
    providers.push(createAnthropicProvider({ apiKey: keys.anthropic }));
  }
  if (keys.openrouter) {
    providers.push(createOpenRouterProvider({ apiKey: keys.openrouter }));
  }
  return providers;
};

/** Convert a Tool (with Zod schema) to a ToolDefinition (JSON schema) for the LLM */
const toolToDefinition = (tool: Tool): AgentLoopToolDef => {
  // Extract JSON schema from Zod — use .describe() output shape
  // Zod's .shape gives us the raw shape, but for the LLM we need a
  // simplified JSON schema representation
  const zodSchema = tool.parameters;
  let jsonSchema: Record<string, unknown> = {};

  try {
    // Try zod-to-json-schema if available, otherwise build from description
    if ("_def" in zodSchema) {
      const def = zodSchema._def as {
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
            innerType?: {
              _def?: { typeName?: string; description?: string };
            };
          };

          let fieldType = "string";
          let isOptional = false;

          if (fieldDef?.typeName === "ZodOptional") {
            isOptional = true;
            const innerTypeName = fieldDef.innerType?._def?.typeName;
            if (innerTypeName === "ZodNumber") fieldType = "number";
            else if (innerTypeName === "ZodBoolean") fieldType = "boolean";
          } else if (fieldDef?.typeName === "ZodNumber") {
            fieldType = "number";
          } else if (fieldDef?.typeName === "ZodBoolean") {
            fieldType = "boolean";
          }

          properties[key] = {
            type: fieldType,
            ...(fieldDef?.description ? { description: fieldDef.description } : {}),
          };

          if (!isOptional) {
            required.push(key);
          }
        }

        jsonSchema = { properties, required };
      }
    }
  } catch {
    // Fallback: empty properties
    jsonSchema = { properties: {} };
  }

  return {
    name: tool.name,
    description: tool.description,
    parameters: jsonSchema,
  };
};

const main = async (): Promise<void> => {
  const config = await loadHairyConfig();
  const metrics = new Metrics();

  // --- Data stores ---
  const queue = new TaskQueue(join(config.dataDir, "tasks", "queue.json"));
  const scheduler = new Scheduler({
    dataPath: join(config.dataDir, "tasks", "tasks.json"),
    onTaskDue: async (_task: ScheduledTask) => {
      metrics.increment("scheduled_tasks_due");
    },
  });
  await scheduler.load();

  // --- Memory ---
  const conversation = new ConversationMemory({
    filePath: join(config.dataDir, "context.jsonl"),
  });
  const semantic = new SemanticMemory({
    filePath: join(config.dataDir, "memory", "semantic.json"),
  });
  const episodic = new EpisodicMemory({ dataDir: config.dataDir });
  const reflection = new ReflectionEngine(semantic);

  // --- Tools ---
  const registry = new ToolRegistry({ logger });
  registry.register(createBashTool());
  registry.register(createReadTool());
  registry.register(createWriteTool());
  registry.register(createEditTool());
  registry.register(createWebSearchTool());

  // Build tool definitions for the LLM
  const toolDefs = registry.list().map(toolToDefinition);

  // --- Providers ---
  const providers = buildProviders(config.providerApiKeys);
  const gateway = new ProviderGateway({
    providers,
    routingConfig: {
      defaultProvider: providers[0]?.name ?? "anthropic",
      fallbackChain: providers.map((p) => p.name),
    },
    metrics,
  });

  // --- System prompt ---
  const systemPrompt = await buildSystemPrompt({
    dataDir: config.dataDir,
    toolDescriptions: toolDefs.map((t) => `- ${t.name}: ${t.description}`),
  });

  // --- Channel adapters ---
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

  // --- Orchestrator with agent loop ---
  const orchestrator = new Orchestrator({
    logger,
    metrics,
    queue,
    handleRun: async (message, traceId) => {
      await conversation.append(message);

      const prompt = message.content.text ?? "";

      // Build initial messages for the agent loop
      const loopMessages: AgentLoopMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      ];

      // Run the agent loop (multi-turn tool calling)
      const result = await runAgentLoop(loopMessages, {
        provider: {
          stream: (msgs, streamOpts) =>
            gateway.stream(msgs, {
              ...streamOpts,
              route: { intent: "complex" },
            }),
        },
        executor: async (name, args, _callId) => {
          const toolResult = await registry.execute(name, args, {
            traceId,
            cwd: process.cwd(),
            dataDir: config.dataDir,
            logger,
            channelId: message.channelId,
          });
          return {
            content: toolResult.content,
            isError: toolResult.isError ?? false,
          };
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
            cost: {
              input: 0,
              output: 0,
              total: result.totalUsage.costUsd,
            },
          },
          durationMs: 0,
        },
        userMessage: message,
      });

      return response;
    },
  });

  // --- Initiative engine ---
  const initiative = new InitiativeEngine({
    rules: [],
    scheduler,
    channels: channelAdapters,
  });

  // --- Connect channels ---
  for (const channel of channelAdapters) {
    channel.onMessage((msg) => {
      void orchestrator.handleMessage(msg);
    });
    await channel.connect();
  }

  // --- Sidecars ---
  const sidecars = new SidecarManager({
    logger,
    registry,
    autoBuild: true,
  });
  await sidecars.loadAll(join(process.cwd(), "sidecars"));

  // --- Health server ---
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
    }),
  });

  await orchestrator.start();
  await initiative.start();
  await health.start();

  // --- Shutdown ---
  const shutdown = async (): Promise<void> => {
    logger.info("shutting down hairy-agent");
    for (const ch of channelAdapters) {
      await ch.disconnect();
    }
    await scheduler.stopAll();
    await initiative.stop();
    await sidecars.stopAll();
    await health.stop();
    await orchestrator.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

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
