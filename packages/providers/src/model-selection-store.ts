import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HairyClawLogger } from "@hairyclaw/observability";

export interface ModelSelectionEntry {
  provider: string;
  model: string;
}

export interface ModelSelectionRecord {
  primaryId: string;
  fallbackIds: string[];
  updatedAt: number;
  updatedBy: string;
}

interface PersistedState {
  current: ModelSelectionRecord;
  /** Bounded history, oldest first, NOT including `current`. */
  history: ModelSelectionRecord[];
}

export interface ModelSelectionStoreOptions {
  filePath: string;
  defaultPrimaryId: string;
  defaultFallbackIds?: string[];
  maxHistory?: number;
  logger?: HairyClawLogger;
}

const noopLogger: HairyClawLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const DEFAULT_MAX_HISTORY = 20;

/**
 * Durable, atomically-persisted active-model selection with bounded history
 * and rollback. All mutating operations are serialized through an internal
 * queue so concurrent /model commands cannot interleave and corrupt state.
 */
export class ModelSelectionStore {
  private current: ModelSelectionRecord;
  private history: ModelSelectionRecord[] = [];
  private readonly maxHistory: number;
  private readonly logger: HairyClawLogger;
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ModelSelectionStoreOptions) {
    this.maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.logger = opts.logger ?? noopLogger;
    this.current = {
      primaryId: opts.defaultPrimaryId,
      fallbackIds: opts.defaultFallbackIds ?? [],
      updatedAt: Date.now(),
      updatedBy: "default",
    };
  }

  getCurrent(): ModelSelectionRecord {
    return { ...this.current, fallbackIds: [...this.current.fallbackIds] };
  }

  getHistory(): ModelSelectionRecord[] {
    return this.history.map((record) => ({ ...record, fallbackIds: [...record.fallbackIds] }));
  }

  /** Atomically switch the primary model. Serialized against all other mutations. */
  async setPrimary(primaryId: string, actor: string): Promise<ModelSelectionRecord> {
    return this.runExclusive(async () => {
      this.pushHistory();
      this.current = {
        primaryId,
        fallbackIds: this.current.fallbackIds,
        updatedAt: Date.now(),
        updatedBy: actor,
      };
      await this.persist();
      return this.getCurrent();
    });
  }

  /** Atomically replace the ordered fallback list. */
  async setFallbacks(fallbackIds: string[], actor: string): Promise<ModelSelectionRecord> {
    return this.runExclusive(async () => {
      this.pushHistory();
      this.current = {
        primaryId: this.current.primaryId,
        fallbackIds: [...fallbackIds],
        updatedAt: Date.now(),
        updatedBy: actor,
      };
      await this.persist();
      return this.getCurrent();
    });
  }

  /** Roll back to the previous state. Returns null if there is no history. */
  async rollback(actor: string): Promise<ModelSelectionRecord | null> {
    return this.runExclusive(async () => {
      const previous = this.history.pop();
      if (!previous) {
        return null;
      }
      this.current = { ...previous, updatedAt: Date.now(), updatedBy: `${actor} (rollback)` };
      await this.persist();
      return this.getCurrent();
    });
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.opts.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.current && typeof parsed.current.primaryId === "string") {
        this.current = {
          primaryId: parsed.current.primaryId,
          fallbackIds: Array.isArray(parsed.current.fallbackIds) ? parsed.current.fallbackIds : [],
          updatedAt: parsed.current.updatedAt ?? Date.now(),
          updatedBy: parsed.current.updatedBy ?? "unknown",
        };
      }
      this.history = Array.isArray(parsed.history) ? parsed.history.slice(-this.maxHistory) : [];
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: unknown }).code === "ENOENT"
      ) {
        await this.persist();
        this.logger.info(
          { filePath: this.opts.filePath },
          "model-selection-store: initialized persisted defaults",
        );
        return;
      }
      this.logger.warn(
        { err },
        "model-selection-store: persisted state is unreadable, starting from defaults",
      );
    }
  }

  /** Serialize all mutating operations through a single-file queue. */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    // Swallow errors for the chain link itself so one failed op doesn't wedge the queue.
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private pushHistory(): void {
    this.history.push({ ...this.current, fallbackIds: [...this.current.fallbackIds] });
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(this.history.length - this.maxHistory);
    }
  }

  private async persist(): Promise<void> {
    const state: PersistedState = { current: this.current, history: this.history };
    const dir = dirname(this.opts.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.opts.filePath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    // rename() is atomic on POSIX filesystems when src/dest share a directory.
    await rename(tmpPath, this.opts.filePath);
  }
}
