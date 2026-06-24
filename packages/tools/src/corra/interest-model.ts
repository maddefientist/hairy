import { z } from "zod";
import type { MemoryBackend } from "@hairyclaw/memory";
import type { Tool, ToolContext } from "../types.js";

export type Weights = Record<string, number>;

const MEMORY_TAG = "corra:interest-model";

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export const scoreItem = (text: string, weights: Weights): number => {
  const tokens = new Set(tokenize(text));
  let total = 0;
  let matched = 0;
  for (const [topic, w] of Object.entries(weights)) {
    total += w;
    if (tokenize(topic).some((t) => tokens.has(t))) matched += w;
  }
  if (total === 0) return 0;
  return Math.max(0, Math.min(1, matched / total));
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

export const applySubscription = (weights: Weights, topics: string[], cap = 0.55, delta = 0.05): Weights => {
  const next: Weights = { ...weights };
  for (const t of topics) {
    const cur = next[t] ?? 0;
    next[t] = Math.min(cap, cur + delta);
  }
  return next;
};

const loadWeights = async (memory: MemoryBackend): Promise<Weights> => {
  const results = await memory.search(MEMORY_TAG, 3);
  for (const r of results) {
    try {
      const parsed = JSON.parse(r.content) as { type?: string; weights?: Weights };
      if (parsed.type === "interest-model" && parsed.weights) return parsed.weights;
    } catch {
      // skip non-JSON records
    }
  }
  return {};
};

const interestSchema = z.object({
  action: z.enum(["score", "react", "subscribe"]),
  text: z.string().optional(),
  topics: z.array(z.string()).optional(),
  signal: z.enum(["useful", "noted", "wrong"]).optional(),
  itemId: z.string().optional(),
});

export interface InterestDeps {
  memory: MemoryBackend;
}

export const createInterestModelTool = (deps: InterestDeps): Tool => ({
  name: "corra_interest",
  description:
    "Corra's interest model. action=score returns a 0-1 relevance for `text` against learned topic weights. action=react updates weights from a Telegram reaction (signal=useful|noted|wrong over `topics`) and trains Hive ranking.",
  parameters: interestSchema,
  timeout_ms: 15_000,
  async execute(args, ctx: ToolContext) {
    const input = interestSchema.parse(args);
    const weights = await loadWeights(deps.memory);

    if (input.action === "score") {
      const score = scoreItem(input.text ?? "", weights);
      return { content: JSON.stringify({ score }), metadata: { score } };
    }

    if (input.action === "subscribe") {
      const topics = extractTopics(input.text ?? "");
      if (topics.length === 0) return { content: JSON.stringify({ subscribed: [] }) };
      const updated = applySubscription(weights, topics);
      await deps.memory.store(JSON.stringify({ type: "interest-model", weights: updated }), [MEMORY_TAG]);
      ctx.logger.info({ topics }, "corra interest subscription prior applied");
      return { content: JSON.stringify({ subscribed: topics }) };
    }

    const topics = input.topics ?? [];
    const signal = input.signal ?? "noted";
    const updated = applyReaction(weights, topics, signal);
    await deps.memory.store(JSON.stringify({ type: "interest-model", weights: updated }), [MEMORY_TAG]);
    if (input.itemId && deps.memory.feedback) {
      await deps.memory.feedback(input.itemId, signal);
    }
    ctx.logger.info({ topics, signal }, "corra interest updated");
    return { content: JSON.stringify({ updated: true, topics, signal }) };
  },
});
