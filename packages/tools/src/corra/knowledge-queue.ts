import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { MemoryBackend } from "@hairyclaw/memory";
import type { Tool, ToolContext } from "../types.js";

export interface Candidate {
  id: string;
  title: string;
  content: string;
  tags: string[];
  status: "pending" | "promoted";
}

const candidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  status: z.enum(["pending", "promoted"]),
});
const queueArraySchema = z.array(candidateSchema);

export const nextKnowledgeState = (
  queue: Candidate[],
  action: "promote" | "edit" | "reject",
  id: string,
  edit?: string,
): Candidate[] => {
  switch (action) {
    case "promote":
      return queue.map((c) => (c.id === id ? { ...c, status: "promoted" } : c));
    case "reject":
      return queue.filter((c) => c.id !== id);
    case "edit":
      return queue.map((c) => (c.id === id ? { ...c, content: edit ?? c.content } : c));
    default:
      return queue;
  }
};

const queuePath = (dataDir: string): string => join(dataDir, "corra", "knowledge-queue.json");

const loadQueue = async (dataDir: string): Promise<Candidate[]> => {
  let raw: string;
  try {
    raw = await readFile(queuePath(dataDir), "utf8");
  } catch {
    return [];
  }
  if (raw.trim() === "") return [];
  const parsed = queueArraySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error("corra knowledge-queue.json failed validation; refusing to overwrite");
  return parsed.data;
};

const saveQueue = async (dataDir: string, q: Candidate[]): Promise<void> => {
  await mkdir(join(dataDir, "corra"), { recursive: true });
  const tmp = `${queuePath(dataDir)}.tmp`;
  await writeFile(tmp, JSON.stringify(q, null, 2));
  await rename(tmp, queuePath(dataDir));
};

let queueLock: Promise<unknown> = Promise.resolve();
const withQueueLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queueLock.then(fn, fn);
  queueLock = run.catch(() => undefined);
  return run;
};

export interface KnowledgeDeps {
  sharedBackend: MemoryBackend; // pinned to writeNamespace=claude-shared
}

export const formatCandidateList = (pending: Candidate[]): string =>
  pending.length === 0
    ? "No pending knowledge candidates."
    : ["🧠 Pending knowledge (for the shared brain):", ...pending.map((c) => `${c.id}. ${c.title}\n   ${c.content.slice(0, 140)}`), "", "Reply: /promote N · /kedit N <text> · /kreject N"].join("\n");

export const listCandidates = async (dataDir: string): Promise<Candidate[]> =>
  (await loadQueue(dataDir)).filter((c) => c.status === "pending");

export const addCandidate = async (
  dataDir: string,
  input: { title: string; content: string; tags?: string[] },
): Promise<Candidate> =>
  withQueueLock(async () => {
    const q = await loadQueue(dataDir);
    const id = String(q.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0) + 1);
    const cand: Candidate = { id, title: input.title, content: input.content, tags: input.tags ?? [], status: "pending" };
    await saveQueue(dataDir, [...q, cand]);
    return cand;
  });

// OWNER-ONLY. Writes to the shared brain FIRST, marks promoted only on success. Refuses re-promote. Locked.
export const promoteKnowledge = async (
  dataDir: string,
  id: string,
  deps: KnowledgeDeps,
): Promise<{ promoted: boolean; reason?: string }> =>
  withQueueLock(async () => {
    const q = await loadQueue(dataDir);
    const cand = q.find((c) => c.id === id);
    if (!cand) return { promoted: false, reason: "candidate not found" };
    if (cand.status === "promoted") return { promoted: false, reason: "already promoted" };
    // Light dedup: skip if the shared brain already has a near-identical title.
    try {
      const existing = await deps.sharedBackend.search(cand.title, 3);
      if (existing.some((e) => (e.content || "").toLowerCase().includes(cand.title.toLowerCase()))) {
        // not a hard block — note it, still promote (owner already approved)
      }
    } catch {
      /* dedup is best-effort */
    }
    try {
      await deps.sharedBackend.store(`${cand.title}\n\n${cand.content}`, ["corra:promoted", ...cand.tags]); // throws -> stays pending
    } catch (error: unknown) {
      return { promoted: false, reason: `backend store failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    await saveQueue(dataDir, nextKnowledgeState(q, "promote", id));
    return { promoted: true };
  });

export const editKnowledge = async (dataDir: string, id: string, content: string): Promise<void> =>
  withQueueLock(async () => {
    await saveQueue(dataDir, nextKnowledgeState(await loadQueue(dataDir), "edit", id, content));
  });

export const rejectKnowledge = async (dataDir: string, id: string): Promise<void> =>
  withQueueLock(async () => {
    await saveQueue(dataDir, nextKnowledgeState(await loadQueue(dataDir), "reject", id));
  });

// MODEL-FACING TOOL: draft + list ONLY. Cannot promote.
const toolSchema = z.object({
  action: z.enum(["draft", "list"]),
  title: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const createKnowledgeQueueTool = (): Tool => ({
  name: "corra_knowledge_queue",
  description:
    "Propose durable, fleet-valuable knowledge for the SHARED brain. action=draft (queue a candidate: title+content+tags — use for generalizable insights, architectural patterns, decision rationale, lessons; NOT ephemeral news) or list (show pending). This tool CANNOT promote — only the owner promotes via /promote.",
  parameters: toolSchema,
  timeout_ms: 20_000,
  async execute(args, ctx: ToolContext) {
    const input = toolSchema.parse(args);
    if (input.action === "draft") {
      if (!input.title || !input.content) return { content: JSON.stringify({ error: "title and content required" }), isError: true };
      const c = await addCandidate(ctx.dataDir, { title: input.title, content: input.content, tags: input.tags ?? [] });
      return { content: JSON.stringify({ drafted: { id: c.id, title: c.title } }) };
    }
    const pending = await listCandidates(ctx.dataDir);
    return { content: JSON.stringify({ pending, text: formatCandidateList(pending) }) };
  },
});
