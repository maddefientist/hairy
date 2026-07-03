import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A cheap health snapshot built entirely from Corra's local state files (H4 observability). */
export interface HealthSnapshot {
  inboxCount: number;
  lastMailAt: string | null;
  interestTopics: number;
  hiveDeferred: number;
}

const readJsonArray = async (path: string): Promise<unknown[]> => {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const readJsonObject = async (path: string): Promise<Record<string, unknown>> => {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export const collectHealth = async (dataDir: string): Promise<HealthSnapshot> => {
  const dir = join(dataDir, "corra");
  const inbox = (await readJsonArray(join(dir, "inbox.json"))) as Array<{ receivedAt?: unknown }>;
  const weights = await readJsonObject(join(dir, "interest-model.json"));
  const deferred = await readJsonArray(join(dir, "hive-deferred.json"));
  const times = inbox.map((e) => (typeof e.receivedAt === "string" ? e.receivedAt : "")).filter(Boolean);
  const lastMailAt = times.length ? times.reduce((a, b) => (a > b ? a : b)) : null;
  return {
    inboxCount: inbox.length,
    lastMailAt,
    interestTopics: Object.keys(weights).length,
    hiveDeferred: deferred.length,
  };
};

/** Compact daily status line for the owner. Surfaces hive-deferred count as the key error signal. */
export const formatHealth = (h: HealthSnapshot): string => {
  const parts = [`📥 ${h.inboxCount} in inbox`, `🎯 ${h.interestTopics} learned topics`];
  if (h.lastMailAt) parts.push(`🕐 last mail ${h.lastMailAt.slice(0, 10)}`);
  if (h.hiveDeferred > 0) parts.push(`⚠️ ${h.hiveDeferred} hive-deferred (need re-sync)`);
  return `🩺 Corra daily health — ${parts.join(" · ")}`;
};
