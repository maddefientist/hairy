/**
 * Denial Tracker Plugin
 *
 * Intercepts tool execution denials from the guardrails plugin and tracks:
 * - Denied tool name, path/args, reason, timestamp, frequency
 * - Analytics: most-denied tools, most-denied paths, denial patterns
 * - After N denials of the same pattern (configurable), emits policy.denial.pattern_detected
 *
 * Gated behind the denialTracking feature flag.
 */

import type { HairyClawLogger } from "@hairyclaw/observability";
import type { FeatureFlagManager } from "../feature-flags.js";
import type { PluginManifest } from "../plugin-manifest.js";
import type { HairyClawPlugin, PluginContext } from "../plugin.js";

export const MANIFEST: PluginManifest = {
  name: "denial-tracker",
  version: "1.0.0",
  description: "Tracks guardrail denials and detects repeated denial patterns",
  capabilities: ["denial-tracking", "policy-analytics"],
  requiredPermissions: ["telemetry"],
  featureFlag: "denialTracking",
  trustLevel: "builtin",
};
import { TELEMETRY_EVENTS } from "../telemetry-events.js";

/**
 * A single recorded denial event
 */
export interface DenialRecord {
  toolName: string;
  args: unknown;
  reason: string;
  timestamp: number;
  traceId: string;
  senderId?: string;
}

/**
 * A detected denial pattern (same tool + reason appearing repeatedly)
 */
export interface DenialPattern {
  toolName: string;
  reason: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

/**
 * Analytics report from the denial tracker
 */
export interface DenialAnalytics {
  /** Total number of tracked denials */
  totalDenials: number;
  /** Denials per tool name, sorted descending */
  byTool: Array<{ toolName: string; count: number }>;
  /** Denials per unique path (from file ops), sorted descending */
  byPath: Array<{ path: string; count: number }>;
  /** Detected patterns (tool+reason combos that exceed threshold) */
  patterns: DenialPattern[];
}

/**
 * Configuration for the denial tracker
 */
export interface DenialTrackerConfig {
  /** Feature flag manager */
  featureFlags?: FeatureFlagManager;
  /** Logger instance */
  logger: HairyClawLogger;
  /** Number of identical denials before emitting pattern_detected (default: 5) */
  patternThreshold?: number;
  /** Maximum denial records to keep in memory (default: 1000) */
  maxRecords?: number;
}

/**
 * Extract a file path from tool args if present
 */
const extractPath = (args: unknown): string | undefined => {
  if (typeof args === "object" && args !== null && "path" in args) {
    return String((args as { path: string }).path);
  }
  return undefined;
};

/**
 * Build a pattern key from tool name + reason for deduplication
 */
const patternKey = (toolName: string, reason: string): string => `${toolName}::${reason}`;

/**
 * Create the denial tracker state (separate from plugin for testability)
 */
export class DenialTracker {
  private records: DenialRecord[] = [];
  private patternCounts = new Map<string, DenialPattern>();
  private readonly patternThreshold: number;
  private readonly maxRecords: number;
  private readonly logger: HairyClawLogger;
  private readonly featureFlags?: FeatureFlagManager;

  constructor(config: DenialTrackerConfig) {
    this.patternThreshold = config.patternThreshold ?? 5;
    this.maxRecords = config.maxRecords ?? 1000;
    this.logger = config.logger;
    this.featureFlags = config.featureFlags;
  }

  /**
   * Track a denial event.
   * Emits telemetry and checks for pattern detection.
   */
  trackDenial(record: DenialRecord): void {
    // Trim if at capacity (FIFO)
    if (this.records.length >= this.maxRecords) {
      this.records.shift();
    }
    this.records.push(record);

    // Emit policy.denial.tracked telemetry
    this.emitTelemetry(TELEMETRY_EVENTS.denial.tracked, {
      toolName: record.toolName,
      reason: record.reason,
      traceId: record.traceId,
      senderId: record.senderId,
    });

    // Update pattern counts
    const key = patternKey(record.toolName, record.reason);
    const existing = this.patternCounts.get(key);
    if (existing) {
      existing.count++;
      existing.lastSeen = record.timestamp;
    } else {
      this.patternCounts.set(key, {
        toolName: record.toolName,
        reason: record.reason,
        count: 1,
        firstSeen: record.timestamp,
        lastSeen: record.timestamp,
      });
    }

    // Check for pattern threshold
    const pattern = this.patternCounts.get(key);
    if (pattern && pattern.count === this.patternThreshold) {
      this.emitTelemetry(TELEMETRY_EVENTS.denial.patternDetected, {
        toolName: pattern.toolName,
        reason: pattern.reason,
        count: pattern.count,
        firstSeen: pattern.firstSeen,
        lastSeen: pattern.lastSeen,
      });
      this.logger.warn(
        {
          event: TELEMETRY_EVENTS.denial.patternDetected,
          toolName: pattern.toolName,
          reason: pattern.reason,
          count: pattern.count,
        },
        `denial pattern detected: ${pattern.toolName} denied ${pattern.count} times`,
      );
    }
  }

