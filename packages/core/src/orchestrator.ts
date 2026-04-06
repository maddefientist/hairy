import { randomUUID } from "node:crypto";
import { type HairyClawLogger, type Metrics, createTrace } from "@hairyclaw/observability";
import {
  type AgentSnapshot,
  type RestoredAgentState,
  createAgentSnapshot,
  restoreFromSnapshot,
} from "./agent-snapshot.js";
import {
  type ArtifactMetadata,
  type ArtifactScratchpad,
  createArtifactScratchpad,
} from "./artifact-scratchpad.js";
import {
  type ExecutionMetadata,
  createExecutionMetadata,
  endExecutionMetadata,
} from "./execution-metadata.js";
import type { FeatureFlagManager } from "./feature-flags.js";
import type { PluginContext, PluginRunner } from "./plugin.js";
import type { TaskQueue } from "./task-queue.js";
import { TELEMETRY_EVENTS, getMetadataLabels } from "./telemetry-events.js";
import type {
  AgentResponse,
  HairyClawMessage,
  QueueItem,
  RunResult,
  TokenUsage,
  ToolCallRecord,
} from "./types.js";

interface OrchestratorDeps {
  logger: HairyClawLogger;
  metrics: Metrics;
  queue: TaskQueue;
  plugins?: PluginRunner;
  featureFlags?: FeatureFlagManager;
  handleRun: (
    message: HairyClawMessage,
    traceId: string,
    pluginCtx: PluginContext,
  ) => Promise<AgentResponse>;
}

const emptyUsage = (): TokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, total: 0 },
});

export class Orchestrator {
  private processing = false;
  private started = false;
  private snapshots = new Map<string, AgentSnapshot>();
  private scratchpads = new Map<string, ArtifactScratchpad>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * Get or create a scratchpad for a given trace/task.
   * Gated behind the sharedArtifacts feature flag.
   * Returns undefined when the flag is disabled.
   */
  getScratchpad(traceId: string): ArtifactScratchpad | undefined {
    if (this.deps.featureFlags?.isDisabled("sharedArtifacts")) {
      return undefined;
    }
    let pad = this.scratchpads.get(traceId);
    if (!pad) {
      pad = createArtifactScratchpad();
      this.scratchpads.set(traceId, pad);
      this.deps.logger.debug({ traceId }, "artifact scratchpad created for task");
    }
    return pad;
  }

  /**
   * Put an artifact on the scratchpad for a given trace, with telemetry.
   * Returns false if shared artifacts are disabled.
   */
  putArtifact(traceId: string, key: string, value: unknown, metadata: ArtifactMetadata): boolean {
    const pad = this.getScratchpad(traceId);
    if (!pad) {
      return false;
    }
    pad.put(key, value, metadata);
    this.emitTelemetry(TELEMETRY_EVENTS.artifact.put, undefined, {
      traceId,
      key,
      producedBy: metadata.producedBy,
      type: metadata.type,
    });
    return true;
  }

  /**
   * Get an artifact from the scratchpad for a given trace, with telemetry.
   */
  getArtifact(traceId: string, key: string): unknown | undefined {
    const pad = this.getScratchpad(traceId);
    if (!pad) {
      return undefined;
    }
    const entry = pad.get(key);
    this.emitTelemetry(TELEMETRY_EVENTS.artifact.get, undefined, {
      traceId,
      key,
      found: entry !== undefined,
    });
    return entry?.value;
  }

  /**
   * Delete a scratchpad for a trace (cleanup after task completion).
   */
  deleteScratchpad(traceId: string): boolean {
    return this.scratchpads.delete(traceId);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.deps.queue.load();
    await this.processLoop();
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async handleMessage(message: HairyClawMessage): Promise<void> {
    const item: QueueItem = {
      id: randomUUID(),
      kind: "message",
      payload: message,
      enqueuedAt: new Date().toISOString(),
    };

    await this.deps.queue.enqueue(item, "user");
    this.deps.metrics.increment("messages_in");
    await this.processLoop();
  }

  /**
   * Create a snapshot of the current orchestrator state for a given trace.
   * Captures execution metadata, tools, artifacts, and a summary for handoff.
   */
  createSnapshot(opts: {
    traceId: string;
    messagesSummary: string;
    activeTools?: string[];
    executionMetadata?: ExecutionMetadata;
    artifacts?: AgentSnapshot["artifacts"];
    state?: Record<string, unknown>;
  }): AgentSnapshot {
    const snapshot = createAgentSnapshot({
      agentId: "orchestrator",
      traceId: opts.traceId,
      messagesSummary: opts.messagesSummary,
      activeTools: opts.activeTools,
      executionMetadata: opts.executionMetadata,
      artifacts: opts.artifacts,
      state: opts.state,
    });

    this.snapshots.set(snapshot.snapshotId, snapshot);
    this.deps.logger.info(
      { snapshotId: snapshot.snapshotId, traceId: opts.traceId },
      "agent snapshot created",
    );
    return snapshot;
  }

  /**
   * Restore agent state from a snapshot ID.
   * Returns the restored state or undefined if snapshot not found.
   */
  restoreSnapshot(snapshotId: string): RestoredAgentState | undefined {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      this.deps.logger.warn({ snapshotId }, "snapshot not found for restoration");
      return undefined;
    }

    const restored = restoreFromSnapshot(snapshot);
    this.deps.logger.info(
      { snapshotId, agentId: snapshot.agentId, traceId: snapshot.traceId },
      "agent snapshot restored",
    );
    return restored;
  }

