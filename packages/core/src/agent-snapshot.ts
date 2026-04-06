/**
 * Agent Snapshot Contract
 *
 * Captures agent state at a point in time for handoff between workers.
 * Supports snapshot creation and restoration for orchestrator state transfers.
 *
 * Includes:
 * - Messages summary (compressed context)
 * - Active tools list
 * - Execution metadata
 * - Key decisions and artifacts
 */

import { randomUUID } from "node:crypto";
import type { AgentLoopMessage, AgentLoopToolDef } from "./agent-loop.js";
import type { ExecutionMetadata } from "./execution-metadata.js";

/**
 * A captured decision or artifact from agent execution
 */
export interface SnapshotArtifact {
  /** Unique identifier */
  id: string;
  /** Artifact type: decision, file, result, error */
  kind: "decision" | "file" | "result" | "error";
  /** Short label */
  label: string;
  /** Content or reference */
  content: string;
  /** When this artifact was created */
  createdAt: number;
}

/**
 * Agent snapshot: a serializable point-in-time capture of agent state
 */
export interface AgentSnapshot {
  /** Unique snapshot ID */
  snapshotId: string;
  /** When the snapshot was taken */
  createdAt: number;
  /** Agent identity */
  agentId: string;
  /** Trace ID this snapshot belongs to */
  traceId: string;
  /** Compressed summary of the conversation so far */
  messagesSummary: string;
  /** Full messages (optional, may be omitted for bandwidth) */
  messages?: AgentLoopMessage[];
  /** Active tool names */
  activeTools: string[];
  /** Execution metadata at snapshot time */
  executionMetadata?: ExecutionMetadata;
  /** Key decisions and artifacts */
  artifacts: SnapshotArtifact[];
  /** Arbitrary state bag for custom data */
  state?: Record<string, unknown>;
}

/**
 * Options for creating a snapshot
 */
export interface CreateSnapshotOptions {
  agentId: string;
  traceId: string;
  messagesSummary: string;
  messages?: AgentLoopMessage[];
  activeTools?: string[] | AgentLoopToolDef[];
  executionMetadata?: ExecutionMetadata;
  artifacts?: SnapshotArtifact[];
  state?: Record<string, unknown>;
}

/**
 * Create a new agent snapshot
 */
export const createAgentSnapshot = (opts: CreateSnapshotOptions): AgentSnapshot => {
  const toolNames = (opts.activeTools ?? []).map((t) => (typeof t === "string" ? t : t.name));

  return {
    snapshotId: randomUUID(),
    createdAt: Date.now(),
    agentId: opts.agentId,
    traceId: opts.traceId,
    messagesSummary: opts.messagesSummary,
    messages: opts.messages,
    activeTools: toolNames,
    executionMetadata: opts.executionMetadata,
    artifacts: opts.artifacts ?? [],
    state: opts.state,
  };
};

/**
 * Create a snapshot artifact
 */
export const createSnapshotArtifact = (
  kind: SnapshotArtifact["kind"],
  label: string,
  content: string,
): SnapshotArtifact => {
  return {
    id: randomUUID(),
    kind,
    label,
    content,
    createdAt: Date.now(),
  };
};

/**
 * Restored state from a snapshot, ready to be used by an agent
 */
export interface RestoredAgentState {
  /** Messages to initialize the agent with */
  messages: AgentLoopMessage[];
  /** System prompt addendum with context from the snapshot */
  contextAddendum: string;
  /** Tool names that were active */
  activeTools: string[];
  /** Execution metadata (if present in snapshot) */
  executionMetadata?: ExecutionMetadata;
  /** Arbitrary state */
  state?: Record<string, unknown>;
}

/**
 * Restore agent state from a snapshot.
 *
 * If the snapshot has full messages, they are used directly.
 * Otherwise, the messages summary is injected as a system-level context message.
 */
export const restoreFromSnapshot = (snapshot: AgentSnapshot): RestoredAgentState => {
  const messages: AgentLoopMessage[] = snapshot.messages
    ? [...snapshot.messages]
    : [
        {
          role: "system",
          content: [
            {
              type: "text",
              text: `[Context from previous agent ${snapshot.agentId}]\n${snapshot.messagesSummary}`,
            },
          ],
        },
      ];

  // Build context addendum from artifacts
  const artifactLines: string[] = [];
  for (const artifact of snapshot.artifacts) {
    artifactLines.push(`[${artifact.kind}] ${artifact.label}: ${artifact.content}`);
  }

  const contextAddendum =
    artifactLines.length > 0 ? `\n## Previous Agent Context\n${artifactLines.join("\n")}` : "";

  return {
    messages,
    contextAddendum,
    activeTools: [...snapshot.activeTools],
    executionMetadata: snapshot.executionMetadata,
    state: snapshot.state ? { ...snapshot.state } : undefined,
  };
};

/**
 * Serialize a snapshot to JSON (for persistence or transfer)
 */
export const serializeSnapshot = (snapshot: AgentSnapshot): string => {
  return JSON.stringify(snapshot);
};

/**
 * Deserialize a snapshot from JSON
 */
export const deserializeSnapshot = (json: string): AgentSnapshot => {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid snapshot JSON: expected object");
  }

  const obj = parsed as Record<string, unknown>;

  // Validate required fields
  if (typeof obj.snapshotId !== "string") {
    throw new Error("Invalid snapshot: missing snapshotId");
  }
  if (typeof obj.agentId !== "string") {
    throw new Error("Invalid snapshot: missing agentId");
  }
  if (typeof obj.traceId !== "string") {
    throw new Error("Invalid snapshot: missing traceId");
  }
  if (typeof obj.messagesSummary !== "string") {
    throw new Error("Invalid snapshot: missing messagesSummary");
  }
  if (!Array.isArray(obj.activeTools)) {
    throw new Error("Invalid snapshot: missing activeTools");
  }

  return parsed as AgentSnapshot;
};
