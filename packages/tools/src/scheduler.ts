/**
 * Tool Scheduler
 *
 * Manages concurrent tool execution with configurable limits and priority.
 * Provides queue overflow telemetry and backpressure signaling.
 *
 * Gated behind toolScheduling feature flag.
 */

import type { HairyClawLogger } from "@hairyclaw/observability";

/**
 * Priority levels for tool execution
 */
export type ToolPriority = "high" | "normal" | "low";

const PRIORITY_ORDER: Record<ToolPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

/**
 * A queued tool execution request
 */
interface QueuedToolExecution<T> {
  id: string;
  toolName: string;
  priority: ToolPriority;
  enqueuedAt: number;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

/**
 * Tool scheduler configuration
 */
export interface ToolSchedulerConfig {
  /** Maximum number of tools running simultaneously. Default: 5 */
  maxConcurrent: number;
  /** Queue size limit. When exceeded, new submissions are rejected. Default: 50 */
  maxQueueSize: number;
  /** Telemetry threshold: emit warning when queue length exceeds this. Default: 10 */
  queueWarningThreshold: number;
}

export const DEFAULT_TOOL_SCHEDULER_CONFIG: ToolSchedulerConfig = {
  maxConcurrent: 5,
  maxQueueSize: 50,
  queueWarningThreshold: 10,
};

/**
 * Telemetry event names for tool scheduling
 */
export const TOOL_SCHEDULER_EVENTS = {
  /** Tool execution started from the scheduler */
  start: "tool.scheduler.start",
  /** Tool execution completed */
  complete: "tool.scheduler.complete",
  /** Tool execution failed */
  error: "tool.scheduler.error",
  /** Queue is backing up beyond warning threshold */
  queueOverflow: "tool.scheduler.queue_overflow",
  /** Submission rejected because queue is full */
  rejected: "tool.scheduler.rejected",
} as const;

/**
 * Scheduler status snapshot
 */
export interface ToolSchedulerStatus {
  activeTasks: number;
  queuedTasks: number;
  maxConcurrent: number;
  maxQueueSize: number;
  totalSubmitted: number;
  totalCompleted: number;
  totalFailed: number;
  totalRejected: number;
}

/**
 * ToolScheduler manages concurrent tool execution with priority queuing.
 */
export class ToolScheduler {
  private readonly queue: QueuedToolExecution<unknown>[] = [];
  private activeTasks = 0;
  private readonly config: ToolSchedulerConfig;
  private nextId = 0;

  // Counters for diagnostics
  private totalSubmitted = 0;
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalRejected = 0;

  constructor(
    private readonly logger: HairyClawLogger,
    config?: Partial<ToolSchedulerConfig>,
  ) {
    this.config = { ...DEFAULT_TOOL_SCHEDULER_CONFIG, ...config };
  }

  /**
   * Submit a tool execution request.
   * Returns a promise that resolves when the tool completes.
   * Rejects immediately if the queue is full.
   */
  async submit<T>(
    toolName: string,
    execute: () => Promise<T>,
    priority: ToolPriority = "normal",
  ): Promise<T> {
    this.totalSubmitted++;

    if (this.queue.length >= this.config.maxQueueSize) {
      this.totalRejected++;
      this.logger.warn(
        {
          event: TOOL_SCHEDULER_EVENTS.rejected,
          toolName,
          queueSize: this.queue.length,
          maxQueueSize: this.config.maxQueueSize,
        },
        TOOL_SCHEDULER_EVENTS.rejected,
      );
      throw new Error(
        `tool scheduler queue full (${this.config.maxQueueSize}): cannot schedule ${toolName}`,
      );
    }

    const id = `sched-${++this.nextId}`;

    return new Promise<T>((resolve, reject) => {
      const entry: QueuedToolExecution<T> = {
        id,
        toolName,
        priority,
        enqueuedAt: Date.now(),
        execute,
        resolve,
        reject,
      };

      // Insert in priority order (stable: same priority preserves FIFO)
      const insertIdx = this.queue.findIndex(
        (q) => PRIORITY_ORDER[q.priority] > PRIORITY_ORDER[priority],
      );
      if (insertIdx === -1) {
        this.queue.push(entry as QueuedToolExecution<unknown>);
      } else {
        this.queue.splice(insertIdx, 0, entry as QueuedToolExecution<unknown>);
      }

      // Emit queue overflow warning if threshold exceeded
      if (this.queue.length >= this.config.queueWarningThreshold) {
        this.logger.warn(
          {
            event: TOOL_SCHEDULER_EVENTS.queueOverflow,
            queueSize: this.queue.length,
            threshold: this.config.queueWarningThreshold,
            activeTasks: this.activeTasks,
          },
          TOOL_SCHEDULER_EVENTS.queueOverflow,
        );
      }

      this.drain();
    });
  }

  /**
   * Drain the queue: start tasks up to maxConcurrent
   */
  private drain(): void {
    while (this.activeTasks < this.config.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) {
        break;
      }
      this.activeTasks++;
      this.executeTask(next);
    }
  }

  /**
   * Execute a single queued task
   */
  private executeTask(entry: QueuedToolExecution<unknown>): void {
    const startedAt = Date.now();
    const waitMs = startedAt - entry.enqueuedAt;

    this.logger.debug(
      {
        event: TOOL_SCHEDULER_EVENTS.start,
        id: entry.id,
        toolName: entry.toolName,
        priority: entry.priority,
        waitMs,
        activeTasks: this.activeTasks,
      },
      TOOL_SCHEDULER_EVENTS.start,
    );

    entry
      .execute()
      .then((result) => {
        this.totalCompleted++;
        const durationMs = Date.now() - startedAt;
        this.logger.debug(
          {
            event: TOOL_SCHEDULER_EVENTS.complete,
            id: entry.id,
            toolName: entry.toolName,
            durationMs,
          },
          TOOL_SCHEDULER_EVENTS.complete,
        );
        entry.resolve(result);
      })
      .catch((error: unknown) => {
        this.totalFailed++;
        const durationMs = Date.now() - startedAt;
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          {
            event: TOOL_SCHEDULER_EVENTS.error,
            id: entry.id,
            toolName: entry.toolName,
            error: msg,
            durationMs,
          },
          TOOL_SCHEDULER_EVENTS.error,
        );
        entry.reject(error instanceof Error ? error : new Error(msg));
      })
      .finally(() => {
        this.activeTasks--;
        this.drain();
      });
  }

  /**
   * Get current scheduler status
   */
  getStatus(): ToolSchedulerStatus {
    return {
      activeTasks: this.activeTasks,
      queuedTasks: this.queue.length,
      maxConcurrent: this.config.maxConcurrent,
      maxQueueSize: this.config.maxQueueSize,
      totalSubmitted: this.totalSubmitted,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      totalRejected: this.totalRejected,
    };
  }

  /**
   * Number of active (running) tasks
   */
  get active(): number {
    return this.activeTasks;
  }

  /**
   * Number of queued (waiting) tasks
   */
  get queued(): number {
    return this.queue.length;
  }
}
