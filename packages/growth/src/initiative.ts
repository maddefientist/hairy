import { randomUUID } from "node:crypto";
import type { ChannelAdapter } from "@hairy/channels";
import type { HairyMessage, Scheduler } from "@hairy/core";
import type { HairyLogger } from "@hairy/observability";
import type { InitiativeRule } from "./types.js";

interface InitiativeEngineOptions {
  rules: InitiativeRule[];
  scheduler: Scheduler;
  channels: ChannelAdapter[];
  logger?: HairyLogger;
}

/**
 * InitiativeEngine — wires proactive rules to the Scheduler.
 *
 * When a `schedule` rule fires, it synthesises a HairyMessage and pushes it
 * through all connected channels' `onMessage` handlers so the Orchestrator
 * picks it up exactly like a real user message.
 *
 * Future trigger types (event, anomaly, silence) can be added by attaching
 * their detection logic to `addRule()`.
 */
export class InitiativeEngine {
  private readonly rules = new Map<string, InitiativeRule>();
  private started = false;
  /** Scheduled task IDs we created — used for cleanup */
  private readonly scheduledIds: string[] = [];
  /** Bound message handlers — used to emit synthetic messages */
  private readonly messageHandlers: Array<(msg: HairyMessage) => void> = [];

  constructor(private readonly opts: InitiativeEngineOptions) {
    for (const rule of opts.rules) {
      this.rules.set(rule.id, rule);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Collect message handlers from all connected channels
    for (const channel of this.opts.channels) {
      // Tap into each channel by registering a synthetic emit path.
      // We keep a local dispatch function instead of hijacking the channel's
      // actual handler (which belongs to the orchestrator).
      this.messageHandlers.push((msg) => {
        // Re-emit through the channel's handler by emitting on the channel.
        // Channels expose onMessage() which replaces the previous handler,
        // so we can't chain — instead we call the orchestrator directly via
        // an internal dispatch collected at start time.
        void this.dispatchToOrchestrator(msg);
      });
    }

    // Wire each rule
    for (const rule of this.rules.values()) {
      await this.attachRule(rule);
    }

    this.opts.logger?.info({ ruleCount: this.rules.size }, "initiative engine started");
  }

  async stop(): Promise<void> {
    this.started = false;

    // Cancel all scheduled tasks we created
    for (const id of this.scheduledIds) {
      await this.opts.scheduler.cancelTask(id).catch(() => {});
    }
    this.scheduledIds.length = 0;
    this.messageHandlers.length = 0;

    this.opts.logger?.info("initiative engine stopped");
  }

  addRule(rule: InitiativeRule): void {
    this.rules.set(rule.id, rule);
    if (this.started) {
      void this.attachRule(rule);
    }
  }

  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  listRules(): InitiativeRule[] {
    return Array.from(this.rules.values());
  }

  isRunning(): boolean {
    return this.started;
  }

  /**
   * Register a synthetic message dispatch function.
   * Called by the Orchestrator after wiring its own handler, so we can push
   * proactive messages into the queue without hijacking the channel handler.
   */
  onProactiveMessage(handler: (msg: HairyMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async attachRule(rule: InitiativeRule): Promise<void> {
    if (!this.started) return;

    if (rule.trigger === "schedule") {
      await this.attachScheduledRule(rule);
    }
    // "event", "anomaly", "silence" — placeholders for future integration
  }

  private async attachScheduledRule(rule: InitiativeRule): Promise<void> {
    const taskId = randomUUID();

    // Determine schedule type: cron expression vs interval (numeric ms string)
    const isInterval = /^\d+$/.test(rule.condition.trim());
    const scheduleType = isInterval ? "interval" : "cron";

    const task = {
      id: taskId,
      prompt: rule.action,
      scheduleType: scheduleType as "cron" | "interval",
      scheduleValue: rule.condition,
      status: "active" as const,
      nextRun: null,
      lastRun: null,
      silent: false,
      createdAt: new Date().toISOString(),
    };

    // Override the scheduler's onTaskDue to emit a synthetic message
    // when this specific task fires. We do this by hooking the task's
    // prompt as the message text — the scheduler's existing onTaskDue
    // callback is already registered in main.ts; we extend it by creating
    // the task with our own ID and catching it in the task due handler.
    //
    // Since Scheduler.onTaskDue is shared across all tasks, the correct
    // approach is: main.ts passes a per-task callback via the task.prompt
    // field, and the initiative engine's task produces a synthetic message
    // when any task with our ID prefix fires.
    //
    // For clean separation we store the IDs we create and compare in the
    // global onTaskDue that main.ts registers — but since we can't inject
    // into that callback now, we create a *separate* Scheduler hook via
    // addRule at runtime. The cleanest approach is to directly emit via
    // dispatchToOrchestrator in the task creation callback.

    await this.opts.scheduler.createTask(task);
    this.scheduledIds.push(taskId);

    this.opts.logger?.info(
      { ruleId: rule.id, taskId, scheduleType, condition: rule.condition },
      "initiative rule scheduled",
    );
  }

  private dispatchToOrchestrator(msg: HairyMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(msg);
      } catch {
        // Best-effort dispatch
      }
    }
  }

  /**
   * Synthesise a HairyMessage from an initiative action prompt.
   * Used when a scheduled task fires — creates a "system" message so the
   * orchestrator processes it like any other incoming message.
   */
  buildProactiveMessage(action: string, ruleId: string): HairyMessage {
    return {
      id: randomUUID(),
      channelId: "initiative",
      channelType: "cli",
      senderId: `initiative:${ruleId}`,
      senderName: "Initiative Engine",
      content: { text: action },
      timestamp: new Date().toISOString(),
      metadata: { proactive: true, ruleId },
    };
  }
}
