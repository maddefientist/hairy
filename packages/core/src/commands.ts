import type { HairyClawLogger } from "@hairyclaw/observability";

/**
 * Durable model-selection role. "brain" is the fast conversational
 * controller/planner (also the target of legacy /model use|fallback|test|
 * rollback for backward compatibility). "hands" is the technical executor
 * for coding, system design, debugging, and explicit machine-exploration
 * delegation.
 */
export type ModelRole = "brain" | "hands";

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
  /**
   * True for commands that change persistent runtime state (self-update, cooldown
   * resets, model selection, etc). Mutating commands are denied unless
   * `ctx.runtime.isOperator(ctx.senderId)` returns true. Sub-command-level
   * authorization (e.g. "/model list" vs "/model use") is the handler's own
   * responsibility — see the built-in "model" command.
   */
  mutating?: boolean;
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

export interface ModelCatalogEntrySummary {
  id: string;
  label: string;
  available: boolean;
  unavailableReason?: string;
}

export interface CircuitStateSummary {
  state: string;
  failures: number;
  remainingCooldownMs: number;
}

export interface ModelStatusSnapshot {
  /**
   * The durably-configured primary model id (what /model use last set /
   * what is persisted). This is configuration state, not a claim that this
   * id actually served the last request — it may be unavailable right now,
   * or have never been successfully attempted.
   */
  configuredPrimaryId: string;
  configuredFallbackIds: string[];
  /**
   * The provider/model attempt chain resolved from the configured primary +
   * fallbacks against current catalog availability (chain[0] = attempt
   * zero), and any warnings produced while resolving it (e.g. "requested
   * primary is unavailable; using safe default").
   */
  resolvedChain: string[];
  resolvedWarnings: string[];
  /**
   * "<provider>/<model>" of the most recent request that actually completed
   * successfully on the primary gateway, if any is known yet. Undefined
   * means no successful call has completed since the gateway was last
   * (re)built — never inferred from configured state.
   */
  lastSuccessfulModel?: string;
  updatedAt: number;
  updatedBy: string;
  circuits: Record<string, CircuitStateSummary>;
  rateLimits: Record<string, { remaining: number; resetAtMs: number }>;
}

export interface ModelCommandResult {
  ok: boolean;
  message: string;
}

/**
 * Role-scoped variant of ModelStatusSnapshot for brain_hands mode: everything
 * in the base snapshot plus which role it describes and the latency of the
 * most recent successful call on that role's own gateway (undefined if no
 * successful call has completed yet on this role's gateway instance).
 */
export interface RoleModelStatusSnapshot extends ModelStatusSnapshot {
  role: ModelRole;
  lastSuccessLatencyMs?: number;
}

export interface CommandRuntime {
  /**
   * Operator allowlist check, bound to BOTH channel type and sender id —
   * never sender id alone. A bare sender id (e.g. a Telegram numeric user
   * id) is not a secret and is not unique across channels/transports, so an
   * unscoped check would let a caller on one channel (e.g. a webhook request
   * with an attacker-supplied body field) impersonate an operator identity
   * that is only meaningful on another, authenticated channel (e.g.
   * Telegram). Implementations should compare against channel-scoped
   * identifiers such as "telegram:<senderId>", and must return false (deny)
   * when the allowlist is empty/unconfigured or when the identity cannot be
   * trusted for this channel type — there is no implicit "allow everyone"
   * fallback for mutating commands.
   */
  isOperator(channelType: string, senderId: string): boolean;
  getModelInfo(): { primary: string; fallbacks: string[] };
  setPrimaryModel?: (model: string) => boolean;
  getProviderHealth(): Map<string, ProfileHealth>;
  clearCooldowns?: () => void;
  getUptime(): number;
  getMetrics(): Record<string, number>;
  getQueueStats(): { pending: number; deadLetters: number };
  getVersion?: () => string;
  selfUpdate?: () => Promise<UpdateResult>;
  /** Bounded, redacted runtime diagnostics for /debug. */
  getDebugSnapshot?: () => Record<string, unknown>;

  // ── Model catalog / durable selection (all optional: runtimes that don't
  //    wire a catalog + store simply report the feature as unavailable) ──
  listModelCatalog?: () => ModelCatalogEntrySummary[];
  getModelStatus?: () => ModelStatusSnapshot;
  useModel?: (id: string, actor: string) => Promise<ModelCommandResult>;
  setModelFallbacks?: (ids: string[], actor: string) => Promise<ModelCommandResult>;
  testModel?: (id: string) => Promise<ModelCommandResult>;
  rollbackModel?: (actor: string) => Promise<ModelCommandResult>;

