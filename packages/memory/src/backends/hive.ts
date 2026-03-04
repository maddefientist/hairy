/**
 * Hari-Hive memory backend.
 * Connects to a running agentssot (https://github.com/maddefientist/agentssot)
 * instance for semantic embedding search + durable knowledge storage.
 *
 * Falls back gracefully — returns empty results on network error, never throws.
 */
import { randomUUID } from "node:crypto";
import type { MemoryBackend, SearchResult } from "../types.js";

export interface HiveBackendOptions {
  /** Root URL of the hive API (e.g. http://localhost:8088) */
  apiUrl: string;
  /** Optional API key for authenticated endpoints */
  apiKey?: string;
  /** Separate read/write keys if the deployment splits them */
  readApiKey?: string;
  writeApiKey?: string;
  /** Default namespace (used for both read and write unless overridden) */
  namespace?: string;
  /** Override: namespaces to search across (read path) */
  readNamespaces?: string[];
  /** Override: namespace to write into */
  writeNamespace?: string;
  /** Optional device/agent identifier for scoped recall */
  device?: string;
}

const buildHeaders = (apiKey?: string): Record<string, string> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
};

const parseSearchItems = (payload: unknown): SearchResult[] => {
  if (typeof payload !== "object" || payload === null) return [];

  const record = payload as Record<string, unknown>;
  const items =
    (Array.isArray(record.items) ? record.items : undefined) ??
    (Array.isArray(record.results) ? record.results : undefined);

  if (!items) return [];

  return items
    .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
    .map((i) => ({
      id: typeof i.id === "string" ? i.id : randomUUID(),
      content: typeof i.content === "string" ? i.content : "",
      tags: Array.isArray(i.tags) ? i.tags.filter((t): t is string => typeof t === "string") : [],
      createdAt:
        typeof i.createdAt === "string"
          ? i.createdAt
          : typeof i.created_at === "string"
            ? i.created_at
            : new Date().toISOString(),
      score: typeof i.score === "number" ? i.score : 0,
    }))
    .filter((i) => i.content.length > 0);
};

export class HiveMemoryBackend implements MemoryBackend {
  readonly name = "hive";
  private readonly root: string;
  private readonly opts: HiveBackendOptions;

  constructor(opts: HiveBackendOptions) {
    this.root = opts.apiUrl.replace(/\/$/, "");
    this.opts = opts;
  }

  async store(content: string, tags: string[] = []): Promise<string> {
    const writeKey = this.opts.writeApiKey ?? this.opts.apiKey;
    const ns = this.opts.writeNamespace ?? this.opts.namespace ?? "default";

    // Try modern /ingest endpoint first
    try {
      const res = await fetch(`${this.root}/ingest`, {
        method: "POST",
        headers: buildHeaders(writeKey),
        body: JSON.stringify({
          namespace: ns,
          knowledge_items: [{ content, tags, source: "hairy-memory" }],
        }),
      });
      if (res.ok) {
        const p = (await res.json()) as Record<string, unknown>;
        const counts = p.counts as Record<string, unknown> | undefined;
        if (typeof counts?.knowledge_items === "number" && counts.knowledge_items > 0) {
          return randomUUID();
        }
      }
    } catch {
      /* fall through */
    }

    // Compatibility: /api/v1/knowledge
    try {
      const res = await fetch(`${this.root}/api/v1/knowledge`, {
        method: "POST",
        headers: buildHeaders(writeKey),
        body: JSON.stringify({ content, tags, namespace: ns, device: this.opts.device }),
      });
      if (res.ok) {
        const p = (await res.json()) as Record<string, unknown>;
        if (typeof p.id === "string") return p.id;
      }
    } catch {
      /* fall through */
    }

    // Legacy: /knowledge
    try {
      const res = await fetch(`${this.root}/knowledge`, {
        method: "POST",
        headers: buildHeaders(writeKey),
        body: JSON.stringify({ content, tags, namespace: ns, device: this.opts.device }),
      });
      if (res.ok) {
        const p = (await res.json()) as Record<string, unknown>;
        if (typeof p.id === "string") return p.id;
      }
    } catch {
      /* fall through */
    }

    // All endpoints failed — let SemanticMemory fall back to local
    throw new Error("hive store: all endpoints unreachable");
  }

  async search(query: string, topK = 5): Promise<SearchResult[]> {
    const readKey = this.opts.readApiKey ?? this.opts.apiKey;
    const defaultNs = this.opts.writeNamespace ?? this.opts.namespace ?? "default";
    const namespaces =
      this.opts.readNamespaces && this.opts.readNamespaces.length > 0
        ? this.opts.readNamespaces
        : [defaultNs];

    const perNs = await Promise.all(
      namespaces.map((ns) => this.recallNamespace(ns, query, topK, readKey)),
    );

    return perNs
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async feedback(id: string, signal: "useful" | "noted" | "wrong"): Promise<void> {
    const writeKey = this.opts.writeApiKey ?? this.opts.apiKey;
    try {
      await fetch(`${this.root}/feedback`, {
        method: "POST",
        headers: buildHeaders(writeKey),
        body: JSON.stringify({ id, signal }),
      });
    } catch {
      // best-effort
    }
  }

  // ── private ──────────────────────────────────────────────────────────

  private async recallNamespace(
    namespace: string,
    query: string,
    topK: number,
    apiKey?: string,
  ): Promise<SearchResult[]> {
    const modernBody: Record<string, unknown> = {
      namespace,
      scope: "all",
      query_text: query,
      top_k: topK,
    };
    if (this.opts.device) modernBody.agent_key = this.opts.device;

    // Modern: /recall
    try {
      const res = await fetch(`${this.root}/recall`, {
        method: "POST",
        headers: buildHeaders(apiKey),
        body: JSON.stringify(modernBody),
      });
      if (res.ok) return parseSearchItems(await res.json());
    } catch {
      /* fall through */
    }

    // Compat: /api/v1/recall
    const compatBody: Record<string, unknown> = {
      query,
      top_k: topK,
      namespace,
      device: this.opts.device,
    };
    try {
      const res = await fetch(`${this.root}/api/v1/recall`, {
        method: "POST",
        headers: buildHeaders(apiKey),
        body: JSON.stringify(compatBody),
      });
      if (res.ok) return parseSearchItems(await res.json());
    } catch {
      /* fall through */
    }

    // Legacy: /search
    try {
      const res = await fetch(`${this.root}/search`, {
        method: "POST",
        headers: buildHeaders(apiKey),
        body: JSON.stringify({ query, topK, namespace }),
      });
      if (res.ok) return parseSearchItems(await res.json());
    } catch {
      /* fall through */
    }

    // All endpoints failed — throw so SemanticMemory can fall back to local
    throw new Error(`hive recall: all endpoints unreachable for namespace ${namespace}`);
  }
}
