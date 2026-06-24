import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "../types.js";

export interface Draft {
  id: string;
  text: string;
  status: "pending" | "approved";
}

const draftSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["pending", "approved"]),
});
const queueArraySchema = z.array(draftSchema);

export const nextQueueState = (
  queue: Draft[],
  action: "approve" | "edit" | "skip",
  id: string,
  edit?: string,
): Draft[] => {
  switch (action) {
    case "approve":
      return queue.map((d) => (d.id === id ? { ...d, status: "approved" } : d));
    case "skip":
      return queue.filter((d) => d.id !== id);
    case "edit":
      return queue.map((d) => (d.id === id ? { ...d, text: edit ?? d.text } : d));
    default:
      return queue;
  }
};

const queuePath = (dataDir: string): string => join(dataDir, "corra", "x-queue.json");

// Validated read. Missing/empty file -> empty queue. Corrupt JSON -> throw (never silently wipe).
const loadQueue = async (dataDir: string): Promise<Draft[]> => {
  let raw: string;
  try {
    raw = await readFile(queuePath(dataDir), "utf8");
  } catch {
    return [];
  }
  if (raw.trim() === "") return [];
  const parsed = queueArraySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error("corra x-queue.json failed schema validation; refusing to overwrite");
  return parsed.data;
};

// Atomic write: temp file + rename.
const saveQueue = async (dataDir: string, q: Draft[]): Promise<void> => {
  await mkdir(join(dataDir, "corra"), { recursive: true });
  const tmp = `${queuePath(dataDir)}.tmp`;
  await writeFile(tmp, JSON.stringify(q, null, 2));
  await rename(tmp, queuePath(dataDir));
};

// In-process serialization of ALL queue mutations (single Node process).
let queueLock: Promise<unknown> = Promise.resolve();
const withQueueLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queueLock.then(fn, fn);
  queueLock = run.catch(() => undefined);
  return run;
};

export interface XQueueDeps {
  n8nWebhookUrl: string;
  postFn?: (text: string) => Promise<void>;
}

export const formatPendingList = (pending: Draft[]): string =>
  pending.length === 0
    ? "No pending X drafts."
    : ["📝 Pending X drafts:", ...pending.map((d) => `${d.id}. ${d.text}`), "", "Reply: /approve N · /edit N <text> · /skip N"].join("\n");

export const listDrafts = async (dataDir: string): Promise<Draft[]> =>
  (await loadQueue(dataDir)).filter((d) => d.status === "pending");

export const addDraft = async (dataDir: string, text: string): Promise<Draft> =>
  withQueueLock(async () => {
    const q = await loadQueue(dataDir);
    const id = String(q.reduce((m, d) => Math.max(m, Number(d.id) || 0), 0) + 1);
    const draft: Draft = { id, text, status: "pending" };
    await saveQueue(dataDir, [...q, draft]);
    return draft;
  });

// OWNER-ONLY. Posts FIRST, marks approved only on success. Refuses re-approve. Locked.
export const approveDraft = async (
  dataDir: string,
  id: string,
  deps: XQueueDeps,
): Promise<{ posted: boolean; reason?: string }> =>
  withQueueLock(async () => {
    const q = await loadQueue(dataDir);
    const target = q.find((d) => d.id === id);
    if (!target) return { posted: false, reason: "draft not found" };
    if (target.status === "approved") return { posted: false, reason: "already approved/posted" };
    if (!deps.postFn && !deps.n8nWebhookUrl) return { posted: false, reason: "no webhook configured" };
    const poster =
      deps.postFn ??
      (async (t: string) => {
        const resp = await fetch(deps.n8nWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: t }),
        });
        if (!resp.ok) throw new Error(`n8n webhook HTTP ${resp.status}`);
      });
    try {
      await poster(target.text);
    } catch (error: unknown) {
      return { posted: false, reason: `post failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    await saveQueue(dataDir, nextQueueState(q, "approve", id));
    return { posted: true };
  });

export const editDraft = async (dataDir: string, id: string, text: string): Promise<void> =>
  withQueueLock(async () => {
    await saveQueue(dataDir, nextQueueState(await loadQueue(dataDir), "edit", id, text));
  });

export const skipDraft = async (dataDir: string, id: string): Promise<void> =>
  withQueueLock(async () => {
    await saveQueue(dataDir, nextQueueState(await loadQueue(dataDir), "skip", id));
  });

// MODEL-FACING TOOL: ONLY draft + list. It CANNOT post — removes the bypass.
const toolSchema = z.object({ action: z.enum(["draft", "list"]), text: z.string().optional() });

export const createXDraftQueueTool = (): Tool => ({
  name: "corra_x_queue",
  description:
    "Compose and list Corra's X/Twitter DRAFTS. action=draft (queue a new draft for the owner to review) or list (show pending drafts). This tool CANNOT post — only the owner can approve and post via the /approve Telegram command.",
  parameters: toolSchema,
  timeout_ms: 20_000,
  async execute(args, ctx: ToolContext) {
    const input = toolSchema.parse(args);
    if (input.action === "draft") {
      const draft = await addDraft(ctx.dataDir, input.text ?? "");
      return { content: JSON.stringify({ drafted: draft }) };
    }
    const pending = await listDrafts(ctx.dataDir);
    return { content: JSON.stringify({ pending, text: formatPendingList(pending) }) };
  },
});
