import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { z } from "zod";
import type { MemoryBackend } from "@hairyclaw/memory";
import type { Tool, ToolContext } from "../types.js";

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
    const ingested: NewsletterDigest[] = [];
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
        if (limit && ingested.length >= limit) break;
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const digest = parseNewsletter(parsed);
        const dupes = await deps.memory.search(digest.messageId, 1);
        if (dupes.some((d) => d.content.includes(digest.messageId))) {
          await client.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true });
          continue;
        }
        await deps.memory.store(JSON.stringify(digest), [
          "corra:newsletter",
          `from:${digest.from}`,
          digest.listId ? `list:${digest.listId}` : "list:none",
        ]);
        ingested.push(digest);
        await client.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
      await client.logout();
    }
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
