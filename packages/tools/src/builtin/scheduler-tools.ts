/**
 * Scheduler tools — let the agent create, list, pause, resume, and cancel scheduled tasks.
 * Tasks are persisted and survive restarts. Supports cron, interval, and one-shot schedules.
 */
import type { Scheduler } from "@hairy/core";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tool } from "../types.js";

/** Parse human-readable duration (e.g. '30m', '4h', '1d') to milliseconds */
const parseDuration = (value: string): number | null => {
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!match) return null;
  const num = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return Math.round(num * (multipliers[unit] ?? 1));
};

const scheduleTaskSchema = z.object({
  id: z
    .string()
    .max(64)
    .optional()
    .describe("Optional task ID (auto-generated if omitted). Use descriptive slugs like 'morning-checkin'."),
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .describe("The prompt/instruction that will be sent to the agent when the task fires."),
  schedule_type: z
    .enum(["cron", "interval", "once"])
    .describe("'cron' for cron expressions, 'interval' for repeating intervals like '30m', 'once' for one-shot."),
  schedule_value: z
    .string()
    .min(1)
    .describe("Cron expression (e.g. '0 9 * * *'), interval (e.g. '4h', '30m'), or ISO datetime for 'once'."),
  silent: z
    .boolean()
    .optional()
    .describe("If true, the agent can respond with [SILENT] to suppress output for routine checks."),
});

export const createScheduleTaskTool = (scheduler: Scheduler): Tool => ({
  name: "schedule_task",
  description:
    "Create a scheduled task. The task will fire at the specified time and send the prompt to the agent for processing. Use cron for recurring (e.g. '0 9 * * 1' = Mondays 9am UTC), interval for periodic (e.g. '6h'), or once for a single future execution.",
  parameters: scheduleTaskSchema,
  async execute(args) {
    const input = scheduleTaskSchema.parse(args);
    const taskId = input.id ?? `task_${randomUUID().slice(0, 8)}`;

    // Convert human-readable intervals to milliseconds for the scheduler
    let resolvedValue = input.schedule_value;
    if (input.schedule_type === "interval") {
      const ms = parseDuration(input.schedule_value);
      if (ms === null || ms < 60000) {
        return { content: `Invalid interval: '${input.schedule_value}'. Use formats like '30m', '4h', '1d'. Minimum 1 minute.`, isError: true };
      }
      resolvedValue = String(ms);
    }

    await scheduler.createTask({
      id: taskId,
      prompt: input.prompt,
      scheduleType: input.schedule_type,
      scheduleValue: resolvedValue,
      status: "active",
      nextRun: null,
      lastRun: null,
      silent: input.silent ?? false,
      createdAt: new Date().toISOString(),
    });

    return {
      content: `Scheduled task '${taskId}' created (${input.schedule_type}: ${input.schedule_value})`,
    };
  },
});

const listTasksSchema = z.object({});

export const createListTasksTool = (scheduler: Scheduler): Tool => ({
  name: "list_tasks",
  description: "List all scheduled tasks with their status, schedule, and last/next run times.",
  parameters: listTasksSchema,
  async execute() {
    const tasks = scheduler.listTasks();
    if (tasks.length === 0) {
      return { content: "No scheduled tasks." };
    }

    const lines = tasks.map((t) => {
      const status = t.status === "active" ? "🟢" : t.status === "paused" ? "⏸️" : "✅";
      const schedule = `${t.scheduleType}: ${t.scheduleValue}`;
      const lastRun = t.lastRun ? `last: ${t.lastRun}` : "never run";
      const nextRun = t.nextRun ? `next: ${t.nextRun}` : "";
      return `${status} [${t.id}] ${schedule} | ${lastRun} ${nextRun}\n   ${t.prompt.slice(0, 120)}`;
    });

    return { content: lines.join("\n\n") };
  },
});

const taskIdSchema = z.object({
  task_id: z.string().min(1).describe("The task ID to operate on."),
});

export const createPauseTaskTool = (scheduler: Scheduler): Tool => ({
  name: "pause_task",
  description: "Pause a scheduled task. It will stop firing until resumed.",
  parameters: taskIdSchema,
  async execute(args) {
    const { task_id } = taskIdSchema.parse(args);
    const ok = await scheduler.pauseTask(task_id);
    return { content: ok ? `Task '${task_id}' paused.` : `Task '${task_id}' not found.`, isError: !ok };
  },
});

export const createResumeTaskTool = (scheduler: Scheduler): Tool => ({
  name: "resume_task",
  description: "Resume a paused scheduled task.",
  parameters: taskIdSchema,
  async execute(args) {
    const { task_id } = taskIdSchema.parse(args);
    const ok = await scheduler.resumeTask(task_id);
    return { content: ok ? `Task '${task_id}' resumed.` : `Task '${task_id}' not found.`, isError: !ok };
  },
});

export const createCancelTaskTool = (scheduler: Scheduler): Tool => ({
  name: "cancel_task",
  description: "Delete a scheduled task permanently.",
  parameters: taskIdSchema,
  async execute(args) {
    const { task_id } = taskIdSchema.parse(args);
    const ok = await scheduler.cancelTask(task_id);
    return { content: ok ? `Task '${task_id}' cancelled.` : `Task '${task_id}' not found.`, isError: !ok };
  },
});
