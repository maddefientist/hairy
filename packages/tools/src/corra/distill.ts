/**
 * corra_distill — distill a media source (video/audio/article/thread) into knowledge
 * candidates via AgentSSOT's POST /api/v1/distill endpoint.
 *
 * Each returned lesson is drafted into the owner promotion queue (corra_knowledge_queue).
 * This tool CANNOT promote — only the owner promotes via /promote.
 */
import { z } from "zod";
import { addCandidate } from "./knowledge-queue.js";
import type { Tool, ToolContext } from "../types.js";

export interface DistillDeps {
  hiveApiUrl: string;
  hiveApiKey?: string;
}

const distillSchema = z
  .object({
    source_url: z.string().url().optional(),
    text: z.string().optional(),
    media_type: z.enum(["video", "audio", "article", "thread"]),
    title: z.string().optional(),
  })
  .refine((v) => (v.media_type === "video" || v.media_type === "audio") ? !!v.source_url : true, {
    message: "source_url is required for video/audio media_type",
    path: ["source_url"],
  })
  .refine((v) => (v.media_type === "article" || v.media_type === "thread") ? (!!v.text && v.text.trim().length > 0) : true, {
    message: "non-empty text is required for article/thread media_type",
    path: ["text"],
  });

const buildHeaders = (apiKey?: string): Record<string, string> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
};

// Endpoint responses are untrusted at runtime — validate each lesson with zod
// and drop malformed ones rather than letting a bad field crash the draft loop.
const lessonSchema = z.object({
  claim: z.string().min(1),
  citation: z.string().default(""),
  memory_type: z.string().default("skill"),
  confidence: z.number().default(0),
});

// Length caps so an oversized endpoint field can't create an unbounded
// knowledge-queue candidate (the ingest backend caps content at 20k).
const MAX_TITLE = 120;
const MAX_FIELD = 2_000;
const MAX_CONTENT = 8_000;

export const createDistillTool = (deps: DistillDeps): Tool => ({
  name: "corra_distill",
  description:
    "Distill a media source (video/audio/article/thread) into reviewable knowledge candidates. Provide source_url (for video/audio) or text (for article/thread). Each extracted lesson is drafted into the corra_knowledge_queue for owner /promote — nothing is auto-promoted to the shared brain.",
  parameters: distillSchema,
  timeout_ms: 60_000,
  async execute(args, ctx: ToolContext) {
    const input = distillSchema.parse(args);

    const url = `${deps.hiveApiUrl.replace(/\/$/, "")}/api/v1/distill`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: buildHeaders(deps.hiveApiKey),
        body: JSON.stringify({
          source_url: input.source_url,
          text: input.text,
          media_type: input.media_type,
          title: input.title,
        }),
      });
    } catch {
      return { content: JSON.stringify({ error: "distill endpoint unreachable" }), isError: true };
    }

    if (!res.ok) {
      return {
        content: JSON.stringify({ error: `distill failed: HTTP ${res.status}` }),
        isError: true,
      };
    }

    const payload = (await res.json()) as {
      provenance?: { source_url?: string };
      transcript_ref?: unknown;
      lessons?: unknown;
    };
    const rawLessons = Array.isArray(payload.lessons) ? payload.lessons : [];
    const transcript_ref = typeof payload.transcript_ref === "string" ? payload.transcript_ref : "";
    const sourceUrl = payload.provenance?.source_url;

    let drafted = 0;
    let skipped = 0;
    for (const raw of rawLessons) {
      const parsed = lessonSchema.safeParse(raw);
      if (!parsed.success) {
        skipped++;
        continue; // malformed lesson — skip, never crash the loop
      }
      const lesson = parsed.data;
      const claim = lesson.claim.slice(0, MAX_FIELD);
      const citation = lesson.citation.slice(0, MAX_FIELD);
      const content = `${claim}\n\nSource: ${sourceUrl ?? "n/a"} @ ${citation}\nconfidence: ${lesson.confidence}`.slice(
        0,
        MAX_CONTENT,
      );
      await addCandidate(ctx.dataDir, {
        title: claim.slice(0, MAX_TITLE),
        content,
        tags: ["corra:intake", input.media_type, lesson.memory_type],
      });
      drafted++;
    }

    return {
      content: JSON.stringify({
        distilled: rawLessons.length,
        drafted,
        skipped,
        transcript_ref,
        note: "Review with corra_knowledge_queue list, then owner /promote to claude-shared.",
      }),
    };
  },
});