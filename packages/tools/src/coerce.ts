/**
 * Coercion helpers for LLM-facing tool schemas.
 *
 * Models routinely pass array parameters as a single comma-separated string
 * (`tags: "ai, agents"` instead of `["ai","agents"]`). Without coercion this throws a
 * ZodError ("Expected array, received string") and the tool call is dropped — silently losing
 * the signal. Wrap any `z.array(...)` param with `z.preprocess(splitCsv, ...)` so both shapes work.
 */

/** Split a comma-separated string into a trimmed, non-empty array; pass through anything else. */
export const splitCsv = (v: unknown): unknown =>
  typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v;
