/**
 * Bounded, redacted diagnostics ring buffer for /debug and /health.
 *
 * This is intentionally NOT a general-purpose logger: every recorded entry
 * is a short category + stage label plus a small, explicitly-allowed set of
 * primitive metadata fields. It must never be handed message text, prompts,
 * tool arguments, chat ids, base URLs, or credentials — callers pass only
 * pre-classified, already-safe values (e.g. an HTTP status code, a provider
 * name, a boolean).
 */

export type DiagnosticMetaValue = string | number | boolean;

export interface DiagnosticEvent {
  category: string;
  stage: string;
  at: number;
  meta?: Record<string, DiagnosticMetaValue>;
}

const DEFAULT_MAX_PER_CATEGORY = 20;
const DEFAULT_MAX_META_KEYS = 6;
const DEFAULT_MAX_META_VALUE_LENGTH = 64;

export interface DiagnosticsRecorderOptions {
  maxPerCategory?: number;
}

const truncateMetaValue = (value: DiagnosticMetaValue): DiagnosticMetaValue => {
  if (typeof value !== "string") return value;
  return value.length > DEFAULT_MAX_META_VALUE_LENGTH
    ? `${value.slice(0, DEFAULT_MAX_META_VALUE_LENGTH)}…`
    : value;
};

/** Strip any meta key that looks like it might carry sensitive content. */
const DISALLOWED_META_KEY_PATTERN =
  /token|secret|password|credential|authorization|apikey|api_key|prompt|message|content|chatid|chat_id|url/i;

export class DiagnosticsRecorder {
  private readonly events = new Map<string, DiagnosticEvent[]>();
  private readonly maxPerCategory: number;

  constructor(opts: DiagnosticsRecorderOptions = {}) {
    this.maxPerCategory = opts.maxPerCategory ?? DEFAULT_MAX_PER_CATEGORY;
  }

  record(category: string, stage: string, meta?: Record<string, DiagnosticMetaValue>): void {
    const safeMeta = this.sanitizeMeta(meta);
    const event: DiagnosticEvent = {
      category,
      stage,
      at: Date.now(),
      ...(safeMeta ? { meta: safeMeta } : {}),
    };

    const bucket = this.events.get(category) ?? [];
    bucket.push(event);
    if (bucket.length > this.maxPerCategory) {
      bucket.splice(0, bucket.length - this.maxPerCategory);
    }
    this.events.set(category, bucket);
  }

  /** Snapshot suitable for /debug — bounded, redacted, safe to serialize as-is. */
  snapshot(): Record<string, DiagnosticEvent[]> {
    const out: Record<string, DiagnosticEvent[]> = {};
    for (const [category, bucket] of this.events) {
      out[category] = bucket.map((e) => ({ ...e, meta: e.meta ? { ...e.meta } : undefined }));
    }
    return out;
  }

  /** Counts per category/stage — cheap enough for /health. */
  counts(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [category, bucket] of this.events) {
      const stageCounts: Record<string, number> = {};
      for (const event of bucket) {
        stageCounts[event.stage] = (stageCounts[event.stage] ?? 0) + 1;
      }
      out[category] = stageCounts;
    }
    return out;
  }

  private sanitizeMeta(
    meta?: Record<string, DiagnosticMetaValue>,
  ): Record<string, DiagnosticMetaValue> | undefined {
    if (!meta) return undefined;
    const entries = Object.entries(meta)
      .filter(([key]) => !DISALLOWED_META_KEY_PATTERN.test(key))
      .slice(0, DEFAULT_MAX_META_KEYS)
      .map(([key, value]) => [key, truncateMetaValue(value)] as const);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
}
