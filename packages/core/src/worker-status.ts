/**
 * Worker Status Registry
 *
 * Tracks all active workers/subagents with their current state.
 * Exposes diagnostic status for operator observability.
 *
 * States: idle, processing, waiting_for_tool, error, completed
 */

import type { HairyClawLogger } from "@hairyclaw/observability";
import { TELEMETRY_EVENTS } from "./telemetry-events.js";

/**
 * Worker lifecycle states
 */
export type WorkerState = "idle" | "processing" | "waiting_for_tool" | "error" | "completed";

/**
 * Telemetry events for worker status
 */
export const WORKER_STATUS_EVENTS = {
  statusChange: "worker.status_change",
  registered: "worker.registered",
  unregistered: "worker.unregistered",
} as const;

/**
 * Individual worker status entry
 */
export interface WorkerStatus {
  /** Unique worker/subagent ID */
  workerId: string;
  /** Agent identity (may differ from workerId for named agents) */
  agentId: string;
  /** Current state */
  state: WorkerState;
  /** Description of the current task */
  currentTask: string | undefined;
  /** When the worker was registered */
  registeredAt: number;
  /** When the worker started processing */
  startedAt: number | undefined;
  /** Last state change timestamp */
  lastActivity: number;
  /** Number of artifacts produced */
  artifactCount: number;
  /** Optional error message if in error state */
  errorMessage: string | undefined;
}

/**
 * WorkerStatusRegistry tracks all active workers/subagents.
 */
export class WorkerStatusRegistry {
  private readonly workers = new Map<string, WorkerStatus>();

  constructor(private readonly logger: HairyClawLogger) {}

  /**
   * Register a new worker
   */
  register(workerId: string, agentId: string): void {
    const now = Date.now();
    const status: WorkerStatus = {
      workerId,
      agentId,
      state: "idle",
      currentTask: undefined,
      registeredAt: now,
      startedAt: undefined,
      lastActivity: now,
      artifactCount: 0,
      errorMessage: undefined,
    };
    this.workers.set(workerId, status);
    this.logger.info(
      { event: WORKER_STATUS_EVENTS.registered, workerId, agentId },
      WORKER_STATUS_EVENTS.registered,
    );
  }

  /**
   * Unregister a worker (cleanup)
   */
  unregister(workerId: string): boolean {
    const existed = this.workers.delete(workerId);
    if (existed) {
      this.logger.info(
        { event: WORKER_STATUS_EVENTS.unregistered, workerId },
        WORKER_STATUS_EVENTS.unregistered,
      );
    }
    return existed;
  }

  /**
   * Transition a worker to a new state
   */
  transition(
    workerId: string,
    newState: WorkerState,
    options?: {
      currentTask?: string;
      errorMessage?: string;
    },
  ): void {
    const entry = this.workers.get(workerId);
    if (!entry) {
      this.logger.warn({ workerId, newState }, "transition called for unknown worker");
      return;
    }

    const oldState = entry.state;
    entry.state = newState;
    entry.lastActivity = Date.now();

    if (options?.currentTask !== undefined) {
      entry.currentTask = options.currentTask;
    }
    if (options?.errorMessage !== undefined) {
      entry.errorMessage = options.errorMessage;
    }
    if (newState === "processing" && entry.startedAt === undefined) {
      entry.startedAt = Date.now();
    }

    this.logger.info(
      {
        event: WORKER_STATUS_EVENTS.statusChange,
        workerId,
        agentId: entry.agentId,
        oldState,
        newState,
        currentTask: entry.currentTask,
      },
      WORKER_STATUS_EVENTS.statusChange,
    );
  }

  /**
   * Increment artifact count for a worker
   */
  incrementArtifacts(workerId: string, count = 1): void {
    const entry = this.workers.get(workerId);
    if (entry) {
      entry.artifactCount += count;
      entry.lastActivity = Date.now();
    }
  }

  /**
   * Get status for a specific worker
   */
  getStatus(workerId: string): WorkerStatus | undefined {
    const entry = this.workers.get(workerId);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Get statuses for all workers
   */
  getWorkerStatuses(): WorkerStatus[] {
    return Array.from(this.workers.values()).map((w) => ({ ...w }));
  }

  /**
   * Get workers in a specific state
   */
  getWorkersByState(state: WorkerState): WorkerStatus[] {
    return this.getWorkerStatuses().filter((w) => w.state === state);
  }

  /**
   * Count of registered workers
   */
  get size(): number {
    return this.workers.size;
  }

  /**
   * Count of active (non-idle, non-completed) workers
   */
  get activeCount(): number {
    let count = 0;
    for (const w of this.workers.values()) {
      if (w.state === "processing" || w.state === "waiting_for_tool") {
        count++;
      }
    }
    return count;
  }
}
