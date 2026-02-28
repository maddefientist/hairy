import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Cron } from "croner";
import type { ScheduledTask } from "./types.js";

interface SchedulerOptions {
  dataPath: string;
  onTaskDue: (task: ScheduledTask) => Promise<void>;
}

type TaskRunner = {
  stop: () => void;
  pause: () => void;
  resume: () => void;
};

export class Scheduler {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly runners = new Map<string, TaskRunner>();

  constructor(private readonly opts: SchedulerOptions) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.opts.dataPath, "utf8");
      const parsed = JSON.parse(raw) as ScheduledTask[];
      for (const task of parsed) {
        this.tasks.set(task.id, task);
        if (task.status === "active") {
          this.attachRunner(task);
        }
      }
    } catch {
      await this.persist();
    }
  }

  async createTask(task: ScheduledTask): Promise<void> {
    this.tasks.set(task.id, task);
    if (task.status === "active") {
      this.attachRunner(task);
    }
    await this.persist();
  }

  async pauseTask(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    const runner = this.runners.get(id);
    if (!task || !runner) {
      return false;
    }

    runner.pause();
    task.status = "paused";
    await this.persist();
    return true;
  }

  async resumeTask(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    const runner = this.runners.get(id);
    if (!task || !runner) {
      return false;
    }

    runner.resume();
    task.status = "active";
    await this.persist();
    return true;
  }

  async cancelTask(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    const runner = this.runners.get(id);
    if (!task || !runner) {
      return false;
    }

    runner.stop();
    this.runners.delete(id);
    task.status = "completed";
    task.nextRun = null;
    await this.persist();
    return true;
  }

  listTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  getActiveTasks(): ScheduledTask[] {
    return this.listTasks().filter((task) => task.status === "active");
  }

  async stopAll(): Promise<void> {
    for (const runner of this.runners.values()) {
      runner.stop();
    }
    this.runners.clear();
    await this.persist();
  }

  private attachRunner(task: ScheduledTask): void {
    const runTask = async (): Promise<void> => {
      task.lastRun = new Date().toISOString();
      if (task.scheduleType === "once") {
        task.status = "completed";
      }
      await this.opts.onTaskDue(task);
      await this.persist();
    };

    if (task.scheduleType === "cron") {
      const job = new Cron(task.scheduleValue, async (self: { nextRun: () => Date | null }) => {
        task.nextRun = self.nextRun()?.toISOString() ?? null;
        await runTask();
      });
      task.nextRun = job.nextRun()?.toISOString() ?? null;
      this.runners.set(task.id, {
        stop: () => job.stop(),
        pause: () => job.pause(),
        resume: () => {
          job.resume();
        },
      });
      return;
    }

    if (task.scheduleType === "interval") {
      const ms = Number(task.scheduleValue);
      const timer = setInterval(() => {
        void runTask();
      }, ms);
      task.nextRun = new Date(Date.now() + ms).toISOString();
      this.runners.set(task.id, {
        stop: () => clearInterval(timer),
        pause: () => clearInterval(timer),
        resume: () => {
          this.attachRunner(task);
        },
      });
      return;
    }

    const delayMs = Math.max(new Date(task.scheduleValue).getTime() - Date.now(), 0);
    const timer = setTimeout(() => {
      void runTask();
    }, delayMs);
    task.nextRun = new Date(Date.now() + delayMs).toISOString();
    this.runners.set(task.id, {
      stop: () => clearTimeout(timer),
      pause: () => clearTimeout(timer),
      resume: () => {
        this.attachRunner(task);
      },
    });
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.opts.dataPath), { recursive: true });
    const data = JSON.stringify(this.listTasks(), null, 2);
    await writeFile(this.opts.dataPath, data, "utf8");
  }
}
