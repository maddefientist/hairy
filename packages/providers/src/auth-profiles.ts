import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HairyClawLogger } from "@hairyclaw/observability";

export interface AuthProfile {
  id: string;
  provider: string;
  type: "api_key" | "oauth" | "none";
  credential: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface ProfileHealth {
  lastUsed?: number;
  lastSuccess?: number;
  lastFailureAt?: number;
  errorCount: number;
  consecutiveErrors: number;
  cooldownUntil?: number;
  failureCounts: Record<string, number>;
}

export interface AuthProfileManagerOptions {
  filePath: string;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  cooldownThreshold?: number;
  logger?: HairyClawLogger;
}

interface PersistedState {
  profiles: AuthProfile[];
  health: Array<{ id: string; health: ProfileHealth }>;
}

const DEFAULT_BASE_COOLDOWN_MS = 15_000;
const DEFAULT_MAX_COOLDOWN_MS = 300_000;
const DEFAULT_COOLDOWN_THRESHOLD = 1;

const defaultFailureCounts = (): Record<string, number> => ({
  timeout: 0,
  rate_limit: 0,
  auth: 0,
  server: 0,
});

const defaultHealth = (): ProfileHealth => ({
  errorCount: 0,
  consecutiveErrors: 0,
  failureCounts: defaultFailureCounts(),
});

const cloneHealth = (health: ProfileHealth): ProfileHealth => ({
  ...health,
  failureCounts: { ...health.failureCounts },
});

const noopLogger: HairyClawLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  child: () => noopLogger,
};

export class AuthProfileManager {
  private readonly profiles = new Map<string, AuthProfile>();
  private readonly health = new Map<string, ProfileHealth>();
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly cooldownThreshold: number;
  private readonly logger: HairyClawLogger;

  constructor(private readonly opts: AuthProfileManagerOptions) {
    this.baseCooldownMs = opts.baseCooldownMs ?? DEFAULT_BASE_COOLDOWN_MS;
    this.maxCooldownMs = opts.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
    this.cooldownThreshold = opts.cooldownThreshold ?? DEFAULT_COOLDOWN_THRESHOLD;
    this.logger = opts.logger ?? noopLogger;
  }

  addProfile(profile: AuthProfile): void {
    this.profiles.set(profile.id, { ...profile });
    if (!this.health.has(profile.id)) {
      this.health.set(profile.id, defaultHealth());
    }
  }

  removeProfile(id: string): void {
    this.profiles.delete(id);
    this.health.delete(id);
  }

  getAvailable(provider: string): AuthProfile | null {
    const now = Date.now();
    const candidates = Array.from(this.profiles.values())
      .filter((profile) => profile.provider === provider)
      .filter((profile) => this.isProfileUsable(profile, now))
      .sort((left, right) => {
        const leftHealth = this.getOrCreateHealth(left.id);
        const rightHealth = this.getOrCreateHealth(right.id);
        const leftLastUsed = leftHealth.lastUsed ?? 0;
        const rightLastUsed = rightHealth.lastUsed ?? 0;
        return leftLastUsed - rightLastUsed;
      });

    const selected = candidates[0] ?? null;
    if (!selected) {
      return null;
    }

    const health = this.getOrCreateHealth(selected.id);
    health.lastUsed = now;

    return { ...selected };
  }

  reportSuccess(profileId: string): void {
    const health = this.health.get(profileId);
    if (!health) {
      return;
    }

    const now = Date.now();
    health.lastUsed = now;
    health.lastSuccess = now;
    health.consecutiveErrors = 0;
    health.cooldownUntil = undefined;
  }

  reportFailure(profileId: string, reason: "timeout" | "rate_limit" | "auth" | "server"): void {
    const health = this.health.get(profileId);
    if (!health) {
      return;
    }

    const now = Date.now();
    health.lastFailureAt = now;
    health.errorCount += 1;
    health.consecutiveErrors += 1;
    health.failureCounts[reason] = (health.failureCounts[reason] ?? 0) + 1;

    if (health.consecutiveErrors >= this.cooldownThreshold) {
      const exponent = health.consecutiveErrors - this.cooldownThreshold;
      const cooldownMs = Math.min(this.baseCooldownMs * 2 ** exponent, this.maxCooldownMs);
      health.cooldownUntil = now + cooldownMs;
      this.logger.warn(
        {
          profileId,
          reason,
          consecutiveErrors: health.consecutiveErrors,
          cooldownUntil: health.cooldownUntil,
        },
        "auth profile moved to cooldown",
      );
    }
  }

  clearCooldown(profileIdOrProvider: string): void {
    if (this.health.has(profileIdOrProvider)) {
      const health = this.getOrCreateHealth(profileIdOrProvider);
      health.cooldownUntil = undefined;
      health.consecutiveErrors = 0;
      return;
    }

    for (const profile of this.profiles.values()) {
      if (profile.provider !== profileIdOrProvider) {
        continue;
      }
      const health = this.getOrCreateHealth(profile.id);
      health.cooldownUntil = undefined;
      health.consecutiveErrors = 0;
    }
  }

  isInCooldown(profileId: string): boolean {
    const health = this.health.get(profileId);
    if (!health?.cooldownUntil) {
      return false;
    }
    return health.cooldownUntil > Date.now();
  }

  getHealthSnapshot(): Map<string, ProfileHealth> {
    return new Map(
      Array.from(this.health.entries()).map(([id, health]) => [id, cloneHealth(health)]),
    );
  }

  async save(): Promise<void> {
    const state: PersistedState = {
      profiles: Array.from(this.profiles.values()),
      health: Array.from(this.health.entries()).map(([id, health]) => ({
        id,
        health: cloneHealth(health),
      })),
    };

    await mkdir(dirname(this.opts.filePath), { recursive: true });
    await writeFile(this.opts.filePath, JSON.stringify(state, null, 2), "utf8");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.opts.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;

      this.profiles.clear();
      this.health.clear();

      for (const profile of parsed.profiles ?? []) {
        this.profiles.set(profile.id, profile);
      }

      for (const entry of parsed.health ?? []) {
        this.health.set(entry.id, {
          ...entry.health,
          failureCounts: {
            ...defaultFailureCounts(),
            ...(entry.health.failureCounts ?? {}),
          },
        });
      }

      for (const profile of this.profiles.values()) {
        if (!this.health.has(profile.id)) {
          this.health.set(profile.id, defaultHealth());
        }
      }
    } catch {
      this.profiles.clear();
      this.health.clear();
    }
  }

  private isProfileUsable(profile: AuthProfile, now: number): boolean {
    if (
      profile.type === "oauth" &&
      profile.expiresAt &&
      profile.expiresAt <= now &&
      !profile.refreshToken
    ) {
      return false;
    }

    const health = this.getOrCreateHealth(profile.id);
    return !health.cooldownUntil || health.cooldownUntil <= now;
  }

  private getOrCreateHealth(profileId: string): ProfileHealth {
    const existing = this.health.get(profileId);
    if (existing) {
      return existing;
    }

    const created = defaultHealth();
    this.health.set(profileId, created);
    return created;
  }
}
