import { z } from "zod";
import type { MemoryBackend } from "@hairyclaw/memory";
import type { Tool, ToolContext } from "../types.js";

export interface SupersedeDeps {
  backend: MemoryBackend; // Corra's namespace backend (writeNamespace=corra)
  hiveApiUrl: string;
  hiveApiKey?: string;
}

const supersedeSchema = z.object({
  query: z.string().describe("text that locates the outdated knowledge item to correct"),
  newContent: z.string().describe("the corrected/updated content that replaces it"),
  tags: z
    .preprocess(
      (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
      z.array(z.string()),
    )
    .optional(),
});

export const createSupersedeTool = (deps: SupersedeDeps): Tool => ({
  name: "corra_supersede",
  description:
    "Correct or replace a stale fact in my own (corra) knowledge. Give a query that locates the outdated item plus the corrected content. I find the item, store the correction, and mark the old one superseded so our knowledge stays accurate. Use this when something I previously stored is now wrong or outdated.",
  parameters: supersedeSchema,
  timeout_ms: 20_000,
  async execute(args, ctx: ToolContext) {
    const input = supersedeSchema.parse(args);
    const hits = await deps.backend.search(input.query, 1);
    if (hits.length === 0) {
      return { content: JSON.stringify({ error: "no matching item to supersede" }), isError: true };
    }
    const oldId = hits[0].id;
    const newId = await deps.backend.store(input.newContent, ["corra:correction", ...(input.tags ?? [])]);
    const resp = await fetch(`${deps.hiveApiUrl}/api/v1/knowledge/items/${oldId}/supersede`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(deps.hiveApiKey ? { "x-api-key": deps.hiveApiKey } : {}),
      },
      body: JSON.stringify({ superseded_by: newId }),
    });
    if (!resp.ok) {
      ctx.logger.warn({ oldId, newId, status: resp.status }, "corra supersede endpoint failed");
      return { content: JSON.stringify({ corrected: false, storedNew: newId, supersedeStatus: resp.status }), isError: true };
    }
    ctx.logger.info({ oldId, newId }, "corra superseded a stale item");
    return { content: JSON.stringify({ corrected: true, oldId, newId }) };
  },
});
