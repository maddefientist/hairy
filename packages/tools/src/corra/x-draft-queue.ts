import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "../types.js";

export interface Draft {
  id: string;
  text: string;
  status: "pending" | "approved";
}

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

const queueSchema = z.object({
  action: z.enum(["draft", "list", "approve", "edit", "skip"]),
  id: z.string().optional(),
  text: z.string().optional(),
});

export interface XQueueDeps {
  n8nWebhookUrl: string;
  postFn?: (text: string) => Promise<void>;
}

const queuePath = (dataDir: string): string => join(dataDir, "corra", "x-queue.json");

const loadQueue = async (dataDir: string): Promise<Draft[]> => {
  try {
    return JSON.parse(await readFile(queuePath(dataDir), "utf8")) as Draft[];
  } catch {
    return [];
  }
};

const saveQueue = async (dataDir: string, q: Draft[]): Promise<void> => {
  await mkdir(join(dataDir, "corra"), { recursive: true });
  await writeFile(queuePath(dataDir), JSON.stringify(q, null, 2));
};

export const createXDraftQueueTool = (deps: XQueueDeps): Tool => ({
  name: "corra_x_queue",
  description:
    "Manage Corra's X/Twitter draft queue. action=draft|list|approve|edit|skip. Approved drafts are posted via the n8n webhook. NOTHING posts without an explicit approve action.",
  parameters: queueSchema,
  timeout_ms: 20_000,
  async execute(args, ctx: ToolContext) {
    const input = queueSchema.parse(args);
    const queue = await loadQueue(ctx.dataDir);

    if (input.action === "draft") {
      const id = String(queue.reduce((m, d) => Math.max(m, Number(d.id) || 0), 0) + 1);
      const draft: Draft = { id, text: input.text ?? "", status: "pending" };
      await saveQueue(ctx.dataDir, [...queue, draft]);
      return { content: JSON.stringify({ drafted: draft }) };
    }

    if (input.action === "list") {
      const pending = queue.filter((d) => d.status === "pending");
      const text =
        pending.length === 0
          ? "No pending X drafts."
          : ["📝 Pending X drafts:", ...pending.map((d) => `${d.id}. ${d.text}`), "", "Reply: /approve N · /edit N <text> · /skip N"].join("\n");
      return { content: JSON.stringify({ pending, text }) };
    }

    if (!input.id) return { content: JSON.stringify({ error: "id required" }), isError: true };

    if (input.action === "approve") {
      const target = queue.find((d) => d.id === input.id);
      if (!target) return { content: JSON.stringify({ error: "draft not found", id: input.id }), isError: true };
      await saveQueue(ctx.dataDir, nextQueueState(queue, "approve", input.id));
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
      await poster(target.text);
      ctx.logger.info({ id: input.id }, "corra x draft approved + posted");
      return { content: JSON.stringify({ approved: input.id, posted: true }) };
    }

    await saveQueue(ctx.dataDir, nextQueueState(queue, input.action, input.id, input.text));
    return { content: JSON.stringify({ action: input.action, id: input.id }) };
  },
});
