import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { MemoryBackend } from "@hairyclaw/memory";
import { splitCsv } from "../coerce.js";
import type { Tool, ToolContext } from "../types.js";

export type Weights = Record<string, number>;

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Per-item relevance in [0,1]: the weight of the STRONGEST topic the item matches. This is
 * vocabulary-independent — unlike dividing matched weight by the sum of ALL weights, which drove
 * every score toward 0 as the model learned more topics (H1). An item about a topic the owner
 * cares about at weight 0.7 scores 0.7, regardless of how many other topics exist.
 */
export const scoreItem = (text: string, weights: Weights): number => {
  const tokens = new Set(tokenize(text));
  let best = 0;
  for (const [topic, w] of Object.entries(weights)) {
    if (tokenize(topic).some((t) => tokens.has(t))) best = Math.max(best, w);
  }
  return Math.max(0, Math.min(1, best));
};

export const applyReaction = (weights: Weights, topics: string[], signal: "useful" | "noted" | "wrong"): Weights => {
  const delta = signal === "useful" ? 0.1 : signal === "wrong" ? -0.15 : 0;
  const next: Weights = { ...weights };
  for (const t of topics) {
    const cur = next[t] ?? 0.5;
    next[t] = Math.max(0, Math.min(1, cur + delta));
  }
  return next;
};

const STOP = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "your", "you",
  "new", "with", "this", "that", "is", "are", "how", "why", "what", "from",
  "weekly", "daily", "newsletter", "issue", "edition", "update", "updates",
]);

export const extractTopics = (subject: string): string[] => {
  const words = (subject.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !STOP.has(w));
  return [...new Set(words)].slice(0, 5);
};

/**
 * Positive engagement bump (owner opened/discussed an item). Cap is ABOVE the ping threshold (0.6)
 * so sustained engagement can actually make future matching items ping — the old 0.55 cap sat below
 * the threshold, guaranteeing zero pings (H1). Only ever called on genuine engagement, never on
 * every arrival (the blanket auto-subscribe that used to inflate every topic was removed).
 */
export const applySubscription = (weights: Weights, topics: string[], cap = 0.9, delta = 0.1): Weights => {
  const next: Weights = { ...weights };
  for (const t of topics) {
    const cur = next[t] ?? 0;
    next[t] = Math.min(cap, cur + delta);
  }
  return next;
};

// ── Persistence: a single local JSON file (atomic + in-process lock), NOT hive semantic-append ──
// The old model stored every update as a new hive item and read back the top-3 by semantic search,
// which never converged (168 snapshots) and landfilled the namespace. One file is the source of truth.
const weightsPath = (dataDir: string): string => join(dataDir, "corra", "interest-model.json");

export const loadWeights = async (dataDir: string): Promise<Weights> => {
  try {
    const raw = await readFile(weightsPath(dataDir), "utf8");
    if (raw.trim() === "") return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Weights = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    /* missing/corrupt -> empty */
  }
  return {};
};

let weightsLock: Promise<unknown> = Promise.resolve();
const withWeightsLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = weightsLock.then(fn, fn);
  weightsLock = run.catch(() => undefined);
  return run;
};

export const saveWeights = async (dataDir: string, weights: Weights): Promise<void> =>
  withWeightsLock(async () => {
    await mkdir(join(dataDir, "corra"), { recursive: true });
    const path = weightsPath(dataDir);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(weights, null, 2));
    await rename(tmp, path);
  });

const interestSchema = z.object({
  action: z.enum(["score", "react", "subscribe"]),
  text: z.string().optional(),
  topics: z.preprocess(splitCsv, z.array(z.string())).optional(),
  signal: z.enum(["useful", "noted", "wrong"]).optional(),
  itemId: z.string().optional(),
});

export interface InterestDeps {
  memory: MemoryBackend; // used only to train hive recall ranking via feedback()
}

export const createInterestModelTool = (deps: InterestDeps): Tool => ({
  name: "corra_interest",
  description:
    "Corra's interest model. action=score returns a 0-1 relevance for `text` against learned topic weights. action=react updates weights from a signal (useful|noted|wrong over `topics`) and trains Hive ranking. action=subscribe bumps interest in a subject's topics (use when the owner opened/engaged with an item).",
  parameters: interestSchema,
  timeout_ms: 15_000,
  async execute(args, ctx: ToolContext) {
    const input = interestSchema.parse(args);
    const weights = await loadWeights(ctx.dataDir);

    if (input.action === "score") {
      const score = scoreItem(input.text ?? "", weights);
      return { content: JSON.stringify({ score }), metadata: { score } };
    }

    if (input.action === "subscribe") {
      const topics = extractTopics(input.text ?? "");
      if (topics.length === 0) return { content: JSON.stringify({ subscribed: [] }) };
      await saveWeights(ctx.dataDir, applySubscription(weights, topics));
      ctx.logger.info({ topics }, "corra interest: engagement bump applied");
      return { content: JSON.stringify({ subscribed: topics }) };
    }

    const topics = input.topics ?? [];
    const signal = input.signal ?? "noted";
    await saveWeights(ctx.dataDir, applyReaction(weights, topics, signal));
    if (input.itemId && deps.memory.feedback) {
      await deps.memory.feedback(input.itemId, signal);
    }
    ctx.logger.info({ topics, signal }, "corra interest updated");
    return { content: JSON.stringify({ updated: true, topics, signal }) };
  },
});