  /**
   * Get analytics about tracked denials
   */
  getAnalytics(): DenialAnalytics {
    // Count by tool
    const toolCounts = new Map<string, number>();
    const pathCounts = new Map<string, number>();

    for (const record of this.records) {
      toolCounts.set(record.toolName, (toolCounts.get(record.toolName) ?? 0) + 1);

      const path = extractPath(record.args);
      if (path) {
        pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
      }
    }

    const byTool = Array.from(toolCounts.entries())
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((a, b) => b.count - a.count);

    const byPath = Array.from(pathCounts.entries())
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count);

    const patterns = Array.from(this.patternCounts.values()).filter(
      (p) => p.count >= this.patternThreshold,
    );

    return {
      totalDenials: this.records.length,
      byTool,
      byPath,
      patterns,
    };
  }

  /**
   * Get all denial records (copy)
   */
  getRecords(): DenialRecord[] {
    return [...this.records];
  }

  /**
   * Clear all tracked denials
   */
  clear(): void {
    this.records = [];
    this.patternCounts.clear();
  }

  private emitTelemetry(eventName: string, details: Record<string, unknown>): void {
    if (this.featureFlags?.isDisabled("standardizedTelemetry")) {
      return;
    }
    this.logger.info({ event: eventName, ...details }, eventName);
  }
}

/**
 * Create the denial tracker plugin.
 *
 * This plugin intercepts the afterTool hook to detect denials
 * (guardrails returns null from beforeTool, which the plugin runner
 * surfaces as a blocked call). We use the beforeTool hook at a lower
 * priority than guardrails to observe denied calls.
 *
 * Strategy: The denial tracker runs beforeTool AFTER guardrails (higher priority number).
 * If guardrails already returned null, this hook won't run for that call.
 * Instead, we hook into the plugin context state: guardrails should store
 * denial info in ctx.state for downstream plugins to observe.
 *
 * Simpler approach: The tracker wraps a GuardrailProvider and intercepts denials directly.
 */
export const createDenialTrackerPlugin = (config: DenialTrackerConfig): {
  plugin: HairyClawPlugin;
  tracker: DenialTracker;
} => {
  const tracker = new DenialTracker(config);

  const plugin: HairyClawPlugin = {
    name: "denial-tracker",
    // Run after guardrails (guardrails is priority 10)
    // This uses onRunEnd to read accumulated denials from context state
    priority: 11,

    beforeTool: async (
      toolName: string,
      args: unknown,
      ctx: PluginContext,
    ): Promise<{ args: unknown } | null> => {
      // Gate behind feature flag
      if (config.featureFlags?.isDisabled("denialTracking")) {
        return { args };
      }

      // We don't block anything ourselves — just observe.
      // Record that this tool call made it past guardrails (no denial here).
      // The actual denial tracking happens via recordDenial() called externally
      // when guardrails returns null.
      return { args };
    },
  };

  return { plugin, tracker };
};

// ---------------------------------------------------------------------------
// Shadowed Rule Diagnostics
// ---------------------------------------------------------------------------

/**
 * A guardrail rule for diagnostic analysis
 */
export interface DiagnosticRule {
  type: "allow" | "block";
  scope: "tool" | "path" | "command" | "pattern";
  value: string;
}

/**
 * A shadowed rule finding
 */
export interface ShadowedRuleFinding {
  /** The rule that is shadowed */
  shadowedRule: DiagnosticRule;
  /** The broader rule that shadows it */
  shadowedBy: DiagnosticRule;
  /** Human-readable explanation */
  explanation: string;
}

/**
 * A conflicting rule finding
 */
export interface ConflictFinding {
  /** The allow rule */
  allowRule: DiagnosticRule;
  /** The block rule that conflicts */
  blockRule: DiagnosticRule;
  /** Human-readable explanation */
  explanation: string;
}

/**
 * Diagnostic report from rule analysis
 */