  /**
   * Get a stored snapshot by ID
   */
  getSnapshot(snapshotId: string): AgentSnapshot | undefined {
    return this.snapshots.get(snapshotId);
  }

  /**
   * List all stored snapshots
   */
  listSnapshots(): AgentSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  /**
   * Remove a snapshot by ID
   */
  deleteSnapshot(snapshotId: string): boolean {
    return this.snapshots.delete(snapshotId);
  }

  private async processLoop(): Promise<void> {
    if (!this.started || this.processing) {
      return;
    }

    this.processing = true;

    try {
      while (this.started) {
        const next = await this.deps.queue.dequeue();
        if (!next) {
          break;
        }

        if (next.kind !== "message") {
          continue;
        }

        const message = next.payload;
        if (!("channelType" in message)) {
          continue;
        }

        const startedAt = Date.now();
        const trace = createTrace();
        const toolCalls: ToolCallRecord[] = [];

        // Create execution metadata when feature flag is enabled
        const metadata = this.createMetadata(trace.traceId);

        const pluginCtx: PluginContext = {
          traceId: trace.traceId,
          channelType: message.channelType,
          channelId: message.channelId,
          senderId: message.senderId,
          state: new Map<string, unknown>(),
          logger: this.deps.logger,
          ...(metadata ? { executionMetadata: metadata } : {}),
        };

        // Emit orchestrator.process.start
        this.emitTelemetry(TELEMETRY_EVENTS.orchestrator.processStart, metadata, {
          channelType: message.channelType,
          channelId: message.channelId,
          senderId: message.senderId,
        });

        let effectiveMessage: HairyClawMessage | null = message;
        if (this.deps.plugins) {
          effectiveMessage = await this.deps.plugins.runOnUserMessage(message, pluginCtx);
          if (effectiveMessage === null) {
            this.deps.logger.info(
              { traceId: trace.traceId, channelType: message.channelType },
              "message blocked by plugin",
            );
            continue;
          }

          await this.deps.plugins.runOnRunStart(pluginCtx);
        }

        try {
          const response = await this.deps.handleRun(effectiveMessage, trace.traceId, pluginCtx);
          const runResult: RunResult = {
            traceId: trace.traceId,
            response,
            stopReason: "completed",
            toolCalls,
            usage: emptyUsage(),
            durationMs: Date.now() - startedAt,
          };

          if (this.deps.plugins) {
            await this.deps.plugins.runOnRunEnd(pluginCtx, runResult, undefined);
          }

          // Emit orchestrator.process.complete
          const completedMetadata = metadata ? endExecutionMetadata(metadata) : undefined;
          this.emitTelemetry(TELEMETRY_EVENTS.orchestrator.processComplete, completedMetadata, {
            durationMs: runResult.durationMs,
            stopReason: runResult.stopReason,
          });

          this.logRun(runResult);
        } catch (error: unknown) {
          const runError = error instanceof Error ? error : new Error(String(error));
          this.deps.logger.error(
            { err: runError, traceId: trace.traceId },
            "orchestrator run failed",
          );
          this.deps.metrics.increment("messages_out", 1, { status: "error" });

          // Emit orchestrator.process.complete with error details
          const failedMetadata = metadata ? endExecutionMetadata(metadata) : undefined;
          this.emitTelemetry(TELEMETRY_EVENTS.orchestrator.processComplete, failedMetadata, {
            durationMs: Date.now() - startedAt,
            error: runError.message,
            status: "error",
          });

          if (this.deps.plugins) {
            await this.deps.plugins.runOnRunEnd(pluginCtx, undefined, runError);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Create execution metadata when the feature flag is enabled.
   * Returns undefined when executionMetadataTracking is disabled.
   */
  private createMetadata(traceId: string): ExecutionMetadata | undefined {
    if (this.deps.featureFlags?.isDisabled("executionMetadataTracking")) {
      return undefined;
    }
    // Feature flag enabled (or no flag manager present — default-on per M2 defaults)
    return createExecutionMetadata(traceId, "orchestrator", "unified").build();
  }

  /**
   * Emit a structured telemetry event when standardizedTelemetry flag is enabled.
   */
  private emitTelemetry(
    eventName: string,
    metadata: ExecutionMetadata | undefined,
    details?: Record<string, unknown>,
  ): void {
    if (this.deps.featureFlags?.isDisabled("standardizedTelemetry")) {
      return;
    }
    const logPayload: Record<string, unknown> = {
      event: eventName,
      ...(metadata ? getMetadataLabels(metadata) : {}),
      ...(details ?? {}),
    };
    this.deps.logger.info(logPayload, eventName);
  }

  private logRun(result: RunResult): void {
    this.deps.logger.info(
      {
        traceId: result.traceId,
        durationMs: result.durationMs,
        stopReason: result.stopReason,
      },
      "orchestrator run completed",
    );
    this.deps.metrics.increment("messages_out");
  }
}
