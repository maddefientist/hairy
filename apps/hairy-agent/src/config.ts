import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "@hairy/core";
import { z } from "zod";

const runtimeSchema = z.object({
  providerApiKeys: z.object({
    anthropic: z.string().optional(),
    openrouter: z.string().optional(),
    gemini: z.string().optional(),
  }),
  ollamaBaseUrl: z.string().optional(),
  channels: z.object({
    telegramToken: z.string().optional(),
    webhookSecret: z.string().optional(),
  }),
});

export interface HairyRuntimeConfig {
  dataDir: string;
  healthPort: number;
  configDir: string;
  providerApiKeys: {
    anthropic?: string;
    openrouter?: string;
    gemini?: string;
  };
  /** Base URL for local Ollama instance (default: http://localhost:11434) */
  ollamaBaseUrl?: string;
  channels: {
    telegramToken?: string;
    webhookSecret?: string;
  };
}

export const loadHairyConfig = async (): Promise<HairyRuntimeConfig> => {
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
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    channels: {
      telegramToken: process.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: process.env.WEBHOOK_SECRET,
    },
  });

  const keys = runtime.providerApiKeys;
  const hasCloudProvider =
    Boolean(keys.anthropic) || Boolean(keys.openrouter) || Boolean(keys.gemini);
  // Ollama is always available locally — treat as valid if base URL set or if
  // no cloud providers are configured (assume local Ollama is running)
  const hasOllama = Boolean(runtime.ollamaBaseUrl) || !hasCloudProvider;

  if (!hasCloudProvider && !hasOllama) {
    throw new Error(
      "No provider configured. Set at least one of: " +
        "ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, or OLLAMA_BASE_URL",
    );
  }

  return {
    dataDir: base.agent.data_dir,
    healthPort: base.health.port,
    configDir,
    providerApiKeys: runtime.providerApiKeys,
    ollamaBaseUrl: runtime.ollamaBaseUrl,
    channels: runtime.channels,
  };
};
