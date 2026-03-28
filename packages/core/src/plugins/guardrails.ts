import type { HairyClawPlugin, PluginContext } from "../plugin.js";

// ---------------------------------------------------------------------------
// GuardrailProvider interface
// ---------------------------------------------------------------------------

export interface GuardrailRequest {
  toolName: string;
  toolArgs: unknown;
  senderId?: string;
  channelType?: string;
  traceId: string;
}

export interface GuardrailDecision {
  allow: boolean;
  reason?: string;
  code?: string; // e.g., "policy.blocked_command", "policy.blocked_path"
}

export interface GuardrailProvider {
  evaluate(request: GuardrailRequest): Promise<GuardrailDecision>;
}

// ---------------------------------------------------------------------------
// AllowlistProvider
// ---------------------------------------------------------------------------

export interface AllowlistConfig {
  /** If set, only these tools can execute */
  allowedTools?: string[];
  /** These tools are always blocked */
  blockedTools?: string[];

  /** Bash-specific rules */
  bash?: {
    allowedCommands?: string[];
    blockedCommands?: string[];
    blockedPatterns?: string[]; // regex pattern strings
  };

  /** File operation rules */
  fileOps?: {
    allowedPaths?: string[];
    blockedPaths?: string[];
  };

  /** Per-sender overrides (merged on top of base config) */
  senderOverrides?: Record<string, Partial<AllowlistConfig>>;
}

const BASH_TOOL_NAMES = new Set(["bash", "shell", "execute", "run_command"]);
const FILE_TOOL_NAMES = new Set(["read", "write", "edit", "read_file", "write_file", "edit_file"]);

const extractBashCommand = (args: unknown): string | null => {
  if (typeof args === "object" && args !== null && "command" in args) {
    return String((args as { command: string }).command);
  }
  return null;
};

const extractFilePath = (args: unknown): string | null => {
  if (typeof args === "object" && args !== null && "path" in args) {
    return String((args as { path: string }).path);
  }
  return null;
};

const evaluateToolLevel = (toolName: string, config: AllowlistConfig): GuardrailDecision | null => {
  if (config.blockedTools?.includes(toolName)) {
    return {
      allow: false,
      reason: `tool "${toolName}" is blocked by policy`,
      code: "policy.blocked_tool",
    };
  }

  if (config.allowedTools && !config.allowedTools.includes(toolName)) {
    return {
      allow: false,
      reason: `tool "${toolName}" is not in the allowlist`,
      code: "policy.tool_not_allowed",
    };
  }

  return null;
};

const evaluateBashRules = (
  command: string,
  bashConfig: NonNullable<AllowlistConfig["bash"]>,
): GuardrailDecision | null => {
  if (bashConfig.blockedCommands) {
    for (const blocked of bashConfig.blockedCommands) {
      if (command === blocked || command.startsWith(`${blocked} `) || command.includes(blocked)) {
        return {
          allow: false,
          reason: `bash command blocked: "${blocked}"`,
          code: "policy.blocked_command",
        };
      }
    }
  }

  if (bashConfig.blockedPatterns) {
    for (const patternStr of bashConfig.blockedPatterns) {
      const regex = new RegExp(patternStr);
      if (regex.test(command)) {
        return {
          allow: false,
          reason: `bash command matched blocked pattern: ${patternStr}`,
          code: "policy.blocked_pattern",
        };
      }
    }
  }

  if (bashConfig.allowedCommands) {
    const baseCommand = command.trim().split(/\s+/)[0] ?? "";
    if (!bashConfig.allowedCommands.includes(baseCommand)) {
      return {
        allow: false,
        reason: `bash command "${baseCommand}" is not in the allowlist`,
        code: "policy.command_not_allowed",
      };
    }
  }

  return null;
};

