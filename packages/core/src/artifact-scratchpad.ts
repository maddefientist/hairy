/**
 * Shared Artifact Scratchpad
 *
 * An in-memory key-value store for cooperating workers to exchange artifacts.
 * The orchestrator owns a scratchpad instance per top-level task and passes
 * it to SubagentExecutors.
 *
 * Design:
 * - Copy-on-read semantics for concurrency safety
 * - Metadata tracks provenance (producedBy, timestamp, type)
 * - Gated behind the sharedArtifacts feature flag
 */

/**
 * Artifact type classification
 */
export type ArtifactType = "code" | "text" | "data" | "plan";

/**
 * Metadata attached to every artifact
 */
export interface ArtifactMetadata {
  /** ID of the agent/worker that produced this artifact */
  producedBy: string;
  /** When the artifact was created/updated */
  timestamp: number;
  /** Classification of the artifact content */
  type: ArtifactType;
  /** Optional additional labels */
  labels?: Record<string, string>;
}

/**
 * A stored artifact entry (value + metadata)
 */
export interface ArtifactEntry {
  key: string;
  value: unknown;
  metadata: ArtifactMetadata;
}

/**
 * Options for putting an artifact
 */
export interface PutArtifactOptions {
  key: string;
  value: unknown;
  metadata: ArtifactMetadata;
}

/**
 * Shared Artifact Scratchpad interface
 */
export interface ArtifactScratchpad {
  /** Store or overwrite an artifact */
  put(key: string, value: unknown, metadata: ArtifactMetadata): void;
  /** Retrieve an artifact by key (copy-on-read). Returns undefined if not found. */
  get(key: string): ArtifactEntry | undefined;
  /** List all artifact entries (copies) */
  list(): ArtifactEntry[];
  /** Delete an artifact by key. Returns true if it existed. */
  delete(key: string): boolean;
  /** Number of stored artifacts */
  readonly size: number;
}

/**
 * Deep-clone a value for copy-on-read semantics.
 * Uses structuredClone for safety; falls back to JSON round-trip.
 */
const deepClone = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
};

/**
 * Create a new in-memory artifact scratchpad.
 */
export const createArtifactScratchpad = (): ArtifactScratchpad => {
  const store = new Map<string, ArtifactEntry>();

  return {
    put(key: string, value: unknown, metadata: ArtifactMetadata): void {
      store.set(key, {
        key,
        value: deepClone(value),
        metadata: { ...metadata },
      });
    },

    get(key: string): ArtifactEntry | undefined {
      const entry = store.get(key);
      if (!entry) {
        return undefined;
      }
      // Copy-on-read: return a deep clone
      return {
        key: entry.key,
        value: deepClone(entry.value),
        metadata: { ...entry.metadata },
      };
    },

    list(): ArtifactEntry[] {
      return Array.from(store.values()).map((entry) => ({
        key: entry.key,
        value: deepClone(entry.value),
        metadata: { ...entry.metadata },
      }));
    },

    delete(key: string): boolean {
      return store.delete(key);
    },

    get size(): number {
      return store.size;
    },
  };
};
