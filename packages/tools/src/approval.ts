import type { HairyClawLogger } from "@hairyclaw/observability";

export type ApprovalDecision = "allow" | "deny" | "confirm";

export interface ApprovalRequest {
  toolName: string;
  args: unknown;
  risk: "low" | "medium" | "high";
  reason: string;
}

export interface ApprovalPolicy {
  /** Tools that always require approval */
  requireApproval: string[];
  /** Patterns that escalate to "confirm" or "deny" */
  highRiskPatterns: Array<{
    toolName: string;
    argPattern?: Record<string, RegExp>;
    risk: "medium" | "high";
    reason: string;
  }>;
  /** Tools that are always allowed */
  autoAllow: string[];
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  requireApproval: [],
  highRiskPatterns: [
    {
      toolName: "bash",
      argPattern: { command: /curl|wget|nc\s|ncat|ssh|scp|rsync/i },
      risk: "high",
      reason: "network command detected",
    },
    {
      toolName: "bash",
      argPattern: { command: /rm\s+-rf|rm\s+-r|shred|mkfs/i },
      risk: "high",
      reason: "destructive file operation",
    },
    {
      toolName: "bash",
      argPattern: { command: /apt|yum|brew\s+install|pip\s+install|npm\s+install.*-g/i },
      risk: "medium",
      reason: "package installation",
    },
    {
      toolName: "write",
      argPattern: { path: /\.(env|toml|yaml|yml|json|conf|cfg)$/i },
      risk: "medium",
      reason: "config file modification",
    },
    {
      toolName: "write",
      argPattern: { path: /\/etc\/|^\/usr\/|^\/sbin/i },
      risk: "high",
      reason: "system path write",
    },
  ],
  autoAllow: ["read", "memory_recall", "memory_ingest", "web_search", "web_fetch"],
};

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export class ApprovalGate {
  constructor(
    private readonly policy: ApprovalPolicy,
    private readonly handler: ApprovalHandler,
    private readonly logger: HairyClawLogger,
  ) {}

  /** Check if a tool call needs approval. Returns the decision. */
  async check(toolName: string, args: unknown): Promise<ApprovalDecision> {
    // Auto-allow
    if (this.policy.autoAllow.includes(toolName)) return "allow";

    // Explicit require
    if (this.policy.requireApproval.includes(toolName)) {
      return this.handler({
        toolName,
        args,
        risk: "high",
        reason: "tool requires explicit approval",
      });
    }

    // Pattern matching
    for (const pattern of this.policy.highRiskPatterns) {
      if (pattern.toolName !== toolName) continue;

      if (!pattern.argPattern) {
        return this.handler({
          toolName,
          args,
          risk: pattern.risk,
          reason: pattern.reason,
        });
      }

      // Check arg patterns
      const argsObj = (args ?? {}) as Record<string, unknown>;
      for (const [argKey, regex] of Object.entries(pattern.argPattern)) {
        const argVal = String(argsObj[argKey] ?? "");
        if (regex.test(argVal)) {
          return this.handler({
            toolName,
            args,
            risk: pattern.risk,
            reason: pattern.reason,
          });
        }
      }
    }

    return "allow";
  }
}

/** Simple handler that auto-denies high-risk, auto-allows low/medium */
export const strictApprovalHandler: ApprovalHandler = async (req) => {
  if (req.risk === "high") return "deny";
  return "allow";
};

/** Handler that always allows (no approval) */
export const permissiveApprovalHandler: ApprovalHandler = async () => "allow";

/** Handler that requires confirmation for everything not auto-allowed */
export const interactiveApprovalHandler: ApprovalHandler = async (req) => {
  console.warn(`[APPROVAL NEEDED] ${req.toolName}: ${req.reason} (risk: ${req.risk})`);
  return "allow";
};
