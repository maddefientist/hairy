/**
 * Parallel Sub-agent Executor
 *
 * Manages a pool of concurrent sub-agent executions with:
 * - Configurable max concurrency (semaphore-based)
 * - Per-task timeout enforcement
 * - Status tracking per task
 * - Trace ID propagation from parent
 * - Execution metadata lineage (when executionMetadataTracking is enabled)
 * - Standardized telemetry events (when standardizedTelemetry is enabled)
 */

import type { HairyClawLogger } from "@hairyclaw/observability";
import type {
  AgentLoopMessage,
  AgentLoopOptions,
  AgentLoopProvider,
  AgentLoopResult,
  ToolExecutor,
} from "./agent-loop.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  type ExecutionMetadata,
  createChildExecutionMetadata,
  endExecutionMetadata,
} from "./execution-metadata.js";
import type { FeatureFlagManager } from "./feature-flags.js";
import { TELEMETRY_EVENTS, getMetadataLabels } from "./telemetry-events.js";

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "timed_out";

export interface SubagentResult {
  taskId: string;
  parentTraceId: string;
  status: SubagentStatus;
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  toolCallCount: number;
}

export type RunAgentLoopFn = (
  messages: AgentLoopMessage[],
  opts: AgentLoopOptions,
) => Promise<AgentLoopResult>;

export interface SubagentConfig {
  maxConcurrent?: number;
  defaultTimeoutMs?: number;
  maxIterations?: number;
  /** Override runAgentLoop for testing. Defaults to the real runAgentLoop. */
  runLoop?: RunAgentLoopFn;
  /** Feature flag manager for gating telemetry and metadata */
  featureFlags?: FeatureFlagManager;
}

/**
 * Subagent context mode:
 * - 'fork': inherit parent context/messages, child ExecutionMetadata carries full parent lineage
 * - 'fresh': clean slate with only the task description, independent metadata with parent trace reference
 */
export type SubagentContextMode = "fork" | "fresh";

export interface SubagentSubmitOptions {
  taskId?: string;
  task: string;
  systemPrompt: string;
  provider: AgentLoopProvider;
  executor: ToolExecutor;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  model: string;
  parentTraceId: string;
  logger: HairyClawLogger;
  timeoutMs?: number;
  /** Parent execution metadata for lineage tracking */
  parentMetadata?: ExecutionMetadata;
  /**
   * Context mode: 'fork' inherits parent messages, 'fresh' starts clean.
   * Defaults to 'fresh' for backward compatibility.
   * Requires subagentContextForking feature flag to be enabled; falls back to 'fresh' when disabled.
   */
  mode?: SubagentContextMode;
  /** Parent messages to inherit in 'fork' mode. Ignored in 'fresh' mode. */
  parentMessages?: AgentLoopMessage[];
}

/** Simple counting semaphore for concurrency control */
class Semaphore {
  private queue: Array<() => void> = [];
  private current = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}

