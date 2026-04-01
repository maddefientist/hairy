/**
 * Standardized Telemetry Event Names and Helpers
 *
 * Provides a canonical set of event names used across the orchestration system.
 * All telemetry uses this schema for consistency and observability.
 */

import type { MetricLabels } from "@hairyclaw/observability";
import type { ExecutionMetadata } from "./execution-metadata.js";

/**
 * Categorized telemetry event names
 */
export const TELEMETRY_EVENTS = {
  // Subagent lifecycle
  subagent: {
    /** Subagent execution started */
    start: "subagent.start",
    /** Subagent execution completed successfully */
    complete: "subagent.complete",
    /** Subagent execution failed */
    error: "subagent.error",
    /** Subagent execution timed out */
    timeout: "subagent.timeout",
  },

  // Summarization/Compaction
  summarization: {
    /** Context summarization started */
    start: "summarization.start",
    /** Context summarization completed */
    complete: "summarization.complete",
    /** Context summarization failed */
    error: "summarization.error",
    /** Tokens saved by summarization */
    tokensSaved: "summarization.tokens_saved",
  },

  // Plugin lifecycle
  plugin: {
    /** Plugin hook started */
    start: "plugin.start",
    /** Plugin hook completed */
    complete: "plugin.complete",
    /** Plugin hook errored */
    error: "plugin.error",
  },

  // Policy and permissions
  policy: {
    /** Policy allow decision */
    allow: "policy.allow",
    /** Policy deny decision */
    deny: "policy.deny",
    /** Policy fallback to manual review */
    fallback: "policy.fallback",
  },

  // Tool execution
  tool: {
    /** Tool execution started */
    start: "tool.start",
    /** Tool execution completed */
    complete: "tool.complete",
    /** Tool execution failed */
    error: "tool.error",
    /** Tool execution timeout */
    timeout: "tool.timeout",
  },

  // Memory operations
  memory: {
    /** Memory recall/search started */
    recallStart: "memory.recall.start",
    /** Memory recall completed */
    recallComplete: "memory.recall.complete",
    /** Memory ingest started */
    ingestStart: "memory.ingest.start",
    /** Memory ingest completed */
    ingestComplete: "memory.ingest.complete",
    /** Memory operation failed */
    error: "memory.error",
    /** Memory fetch/load started */
    loadStart: "memory.load.start",
    /** Memory fetch/load completed */
    loadComplete: "memory.load.complete",
  },

  // Model inference
  model: {
    /** Model call started */
    start: "model.start",
    /** Model call completed */
    complete: "model.complete",
    /** Model call failed */
    error: "model.error",
    /** Prompt too large, cache eviction triggered */
    cacheEviction: "model.cache_eviction",
  },

  // Message/Channel
  message: {
    /** Message received from channel */
    received: "message.received",
    /** Message sent to channel */
    sent: "message.sent",
    /** Message delivery failed */
    deliveryFailed: "message.delivery_failed",
  },

  // Orchestrator
  orchestrator: {
    /** Orchestrator started processing */
    processStart: "orchestrator.process.start",
    /** Orchestrator finished processing queue item */
    processComplete: "orchestrator.process.complete",
    /** Orchestrator processing loop paused */
    processPaused: "orchestrator.process.paused",
    /** Queue item dequeued */
    dequeue: "orchestrator.dequeue",
    /** Queue item enqueued */
    enqueue: "orchestrator.enqueue",
  },

  // Verification
  verification: {
    /** Verification check started */
    start: "verification.start",
    /** Verification check passed */
    pass: "verification.pass",
    /** Verification check failed */
    fail: "verification.fail",
    /** Verification timed out */
    timeout: "verification.timeout",
  },

  // Session/Lifecycle
  session: {
    /** Session started */
    start: "session.start",
    /** Session ended */
    end: "session.end",
    /** Session crashed or errored */
    error: "session.error",
  },
} as const;

/**
 * Helper to build standard metric labels from execution metadata
 */
export const getMetadataLabels = (metadata: ExecutionMetadata): MetricLabels => {
  return {
    turnId: metadata.turnId,
    traceId: metadata.traceId,
    agentId: metadata.agentId,
    executionMode: metadata.executionMode,
    executorType: metadata.executorType,
  };
};

/**
 * Telemetry event emission context
 * Captures all the info needed to emit consistent events
 */
export interface TelemetryContext {
  eventName: string;
  metadata: ExecutionMetadata;
  labels?: MetricLabels;
  duration?: number;
  error?: Error;
  details?: Record<string, unknown>;
}

/**
 * Helper to create a telemetry context
 */
export const createTelemetryContext = (
  eventName: string,
  metadata: ExecutionMetadata,
  options?: {
    labels?: MetricLabels;
    duration?: number;
    error?: Error;
    details?: Record<string, unknown>;
  },
): TelemetryContext => {
  return {
    eventName,
    metadata,
    labels: {
      ...getMetadataLabels(metadata),
      ...(options?.labels ?? {}),
    },
    duration: options?.duration,
    error: options?.error,
    details: options?.details,
  };
};

/**
 * Well-known metric names for standardized counters/gauges
 */
export const STANDARD_METRICS = {
  // Counters (cumulative)
  subagentsStarted: "subagents.started",
  subagentsCompleted: "subagents.completed",
  subagentsFailed: "subagents.failed",
  subagentsTimedOut: "subagents.timed_out",

  toolsExecuted: "tools.executed",
  toolsFailed: "tools.failed",
  toolsTimedOut: "tools.timed_out",

  policiesAllowed: "policies.allowed",
  policiesDenied: "policies.denied",
  policiesFallbacks: "policies.fallbacks",

  messagesProcessed: "messages.processed",
  messagesFailed: "messages.failed",

  summarizationsStarted: "summarizations.started",
  summarizationsCompleted: "summarizations.completed",
  summarizationsFailed: "summarizations.failed",

  // Gauges (point-in-time values)
  activeSubagents: "subagents.active",
  queueLength: "queue.length",
  contextTokens: "context.tokens",
} as const;

/**
 * Validate that an event name is in the canonical list
 */
export const isKnownEvent = (eventName: string): boolean => {
  const flatEvents = flattenEventNames(TELEMETRY_EVENTS);
  return flatEvents.includes(eventName);
};

/**
 * Helper to flatten the nested event names object into a flat list
 */
const flattenEventNames = (obj: unknown): string[] => {
  const result: string[] = [];

  function flatten(current: unknown) {
    if (typeof current === "string") {
      result.push(current);
    } else if (typeof current === "object" && current !== null) {
      for (const value of Object.values(current)) {
        flatten(value);
      }
    }
  }

  flatten(obj);
  return result;
};

/**
 * Get all canonical event names
 */
export const getAllEventNames = (): string[] => {
  return flattenEventNames(TELEMETRY_EVENTS);
};

/**
 * Get all metric names
 */
export const getAllMetricNames = (): string[] => {
  return Object.values(STANDARD_METRICS);
};

/**
 * Telemetry configuration
 */
export interface TelemetryConfig {
  /** Enable telemetry event emission */
  enabled: boolean;
  /** Minimum event level to emit (info/debug) */
  level?: "debug" | "info";
  /** Include execution metadata in every event */
  includeMetadata?: boolean;
  /** Include duration in events if available */
  includeDuration?: boolean;
}

/**
 * Default telemetry configuration
 */
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  level: "info",
  includeMetadata: true,
  includeDuration: true,
};