const evaluateFileRules = (
  filePath: string,
  fileConfig: NonNullable<AllowlistConfig["fileOps"]>,
): GuardrailDecision | null => {
  if (fileConfig.blockedPaths) {
    for (const blocked of fileConfig.blockedPaths) {
      if (
        filePath === blocked ||
        filePath.startsWith(`${blocked}/`) ||
        filePath.startsWith(blocked)
      ) {
        return {
          allow: false,
          reason: `file path blocked: "${blocked}"`,
          code: "policy.blocked_path",
        };
      }
    }
  }

  if (fileConfig.allowedPaths) {
    const inAllowed = fileConfig.allowedPaths.some(
      (allowed) =>
        filePath === allowed || filePath.startsWith(`${allowed}/`) || filePath.startsWith(allowed),
    );

    if (!inAllowed) {
      return {
        allow: false,
        reason: `file path "${filePath}" is not in any allowed path`,
        code: "policy.path_not_allowed",
      };
    }
  }

  return null;
};

const resolveConfig = (base: AllowlistConfig, senderId: string | undefined): AllowlistConfig => {
  if (!senderId || !base.senderOverrides?.[senderId]) {
    return base;
  }

  const override = base.senderOverrides[senderId];

  return {
    allowedTools: override.allowedTools ?? base.allowedTools,
    blockedTools: override.blockedTools ?? base.blockedTools,
    bash: override.bash ?? base.bash,
    fileOps: override.fileOps ?? base.fileOps,
    // Don't recurse senderOverrides
  };
};

export class AllowlistProvider implements GuardrailProvider {
  private readonly config: AllowlistConfig;

  constructor(config: AllowlistConfig) {
    this.config = config;
  }

  async evaluate(request: GuardrailRequest): Promise<GuardrailDecision> {
    const effectiveConfig = resolveConfig(this.config, request.senderId);

    // Tool-level check
    const toolDecision = evaluateToolLevel(request.toolName, effectiveConfig);
    if (toolDecision) {
      return toolDecision;
    }

    // Bash-specific checks
    if (BASH_TOOL_NAMES.has(request.toolName) && effectiveConfig.bash) {
      const command = extractBashCommand(request.toolArgs);
      if (command) {
        const bashDecision = evaluateBashRules(command, effectiveConfig.bash);
        if (bashDecision) {
          return bashDecision;
        }
      }
    }

    // File op checks
    if (FILE_TOOL_NAMES.has(request.toolName) && effectiveConfig.fileOps) {
      const path = extractFilePath(request.toolArgs);
      if (path) {
        const fileDecision = evaluateFileRules(path, effectiveConfig.fileOps);
        if (fileDecision) {
          return fileDecision;
        }
      }
    }

    return { allow: true };
  }
}

// ---------------------------------------------------------------------------
// Guardrail Plugin
// ---------------------------------------------------------------------------

export interface GuardrailPluginOptions {
  provider: GuardrailProvider;
  /** Default: true — block on provider error */
  failClosed?: boolean;
}

export const createGuardrailPlugin = (opts: GuardrailPluginOptions): HairyClawPlugin => {
  const { provider, failClosed = true } = opts;

  return {
    name: "guardrails",
    priority: 10, // Run early, before other plugins

    beforeTool: async (
      toolName: string,
      args: unknown,
      ctx: PluginContext,
    ): Promise<{ args: unknown } | null> => {
      const request: GuardrailRequest = {
        toolName,
        toolArgs: args,
        senderId: ctx.senderId,
        channelType: ctx.channelType,
        traceId: ctx.traceId,
      };

      try {
        const decision = await provider.evaluate(request);

        if (!decision.allow) {
          ctx.logger.warn(
            {
              toolName,
              reason: decision.reason,
              code: decision.code,
              traceId: ctx.traceId,
              senderId: ctx.senderId,
            },
            `guardrail blocked tool call: ${decision.reason ?? "policy denied"}`,
          );
          return null;
        }

        return { args };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        if (failClosed) {
          ctx.logger.warn(
            { toolName, error: message, traceId: ctx.traceId },
            "guardrail provider error — blocking tool call (fail-closed)",
          );
          return null;
        }

        ctx.logger.warn(
          { toolName, error: message, traceId: ctx.traceId },
          "guardrail provider error — allowing tool call (fail-open)",
        );
        return { args };
      }
    },
  };
};
