import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { z } from "zod";
import type { MemoryBackend } from "@hairyclaw/memory";
import type { Tool, ToolContext } from "../types.js";
import { appendToInbox } from "./inbox.js";

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
    for (const m of raw) {
      const digest = parseNewsletter(await simpleParser(m.source));
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
          await deps.memory.store(JSON.stringify(digest), [
            "corra:newsletter",
            `from:${digest.from}`,
            digest.listId ? `list:${digest.listId}` : "list:none",
          ]);
          ingested.push(digest);
        } catch (err) {
          ctx.logger.error({ err }, "corra store failed; leaving message unseen for retry");
          continue;
        }
      }
      await client.messageFlagsAdd(String(m.uid), ["\\Seen"], { uid: true });
    }
    await client.logout();
    ctx.logger.info({ count: ingested.length }, "corra ingest run");
    return {
      content: JSON.stringify({
        ingested: ingested.length,
        items: ingested.map((i) => ({ subject: i.subject, from: i.from })),
      }),
      metadata: { count: ingested.length },
    };
  },
});
