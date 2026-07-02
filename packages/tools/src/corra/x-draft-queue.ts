import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "../types.js";

// "posting" = an approve is/was in-flight to X. It is persisted BEFORE the webhook call so that a
// crash between a successful post and the "approved" write cannot leave the draft re-postable.
export interface Draft {
  id: string;
  text: string;
  status: "pending" | "posting" | "approved";
}

const draftSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["pending", "posting", "approved"]),
});

// Thrown by the default poster when n8n returned an HTTP response that was NOT ok. Because the
// webhook uses responseMode=lastNode, a non-2xx means the tweet was definitively NOT published,
// so this failure is safe to roll back to "pending" and retry. A network error (no response) is
// left as the raw error → treated as ambiguous → the draft is held in-flight, never auto-reposted.
export class WebhookHttpError extends Error {
  constructor(readonly status: number) {
    super(`n8n webhook HTTP ${status}`);
    this.name = "WebhookHttpError";
  }
}
const queueArraySchema = z.array(draftSchema);

// Set a single draft's status, leaving the rest untouched.
const setStatus = (queue: Draft[], id: string, status: Draft["status"]): Draft[] =>
  queue.map((d) => (d.id === id ? { ...d, status } : d));

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
  // Shared secret sent as the `x-corra-secret` header so the n8n webhook (Header Auth) rejects any
  // LAN caller that isn't us. On the real webhook path an empty/undefined secret makes approveDraft
  // fail CLOSED (refuse to post) before any network I/O — it is never sent unauthenticated.
  n8nSharedSecret?: string;
  postFn?: (text: string) => Promise<void>;
}

export const formatPendingList = (pending: Draft[]): string =>
  pending.length === 0
    ? "No pending X drafts."
    : [
        "📝 Pending X drafts:",
        ...pending.map((d) =>
          d.status === "posting"
            ? `${d.id}. ⏳ ${d.text}  (in-flight — a prior post was interrupted; verify on X, then /skip to clear)`
            : `${d.id}. ${d.text}`,
        ),
        "",
        "Reply: /approve N · /edit N <text> · /skip N",
      ].join("\n");

// Everything the owner still needs to act on: pending drafts + any left in-flight ("posting").
export const listDrafts = async (dataDir: string): Promise<Draft[]> =>
  (await loadQueue(dataDir)).filter((d) => d.status !== "approved");

export const addDraft = async (dataDir: string, text: string): Promise<Draft> =>
  withQueueLock(async () => {
    const q = await loadQueue(dataDir);
    const id = String(q.reduce((m, d) => Math.max(m, Number(d.id) || 0), 0) + 1);
    const draft: Draft = { id, text, status: "pending" };
    await saveQueue(dataDir, [...q, draft]);
    return draft;
  });

// OWNER-ONLY. Marks the draft in-flight ("posting") and persists that BEFORE the external post,
// posts, then marks "approved" on success. Refuses to (re-)approve a draft that is already approved
// or already in-flight — so a crash between a successful post and the "approved" write can never
// leave the draft re-postable (no double tweet). Locked.
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
    if (target.status === "posting")
      return {
        posted: false,
        reason: "a prior post attempt was interrupted before confirmation — verify on X, then /skip to clear (it will not auto-repost)",
      };
    // Fail CLOSED on the real webhook path: never POST to X without the shared secret.
    // A blank env (secret unloaded) must refuse to post, not silently send an unauthenticated
    // request that some other endpoint might accept. postFn (test/alternate injection) opts out.
    if (!deps.postFn) {
      if (!deps.n8nWebhookUrl) return { posted: false, reason: "no webhook configured" };
      if (!deps.n8nSharedSecret)
        return { posted: false, reason: "webhook secret not configured — refusing to post unauthenticated" };
    }
    const usingDefaultPoster = !deps.postFn;
    const poster =
      deps.postFn ??
      (async (t: string) => {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-corra-secret": deps.n8nSharedSecret as string,
        };
        const resp = await fetch(deps.n8nWebhookUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ text: t }),
        });
        if (!resp.ok) throw new WebhookHttpError(resp.status);
      });
    // Persist the in-flight intent BEFORE the side effect. If THIS write fails nothing was posted
    // and the draft is untouched (still pending) — safe to surface as an error and retry later.
    await saveQueue(dataDir, setStatus(q, id, "posting"));
    try {
      await poster(target.text);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      // Definite non-2xx from n8n (responseMode=lastNode) means the tweet was NOT published, so it
      // is safe to roll back to "pending" and let the owner retry. Injected postFn signals the same
      // by throwing. A network error from the real webhook is AMBIGUOUS (the post may have landed) —
      // leave it in-flight and never auto-repost; the owner reconciles via /skip.
      const definitelyNotPosted = !usingDefaultPoster || error instanceof WebhookHttpError;
      if (definitelyNotPosted) {
        await saveQueue(dataDir, setStatus(q, id, "pending"));
        return { posted: false, reason: `post failed: ${reason}` };
      }
      return {
        posted: false,
        reason: `post unconfirmed (network error) — draft held in-flight; verify on X, then /skip to clear: ${reason}`,
      };
    }
    await saveQueue(dataDir, setStatus(q, id, "approved"));
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
