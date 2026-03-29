import type { HairyClawLogger } from "@hairyclaw/observability";

export interface ProfileHealth {
  lastUsed?: number;
  lastSuccess?: number;
  lastFailureAt?: number;
  errorCount: number;
  consecutiveErrors: number;
  cooldownUntil?: number;
  failureCounts: Record<string, number>;
}

export interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  exclusive?: boolean;
  handler: (args: string, ctx: CommandContext) => Promise<string | null>;
}

export interface CommandContext {
  channelType: string;
  channelId: string;
  senderId: string;
  runtime: CommandRuntime;
}

export interface UpdateResult {
  success: boolean;
  previousVersion: string;
  currentVersion: string;
  changes: string;
  error?: string;
}

export interface CommandRuntime {
  getModelInfo(): { primary: string; fallbacks: string[] };
  setPrimaryModel?: (model: string) => boolean;
  getProviderHealth(): Map<string, ProfileHealth>;
  clearCooldowns?: () => void;
  getUptime(): number;
  getMetrics(): Record<string, number>;
  getQueueStats(): { pending: number; deadLetters: number };
  getVersion?: () => string;
  selfUpdate?: () => Promise<UpdateResult>;
}

const noopLogger: HairyClawLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
};

const formatHealth = (health: Map<string, ProfileHealth>): string => {
  if (health.size === 0) {
    return "No provider profiles loaded.";
  }

  const now = Date.now();
  return Array.from(health.entries())
    .map(([id, stats]) => {
      const cooldownUntil = stats.cooldownUntil;
      const inCooldown = typeof cooldownUntil === "number" && cooldownUntil > now;
      const cooldownText = inCooldown
        ? `cooldown until ${new Date(cooldownUntil).toISOString()}`
        : "ready";
      return [
        `- ${id}`,
        `  status: ${cooldownText}`,
        `  errors: total=${stats.errorCount}, consecutive=${stats.consecutiveErrors}`,
        `  failures: ${JSON.stringify(stats.failureCounts)}`,
      ].join("\n");
    })
    .join("\n");
};

export class CommandRouter {
  private readonly commands = new Map<string, CommandDef>();
  private readonly aliases = new Map<string, string>();

  constructor(private readonly logger: HairyClawLogger = noopLogger) {
    this.registerBuiltins();
  }

  register(command: CommandDef): void {
    this.commands.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      this.aliases.set(alias, command.name);
    }
  }

  async route(text: string, ctx: CommandContext): Promise<string | null> {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      return null;
    }

    const withoutSlash = trimmed.slice(1).trim();
    if (withoutSlash.length === 0) {
      return null;
    }

    const [rawName, ...rest] = withoutSlash.split(/\s+/);
    const args = rest.join(" ").trim();

    const commandName = this.aliases.get(rawName) ?? rawName;
    const command = this.commands.get(commandName);

    if (!command) {
      return null;
    }

    try {
      const result = await command.handler(args, ctx);
      if (result === null && command.exclusive) {
        return "";
      }
      return result;
    } catch (error: unknown) {
      this.logger.error(
        {
          command: command.name,
          error: error instanceof Error ? error.message : String(error),
        },
        "command failed",
      );
      return "Command failed. Check logs for details.";
    }
  }

  listCommands(): CommandDef[] {
    return Array.from(this.commands.values()).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  private registerBuiltins(): void {
    this.register({
      name: "help",
      description: "List available commands",
      exclusive: true,
      handler: async () => {
        const lines = this.listCommands().map((cmd) => {
          const aliases =
            (cmd.aliases ?? []).length > 0 ? ` (aliases: ${(cmd.aliases ?? []).join(", ")})` : "";
          return `/${cmd.name}${aliases} — ${cmd.description}`;
        });
        return ["Available commands:", ...lines].join("\n");
      },
    });

    this.register({
      name: "status",
      description: "Show runtime status snapshot",
      exclusive: true,
      handler: async (_args, ctx) => {
        const model = ctx.runtime.getModelInfo();
        const queue = ctx.runtime.getQueueStats();
        const metrics = ctx.runtime.getMetrics();

        return [
          "Status",
          `- Uptime: ${formatDuration(ctx.runtime.getUptime())}`,
          `- Model: ${model.primary}`,
          `- Fallbacks: ${model.fallbacks.join(", ") || "none"}`,
          `- Queue: pending=${queue.pending}, deadLetters=${queue.deadLetters}`,
          `- Metrics: ${Object.entries(metrics)
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")}`,
        ].join("\n");
      },
    });

    this.register({
      name: "model",
      aliases: ["m"],
      description: "Show or switch active model",
      exclusive: true,
      handler: async (args, ctx) => {
        if (args.length === 0) {
          const info = ctx.runtime.getModelInfo();
          return [
            `Primary model: ${info.primary}`,
            `Fallbacks: ${info.fallbacks.join(", ") || "none"}`,
          ].join("\n");
        }

        if (!ctx.runtime.setPrimaryModel) {
          return "Model switching is not enabled in this runtime.";
        }

        const switched = ctx.runtime.setPrimaryModel(args);
        return switched ? `Primary model switched to ${args}` : `Unknown model alias: ${args}`;
      },
    });

    this.register({
      name: "health",
      description: "Show provider profile health",
      exclusive: true,
      handler: async (_args, ctx) => {
        return ["Provider health:", formatHealth(ctx.runtime.getProviderHealth())].join("\n");
      },
    });

    this.register({
      name: "clear",
      description: "Clear provider cooldowns",
      exclusive: true,
      handler: async (_args, ctx) => {
        if (ctx.runtime.clearCooldowns) {
          ctx.runtime.clearCooldowns();
          return "Cleared provider cooldowns.";
        }
        return "Cooldown clearing is not enabled in this runtime.";
      },
    });

    this.register({
      name: "queue",
      description: "Show delivery queue stats",
      exclusive: true,
      handler: async (_args, ctx) => {
        const queue = ctx.runtime.getQueueStats();
        return `Queue pending=${queue.pending}, deadLetters=${queue.deadLetters}`;
      },
    });

    this.register({
      name: "version",
      aliases: ["v"],
      description: "Show current version/commit",
      exclusive: true,
      handler: async (_args, ctx) => {
        if (!ctx.runtime.getVersion) {
          return "Version info not available.";
        }
        return ctx.runtime.getVersion();
      },
    });

    this.register({
      name: "update",
      aliases: ["upgrade"],
      description: "Self-update: pull latest code, rebuild, and restart",
      exclusive: true,
      handler: async (_args, ctx) => {
        if (!ctx.runtime.selfUpdate) {
          return "Self-update is not enabled in this runtime.";
        }

        const result = await ctx.runtime.selfUpdate();
        if (!result.success) {
          return [
            "❌ Update failed",
            `Error: ${result.error ?? "unknown"}`,
            `Version: ${result.previousVersion} (unchanged)`,
          ].join("\n");
        }

        if (result.previousVersion === result.currentVersion) {
          return `✅ Already up to date (${result.currentVersion})`;
        }

        return [
          "✅ Update successful — restarting...",
          `${result.previousVersion} → ${result.currentVersion}`,
          result.changes ? `\nChanges:\n${result.changes}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    });
  }
}
