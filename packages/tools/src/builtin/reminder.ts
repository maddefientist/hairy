import { z } from "zod";
import type { Tool } from "../types.js";

const reminderInputSchema = z.object({
  action: z.enum(["set", "list", "cancel"]),
  message: z.string().optional(),
  time: z
    .string()
    .optional()
    .describe(
      "When to fire. Accepts: ISO 8601 datetime, relative like '30m', '2h', '1d', or cron expression for recurring.",
    ),
  recurring: z
    .boolean()
    .optional()
    .describe("If true, treat time as a cron expression for recurring reminders."),
  id: z.string().optional().describe("Reminder ID for cancellation."),
});

interface Reminder {
  id: string;
  message: string;
  time: string;
  createdAt: string;
  channelId?: string;
  recurring: boolean;
  fired: boolean;
}

const reminders: Map<string, Reminder> = new Map();
let nextId = 1;
let onReminderFire: ((reminder: Reminder) => void) | null = null;

/** Register callback for when a reminder fires */
export const setReminderCallback = (cb: (reminder: Reminder) => void): void => {
  onReminderFire = cb;
};

/** Check and fire due reminders. Call this periodically. */
export const checkReminders = (): void => {
  const now = Date.now();
  for (const [id, reminder] of reminders) {
    if (reminder.fired) continue;
    const fireAt = new Date(reminder.time).getTime();
    if (Number.isNaN(fireAt)) continue;
    if (now >= fireAt) {
      reminder.fired = true;
      if (!reminder.recurring) {
        reminders.delete(id);
      }
      onReminderFire?.(reminder);
    }
  }
};

function parseRelativeTime(input: string): Date | null {
  const match = input.match(
    /^(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|weeks?|s|secs?|seconds?)$/i,
  );
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const now = Date.now();
  if (unit.startsWith("s")) return new Date(now + amount * 1000);
  if (unit.startsWith("m")) return new Date(now + amount * 60_000);
  if (unit.startsWith("h")) return new Date(now + amount * 3_600_000);
  if (unit.startsWith("d")) return new Date(now + amount * 86_400_000);
  if (unit.startsWith("w")) return new Date(now + amount * 604_800_000);
  return null;
}

function parseTime(input: string): Date | null {
  // Try relative first
  const relative = parseRelativeTime(input.trim());
  if (relative) return relative;

  // Try ISO / natural date
  const parsed = new Date(input);
  if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) return parsed;

  // Try "tomorrow at 2pm" style
  const tomorrowMatch = input.match(/tomorrow\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (tomorrowMatch) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    let hour = Number.parseInt(tomorrowMatch[1], 10);
    const min = tomorrowMatch[2] ? Number.parseInt(tomorrowMatch[2], 10) : 0;
    const ampm = tomorrowMatch[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    d.setHours(hour, min, 0, 0);
    return d;
  }

  // Try "in X hours/minutes" prefix
  const inMatch = input.match(/^in\s+(.+)$/i);
  if (inMatch) return parseRelativeTime(inMatch[1].trim());

  return null;
}

export const createReminderTool = (opts?: { agentName?: string }): Tool => ({
  name: "reminder",
  description: `Set, list, or cancel reminders. Supports relative times ('30m', '2h', '1d'), absolute times, and natural language ('tomorrow at 2pm'). ${opts?.agentName ?? "The agent"} will send the reminder message when it's due.`,
  parameters: reminderInputSchema,
  async execute(args, context) {
    const input = reminderInputSchema.parse(args);

    if (input.action === "list") {
      const active = [...reminders.values()].filter((r) => !r.fired);
      if (active.length === 0) {
        return { content: "No active reminders." };
      }
      const lines = active.map(
        (r) => `- **${r.id}**: "${r.message}" → ${r.time}${r.recurring ? " (recurring)" : ""}`,
      );
      return { content: `Active reminders:\n${lines.join("\n")}` };
    }

    if (input.action === "cancel") {
      if (!input.id) {
        return {
          content: "Need a reminder ID to cancel. Use action='list' to see active reminders.",
          isError: true,
        };
      }
      const deleted = reminders.delete(input.id);
      return {
        content: deleted ? `Reminder ${input.id} cancelled.` : `Reminder ${input.id} not found.`,
      };
    }

    // action === "set"
    if (!input.message) {
      return { content: "Need a message for the reminder.", isError: true };
    }
    if (!input.time) {
      return {
        content: "Need a time for the reminder (e.g. '30m', '2h', 'tomorrow at 9am').",
        isError: true,
      };
    }

    if (input.recurring) {
      // For recurring, store cron expression as-is (handled by scheduler)
      const id = `rem-${nextId++}`;
      const reminder: Reminder = {
        id,
        message: input.message,
        time: input.time,
        createdAt: new Date().toISOString(),
        channelId: context?.channelId,
        recurring: true,
        fired: false,
      };
      reminders.set(id, reminder);
      return {
        content: `Recurring reminder set: "${input.message}" on schedule: ${input.time} (ID: ${id})`,
      };
    }

    const fireAt = parseTime(input.time);
    if (!fireAt) {
      return {
        content: `Couldn't parse time "${input.time}". Try: "30m", "2h", "tomorrow at 3pm", or an ISO date.`,
        isError: true,
      };
    }

    const id = `rem-${nextId++}`;
    const reminder: Reminder = {
      id,
      message: input.message,
      time: fireAt.toISOString(),
      createdAt: new Date().toISOString(),
      channelId: context?.channelId,
      recurring: false,
      fired: false,
    };
    reminders.set(id, reminder);

    const diffMs = fireAt.getTime() - Date.now();
    const diffMin = Math.round(diffMs / 60_000);
    const humanTime =
      diffMin < 60
        ? `${diffMin} minute${diffMin !== 1 ? "s" : ""}`
        : diffMin < 1440
          ? `${Math.round(diffMin / 60)} hour${Math.round(diffMin / 60) !== 1 ? "s" : ""}`
          : `${Math.round(diffMin / 1440)} day${Math.round(diffMin / 1440) !== 1 ? "s" : ""}`;

    return {
      content: `Reminder set: "${input.message}" in ${humanTime} (${fireAt.toLocaleString()}) — ID: ${id}`,
    };
  },
});
