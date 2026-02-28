import { randomUUID } from "node:crypto";
import { type HairyLogger, type Metrics, createTrace } from "@hairy/observability";
import type { TaskQueue } from "./task-queue.js";
import type {
  AgentResponse,
  HairyMessage,
  QueueItem,
  RunResult,
  TokenUsage,
  ToolCallRecord,
} from "./types.js";

interface OrchestratorDeps {
  logger: HairyLogger;
  metrics: Metrics;
  queue: TaskQueue;
  handleRun: (message: HairyMessage, traceId: string) => Promise<AgentResponse>;
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

  constructor(private readonly deps: OrchestratorDeps) {}

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

  async handleMessage(message: HairyMessage): Promise<void> {
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

        try {
          const response = await this.deps.handleRun(message, trace.traceId);
          const runResult: RunResult = {
            traceId: trace.traceId,
            response,
            stopReason: "completed",
            toolCalls,
            usage: emptyUsage(),
            durationMs: Date.now() - startedAt,
          };
          this.logRun(runResult);
        } catch (error: unknown) {
          this.deps.logger.error({ err: error, traceId: trace.traceId }, "orchestrator run failed");
          this.deps.metrics.increment("messages_out", 1, { status: "error" });
        }
      }
    } finally {
      this.processing = false;
    }
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
