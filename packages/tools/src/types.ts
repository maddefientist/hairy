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
}

export interface ToolResult {
  content: string;
  isError?: boolean;
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
