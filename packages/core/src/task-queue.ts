import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { QueueItem, QueueState, TaskPriority } from "./types.js";

const defaultState = (): QueueState => ({
  urgent: [],
  user: [],
  task: [],
  background: [],
});

const priorities: TaskPriority[] = ["urgent", "user", "task", "background"];

export class TaskQueue {
  private state: QueueState = defaultState();

  constructor(private readonly statePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as QueueState;
      this.state = {
        urgent: parsed.urgent ?? [],
        user: parsed.user ?? [],
        task: parsed.task ?? [],
        background: parsed.background ?? [],
      };
    } catch {
      this.state = defaultState();
    }
  }

  async enqueue(item: QueueItem, priority: TaskPriority): Promise<void> {
    this.state[priority].push(item);
    await this.persist();
  }

  async dequeue(): Promise<QueueItem | null> {
    for (const priority of priorities) {
      const next = this.state[priority].shift();
      if (next) {
        await this.persist();
        return next;
      }
    }

    return null;
  }

  peek(): QueueItem | null {
    for (const priority of priorities) {
      const next = this.state[priority][0];
      if (next) {
        return next;
      }
    }

    return null;
  }

  size(): number {
    return priorities.reduce((acc, priority) => acc + this.state[priority].length, 0);
  }

  async drain(): Promise<QueueItem[]> {
    const items: QueueItem[] = [];
    for (const priority of priorities) {
      items.push(...this.state[priority]);
      this.state[priority] = [];
    }
    await this.persist();
    return items;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }
}
