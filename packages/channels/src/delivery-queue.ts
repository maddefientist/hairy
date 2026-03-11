import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentResponse } from "@hairy/core";
import type { HairyLogger } from "@hairy/observability";

export interface DeliveryItem {
  id: string;
  channelType: string;
  channelId: string;
  response: AgentResponse;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  createdAt: number;
  lastError?: string;
}

export interface DeliveryQueueOptions {
  filePath: string;
  maxAttempts?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  logger?: HairyLogger;
}

interface DeliveryQueueState {
  pending: DeliveryItem[];
  deadLetters: DeliveryItem[];
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_RETRY_MS = 5_000;
const DEFAULT_MAX_RETRY_MS = 300_000;

const noopLogger: HairyLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  child: () => noopLogger,
};

export class DeliveryQueue {
  private readonly maxAttempts: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly logger: HairyLogger;
  private state: DeliveryQueueState = { pending: [], deadLetters: [] };
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly opts: DeliveryQueueOptions) {
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseRetryMs = opts.baseRetryMs ?? DEFAULT_BASE_RETRY_MS;
    this.maxRetryMs = opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    this.logger = opts.logger ?? noopLogger;
  }

  async enqueue(channelType: string, channelId: string, response: AgentResponse): Promise<void> {
    await this.withLock(async () => {
      this.state.pending.push({
        id: randomUUID(),
        channelType,
        channelId,
        response,
        attempts: 0,
        maxAttempts: this.maxAttempts,
        nextRetryAt: Date.now(),
        createdAt: Date.now(),
      });
      await this.saveUnsafe();
    });
  }

  async processDue(
    send: (channelType: string, channelId: string, response: AgentResponse) => Promise<void>,
  ): Promise<number> {
    return this.withLock(async () => {
      const now = Date.now();
      const due = this.state.pending
        .filter((item) => item.nextRetryAt <= now)
        .sort((left, right) => left.nextRetryAt - right.nextRetryAt);

      if (due.length === 0) {
        return 0;
      }

      let processed = 0;

      for (const item of due) {
        processed += 1;
        try {
          await send(item.channelType, item.channelId, item.response);
          this.state.pending = this.state.pending.filter((pending) => pending.id !== item.id);
        } catch (error: unknown) {
          item.attempts += 1;
          item.lastError = error instanceof Error ? error.message : String(error);

          if (item.attempts >= item.maxAttempts) {
            this.state.pending = this.state.pending.filter((pending) => pending.id !== item.id);
            this.state.deadLetters.push({ ...item });
            this.logger.error(
              {
                itemId: item.id,
                channelType: item.channelType,
                channelId: item.channelId,
                attempts: item.attempts,
              },
              "delivery exhausted retries and moved to dead letters",
            );
            continue;
          }

          const retryDelay = Math.min(this.baseRetryMs * 2 ** item.attempts, this.maxRetryMs);
          item.nextRetryAt = now + retryDelay;
          this.logger.warn(
            {
              itemId: item.id,
              attempts: item.attempts,
              nextRetryAt: item.nextRetryAt,
              error: item.lastError,
            },
            "delivery failed, scheduled retry",
          );
        }
      }

      await this.saveUnsafe();
      return processed;
    });
  }

  getDeadLetters(): DeliveryItem[] {
    return this.state.deadLetters.map((item) => ({ ...item, response: { ...item.response } }));
  }

  async removeDeadLetter(id: string): Promise<void> {
    await this.withLock(async () => {
      this.state.deadLetters = this.state.deadLetters.filter((item) => item.id !== id);
      await this.saveUnsafe();
    });
  }

  stats(): { pending: number; deadLetters: number } {
    return {
      pending: this.state.pending.length,
      deadLetters: this.state.deadLetters.length,
    };
  }

  async save(): Promise<void> {
    await this.withLock(async () => {
      await this.saveUnsafe();
    });
  }

  async load(): Promise<void> {
    await this.withLock(async () => {
      try {
        const raw = await readFile(this.opts.filePath, "utf8");
        const parsed = JSON.parse(raw) as DeliveryQueueState;
        this.state = {
          pending: parsed.pending ?? [],
          deadLetters: parsed.deadLetters ?? [],
        };
      } catch {
        this.state = { pending: [], deadLetters: [] };
      }
    });
  }

  private async saveUnsafe(): Promise<void> {
    await mkdir(dirname(this.opts.filePath), { recursive: true });
    await writeFile(this.opts.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
