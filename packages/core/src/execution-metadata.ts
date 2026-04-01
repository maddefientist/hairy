/**
 * Execution Metadata Model
 *
 * Tracks detailed lineage and context for every execution:
 * - Turn IDs for unique message processing sessions
 * - Agent/Subagent lineage
 * - Execution mode (unified/orchestrator/executor)
 * - Executor type (model/tool/plugin/verification)
 * - Metadata tags for cross-cutting concerns
 */

import { randomUUID } from "node:crypto";

/**
 * Execution mode: the overall agent configuration
 */
export type ExecutionMode = "unified" | "orchestrator" | "executor";

/**
 * Type of executor running the current step
 */
export type ExecutorType = "model" | "tool" | "plugin" | "verification" | "subagent";

/**
 * Full execution metadata for a single turn or step
 */
export interface ExecutionMetadata {
  /** Unique ID for this entire message processing session */
  turnId: string;

  /** Distributed trace ID (from orchestrator/tracer) */
  traceId: string;

  /** Current agent identifier */
  agentId: string;

  /** Parent agent ID if this is a forked/spawned agent */
  parentAgentId?: string;

  /** Execution mode: unified, orchestrator, or executor */
  executionMode: ExecutionMode;

  /** Type of executor running this step */
  executorType: ExecutorType;

  /** Optional: execution context tags for cross-cutting concerns */
  tags?: Record<string, string | number | boolean>;

  /** When this execution started */
  startedAt: number;

  /** When this execution ended (filled in by end()) */
  endedAt?: number;

  /** Wall-clock duration in milliseconds */
  durationMs?: number;
}

/**
 * Builder for execution metadata with fluent interface
 */
export class ExecutionMetadataBuilder {
  private metadata: ExecutionMetadata;

  constructor(traceId: string, agentId: string, executionMode: ExecutionMode = "unified") {
    this.metadata = {
      turnId: randomUUID(),
      traceId,
      agentId,
      executionMode,
      executorType: "model",
      startedAt: Date.now(),
    };
  }

  /**
   * Set parent agent ID for forked/specialized agents
   */
  withParentAgent(parentAgentId: string): this {
    this.metadata.parentAgentId = parentAgentId;
    return this;
  }

  /**
   * Set executor type
   */
  withExecutorType(executorType: ExecutorType): this {
    this.metadata.executorType = executorType;
    return this;
  }

  /**
   * Add a metadata tag
   */
  withTag(key: string, value: string | number | boolean): this {
    if (!this.metadata.tags) {
      this.metadata.tags = {};
    }
    this.metadata.tags[key] = value;
    return this;
  }

  /**
   * Add multiple tags
   */
  withTags(tags: Record<string, string | number | boolean>): this {
    this.metadata.tags = { ...this.metadata.tags, ...tags };
    return this;
  }

  /**
   * Build the metadata object
   */
  build(): ExecutionMetadata {
    return { ...this.metadata };
  }

  /**
   * Build and mark as ended (returns the same object with duration filled)
   */
  end(): ExecutionMetadata {
    const now = Date.now();
    this.metadata.endedAt = now;
    this.metadata.durationMs = now - this.metadata.startedAt;
    return { ...this.metadata };
  }
}

/**
 * Create a new execution metadata builder
 */
export const createExecutionMetadata = (
  traceId: string,
  agentId: string,
  executionMode?: ExecutionMode,
): ExecutionMetadataBuilder => {
  return new ExecutionMetadataBuilder(traceId, agentId, executionMode);
};

/**
 * Create child metadata from parent (for forked agents)
 */
export const createChildExecutionMetadata = (
  parent: ExecutionMetadata,
  newAgentId: string,
  executorType: ExecutorType = "subagent",
): ExecutionMetadata => {
  return {
    turnId: randomUUID(),
    traceId: parent.traceId,
    agentId: newAgentId,
    parentAgentId: parent.agentId,
    executionMode: parent.executionMode,
    executorType,
    startedAt: Date.now(),
    tags: {
      ...parent.tags,
      isForked: true,
    },
  };
};

/**
 * Add duration to metadata if not already set
 */
export const endExecutionMetadata = (metadata: ExecutionMetadata): ExecutionMetadata => {
  if (metadata.endedAt === undefined) {
    const now = Date.now();
    return {
      ...metadata,
      endedAt: now,
      durationMs: now - metadata.startedAt,
    };
  }
  return metadata;
};

/**
 * Extract lineage chain from metadata
 */
export const getLineageChain = (metadata: ExecutionMetadata): string[] => {
  const chain = [metadata.agentId];
  const current = metadata;

  if (current.parentAgentId) {
    chain.unshift(current.parentAgentId);
    // Note: we don't have the parent metadata, so we stop here
    // In a full implementation, we'd traverse the lineage tree
  }

  return chain;
};

/**
 * Convert metadata to JSON-serializable diagnostic format
 */
export const getMetadataDiagnostics = (metadata: ExecutionMetadata): Record<string, unknown> => {
  return {
    turnId: metadata.turnId,
    traceId: metadata.traceId,
    agentId: metadata.agentId,
    parentAgentId: metadata.parentAgentId,
    executionMode: metadata.executionMode,
    executorType: metadata.executorType,
    durationMs: metadata.durationMs,
    tags: metadata.tags,
  };
};
