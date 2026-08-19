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
  autoAllow: ["read", "memory_recall", "memory_ingest", "web-search", "web-fetch"],
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

/**
 * Fail-closed handler: HairyClaw does not yet have a real asynchronous
 * /approve token exchange (an operator confirming a specific pending call
 * out-of-band before it executes). Rather than ship a handler that logs a
 * warning and then allows the call anyway — which is a fake approval gate —
 * every tool call that reaches this handler (i.e. every call ApprovalGate
 * decided needs explicit approval or is high/medium risk) is denied. This is
 * a known, intentional limitation of this release: high-impact tools that
 * match the approval policy are unavailable until a real approval channel
 * ships. See ApprovalGate / DEFAULT_APPROVAL_POLICY for what triggers this.
 */
export const failClosedApprovalHandler: ApprovalHandler = async (req) => {
  console.warn(
    `[APPROVAL REQUIRED — DENIED, NO APPROVAL CHANNEL] ${req.toolName}: ${req.reason} (risk: ${req.risk})`,
  );
  return "deny";
};

/**
 * @deprecated Use {@link failClosedApprovalHandler}. This name previously
 * implied a human could interactively approve requests, but it always
 * auto-allowed — a fake gate. Kept only so external callers importing the
 * old name fail loudly at the type level instead of silently getting the
 * old (unsafe) behavior back; it is defined as an alias of the fail-closed
 * handler.
 */
export const interactiveApprovalHandler: ApprovalHandler = failClosedApprovalHandler;
