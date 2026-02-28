import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "@hairy/core";
import { z } from "zod";

const runtimeSchema = z.object({
  providerApiKeys: z.object({
    anthropic: z.string().optional(),
    openrouter: z.string().optional(),
  }),
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
  };
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
    },
    channels: {
      telegramToken: process.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: process.env.WEBHOOK_SECRET,
    },
  });

  const hasProvider = Boolean(
    runtime.providerApiKeys.anthropic || runtime.providerApiKeys.openrouter,
  );
  if (!hasProvider) {
    throw new Error(
      "At least one provider key must be set: ANTHROPIC_API_KEY or OPENROUTER_API_KEY",
    );
  }

  return {
    dataDir: base.agent.data_dir,
    healthPort: base.health.port,
    configDir,
    providerApiKeys: runtime.providerApiKeys,
    channels: runtime.channels,
  };
};
