import { randomUUID } from "node:crypto";
import type { ChannelAdapter } from "@hairy/channels";
import type { HairyMessage, ScheduledTask, Scheduler } from "@hairy/core";
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
 * Scheduled rules are persisted into Scheduler tasks. When those tasks become
 * due, `handleDueTask()` turns them into synthetic messages and dispatches
 * them to orchestrator handlers registered via `onProactiveMessage()`.
 */
export class InitiativeEngine {
  private readonly rules = new Map<string, InitiativeRule>();
  private readonly taskRuleMap = new Map<string, InitiativeRule>();
  private started = false;
  /** Scheduled task IDs we created — used for cleanup */
  private readonly scheduledIds: string[] = [];
  /** Orchestrator handlers for proactive message dispatch */
  private readonly messageHandlers: Array<(msg: HairyMessage) => void> = [];

  constructor(private readonly opts: InitiativeEngineOptions) {
    for (const rule of opts.rules) {
      this.rules.set(rule.id, rule);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

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
      this.taskRuleMap.delete(id);
    }
    this.scheduledIds.length = 0;

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
   * Called by the Orchestrator after wiring its own handler.
   */
  onProactiveMessage(handler: (msg: HairyMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Handle Scheduler due events. Returns true if the task belonged to initiative
   * rules and was dispatched, false otherwise.
   */
  handleDueTask(task: ScheduledTask): boolean {
    const rule = this.taskRuleMap.get(task.id);
    if (!rule) {
      return false;
    }

    const message = this.buildProactiveMessage(rule.action, rule.id);
    this.dispatchToOrchestrator(message);

    this.opts.logger?.info({ taskId: task.id, ruleId: rule.id }, "initiative rule fired");
    return true;
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
    const isInterval = /^\d+$/.test(rule.condition.trim());
    const scheduleType = isInterval ? "interval" : "cron";

    const existing = this.opts.scheduler
      .listTasks()
      .find(
        (task) =>
          task.status === "active" &&
          task.prompt === rule.action &&
          task.scheduleType === scheduleType &&
          task.scheduleValue === rule.condition,
      );

    if (existing) {
      this.scheduledIds.push(existing.id);
      this.taskRuleMap.set(existing.id, rule);
      this.opts.logger?.info(
        { ruleId: rule.id, taskId: existing.id, scheduleType, condition: rule.condition },
        "initiative rule reused existing schedule",
      );
      return;
    }

    const taskId = randomUUID();

    const task: ScheduledTask = {
      id: taskId,
      prompt: rule.action,
      scheduleType,
      scheduleValue: rule.condition,
      status: "active",
      nextRun: null,
      lastRun: null,
      silent: false,
      createdAt: new Date().toISOString(),
    };

    await this.opts.scheduler.createTask(task);
    this.scheduledIds.push(taskId);
    this.taskRuleMap.set(taskId, rule);

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
