import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { z } from "zod";
import { HiveStoreError, type MemoryBackend } from "@hairyclaw/memory";
import type { Tool, ToolContext } from "../types.js";
import { appendToInbox } from "./inbox.js";

// Dead-letter for newsletters the hive refused (e.g. 422 secret-scanner reject). The email itself
// is always safe in the local inbox; this records what still needs a (sanitized) push to hive so a
// later re-sync can find it, and stops the message from being refetched forever.
interface HiveDeferredEntry {
  messageId: string;
  subject: string;
  status: number;
  permanent: boolean;
  at: string;
}

const DEFERRED_CAP = 500;
const deferredPath = (dataDir: string): string => join(dataDir, "corra", "hive-deferred.json");

const recordHiveDeferred = async (dataDir: string, entry: HiveDeferredEntry): Promise<void> => {
  const path = deferredPath(dataDir);
  let existing: HiveDeferredEntry[] = [];
  try {
    const raw = await readFile(path, "utf8");
    if (raw.trim() !== "") {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed as HiveDeferredEntry[];
    }
  } catch {
    /* missing/corrupt -> start fresh */
  }
  const next = [...existing, entry].slice(-DEFERRED_CAP);
  await mkdir(join(dataDir, "corra"), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2));
  await rename(tmp, path);
};

export interface NewsletterDigest {
  messageId: string;
  from: string;
  listId?: string;
  subject: string;
  receivedAt: string;
  cleanText: string;
}

export interface ImapCfg {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface EmailIngestDeps {
  imap: ImapCfg;
  memory: MemoryBackend;
}

const stripHtml = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const parseNewsletter = (mail: ParsedMail): NewsletterDigest => {
  const rawListId = mail.headers?.get?.("list-id");
  const listId = typeof rawListId === "string" ? rawListId : undefined;
  const body = mail.text ?? (mail.html ? stripHtml(mail.html as string) : "");
  return {
    messageId: mail.messageId ?? `${Date.now()}@corra`,
    from: mail.from?.text ?? "unknown",
    listId,
    subject: mail.subject ?? "(no subject)",
    receivedAt: (mail.date ?? new Date()).toISOString(),
    cleanText: body.slice(0, 20000),
  };
};

/**
 * Strip the things that (a) make newsletters landfill in the semantic index and (b) trip the hive
 * secret-scanner (which was 422-rejecting every newsletter): tracking URLs, long base64/hex blobs,
 * and access-key-shaped tokens. The full raw body always stays in the local inbox; hive only needs
 * a clean, recall-friendly gist.
 */
export const stripTracking = (text: string): string =>
  text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, " ")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, " ")
    .replace(/\b[0-9a-fA-F]{32,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Distilled, scanner-safe summary of a newsletter for the hive semantic index. Compact (a short
 * cleaned excerpt, not the full body) so the `corra` namespace stops being a landfill of raw blobs.
 * Includes `Ref: <messageId>` so hive dedup by message-id keeps working.
 */
export const distillNewsletter = (d: NewsletterDigest): string =>
  [
    `Newsletter: ${d.subject}`,
    `From: ${d.from}`,
    d.listId ? `List: ${d.listId}` : "",
    `Received: ${d.receivedAt}`,
    `Ref: ${d.messageId}`,
    `Summary: ${stripTracking(d.cleanText).slice(0, 600)}`,
  ]
    .filter(Boolean)
    .join("\n");

const ingestSchema = z.object({ limit: z.number().optional() });

export const createEmailIngestTool = (deps: EmailIngestDeps): Tool => ({
  name: "corra_email_ingest",
  description:
    "Poll the Corra mailbox over IMAP, parse new (unseen) newsletters, dedup by message-id, and store digests in memory. Returns count + brief summaries of newly ingested items.",
  parameters: ingestSchema,
  timeout_ms: 60_000,
  async execute(args, ctx: ToolContext) {
    const { limit } = ingestSchema.parse(args);
    const client = new ImapFlow({
      host: deps.imap.host,
      port: deps.imap.port,
      secure: true,
      auth: { user: deps.imap.user, pass: deps.imap.password },
      logger: false,
    });
    await client.connect();

    // 1) Buffer raw message sources first. Do NOT await external services (hive)
    //    inside the fetch stream — imapflow stalls if the connection is blocked
    //    mid-fetch, which deadlocks the poll until the tool times out.
    const raw: Array<{ uid: number; source: Buffer }> = [];
    const lock = await client.getMailboxLock("INBOX");
    try {
      for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
        if (!msg.source) continue;
        raw.push({ uid: msg.uid, source: msg.source });
        if (limit && raw.length >= limit) break;
      }
    } finally {
      lock.release();
    }

    // 2) Process buffered messages off the IMAP stream: parse, dedup, store.
    //    Hive failures degrade gracefully — a failed dedup is treated as "new",
    //    a failed store leaves the message unseen so the next poll retries it.
    const ingested: NewsletterDigest[] = [];
    let hiveDeferred = 0;
    for (const m of raw) {
      const digest = parseNewsletter(await simpleParser(m.source));
      // The local inbox is the reliable backbone — persist FIRST so the email is never lost,
      // whatever the hive does next.
      await appendToInbox(ctx.dataDir, digest);
      let isDuplicate = false;
      try {
        const dupes = await deps.memory.search(digest.messageId, 1);
        isDuplicate = dupes.some((d) => d.content.includes(digest.messageId));
      } catch (err) {
        ctx.logger.warn({ err }, "corra dedup lookup failed; treating message as new");
      }
      if (!isDuplicate) {
        try {
          // Store only a distilled, sanitized summary — the full body lives in the local inbox.
          // This stops the corra namespace landfilling and stops tripping the secret scanner.
          await deps.memory.store(distillNewsletter(digest), [
            "corra:newsletter",
            `from:${digest.from}`,
            digest.listId ? `list:${digest.listId}` : "list:none",
          ]);
          ingested.push(digest);
        } catch (err) {
          // The email is already in the local inbox. Do NOT leave the message unseen — that caused
          // an infinite 120s refetch/poison loop (e.g. 422 secret-scanner rejects of newsletters
          // retried forever, plus 60s tool timeouts). Mark it Seen and dead-letter the hive-deferred
          // item for a later sanitized re-sync. HiveStoreError surfaces permanent (4xx) vs transient.
          const status = err instanceof HiveStoreError ? err.status : 0;
          const permanent = err instanceof HiveStoreError ? err.permanent : false;
          ctx.logger.warn(
            { messageId: digest.messageId, subject: digest.subject, status, permanent },
            "corra hive store failed; email kept in local inbox, marking seen (no retry loop)",
          );
          await recordHiveDeferred(ctx.dataDir, {
            messageId: digest.messageId,
            subject: digest.subject,
            status,
            permanent,
            at: new Date().toISOString(),
          });
          hiveDeferred += 1;
        }
      }
      await client.messageFlagsAdd(String(m.uid), ["\\Seen"], { uid: true });
    }
    await client.logout();
    ctx.logger.info({ count: ingested.length, hiveDeferred }, "corra ingest run");
    return {
      content: JSON.stringify({
        ingested: ingested.length,
        hiveDeferred,
        items: ingested.map((i) => ({ subject: i.subject, from: i.from })),
      }),
      metadata: { count: ingested.length, hiveDeferred },
    };
  },
});
