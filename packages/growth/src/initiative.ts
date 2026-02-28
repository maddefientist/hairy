import type { ChannelAdapter } from "@hairy/channels";
import type { Scheduler } from "@hairy/core";
import type { InitiativeRule } from "./types.js";

interface InitiativeEngineOptions {
  rules: InitiativeRule[];
  scheduler: Scheduler;
  channels: ChannelAdapter[];
}

export class InitiativeEngine {
  private readonly rules = new Map<string, InitiativeRule>();
  private started = false;

  constructor(private readonly opts: InitiativeEngineOptions) {
    for (const rule of opts.rules) {
      this.rules.set(rule.id, rule);
    }
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  addRule(rule: InitiativeRule): void {
    this.rules.set(rule.id, rule);
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
}
