import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "@hairyclaw/core";
import { z } from "zod";

const parseBooleanEnv = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
};

const toList = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
};

const parseIntegerEnv = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
};

const runtimeSchema = z.object({
  providerApiKeys: z.object({
    anthropic: z.string().optional(),
    openrouter: z.string().optional(),
    gemini: z.string().optional(),
  }),
  ollama: z.object({
    enabled: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    model: z.string().optional(),
  }),
  channels: z.object({
    telegramMode: z.enum(["bot", "mtproto"]).optional(),
    telegramToken: z.string().optional(),
    telegramApiId: z.number().int().positive().optional(),
    telegramApiHash: z.string().optional(),
    telegramPhoneNumber: z.string().optional(),
    telegramPhoneCode: z.string().optional(),
    telegramPassword: z.string().optional(),
    telegramSession: z.string().optional(),
    telegramSessionFile: z.string().optional(),
    telegramChatIds: z.array(z.string()).optional(),
    webhookSecret: z.string().optional(),
    webhookPort: z.number().int().positive().optional(),
    whatsappEnabled: z.boolean().optional(),
    whatsappSessionDir: z.string().optional(),
    whatsappAllowedJids: z.array(z.string()).optional(),
    whatsappPairPhone: z.string().optional(),
  }),
});

interface ProviderRuntimeConfig {
  enabled: boolean;
  defaultModel: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindow?: number;
}

export interface OrchestratorModeConfig {
  model: string; // "provider/model" e.g. "openrouter/glm-5:cloud"
  tools: string[]; // tool names the orchestrator gets
  temperature: number;
  maxTokens: number;
}

export interface ExecutorModeConfig {
  model: string; // "provider/model" e.g. "ollama/qwen3.5:9b"
  tools: string[]; // tool names the executor gets
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  systemPrompt: string; // custom override — empty = use built-in structured prompt
}

export interface HairyClawRuntimeConfig {
  agentName: string;
  dataDir: string;
  healthPort: number;
  configDir: string;
  maxIterationsPerRun: number;
  maxContextTokens: number;
  agentMode: "unified" | "orchestrator";
  orchestratorConfig: OrchestratorModeConfig;
  executorConfig: ExecutorModeConfig;
  providers: {
    anthropic: ProviderRuntimeConfig;
    openrouter: ProviderRuntimeConfig;
    gemini: ProviderRuntimeConfig;
    ollama: ProviderRuntimeConfig;
  };
  routing: {
    defaultProvider: string;
    fallbackChain: string[];
    modelFallbackChain: string[];
  };
  channels: {
    cli: { enabled: boolean };
    telegram: {
      enabled: boolean;
      mode: "bot" | "mtproto";
      botToken?: string;
      apiId?: number;
      apiHash?: string;
      phoneNumber?: string;
      phoneCode?: string;
      password?: string;
      sessionString?: string;
      sessionFile: string;
      allowedChatIds: string[];
    };
    webhook: {
      enabled: boolean;
      secret?: string;
      port: number;
    };
    whatsapp: {
      enabled: boolean;
      sessionDir: string;
      allowedJids: string[];
      pairPhone?: string;
    };
  };
  growth: {
    reflectionEnabled: boolean;
    initiativeEnabled: boolean;
    skillAutoPromote: boolean;
  };
  resilience: {
    cooldownBaseMs: number;
    cooldownMaxMs: number;
    cooldownThreshold: number;
    requestTimeoutMs: number;
  };
  delivery: {
    maxAttempts: number;
    baseRetryMs: number;
    maxRetryMs: number;
  };
  memory: {
    autoPreload: boolean;
    preloadTopK: number;
    preloadMinScore: number;
    preloadMaxChars: number;
  };
  tools: {
    sidecarAutoBuild: boolean;
  };
  features: {
    executionMetadataTracking: boolean;
    standardizedTelemetry: boolean;
    denialTracking: boolean;
    subagentContextForking: boolean;
    verificationWorker: boolean;
    sessionMemoryExtraction: boolean;
    typedMemory: boolean;
    sharedArtifacts: boolean;
    deferredToolLoading: boolean;
    remoteExecution: boolean;
  };
}

