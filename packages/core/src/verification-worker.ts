/**
 * Verification Worker Pattern
 *
 * Spawns a subagent in 'fresh' mode with a verification-specific system prompt
 * to validate proposed outputs against criteria.
 *
 * Gated behind the verificationWorker feature flag.
 *
 * Usage:
 *   const worker = createVerificationWorker(subagentExecutor, { ... });
 *   const verdict = await worker.verify({ task, output, criteria });
 */

import type { HairyClawLogger } from "@hairyclaw/observability";
import type { AgentLoopProvider, ToolExecutor } from "./agent-loop.js";
import type { ExecutionMetadata } from "./execution-metadata.js";
import type { FeatureFlagManager } from "./feature-flags.js";
import type { SubagentExecutor } from "./subagent-executor.js";
import { TELEMETRY_EVENTS } from "./telemetry-events.js";

/**
 * Structured verdict returned by the verification worker
 */
export interface VerificationVerdict {
  /** Whether the output passed verification */
  passed: boolean;
  /** Specific issues found (empty if passed) */
  issues: string[];
  /** Improvement suggestions (may be present even if passed) */
  suggestions: string[];
}

/**
 * Input to a verification check
 */
export interface VerificationInput {
  /** The original task/request that produced the output */
  task: string;
  /** The proposed output to verify */
  output: string;
  /** Verification criteria (natural language or structured) */
  criteria: string[];
}

/**
 * Configuration for the verification worker
 */
export interface VerificationWorkerConfig {
  /** LLM provider for verification */
  provider: AgentLoopProvider;
  /** Tool executor (typically limited tools for verification) */
  executor: ToolExecutor;
  /** Model to use for verification */
  model: string;
  /** Logger instance */
  logger: HairyClawLogger;
  /** Optional parent trace ID */
  parentTraceId?: string;
  /** Optional parent execution metadata */
  parentMetadata?: ExecutionMetadata;
  /** Optional timeout for verification (default: 60s) */
  timeoutMs?: number;
  /**
   * Custom system prompt for verification.
   * If not provided, uses the default verification prompt.
   */
  systemPrompt?: string;
  /** Feature flag manager */
  featureFlags?: FeatureFlagManager;
}

/**
 * Default system prompt for verification workers.
 * Configurable via VerificationWorkerConfig.systemPrompt.
 */
const DEFAULT_VERIFICATION_SYSTEM_PROMPT = `You are a verification agent. Your role is to evaluate whether a proposed output correctly addresses the original task according to specific criteria.

Respond ONLY with valid JSON matching this schema:
{
  "passed": boolean,
  "issues": string[],
  "suggestions": string[]
}

Rules:
- Set "passed" to true ONLY if ALL criteria are satisfied
- List each unmet criterion as a separate issue
- Provide actionable suggestions for improvement
- Be specific and precise in your feedback
- Do not include any text outside the JSON response`;

/**
 * Build the verification task prompt from the input
 */
const buildVerificationPrompt = (input: VerificationInput): string => {
  const criteriaList = input.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

  return `## Original Task
${input.task}

## Proposed Output
${input.output}

## Verification Criteria
${criteriaList}

Evaluate the proposed output against ALL criteria and respond with the JSON verdict.`;
};

/**
 * Parse a verification verdict from LLM output.
 * Robust: handles markdown fences, extra whitespace, and partial JSON.
 */
export const parseVerificationVerdict = (raw: string): VerificationVerdict => {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (typeof parsed !== "object" || parsed === null) {
      return {
        passed: false,
        issues: ["Verification produced non-object response"],
        suggestions: [],
      };
    }

    const obj = parsed as Record<string, unknown>;
    const passed = typeof obj.passed === "boolean" ? obj.passed : false;
    const issues = Array.isArray(obj.issues)
      ? obj.issues.filter((i): i is string => typeof i === "string")
      : [];
    const suggestions = Array.isArray(obj.suggestions)
      ? obj.suggestions.filter((s): s is string => typeof s === "string")
      : [];

    return { passed, issues, suggestions };
  } catch {
    // If JSON parsing fails, treat as failure with the raw text as an issue
    return {
      passed: false,
      issues: [`Failed to parse verification verdict: ${cleaned.slice(0, 200)}`],
      suggestions: [],
    };
  }
};

/**
 * Verification worker: spawns a fresh subagent to verify outputs
 */
export interface VerificationWorker {
  /**
   * Verify a proposed output against criteria.
   * Returns a structured verdict.
   */
  verify(input: VerificationInput): Promise<VerificationVerdict>;
}

/**
 * Create a verification worker bound to a SubagentExecutor.
 *
 * The worker is gated behind the `verificationWorker` feature flag.
 * When the flag is disabled, verify() returns a pass-through verdict.
 */
export const createVerificationWorker = (
  subagentExecutor: SubagentExecutor,
  config: VerificationWorkerConfig,
): VerificationWorker => {
  const systemPrompt = config.systemPrompt ?? DEFAULT_VERIFICATION_SYSTEM_PROMPT;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const parentTraceId = config.parentTraceId ?? "verification";

  return {
    async verify(input: VerificationInput): Promise<VerificationVerdict> {
      // Gate behind feature flag
      if (config.featureFlags?.isDisabled("verificationWorker")) {
        config.logger.debug(
          { event: "verification.skipped" },
          "verification worker disabled by feature flag",
        );
        return { passed: true, issues: [], suggestions: [] };
      }

      const taskPrompt = buildVerificationPrompt(input);
      const taskId = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // Emit verification.start telemetry
      emitVerificationTelemetry(config, TELEMETRY_EVENTS.verification.start, {
        taskId,
        criteriaCount: input.criteria.length,
      });

      try {
        const submittedId = await subagentExecutor.submit({
          taskId,
          task: taskPrompt,
          systemPrompt,
          provider: config.provider,
          executor: config.executor,
          tools: [], // Verification workers typically don't need tools
          model: config.model,
          parentTraceId,
          logger: config.logger,
          timeoutMs,
          parentMetadata: config.parentMetadata,
          mode: "fresh", // Always fresh: verification should be independent
        });

        const result = await subagentExecutor.waitFor(submittedId);

        if (result.status !== "completed" || !result.result) {
          const errorMsg = result.error ?? `Verification task ended with status: ${result.status}`;
          emitVerificationTelemetry(config, TELEMETRY_EVENTS.verification.fail, {
            taskId,
            error: errorMsg,
          });
          return {
            passed: false,
            issues: [`Verification failed: ${errorMsg}`],
            suggestions: [],
          };
        }

        const verdict = parseVerificationVerdict(result.result);

        // Emit pass or fail telemetry
        const eventName = verdict.passed
          ? TELEMETRY_EVENTS.verification.pass
          : TELEMETRY_EVENTS.verification.fail;
        emitVerificationTelemetry(config, eventName, {
          taskId,
          passed: verdict.passed,
          issueCount: verdict.issues.length,
          suggestionCount: verdict.suggestions.length,
        });

        return verdict;
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        emitVerificationTelemetry(config, TELEMETRY_EVENTS.verification.timeout, {
          taskId,
          error: errorMsg,
        });
        return {
          passed: false,
          issues: [`Verification error: ${errorMsg}`],
          suggestions: [],
        };
      }
    },
  };
};

/**
 * Emit verification telemetry when standardizedTelemetry is enabled
 */
const emitVerificationTelemetry = (
  config: VerificationWorkerConfig,
  eventName: string,
  details: Record<string, unknown>,
): void => {
  if (config.featureFlags?.isDisabled("standardizedTelemetry")) {
    return;
  }
  config.logger.info({ event: eventName, ...details }, eventName);
};