const generateTaskId = (): string =>
  `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`sub-agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export class SubagentExecutor {
  private readonly tasks = new Map<string, SubagentResult>();
  private readonly running = new Map<string, Promise<SubagentResult>>();
  private readonly semaphore: Semaphore;
  private readonly config: Required<Omit<SubagentConfig, "runLoop" | "featureFlags">>;
  private readonly runLoop: RunAgentLoopFn;
  private readonly featureFlags?: FeatureFlagManager;

  constructor(config?: SubagentConfig) {
    this.config = {
      maxConcurrent: config?.maxConcurrent ?? 3,
      defaultTimeoutMs: config?.defaultTimeoutMs ?? 120_000,
      maxIterations: config?.maxIterations ?? 10,
    };
    this.runLoop = config?.runLoop ?? runAgentLoop;
    this.featureFlags = config?.featureFlags;
    this.semaphore = new Semaphore(this.config.maxConcurrent);
  }

  /** Submit a task for background execution. Returns taskId immediately. */
  async submit(opts: SubagentSubmitOptions): Promise<string> {
    const taskId = opts.taskId ?? generateTaskId();
    const timeoutMs = opts.timeoutMs ?? this.config.defaultTimeoutMs;

    const taskResult: SubagentResult = {
      taskId,
      parentTraceId: opts.parentTraceId,
      status: "pending",
      toolCallCount: 0,
    };

    this.tasks.set(taskId, taskResult);

    const executionPromise = this.executeTask(taskId, opts, timeoutMs);
    this.running.set(taskId, executionPromise);

    // Clean up running map when done (fire-and-forget)
    executionPromise.then(
      () => this.running.delete(taskId),
      () => this.running.delete(taskId),
    );

    return taskId;
  }

  /** Poll a task's status */
  getResult(taskId: string): SubagentResult | undefined {
    return this.tasks.get(taskId);
  }

  /** List all tasks */
  listTasks(): SubagentResult[] {
    return Array.from(this.tasks.values());
  }

  /** Wait for a specific task to complete (with optional timeout) */
  async waitFor(taskId: string, timeoutMs?: number): Promise<SubagentResult> {
    const runningPromise = this.running.get(taskId);
    if (runningPromise) {
      if (timeoutMs !== undefined) {
        return await withTimeout(runningPromise, timeoutMs);
      }
      return await runningPromise;
    }

    const existing = this.tasks.get(taskId);
    if (existing) {
      return existing;
    }

    throw new Error(`unknown task: ${taskId}`);
  }

  /** Wait for all currently running tasks */
  async waitForAll(timeoutMs?: number): Promise<SubagentResult[]> {
    const promises = Array.from(this.running.values());
    if (promises.length === 0) {
      return [];
    }

    const allPromise = Promise.all(promises);
    if (timeoutMs !== undefined) {
      return await withTimeout(allPromise, timeoutMs);
    }
    return await allPromise;
  }

  /** Clean up completed tasks */
  cleanup(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task && task.status !== "running" && task.status !== "pending") {
      this.tasks.delete(taskId);
    }
  }

  /** Number of currently running tasks */
  get activeCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "running" || task.status === "pending") {
        count++;
      }
    }
    return count;
  }

  /**
   * Resolve the effective context mode, respecting feature flags.
   * Returns 'fresh' if subagentContextForking is disabled or no mode specified.
   */
  private resolveContextMode(requestedMode?: SubagentContextMode): SubagentContextMode {
    if (!requestedMode || requestedMode === "fresh") {
      return "fresh";
    }
    // Fork mode requires feature flag
    if (this.featureFlags?.isDisabled("subagentContextForking")) {
      return "fresh";
    }
    return "fork";
  }

  /**
   * Build the initial messages for the subagent based on context mode.
   * - 'fresh': single user message with task description only
   * - 'fork': parent messages + task appended as new user message
   */
  private buildInitialMessages(
    opts: SubagentSubmitOptions,
    mode: SubagentContextMode,
  ): AgentLoopMessage[] {
    if (mode === "fork" && opts.parentMessages && opts.parentMessages.length > 0) {
      return [
        ...opts.parentMessages,
        { role: "user", content: [{ type: "text", text: opts.task }] },
      ];
    }
    // Fresh mode: clean slate
    return [{ role: "user", content: [{ type: "text", text: opts.task }] }];
  }

  private async executeTask(
    taskId: string,
    opts: SubagentSubmitOptions,
    timeoutMs: number,
  ): Promise<SubagentResult> {
    const taskResult = this.tasks.get(taskId);
    if (!taskResult) {
      throw new Error(`task not found: ${taskId}`);
    }

    const effectiveMode = this.resolveContextMode(opts.mode);

    // Create child execution metadata if parent provided and feature enabled
    const childMetadata = this.createChildMetadata(opts, taskId, effectiveMode);

    await this.semaphore.acquire();

    taskResult.status = "running";
    taskResult.startedAt = Date.now();

    // Emit subagent.start
    this.emitTelemetry(opts.logger, TELEMETRY_EVENTS.subagent.start, childMetadata, {
      taskId,
      parentTraceId: opts.parentTraceId,
      task: opts.task,
      model: opts.model,
      timeoutMs,
      contextMode: effectiveMode,
    });

    try {
      const initialMessages = this.buildInitialMessages(opts, effectiveMode);

      const loopPromise = this.runLoop(initialMessages, {
        provider: opts.provider,
        executor: opts.executor,
        logger: opts.logger,
        maxIterations: this.config.maxIterations,
        streamOpts: {
          model: opts.model,
          systemPrompt: opts.systemPrompt,
          tools: opts.tools,
        },
      });

      const agentResult: AgentLoopResult = await withTimeout(loopPromise, timeoutMs);

      taskResult.status = "completed";
      taskResult.result = agentResult.text;
      taskResult.toolCallCount = agentResult.toolCalls.length;
      taskResult.completedAt = Date.now();

      // Emit subagent.complete
      const completedMeta = childMetadata ? endExecutionMetadata(childMetadata) : undefined;
      this.emitTelemetry(opts.logger, TELEMETRY_EVENTS.subagent.complete, completedMeta, {
        taskId,
        parentTraceId: opts.parentTraceId,
        toolCallCount: taskResult.toolCallCount,
        durationMs: taskResult.completedAt - (taskResult.startedAt ?? taskResult.completedAt),
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes("timed out");

      if (isTimeout) {
        taskResult.status = "timed_out";
      } else {
        taskResult.status = "failed";
      }

      taskResult.error = errorMessage;
      taskResult.completedAt = Date.now();

      // Emit subagent.timeout or subagent.error
      const failedMeta = childMetadata ? endExecutionMetadata(childMetadata) : undefined;
      const eventName = isTimeout
        ? TELEMETRY_EVENTS.subagent.timeout
        : TELEMETRY_EVENTS.subagent.error;
      this.emitTelemetry(opts.logger, eventName, failedMeta, {
        taskId,
        parentTraceId: opts.parentTraceId,
        error: errorMessage,
        durationMs: taskResult.completedAt - (taskResult.startedAt ?? taskResult.completedAt),
      });

      opts.logger.error(
        { taskId, error: errorMessage, parentTraceId: opts.parentTraceId },
        "subagent task failed",
      );
    } finally {
      this.semaphore.release();
    }

    return taskResult;
  }

  /**
   * Create child execution metadata from parent when feature flag is enabled.
   * Returns undefined when executionMetadataTracking is disabled or no parent metadata.
   *
   * In 'fork' mode: full parent lineage with isForked=true tag
   * In 'fresh' mode: independent metadata with parentTraceRef tag pointing back
   */
  private createChildMetadata(
    opts: SubagentSubmitOptions,
    taskId: string,
    mode: SubagentContextMode = "fresh",
  ): ExecutionMetadata | undefined {
    if (this.featureFlags?.isDisabled("executionMetadataTracking")) {
      return undefined;
    }
    if (!opts.parentMetadata) {
      return undefined;
    }

    if (mode === "fork") {
      // Fork: child inherits parent's trace and full lineage
      const child = createChildExecutionMetadata(opts.parentMetadata, taskId, "subagent");
      child.tags = { ...child.tags, contextMode: "fork" };
      return child;
    }

    // Fresh: independent metadata with reference back to parent trace
    const fresh = createChildExecutionMetadata(opts.parentMetadata, taskId, "subagent");
    fresh.tags = { ...fresh.tags, contextMode: "fresh", isForked: false };
    return fresh;
  }

  /**
   * Emit a structured telemetry event when standardizedTelemetry flag is enabled.
   */
  private emitTelemetry(
    logger: HairyClawLogger,
    eventName: string,
    metadata: ExecutionMetadata | undefined,
    details?: Record<string, unknown>,
  ): void {
    if (this.featureFlags?.isDisabled("standardizedTelemetry")) {
      return;
    }
    const logPayload: Record<string, unknown> = {
      event: eventName,
      ...(metadata ? getMetadataLabels(metadata) : {}),
      ...(details ?? {}),
    };
    logger.info(logPayload, eventName);
  }
}