export const loadHairyClawConfig = async (): Promise<HairyClawRuntimeConfig> => {
  const configDir = resolve(process.cwd(), "config");
  if (!existsSync(configDir)) {
    throw new Error(`config directory does not exist: ${configDir}`);
  }

  const base = await loadConfig(configDir);

  const runtime = runtimeSchema.parse({
    providerApiKeys: {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
    },
    ollama: {
      enabled: parseBooleanEnv(process.env.OLLAMA_ENABLED),
      baseUrl: process.env.OLLAMA_BASE_URL,
      model: process.env.OLLAMA_MODEL,
    },
    channels: {
      telegramMode:
        process.env.TELEGRAM_MODE === "bot" || process.env.TELEGRAM_MODE === "mtproto"
          ? process.env.TELEGRAM_MODE
          : undefined,
      telegramToken: process.env.TELEGRAM_BOT_TOKEN,
      telegramApiId: parseIntegerEnv(process.env.TELEGRAM_API_ID),
      telegramApiHash: process.env.TELEGRAM_API_HASH,
      telegramPhoneNumber: process.env.TELEGRAM_PHONE_NUMBER,
      telegramPhoneCode: process.env.TELEGRAM_PHONE_CODE,
      telegramPassword: process.env.TELEGRAM_2FA_PASSWORD,
      telegramSession: process.env.TELEGRAM_SESSION,
      telegramSessionFile: process.env.TELEGRAM_SESSION_FILE,
      telegramChatIds: toList(process.env.TELEGRAM_CHAT_IDS),
      webhookSecret: process.env.WEBHOOK_SECRET,
      webhookPort: process.env.WEBHOOK_PORT ? Number(process.env.WEBHOOK_PORT) : undefined,
      whatsappEnabled: parseBooleanEnv(process.env.WHATSAPP_ENABLED),
      whatsappSessionDir: process.env.WHATSAPP_SESSION_DIR,
      whatsappAllowedJids: toList(process.env.WHATSAPP_ALLOWED_JIDS),
      whatsappPairPhone: process.env.WHATSAPP_PAIR_PHONE,
    },
  });

  const providers = {
    anthropic: {
      enabled: base.providers.anthropic?.enabled ?? false,
      defaultModel: base.providers.anthropic?.default_model ?? "claude-sonnet-4-20250514",
      apiKey: runtime.providerApiKeys.anthropic,
    },
    openrouter: {
      enabled: base.providers.openrouter?.enabled ?? false,
      defaultModel:
        base.providers.openrouter?.default_model ?? "anthropic/claude-sonnet-4-20250514",
      apiKey: runtime.providerApiKeys.openrouter,
    },
    gemini: {
      enabled: base.providers.gemini?.enabled ?? false,
      defaultModel: base.providers.gemini?.default_model ?? "gemini-2.5-flash",
      apiKey: runtime.providerApiKeys.gemini,
    },
    ollama: {
      enabled: runtime.ollama.enabled ?? base.providers.ollama?.enabled ?? false,
      defaultModel: runtime.ollama.model ?? base.providers.ollama?.default_model ?? "llama3.2",
      baseUrl:
        runtime.ollama.baseUrl ?? base.providers.ollama?.base_url ?? "http://localhost:11434",
      contextWindow: base.providers.ollama?.context_window,
    },
  };

  const hasCloudProvider =
    (providers.anthropic.enabled && Boolean(providers.anthropic.apiKey)) ||
    (providers.openrouter.enabled && Boolean(providers.openrouter.apiKey)) ||
    (providers.gemini.enabled && Boolean(providers.gemini.apiKey));

  if (!hasCloudProvider && !providers.ollama.enabled) {
    throw new Error(
      "No provider configured. Enable Ollama in config/default.toml or configure cloud provider keys.",
    );
  }

  const orchestratorModel = process.env.ORCHESTRATOR_MODEL ?? base.orchestrator.model ?? "";
  const executorModel = process.env.EXECUTOR_MODEL ?? base.executor.model ?? "";

  return {
    agentName: base.agent.name,
    dataDir: base.agent.data_dir,
    healthPort: base.health.port,
    configDir,
    maxIterationsPerRun: base.agent.max_iterations_per_run,
    maxContextTokens: base.agent.max_context_tokens,
    agentMode:
      (process.env.AGENT_MODE as "unified" | "orchestrator" | undefined) ??
      base.agent.mode ??
      "unified",
    orchestratorConfig: {
      model: orchestratorModel,
      tools: base.orchestrator.tools,
      temperature: base.orchestrator.temperature,
      maxTokens: base.orchestrator.max_tokens,
    },
    executorConfig: {
      model: executorModel,
      tools: base.executor.tools,
      temperature: base.executor.temperature,
      maxTokens: base.executor.max_tokens,
      maxIterations: base.executor.max_iterations,
      systemPrompt: process.env.EXECUTOR_SYSTEM_PROMPT ?? base.executor.system_prompt ?? "",
    },
    providers,
    routing: {
      defaultProvider: base.routing.default_provider,
      fallbackChain: base.routing.fallback_chain,
      modelFallbackChain:
        toList(process.env.MODEL_FALLBACK_CHAIN) ??
        base.providers.ollama?.model_fallback_chain ??
        [],
    },
    channels: {
      cli: {
        enabled: base.channels.cli.enabled,
      },
      telegram: {
        enabled: base.channels.telegram.enabled,
        mode: runtime.channels.telegramMode ?? base.channels.telegram.mode ?? "bot",
        botToken: runtime.channels.telegramToken ?? base.channels.telegram.bot_token,
        apiId: runtime.channels.telegramApiId,
        apiHash: runtime.channels.telegramApiHash,
        phoneNumber: runtime.channels.telegramPhoneNumber,
        phoneCode: runtime.channels.telegramPhoneCode,
        password: runtime.channels.telegramPassword,
        sessionString: runtime.channels.telegramSession,
        sessionFile:
          runtime.channels.telegramSessionFile ??
          base.channels.telegram.session_file ??
          resolve(base.agent.data_dir, "telegram", "session.txt"),
        allowedChatIds:
          runtime.channels.telegramChatIds ?? base.channels.telegram.allowed_chat_ids ?? [],
      },
      webhook: {
        enabled: base.channels.webhook.enabled,
        secret: runtime.channels.webhookSecret ?? base.channels.webhook.secret,
        port: runtime.channels.webhookPort ?? base.channels.webhook.port,
      },
      whatsapp: {
        enabled: runtime.channels.whatsappEnabled ?? base.channels.whatsapp.enabled,
        sessionDir:
          runtime.channels.whatsappSessionDir ??
          base.channels.whatsapp.session_dir ??
          resolve(base.agent.data_dir, "whatsapp-session"),
        allowedJids:
          runtime.channels.whatsappAllowedJids ?? base.channels.whatsapp.allowed_jids ?? [],
        pairPhone: runtime.channels.whatsappPairPhone,
      },
    },
    growth: {
      reflectionEnabled: base.growth.reflection_enabled,
      initiativeEnabled: base.growth.initiative_enabled,
      skillAutoPromote: base.growth.skill_auto_promote,
    },
    resilience: {
      cooldownBaseMs: base.resilience.cooldown_base_ms,
      cooldownMaxMs: base.resilience.cooldown_max_ms,
      cooldownThreshold: base.resilience.cooldown_threshold,
      requestTimeoutMs: base.resilience.request_timeout_ms,
    },
    delivery: {
      maxAttempts: base.delivery.max_attempts,
      baseRetryMs: base.delivery.base_retry_ms,
      maxRetryMs: base.delivery.max_retry_ms,
    },
    memory: {
      autoPreload: base.memory.auto_preload,
      preloadTopK: base.memory.preload_top_k,
      preloadMinScore: base.memory.preload_min_score,
      preloadMaxChars: base.memory.preload_max_chars,
    },
    tools: {
      sidecarAutoBuild: base.tools.sidecar.auto_build,
    },
    features: {
      executionMetadataTracking:
        parseBooleanEnv(process.env.FEATURE_EXECUTION_METADATA_TRACKING) ??
        base.features?.execution_metadata_tracking ??
        true,
      standardizedTelemetry:
        parseBooleanEnv(process.env.FEATURE_STANDARDIZED_TELEMETRY) ??
        base.features?.standardized_telemetry ??
        true,
      denialTracking:
        parseBooleanEnv(process.env.FEATURE_DENIAL_TRACKING) ??
        base.features?.denial_tracking ??
        false,
      subagentContextForking:
        parseBooleanEnv(process.env.FEATURE_SUBAGENT_CONTEXT_FORKING) ??
        base.features?.subagent_context_forking ??
        false,
      verificationWorker:
        parseBooleanEnv(process.env.FEATURE_VERIFICATION_WORKER) ??
        base.features?.verification_worker ??
        false,
      sessionMemoryExtraction:
        parseBooleanEnv(process.env.FEATURE_SESSION_MEMORY_EXTRACTION) ??
        base.features?.session_memory_extraction ??
        false,
      typedMemory:
        parseBooleanEnv(process.env.FEATURE_TYPED_MEMORY) ?? base.features?.typed_memory ?? false,
      sharedArtifacts:
        parseBooleanEnv(process.env.FEATURE_SHARED_ARTIFACTS) ??
        base.features?.shared_artifacts ??
        false,
      deferredToolLoading:
        parseBooleanEnv(process.env.FEATURE_DEFERRED_TOOL_LOADING) ??
        base.features?.deferred_tool_loading ??
        false,
      remoteExecution:
        parseBooleanEnv(process.env.FEATURE_REMOTE_EXECUTION) ??
        base.features?.remote_execution ??
        false,
    },
  };
};
