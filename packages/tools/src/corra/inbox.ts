import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "../types.js";
import type { NewsletterDigest } from "./email-ingest.js";

export interface InboxEntry {
  messageId: string;
  from: string;
  listId?: string;
  subject: string;
  receivedAt: string;
  snippet: string;
}

const MAX_ENTRIES = 1000;
const SNIPPET_CAP = 8000;

const inboxPath = (dataDir: string): string => join(dataDir, "corra", "inbox.json");

const load = async (dataDir: string): Promise<InboxEntry[]> => {
  try {
    return JSON.parse(await readFile(inboxPath(dataDir), "utf8")) as InboxEntry[];
  } catch {
    return [];
  }
};

const save = async (dataDir: string, entries: InboxEntry[]): Promise<void> => {
  await mkdir(join(dataDir, "corra"), { recursive: true });
  const tmp = `${inboxPath(dataDir)}.tmp`;
  await writeFile(tmp, JSON.stringify(entries, null, 2));
  await rename(tmp, inboxPath(dataDir));
};

let lock: Promise<unknown> = Promise.resolve();
const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
};

const byNewest = (a: InboxEntry, b: InboxEntry): number =>
  b.receivedAt > a.receivedAt ? 1 : b.receivedAt < a.receivedAt ? -1 : 0;

export const appendToInbox = async (dataDir: string, d: NewsletterDigest): Promise<void> =>
  withLock(async () => {
    const entries = await load(dataDir);
    if (entries.some((e) => e.messageId === d.messageId)) return;
    entries.push({
      messageId: d.messageId,
      from: d.from,
      listId: d.listId,
      subject: d.subject,
      receivedAt: d.receivedAt,
      snippet: d.cleanText.slice(0, SNIPPET_CAP),
    });
    entries.sort(byNewest);
    await save(dataDir, entries.slice(0, MAX_ENTRIES));
  });

export const listInbox = async (dataDir: string, limit = 20, sinceDays?: number): Promise<InboxEntry[]> => {
  const entries = (await load(dataDir)).sort(byNewest);
  const filtered =
    typeof sinceDays === "number"
      ? entries.filter((e) => Date.now() - new Date(e.receivedAt).getTime() <= sinceDays * 86_400_000)
      : entries;
  return filtered.slice(0, limit);
};

export const readInboxItem = async (dataDir: string, ref: string): Promise<InboxEntry | undefined> => {
  const entries = await listInbox(dataDir, MAX_ENTRIES);
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1 && n <= entries.length) return entries[n - 1];
  const q = ref.toLowerCase();
  return entries.find(
    (e) => e.messageId === ref || e.subject.toLowerCase().includes(q) || e.from.toLowerCase().includes(q),
  );
};

export const searchInbox = async (dataDir: string, query: string, limit = 10): Promise<InboxEntry[]> => {
  const q = query.toLowerCase();
  const entries = await listInbox(dataDir, MAX_ENTRIES);
  return entries
    .filter((e) => `${e.subject} ${e.from} ${e.snippet}`.toLowerCase().includes(q))
    .slice(0, limit);
};

export const formatInboxList = (entries: InboxEntry[]): string =>
  entries.length === 0
    ? "Inbox is empty — nothing has been ingested yet."
    : [
        "📥 Inbox (newest first):",
        ...entries.map((e, i) => `${i + 1}. ${e.subject} — ${e.from} (${e.receivedAt.slice(0, 10)})`),
      ].join("\n");

const inboxSchema = z.object({
  action: z.enum(["list", "read", "search"]),
  ref: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().optional(),
  sinceDays: z.number().optional(),
});

export const createInboxTool = (): Tool => ({
  name: "corra_inbox",
  description:
    "Browse the newsletters/emails I have ACTUALLY received and stored. action=list (most recent; optional limit, sinceDays), read (full body of one — ref = its list number, subject text, sender, or messageId), or search (keyword across subject/sender/body). ALWAYS use this to answer 'what's in my inbox', 'what newsletters do you have', 'what did <X> say', 'what's new', or anything about received mail — it reflects my real stored inbox; never answer such questions from memory or with semantic recall.",
  parameters: inboxSchema,
  timeout_ms: 15_000,
  async execute(args, ctx: ToolContext) {
    const input = inboxSchema.parse(args);
    if (input.action === "list") {
      const entries = await listInbox(ctx.dataDir, input.limit ?? 20, input.sinceDays);
      return {
        content: JSON.stringify({
          count: entries.length,
          items: entries.map(({ snippet, ...e }) => e),
          text: formatInboxList(entries),
        }),
      };
    }
    if (input.action === "read") {
      if (!input.ref)
        return {
          content: JSON.stringify({ error: "ref required (number, subject, sender, or messageId)" }),
          isError: true,
        };
      const item = await readInboxItem(ctx.dataDir, input.ref);
      if (!item)
        return {
          content: JSON.stringify({ error: "not found", ref: input.ref }),
          isError: true,
        };
      return {
        content: JSON.stringify({
          subject: item.subject,
          from: item.from,
          receivedAt: item.receivedAt,
          body: item.snippet,
        }),
      };
    }
    if (!input.query)
      return {
        content: JSON.stringify({ error: "query required" }),
        isError: true,
      };
    const hits = await searchInbox(ctx.dataDir, input.query, input.limit ?? 10);
    return {
      content: JSON.stringify({
        count: hits.length,
        items: hits.map(({ snippet, ...e }) => e),
        text: formatInboxList(hits),
      }),
    };
  },
});