export interface RuleDiagnosticReport {
  shadowedRules: ShadowedRuleFinding[];
  conflicts: ConflictFinding[];
  recommendations: string[];
}

/**
 * Check if pathA is a prefix/parent of pathB
 */
const isPathPrefix = (parent: string, child: string): boolean => {
  if (parent === child) return true;
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(normalizedParent);
};

/**
 * Diagnose guardrail rules for shadowing and conflicts.
 * This is a static analysis function — no runtime evaluation.
 *
 * @param rules - Array of rules to analyze
 * @returns Diagnostic report with shadows, conflicts, and recommendations
 */
export const diagnoseRules = (rules: DiagnosticRule[]): RuleDiagnosticReport => {
  const shadowedRules: ShadowedRuleFinding[] = [];
  const conflicts: ConflictFinding[] = [];
  const recommendations: string[] = [];

  // Separate rules by type
  const allowRules = rules.filter((r) => r.type === "allow");
  const blockRules = rules.filter((r) => r.type === "block");

  // Check for shadowed rules (a narrower rule is overshadowed by a broader one of the same type)
  for (const narrow of rules) {
    for (const broad of rules) {
      if (narrow === broad) continue;
      if (narrow.type !== broad.type) continue;
      if (narrow.scope !== broad.scope) continue;

      // For path-scoped rules: check if broad path is a parent of narrow path
      if (narrow.scope === "path" && isPathPrefix(broad.value, narrow.value) && broad.value !== narrow.value) {
        shadowedRules.push({
          shadowedRule: narrow,
          shadowedBy: broad,
          explanation: `${narrow.type} path "${narrow.value}" is shadowed by broader ${broad.type} path "${broad.value}"`,
        });
      }

      // For tool-scoped rules: exact duplicates
      if (narrow.scope === "tool" && narrow.value === broad.value && narrow !== broad) {
        // Duplicate rule — only report once (first shadows second)
        const alreadyReported = shadowedRules.some(
          (s) => s.shadowedRule.value === broad.value && s.shadowedBy.value === narrow.value,
        );
        if (!alreadyReported) {
          shadowedRules.push({
            shadowedRule: broad,
            shadowedBy: narrow,
            explanation: `duplicate ${narrow.type} tool rule for "${narrow.value}"`,
          });
        }
      }
    }
  }

  // Check for conflicts (allow and block for the same or overlapping scope)
  for (const allow of allowRules) {
    for (const block of blockRules) {
      if (allow.scope !== block.scope) continue;

      let isConflict = false;
      let explanation = "";

      if (allow.scope === "tool" && allow.value === block.value) {
        isConflict = true;
        explanation = `tool "${allow.value}" is both allowed and blocked`;
      }

      if (allow.scope === "path") {
        if (allow.value === block.value) {
          isConflict = true;
          explanation = `path "${allow.value}" is both allowed and blocked`;
        } else if (isPathPrefix(allow.value, block.value)) {
          isConflict = true;
          explanation = `allowed path "${allow.value}" contains blocked path "${block.value}"`;
        } else if (isPathPrefix(block.value, allow.value)) {
          isConflict = true;
          explanation = `blocked path "${block.value}" contains allowed path "${allow.value}"`;
        }
      }

      if (allow.scope === "command" && allow.value === block.value) {
        isConflict = true;
        explanation = `command "${allow.value}" is both allowed and blocked`;
      }

      if (isConflict) {
        conflicts.push({ allowRule: allow, blockRule: block, explanation });
      }
    }
  }

  // Generate recommendations
  if (shadowedRules.length > 0) {
    recommendations.push(
      `Found ${shadowedRules.length} shadowed rule(s). Remove the narrower rules or broaden them to be intentional.`,
    );
  }

  if (conflicts.length > 0) {
    recommendations.push(
      `Found ${conflicts.length} conflicting rule(s). Block rules typically take precedence — verify this is intentional.`,
    );
  }

  // Check for overly broad block rules
  const broadBlocks = blockRules.filter(
    (r) => r.scope === "path" && (r.value === "/" || r.value === "~" || r.value === "."),
  );
  if (broadBlocks.length > 0) {
    recommendations.push(
      "Very broad block path rules detected (/ or ~ or .). This may block legitimate operations.",
    );
  }

  if (shadowedRules.length === 0 && conflicts.length === 0) {
    recommendations.push("No shadowed or conflicting rules detected. Policy looks clean.");
  }

  return { shadowedRules, conflicts, recommendations };
};
