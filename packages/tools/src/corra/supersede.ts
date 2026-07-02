import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MemoryBackend } from "@hairyclaw/memory";
import type { Tool, ToolContext } from "../types.js";

export interface SupersedeDeps {
  backend: MemoryBackend; // Corra's namespace backend (writeNamespace=corra) — used to LOCATE the stale item
  hiveApiUrl: string;
  hiveApiKey?: string;
  namespace: string; // hive namespace corra writes to (e.g. "corra")
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

const hiveHeaders = (apiKey?: string): Record<string, string> => ({
  "content-type": "application/json",
  ...(apiKey ? { "x-api-key": apiKey } : {}),
});

/**
 * Store the correction and return its REAL hive item id.
 *
 * The hive `/ingest` endpoint returns only counts (no ids), which is exactly why the shared
 * backend.store() fabricates a random UUID — a value that does NOT exist in hive and makes the
 * supersede endpoint 404 (it does `session.get(KnowledgeItem, superseded_by)`). To get the real id
 * we stamp a unique correlation marker into the item's `source` field, then look it up by that
 * marker via GET /query (keyword ilike over content/source). Returns the real UUID, or null if it
 * could not be resolved (in which case we must NOT link a bogus id).
 */
const storeCorrectionReturningId = async (
  deps: SupersedeDeps,
  content: string,
  tags: string[],
): Promise<string | null> => {
  const marker = randomUUID();
  const source = `corra:correction:${marker}`;
  const ingestRes = await fetch(`${deps.hiveApiUrl}/ingest`, {
    method: "POST",
    headers: hiveHeaders(deps.hiveApiKey),
    body: JSON.stringify({
      namespace: deps.namespace,
      knowledge_items: [{ content, tags, source, memory_type: "correction" }],
    }),
  });
  if (!ingestRes.ok) throw new Error(`hive ingest HTTP ${ingestRes.status}`);

  // /ingest commits synchronously, but poll a few times to tolerate any indexing lag.
  const url = `${deps.hiveApiUrl}/query?q=${encodeURIComponent(marker)}&namespace=${encodeURIComponent(deps.namespace)}&limit=5`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const qr = await fetch(url, { headers: hiveHeaders(deps.hiveApiKey) });
    if (qr.ok) {
      const body = (await qr.json()) as { results?: Array<{ id?: unknown; kind?: unknown }> };
      const hit = (body.results ?? []).find(
        (r) => r.kind === "knowledge_item" && typeof r.id === "string",
      );
      if (hit && typeof hit.id === "string") return hit.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
};

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

    // Store the correction and resolve its REAL hive id. If we cannot resolve a real id we refuse to
    // supersede — linking to a fabricated id would 404 or corrupt the knowledge graph (M1).
    let newId: string | null;
    try {
      newId = await storeCorrectionReturningId(deps, input.newContent, ["corra:correction", ...(input.tags ?? [])]);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.logger.warn({ oldId, reason }, "corra supersede: storing correction failed");
      return { content: JSON.stringify({ corrected: false, error: `failed to store correction: ${reason}` }), isError: true };
    }
    if (!newId) {
      ctx.logger.warn({ oldId }, "corra supersede: correction stored but real hive id unresolved; not linking");
      return {
        content: JSON.stringify({
          corrected: false,
          error: "stored the correction but could not resolve its hive id; left the old item unchanged to avoid a bogus supersede link",
        }),
        isError: true,
      };
    }

    const resp = await fetch(`${deps.hiveApiUrl}/api/v1/knowledge/items/${oldId}/supersede`, {
      method: "POST",
      headers: hiveHeaders(deps.hiveApiKey),
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
