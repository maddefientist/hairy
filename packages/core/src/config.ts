import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { z } from "zod";

const providerSchema = z.object({
  enabled: z.boolean().default(false),
  default_model: z.string().min(1),
  api_key: z.string().optional(),
  base_url: z.string().url().optional(),
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
  providers: z
    .object({
      anthropic: providerSchema.optional(),
      openrouter: providerSchema.optional(),
      ollama: providerSchema.optional(),
    })
    .default({}),
  routing: z
    .object({
      default_provider: z.string().default("anthropic"),
      fallback_chain: z.array(z.string()).default(["anthropic"]),
    })
    .default({ default_provider: "anthropic", fallback_chain: ["anthropic"] }),
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
