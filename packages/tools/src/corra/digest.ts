import { z } from "zod";
import type { MemoryBackend } from "@hairyclaw/memory";
import type { Tool, ToolContext } from "../types.js";
import type { NewsletterDigest } from "./email-ingest.js";

export interface ScoredItem { id: string; score: number; }

export const selectPushWorthy = (items: ScoredItem[], threshold: number): ScoredItem[] =>
  items.filter((i) => i.score >= threshold).sort((a, b) => b.score - a.score);

const digestSchema = z.object({
  mode: z.enum(["item", "daily", "weekly"]),
  messageId: z.string().optional(),
  windowDays: z.number().optional(),
});

export interface DigestDeps { memory: MemoryBackend; }

const parseDigests = (results: { content: string }[]): NewsletterDigest[] => {
  const out: NewsletterDigest[] = [];
  for (const r of results) {
    try {
      const d = JSON.parse(r.content) as NewsletterDigest;
      if (d.messageId && d.subject) out.push(d);
    } catch {
      // skip non-digest records
    }
  }
  return out;
};

const withinDays = (iso: string, days: number, now: number): boolean => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && now - t <= days * 86_400_000;
};

const assemble = (items: NewsletterDigest[], label: string): string => {
  if (items.length === 0) return `No newsletters in the ${label} window.`;
  const bySender = new Map<string, NewsletterDigest[]>();
  for (const it of items) {
    const arr = bySender.get(it.from) ?? [];
    arr.push(it);
    bySender.set(it.from, arr);
  }
  const lines: string[] = [`🗞️ Corra ${label} synthesis — ${items.length} item(s)`];
  for (const [sender, group] of bySender) {
    lines.push(`\n• ${sender}`);
    for (const g of group) lines.push(`  - ${g.subject}: ${g.cleanText.slice(0, 180).trim()}…`);
  }
  return lines.join("\n");
};

export const createDigestTool = (deps: DigestDeps): Tool => ({
  name: "corra_digest",
  description:
    "Produce a newsletter digest. mode=item (one message), daily, or weekly. Returns assembled text + count of items in the window.",
  parameters: digestSchema,
  timeout_ms: 30_000,
  async execute(args, ctx: ToolContext) {
    const input = digestSchema.parse(args);
    const now = Date.now();
    if (input.mode === "item") {
      const results = await deps.memory.search(input.messageId ?? "corra:newsletter", 5);
      const items = parseDigests(results);
      return { content: JSON.stringify({ text: assemble(items.slice(0, 1), "item"), count: items.length ? 1 : 0 }) };
    }
    const days = input.windowDays ?? (input.mode === "weekly" ? 7 : 1);
    const results = await deps.memory.search("corra:newsletter", 50);
    const items = parseDigests(results).filter((d) => withinDays(d.receivedAt, days, now));
    ctx.logger.info({ mode: input.mode, count: items.length }, "corra digest");
    return { content: JSON.stringify({ text: assemble(items, input.mode), count: items.length }), metadata: { count: items.length } };
  },
});
