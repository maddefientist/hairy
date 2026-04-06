import { type HiveBackendOptions, HiveMemoryBackend } from "./backends/hive.js";
/**
 * SemanticMemory — thin wrapper that delegates to a MemoryBackend.
 *
 * The backend is pluggable:
 *  - LocalMemoryBackend  (default — JSON file, keyword scoring, zero deps)
 *  - HiveMemoryBackend   (optional — Hari-Hive semantic search service)
 *  - Bring your own:      implement MemoryBackend, pass it in
 *
 * Factory: `createMemoryBackend()` picks the right one from env vars.
 */
import { LocalMemoryBackend } from "./backends/local.js";
import type { MemoryBackend, SearchOptions, SearchResult, StoreOptions } from "./types.js";

export interface SemanticMemoryOptions {
  /** Path for local JSON storage (used by LocalMemoryBackend, and as fallback) */
  filePath: string;
  /** Inject a pre-built backend. If omitted, `createMemoryBackend()` is used. */
  backend?: MemoryBackend;
}

export class SemanticMemory {
  private readonly backend: MemoryBackend;
  private readonly fallback: LocalMemoryBackend;

  constructor(opts: SemanticMemoryOptions) {
    this.fallback = new LocalMemoryBackend({ filePath: opts.filePath });
    this.backend = opts.backend ?? this.fallback;
  }

  /** Which backend is active */
  get backendName(): string {
    return this.backend.name;
  }

  async store(content: string, tags: string[] = [], options?: StoreOptions): Promise<string> {
    try {
      return await this.backend.store(content, tags, options);
    } catch {
      // If remote backend fails, fall through to local
      if (this.backend !== this.fallback) {
        return this.fallback.store(content, tags, options);
      }
      throw new Error("local memory backend failed");
    }
  }

  async search(query: string, topK = 5, options?: SearchOptions): Promise<SearchResult[]> {
    try {
      return await this.backend.search(query, topK, options);
    } catch {
      if (this.backend !== this.fallback) {
        return this.fallback.search(query, topK, options);
      }
      return [];
    }
  }

  async feedback(id: string, signal: "useful" | "noted" | "wrong"): Promise<void> {
    if (this.backend.feedback) {
      await this.backend.feedback(id, signal);
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────

export interface MemoryBackendEnvOptions {
  /** Path for local JSON file (always used as fallback) */
  filePath: string;
  /** Explicit hive options — if provided, hive backend is used */
  hive?: HiveBackendOptions;
}

/**
 * Create a MemoryBackend from environment variables.
 *
 * Priority:
 *  1. If `hive` options or `HARI_HIVE_URL` env var is set → HiveMemoryBackend
 *  2. Otherwise → LocalMemoryBackend (works immediately, no infra needed)
 */
export const createMemoryBackend = (opts: MemoryBackendEnvOptions): MemoryBackend => {
  // Explicit hive config takes priority
  if (opts.hive) {
    return new HiveMemoryBackend(opts.hive);
  }

  // Auto-detect from env vars
  const hiveUrl = process.env.HARI_HIVE_URL;
  if (hiveUrl) {
    return new HiveMemoryBackend({
      apiUrl: hiveUrl,
      apiKey: process.env.HARI_HIVE_API_KEY,
      readApiKey: process.env.HARI_HIVE_READ_API_KEY,
      writeApiKey: process.env.HARI_HIVE_WRITE_API_KEY,
      namespace: process.env.HARI_HIVE_NAMESPACE,
      readNamespaces: parseCsvEnv(process.env.HARI_HIVE_READ_NAMESPACES),
      writeNamespace: process.env.HARI_HIVE_WRITE_NAMESPACE,
      device: process.env.HARI_HIVE_DEVICE,
    });
  }

  // Default: local JSON backend
  return new LocalMemoryBackend({ filePath: opts.filePath });
};

const parseCsvEnv = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
};

// Re-export backends for direct use
export { LocalMemoryBackend } from "./backends/local.js";
export { HiveMemoryBackend } from "./backends/hive.js";
export type { HiveBackendOptions } from "./backends/hive.js";
