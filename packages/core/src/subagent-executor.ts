/**
 * Parallel Sub-agent Executor
 *
 * Manages a pool of concurrent sub-agent executions with:
 * - Configurable max concurrency (semaphore-based)
 * - Per-task timeout enforcement
 * - Status tracking per task
 * - Trace ID propagation from parent
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
}

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
  private readonly config: Required<Omit<SubagentConfig, "runLoop">>;
  private readonly runLoop: RunAgentLoopFn;

  constructor(config?: SubagentConfig) {
    this.config = {
      maxConcurrent: config?.maxConcurrent ?? 3,
      defaultTimeoutMs: config?.defaultTimeoutMs ?? 120_000,
      maxIterations: config?.maxIterations ?? 10,
    };
    this.runLoop = config?.runLoop ?? runAgentLoop;
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

  private async executeTask(
    taskId: string,
    opts: SubagentSubmitOptions,
    timeoutMs: number,
  ): Promise<SubagentResult> {
    const taskResult = this.tasks.get(taskId);
    if (!taskResult) {
      throw new Error(`task not found: ${taskId}`);
    }

    await this.semaphore.acquire();

    taskResult.status = "running";
    taskResult.startedAt = Date.now();

    try {
      const loopPromise = this.runLoop(
        [{ role: "user", content: [{ type: "text", text: opts.task }] }],
        {
          provider: opts.provider,
          executor: opts.executor,
          logger: opts.logger,
          maxIterations: this.config.maxIterations,
          streamOpts: {
            model: opts.model,
            systemPrompt: opts.systemPrompt,
            tools: opts.tools,
          },
        },
      );

      const agentResult: AgentLoopResult = await withTimeout(loopPromise, timeoutMs);

      taskResult.status = "completed";
      taskResult.result = agentResult.text;
      taskResult.toolCallCount = agentResult.toolCalls.length;
      taskResult.completedAt = Date.now();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes("timed out")) {
        taskResult.status = "timed_out";
      } else {
        taskResult.status = "failed";
      }

      taskResult.error = errorMessage;
      taskResult.completedAt = Date.now();

      opts.logger.error(
        { taskId, error: errorMessage, parentTraceId: opts.parentTraceId },
        "subagent task failed",
      );
    } finally {
      this.semaphore.release();
    }

    return taskResult;
  }
}
