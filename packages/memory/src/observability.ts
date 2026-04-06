/**
 * Memory Observability
 *
 * Wraps a MemoryBackend and records recall/ingest metrics for
 * operator visibility and diagnostics.
 *
 * Gated behind memoryObservability feature flag.
 */

import type { HairyClawLogger } from "@hairyclaw/observability";
import type { MemoryBackend, SearchOptions, SearchResult, StoreOptions } from "./types.js";

/**
 * Metrics tracked by the memory observer
 */
export interface MemoryMetrics {
  /** Total recall (search) calls */
  recallCount: number;
  /** Total ingest (store) calls */
  ingestCount: number;
  /** Average recall latency in ms */
  avgRecallLatencyMs: number;
  /** Last recall latency in ms */
  lastRecallLatencyMs: number | undefined;
  /** Total number of cache hits (when identical query is repeated) */
  cacheHits: number;
  /** Total recall calls (for hit ratio computation) */
  totalRecallAttempts: number;
  /** Cache hit ratio (0-1) */
  cacheHitRatio: number;
  /** ISO timestamp of last recall operation */
  lastRecallAt: string | undefined;
  /** ISO timestamp of last ingest operation */
  lastIngestAt: string | undefined;
}

/**
 * MemoryObserver wraps a MemoryBackend and records metrics.
 */
export class MemoryObserver implements MemoryBackend {
  readonly name: string;

  private recallCount = 0;
  private ingestCount = 0;
  private totalRecallLatencyMs = 0;
  private lastRecallLatencyMs: number | undefined;
  private cacheHits = 0;
  private totalRecallAttempts = 0;
  private lastRecallAt: string | undefined;
  private lastIngestAt: string | undefined;

  /** Simple query cache for hit tracking (LRU-ish: only tracks recent queries) */
  private readonly recentQueries = new Map<string, number>();
  private readonly maxCacheEntries = 100;

  constructor(
    private readonly inner: MemoryBackend,
    private readonly logger: HairyClawLogger,
  ) {
    this.name = `observed(${inner.name})`;
  }

  /**
   * Store content, recording ingest metrics.
   */
  async store(content: string, tags?: string[], options?: StoreOptions): Promise<string> {
    const startedAt = Date.now();
    try {
      const id = await this.inner.store(content, tags, options);
      this.ingestCount++;
      this.lastIngestAt = new Date().toISOString();

      this.logger.debug(
        {
          event: "memory.observe.ingest",
          backend: this.inner.name,
          durationMs: Date.now() - startedAt,
          tags,
        },
        "memory ingest observed",
      );

      return id;
    } catch (error: unknown) {
      this.logger.error(
        {
          event: "memory.observe.ingest.error",
          backend: this.inner.name,
          error: error instanceof Error ? error.message : String(error),
        },
        "memory ingest error observed",
      );
      throw error;
    }
  }

  /**
   * Search with recall metrics tracking.
   */
  async search(query: string, topK?: number, options?: SearchOptions): Promise<SearchResult[]> {
    this.totalRecallAttempts++;

    // Track cache hits: same query seen recently
    const cacheKey = `${query}|${String(topK)}|${JSON.stringify(options ?? {})}`;
    if (this.recentQueries.has(cacheKey)) {
      this.cacheHits++;
    }
    this.updateQueryCache(cacheKey);

    const startedAt = Date.now();
    try {
      const results = await this.inner.search(query, topK, options);
      const durationMs = Date.now() - startedAt;

      this.recallCount++;
      this.totalRecallLatencyMs += durationMs;
      this.lastRecallLatencyMs = durationMs;
      this.lastRecallAt = new Date().toISOString();

      this.logger.debug(
        {
          event: "memory.observe.recall",
          backend: this.inner.name,
          durationMs,
          resultCount: results.length,
          query: query.slice(0, 80),
        },
        "memory recall observed",
      );

      return results;
    } catch (error: unknown) {
      this.logger.error(
        {
          event: "memory.observe.recall.error",
          backend: this.inner.name,
          error: error instanceof Error ? error.message : String(error),
        },
        "memory recall error observed",
      );
      throw error;
    }
  }

  /**
   * Delegate feedback to inner backend if supported.
   */
  async feedback(id: string, signal: "useful" | "noted" | "wrong"): Promise<void> {
    if (this.inner.feedback) {
      return this.inner.feedback(id, signal);
    }
  }

  /**
   * Get current memory metrics snapshot.
   */
  getMemoryMetrics(): MemoryMetrics {
    return {
      recallCount: this.recallCount,
      ingestCount: this.ingestCount,
      avgRecallLatencyMs: this.recallCount > 0 ? this.totalRecallLatencyMs / this.recallCount : 0,
      lastRecallLatencyMs: this.lastRecallLatencyMs,
      cacheHits: this.cacheHits,
      totalRecallAttempts: this.totalRecallAttempts,
      cacheHitRatio: this.totalRecallAttempts > 0 ? this.cacheHits / this.totalRecallAttempts : 0,
      lastRecallAt: this.lastRecallAt,
      lastIngestAt: this.lastIngestAt,
    };
  }

  /**
   * Reset metrics (useful for testing or periodic snapshots)
   */
  resetMetrics(): void {
    this.recallCount = 0;
    this.ingestCount = 0;
    this.totalRecallLatencyMs = 0;
    this.lastRecallLatencyMs = undefined;
    this.cacheHits = 0;
    this.totalRecallAttempts = 0;
    this.lastRecallAt = undefined;
    this.lastIngestAt = undefined;
    this.recentQueries.clear();
  }

  /**
   * Track a query in the recency cache, evicting oldest if over limit
   */
  private updateQueryCache(key: string): void {
    this.recentQueries.set(key, Date.now());
    if (this.recentQueries.size > this.maxCacheEntries) {
      // Delete oldest entry
      let oldestKey: string | undefined;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [k, t] of this.recentQueries.entries()) {
        if (t < oldestTime) {
          oldestTime = t;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.recentQueries.delete(oldestKey);
      }
    }
  }
}
