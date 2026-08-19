import type { HairyClawLogger as Logger } from "@hairyclaw/observability";
import type { ZodSchema } from "zod";

export interface Tool {
  name: string;
  description: string;
  parameters: ZodSchema;
  permissions?: ToolPermissions;
  timeout_ms?: number;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  traceId: string;
  cwd: string;
  dataDir: string;
  logger: Logger;
  channelId?: string;
  /**
   * When set, ToolRegistry.execute denies any tool name not in this list —
   * regardless of what the caller passed — enforcing a named tool profile
   * (e.g. the child/sub-agent profile) at the point of execution rather than
   * only at tool-def construction time. Undefined means unrestricted (the
   * trusted primary operator boundary).
   */
  allowedTools?: readonly string[];
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /**
   * True when isError stems from input-shape validation (e.g. a Zod parse
   * failure on the tool's parameter schema), rather than execution failure.
   * The agent loop excludes these from its consecutive-error circuit-breaker
   * because the model can correct its arguments on the next iteration.
   */
  isValidationError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolPermissions {
  allowedPaths?: string[];
  blockedPaths?: string[];
  allowedCommands?: string[];
  blockedCommands?: string[];
  requireApproval?: boolean;
  networkAccess?: boolean;
}
