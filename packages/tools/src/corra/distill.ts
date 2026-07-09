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

interface DistillLesson {
  claim: string;
  citation: string;
  memory_type: string;
  confidence: number;
}

interface DistillResponse {
  provenance: { source_url?: string };
  transcript_ref: string;
  lessons: DistillLesson[];
}

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

    const payload = (await res.json()) as DistillResponse;
    const lessons = Array.isArray(payload.lessons) ? payload.lessons : [];
    const transcript_ref = typeof payload.transcript_ref === "string" ? payload.transcript_ref : "";
    const sourceUrl = payload.provenance?.source_url;

    let drafted = 0;
    for (const lesson of lessons) {
      const content = `${lesson.claim}\n\nSource: ${sourceUrl ?? "n/a"} @ ${lesson.citation}\nconfidence: ${lesson.confidence}`;
      await addCandidate(ctx.dataDir, {
        title: lesson.claim.slice(0, 120),
        content,
        tags: ["corra:intake", input.media_type, lesson.memory_type],
      });
      drafted++;
    }

    return {
      content: JSON.stringify({
        distilled: lessons.length,
        drafted,
        transcript_ref,
        note: "Review with corra_knowledge_queue list, then owner /promote to claude-shared.",
      }),
    };
  },
});