import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { z } from "zod";

const providerSchema = z.object({
  enabled: z.boolean().default(false),
  default_model: z.string().min(1),
  fallback_model: z.string().optional(),
  api_key: z.string().optional(),
  base_url: z.string().url().optional(),
});

const channelsSchema = z.object({
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(["bot", "mtproto"]).default("bot"),
      bot_token: z.string().optional(),
      allowed_chat_ids: z.array(z.string()).optional(),
      session_file: z.string().optional(),
    })
    .default({ enabled: false, mode: "bot" }),
  whatsapp: z
    .object({
      enabled: z.boolean().default(false),
      session_dir: z.string().optional(),
      allowed_jids: z.array(z.string()).optional(),
    })
    .default({ enabled: false }),
  webhook: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().positive().default(8080),
      secret: z.string().optional(),
    })
    .default({ enabled: false, port: 8080 }),
  cli: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
});

const growthSchema = z.object({
  reflection_enabled: z.boolean().default(true),
  initiative_enabled: z.boolean().default(false),
  skill_auto_promote: z.boolean().default(false),
});

const toolsSchema = z.object({
  bash: z
    .object({
      timeout_ms: z.number().int().positive().default(30000),
      max_output_bytes: z.number().int().positive().default(1_048_576),
    })
    .default({ timeout_ms: 30000, max_output_bytes: 1_048_576 }),
  sidecar: z
    .object({
      auto_build: z.boolean().default(true),
      health_check_interval_ms: z.number().int().positive().default(30000),
    })
    .default({ auto_build: true, health_check_interval_ms: 30000 }),
});

const configSchema = z.object({
  agent: z.object({
    name: z.string().default("Hairy"),
    data_dir: z.string().default("./data"),
    max_iterations_per_run: z.number().int().positive().default(25),
    max_context_tokens: z.number().int().positive().default(100000),
  }),
  health: z.object({
    port: z.number().int().positive().default(9090),
  }),
  channels: channelsSchema.default({
    telegram: { enabled: false, mode: "bot" },
    whatsapp: { enabled: false },
    webhook: { enabled: false, port: 8080 },
    cli: { enabled: true },
  }),
  providers: z
    .object({
      anthropic: providerSchema.optional(),
      openrouter: providerSchema.optional(),
      ollama: providerSchema.optional(),
      gemini: providerSchema.optional(),
    })
    .default({}),
  routing: z
    .object({
      default_provider: z.string().default("anthropic"),
      fallback_chain: z.array(z.string()).default(["anthropic"]),
      rules: z
        .record(
          z.object({
            provider: z.string(),
            model: z.string(),
          }),
        )
        .optional(),
      cost: z
        .object({
          track: z.boolean().default(true),
          daily_budget_usd: z.number().positive().default(10),
          alert_threshold_pct: z.number().min(0).max(100).default(80),
        })
        .default({ track: true, daily_budget_usd: 10, alert_threshold_pct: 80 }),
    })
    .default({ default_provider: "anthropic", fallback_chain: ["anthropic"] }),
  growth: growthSchema.default({
    reflection_enabled: true,
    initiative_enabled: false,
    skill_auto_promote: false,
  }),
  tools: toolsSchema.default({
    bash: { timeout_ms: 30000, max_output_bytes: 1_048_576 },
    sidecar: { auto_build: true, health_check_interval_ms: 30000 },
  }),
});

export type HairyConfig = z.infer<typeof configSchema>;

const parseTomlFile = async (path: string): Promise<Record<string, unknown>> => {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = TOML.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const mergeObjects = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (
      typeof current === "object" &&
      current !== null &&
      !Array.isArray(current) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = mergeObjects(
        current as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
};

export const loadConfig = async (configDir = "config"): Promise<HairyConfig> => {
  const defaults = await parseTomlFile(join(configDir, "default.toml"));

  const envOverride: Record<string, unknown> = {
    health: {
      port: process.env.HAIRY_HEALTH_PORT ? Number(process.env.HAIRY_HEALTH_PORT) : undefined,
    },
  };

  const merged = mergeObjects(defaults, envOverride);
  return configSchema.parse(merged);
};