  // ── Role-aware model selection (brain_hands / orchestrator mode only).
  //    Runtimes that don't run in brain_hands mode simply don't wire these,
  //    and "/model brain ..." / "/model hands ..." report the feature as
  //    unavailable. The legacy hooks above (useModel, setModelFallbacks,
  //    testModel, rollbackModel, getModelStatus) remain the unified/brain
  //    alias and keep working unchanged in both modes. ──
  isRoleAwareModelSelectionEnabled?: () => boolean;
  getModelStatusForRole?: (role: ModelRole) => RoleModelStatusSnapshot;
  useModelForRole?: (role: ModelRole, id: string, actor: string) => Promise<ModelCommandResult>;
  setModelFallbacksForRole?: (
    role: ModelRole,
    ids: string[],
    actor: string,
  ) => Promise<ModelCommandResult>;
  testModelForRole?: (role: ModelRole, id: string) => Promise<ModelCommandResult>;
  rollbackModelForRole?: (role: ModelRole, actor: string) => Promise<ModelCommandResult>;
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

    if (command.mutating && !this.isAuthorized(ctx)) {
      this.logger.warn(
        { command: command.name, senderId: ctx.senderId, channelType: ctx.channelType },
        "mutating command denied: sender is not on the operator allowlist",
      );
      return "Not authorized. This command requires operator access, and no operator authorized it.";
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

  /** Deny-safe by construction: any error evaluating isOperator is treated as "not authorized". */
  private isAuthorized(ctx: CommandContext): boolean {
    try {
      return ctx.runtime.isOperator(ctx.channelType, ctx.senderId) === true;
    } catch (error: unknown) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "isOperator check threw; denying by default",
      );
      return false;
    }
  }

  private readonly NOT_AUTHORIZED =
    "Not authorized. This command requires operator access, and no operator authorized it.";

  private async handleModelCommand(args: string, ctx: CommandContext): Promise<string> {
    const [rawSub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const sub = (rawSub ?? "").toLowerCase();
    const subArgs = rest.join(" ").trim();

    if (sub === "brain" || sub === "hands") {
      return this.handleRoleModelCommand(sub, subArgs, ctx);
    }

    if (sub.length === 0 || sub === "status") {
      return this.modelStatusText(ctx);
    }

    if (sub === "list") {
      if (!ctx.runtime.listModelCatalog) {
        return "Model catalog is not enabled in this runtime.";
      }
      const entries = ctx.runtime.listModelCatalog();
      if (entries.length === 0) return "Model catalog is empty.";
      return [
        "Model catalog:",
        ...entries.map((entry) =>
          entry.available
            ? `- ${entry.id} — ${entry.label}`
            : `- ${entry.id} — ${entry.label} [unavailable: ${entry.unavailableReason ?? "not provisioned"}]`,
        ),
      ].join("\n");
    }

    if (sub === "use") {
      if (!this.isAuthorized(ctx)) return this.NOT_AUTHORIZED;
      if (!ctx.runtime.useModel) return "Model switching is not enabled in this runtime.";
      if (subArgs.length === 0) return "Usage: /model use <provider/model>";
      const result = await ctx.runtime.useModel(subArgs, ctx.senderId);
      return result.message;
    }

    if (sub === "fallback") {
      if (!this.isAuthorized(ctx)) return this.NOT_AUTHORIZED;
      if (!ctx.runtime.setModelFallbacks)
        return "Fallback configuration is not enabled in this runtime.";
      const ids = subArgs
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const result = await ctx.runtime.setModelFallbacks(ids, ctx.senderId);
      return result.message;
    }

    if (sub === "test") {
      if (!this.isAuthorized(ctx)) return this.NOT_AUTHORIZED;
      if (!ctx.runtime.testModel) return "Model testing is not enabled in this runtime.";
      if (subArgs.length === 0) return "Usage: /model test <provider/model>";
      const result = await ctx.runtime.testModel(subArgs);
      return result.message;
    }

    if (sub === "rollback") {
      if (!this.isAuthorized(ctx)) return this.NOT_AUTHORIZED;
      if (!ctx.runtime.rollbackModel) return "Model rollback is not enabled in this runtime.";
      const result = await ctx.runtime.rollbackModel(ctx.senderId);
      return result.message;
    }

    // Legacy syntax: "/model <alias>" switches the primary model directly.
    if (!this.isAuthorized(ctx)) return this.NOT_AUTHORIZED;
    if (!ctx.runtime.setPrimaryModel) return "Model switching is not enabled in this runtime.";
    const switched = ctx.runtime.setPrimaryModel(args);
    return switched ? `Primary model switched to ${args}` : `Unknown model alias: ${args}`;
  }

  private modelStatusText(ctx: CommandContext): string {
    if (ctx.runtime.getModelStatus) {
      const status = ctx.runtime.getModelStatus();
      const circuitLines = Object.entries(status.circuits).map(
        ([provider, c]) =>
          `  - ${provider}: ${c.state} (failures=${c.failures}, cooldown=${c.remainingCooldownMs}ms)`,
      );
      const rateLimitLines = Object.entries(status.rateLimits).map(
        ([provider, r]) =>
          `  - ${provider}: remaining=${r.remaining}, resetAt=${new Date(r.resetAtMs).toISOString()}`,
      );
      return [
        // Deliberately distinct labels: "configured" is durable selection
        // state, "resolved" is what would actually be attempted right now
        // given current catalog availability, and "last successful" is what
        // actually worked most recently — never collapse these into one
        // "primary" line, since they can legitimately differ (e.g. the
        // configured id just went unavailable and resolution fell back).
        `Configured primary: ${status.configuredPrimaryId}`,
        `Configured fallbacks: ${status.configuredFallbackIds.join(", ") || "none"}`,
        `Resolved attempt chain: ${status.resolvedChain.join(" -> ") || "(none)"}`,
        ...(status.resolvedWarnings.length > 0
          ? [`Resolution warnings: ${status.resolvedWarnings.join(" | ")}`]
          : []),
        `Last successful: ${status.lastSuccessfulModel ?? "(none yet on this gateway)"}`,
        `Last changed: ${new Date(status.updatedAt).toISOString()} by ${status.updatedBy}`,
        "Circuit state:",
        ...(circuitLines.length > 0 ? circuitLines : ["  (none)"]),
        "Rate limits:",
        ...(rateLimitLines.length > 0 ? rateLimitLines : ["  (none)"]),
      ].join("\n");
    }

    const info = ctx.runtime.getModelInfo();
    return [
      `Primary model: ${info.primary}`,
      `Fallbacks: ${info.fallbacks.join(", ") || "none"}`,
    ].join("\n");
  }

  /**
   * Handles "/model brain ..." and "/model hands ...". Sub-command shape
   * mirrors the legacy (role-less) /model command: [list|status|use
   * <id>|fallback <ids>|test <id>|rollback]. "list" is intentionally
   * omitted — the catalog is shared across roles and already reachable via
   * plain "/model list".
   */
  private async handleRoleModelCommand(
    role: ModelRole,
    args: string,
    ctx: CommandContext,
  ): Promise<string> {
    if (!ctx.runtime.isRoleAwareModelSelectionEnabled?.()) {
      return "Role-aware model selection (brain/hands) is not enabled in this runtime. This agent is not running in brain_hands/orchestrator mode.";
    }

    const [rawSub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const sub = (rawSub ?? "status").toLowerCase();
    const subArgs = rest.join(" ").trim();

    if (sub === "status" || sub.length === 0) {
      return this.roleModelStatusText(role, ctx);
    }

    if (sub === "use") {
      if (!this.isAuthorized(ctx)) return this.NOT_AUTHORIZED;
      if (!ctx.runtime.useModelForRole) return `Model switching for "${role}" is not enabled.`;
      if (subArgs.length === 0) return `Usage: /model ${role} use <provider/model>`;
      const result = await ctx.runtime.useModelForRole(role, subArgs, ctx.senderId);
      return result.message;
    }

    if (sub === "fallback") {
      if (!this.isAuthorized(ctx)) return this.NOT_AUTHORIZED;
      if (!ctx.runtime.setModelFallbacksForRole)
        return `Fallback configuration for "${role}" is not enabled.`;
      const ids = subArgs
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const result = await ctx.runtime.setModelFallbacksForRole(role, ids, ctx.senderId);
      return result.message;
    }

    if (sub === "test") {
      if (!this.isAuthorized(ctx)) return this.NOT_AUTHORIZED;
      if (!ctx.runtime.testModelForRole) return `Model testing for "${role}" is not enabled.`;
      if (subArgs.length === 0) return `Usage: /model ${role} test <provider/model>`;
      const result = await ctx.runtime.testModelForRole(role, subArgs);
      return result.message;
    }

    if (sub === "rollback") {
      if (!this.isAuthorized(ctx)) return this.NOT_AUTHORIZED;
      if (!ctx.runtime.rollbackModelForRole) return `Model rollback for "${role}" is not enabled.`;
      const result = await ctx.runtime.rollbackModelForRole(role, ctx.senderId);
      return result.message;
    }

    return `Unknown /model ${role} subcommand "${sub}". Use: status|use|fallback|test|rollback.`;
  }

  private roleModelStatusText(role: ModelRole, ctx: CommandContext): string {
    if (!ctx.runtime.getModelStatusForRole) {
      return `Role-aware status for "${role}" is not enabled in this runtime.`;
    }
    const status = ctx.runtime.getModelStatusForRole(role);
    const circuitLines = Object.entries(status.circuits).map(
      ([provider, c]) =>
        `  - ${provider}: ${c.state} (failures=${c.failures}, cooldown=${c.remainingCooldownMs}ms)`,
    );
    const rateLimitLines = Object.entries(status.rateLimits).map(
      ([provider, r]) =>
        `  - ${provider}: remaining=${r.remaining}, resetAt=${new Date(r.resetAtMs).toISOString()}`,
    );
    return [
      `Role: ${status.role}`,
      `Configured primary: ${status.configuredPrimaryId}`,
      `Configured fallbacks: ${status.configuredFallbackIds.join(", ") || "none"}`,
      `Resolved attempt chain: ${status.resolvedChain.join(" -> ") || "(none)"}`,
      ...(status.resolvedWarnings.length > 0
        ? [`Resolution warnings: ${status.resolvedWarnings.join(" | ")}`]
        : []),
      `Last successful: ${status.lastSuccessfulModel ?? "(none yet on this role's gateway)"}${
        status.lastSuccessLatencyMs !== undefined
          ? ` (latency ${status.lastSuccessLatencyMs}ms)`
          : ""
      }`,
      `Last changed: ${new Date(status.updatedAt).toISOString()} by ${status.updatedBy}`,
      "Circuit state:",
      ...(circuitLines.length > 0 ? circuitLines : ["  (none)"]),
      "Rate limits:",
      ...(rateLimitLines.length > 0 ? rateLimitLines : ["  (none)"]),
    ].join("\n");
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
      description:
        "Model catalog & selection: /model [list|status|use <id>|fallback <id1,id2,...>|test <id>|rollback]",
      exclusive: true,
      handler: async (args, ctx) => this.handleModelCommand(args, ctx),
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
      name: "debug",
      description: "Show bounded, redacted runtime diagnostics",
      exclusive: true,
      handler: async (_args, ctx) => {
        if (!this.isAuthorized(ctx)) return this.NOT_AUTHORIZED;
        if (!ctx.runtime.getDebugSnapshot) {
          return "Debug diagnostics are not enabled in this runtime.";
        }
        const snapshot = ctx.runtime.getDebugSnapshot();
        return ["Debug snapshot:", JSON.stringify(snapshot, null, 2)].join("\n");
      },
    });

    this.register({
      name: "clear",
      description: "Clear provider cooldowns",
      exclusive: true,
      mutating: true,
      handler: async (_args, ctx) => {
        if (ctx.runtime.clearCooldowns) {
          ctx.runtime.clearCooldowns();
          return "Cleared provider cooldowns.";
        }
        return "Cooldown clearing is not enabled in this runtime.";
      },
    });

    this.register({
      name: "approve",
      description: "Approve a pending high-impact tool call (not available in this release)",
      exclusive: true,
      mutating: true,
      handler: async () => {
        // HairyClaw does not yet have a real asynchronous approval-token exchange that
        // can safely correlate this command with a specific pending tool call. Rather
        // than fake an approval, this is explicit: high-impact tools stay denied.
        return [
          "Approval workflow is not available in this release.",
          "High-impact tool calls (destructive bash, config writes, network installs, etc.) are denied by default — there is no way to approve a specific pending call yet.",
          "Run the action directly as the operator if it's genuinely needed.",
        ].join("\n");
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
      mutating: true,
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
