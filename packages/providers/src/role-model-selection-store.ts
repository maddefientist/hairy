import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HairyClawLogger } from "@hairyclaw/observability";
import { ModelSelectionStore } from "./model-selection-store.js";
import type { ModelSelectionRecord } from "./model-selection-store.js";

/**
 * A durable model-selection role. "brain" is the fast conversational
 * controller/planner (also the unified-mode alias target); "hands" is the
 * technical executor for coding, system design, debugging, and explicit
 * machine-exploration delegation.
 */
export type ModelRole = "brain" | "hands";

export const MODEL_ROLES: readonly ModelRole[] = ["brain", "hands"];

export interface RoleModelSelectionStoreOptions {
  /** Directory that holds per-role selection state files. */
  dataDir: string;
  /**
   * Path to the pre-existing single-role selection file (unified mode). Used
   * only once, to seed the "brain" role atomically the first time a role
   * store is loaded against a deployment that previously ran unified mode —
   * never read again afterward.
   */
  legacyFilePath: string;
  defaultPrimaryId: Record<ModelRole, string>;
  defaultFallbackIds?: Partial<Record<ModelRole, string[]>>;
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

const roleFileName = (role: ModelRole): string => `model-selection-${role}.json`;

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Durable, role-aware model selection. Wraps one `ModelSelectionStore` per
 * role, each independently persisted (own primary, fallback chain, and
 * bounded rollback history). On first load, if a legacy single-role
 * selection file exists from a prior unified-mode deployment and the
 * "brain" role file does not yet exist, the legacy state is migrated into
 * "brain" via an atomic write (temp file + rename) so brain_hands mode
 * starts from the operator's last-known-good unified selection instead of
 * silently resetting to config defaults.
 */
export class RoleModelSelectionStore {
  private readonly logger: HairyClawLogger;
  private readonly stores: Record<ModelRole, ModelSelectionStore>;
  private migrated = false;

  constructor(private readonly opts: RoleModelSelectionStoreOptions) {
    this.logger = opts.logger ?? noopLogger;
    this.stores = {
      brain: new ModelSelectionStore({
        filePath: join(opts.dataDir, roleFileName("brain")),
        defaultPrimaryId: opts.defaultPrimaryId.brain,
        defaultFallbackIds: opts.defaultFallbackIds?.brain,
        maxHistory: opts.maxHistory,
        logger: this.logger,
      }),
      hands: new ModelSelectionStore({
        filePath: join(opts.dataDir, roleFileName("hands")),
        defaultPrimaryId: opts.defaultPrimaryId.hands,
        defaultFallbackIds: opts.defaultFallbackIds?.hands,
        maxHistory: opts.maxHistory,
        logger: this.logger,
      }),
    };
  }

  /** True once `load()` has migrated a legacy unified-mode file into "brain". */
  didMigrateLegacy(): boolean {
    return this.migrated;
  }

  async load(): Promise<void> {
    await this.migrateLegacyIfNeeded();
    await Promise.all([this.stores.brain.load(), this.stores.hands.load()]);
  }

  getStore(role: ModelRole): ModelSelectionStore {
    return this.stores[role];
  }

  getCurrent(role: ModelRole): ModelSelectionRecord {
    return this.stores[role].getCurrent();
  }

  getHistory(role: ModelRole): ModelSelectionRecord[] {
    return this.stores[role].getHistory();
  }

  async setPrimary(role: ModelRole, id: string, actor: string): Promise<ModelSelectionRecord> {
    return this.stores[role].setPrimary(id, actor);
  }

  async setFallbacks(
    role: ModelRole,
    fallbackIds: string[],
    actor: string,
  ): Promise<ModelSelectionRecord> {
    return this.stores[role].setFallbacks(fallbackIds, actor);
  }

  async rollback(role: ModelRole, actor: string): Promise<ModelSelectionRecord | null> {
    return this.stores[role].rollback(actor);
  }

  /**
   * Atomic, one-time migration: legacy unified selection file -> brain role
   * file. Skipped entirely if the brain role file already exists (already
   * migrated or brain_hands mode has already run in this deployment), or if
   * no legacy file exists (fresh install). Uses temp-file + rename so a
   * crash mid-migration cannot leave a partially-written brain file.
   */
  private async migrateLegacyIfNeeded(): Promise<void> {
    const brainPath = join(this.opts.dataDir, roleFileName("brain"));
    if (await fileExists(brainPath)) {
      return;
    }
    if (!(await fileExists(this.opts.legacyFilePath))) {
      return;
    }

    let raw: string;
    try {
      raw = await readFile(this.opts.legacyFilePath, "utf8");
      const parsed = JSON.parse(raw) as {
        current?: { primaryId?: unknown; fallbackIds?: unknown };
        history?: unknown;
      };
      if (
        !parsed.current ||
        typeof parsed.current.primaryId !== "string" ||
        parsed.current.primaryId.trim().length === 0 ||
        !Array.isArray(parsed.current.fallbackIds) ||
        !parsed.current.fallbackIds.every((id) => typeof id === "string") ||
        !Array.isArray(parsed.history)
      ) {
        throw new Error("legacy model-selection state has an invalid shape");
      }
    } catch (err: unknown) {
      this.logger.warn(
        { err, legacyFilePath: this.opts.legacyFilePath },
        "role-model-selection-store: legacy state unreadable, skipping migration",
      );
      return;
    }

    await mkdir(this.opts.dataDir, { recursive: true, mode: 0o700 });
    const tmpPath = `${brainPath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, raw, { encoding: "utf8", mode: 0o600 });
    await rename(tmpPath, brainPath);
    this.migrated = true;
    this.logger.info(
      { legacyFilePath: this.opts.legacyFilePath, brainPath },
      "role-model-selection-store: migrated legacy unified selection into brain role",
    );
  }
}
