export interface RateLimitSnapshot {
  remaining: number;
  resetAtMs: number;
}

export class RateLimitTracker {
  private readonly snapshots = new Map<string, RateLimitSnapshot>();

  constructor(private readonly exhaustionThreshold = 5) {}

  update(provider: string, remaining: number, resetAtMs: number): void {
    if (!Number.isFinite(remaining) || !Number.isFinite(resetAtMs)) return;
    const now = Date.now();
    // Allow 1s clock skew; cap at 24h out
    if (resetAtMs < now - 1000 || resetAtMs > now + 86_400_000) return;
    this.snapshots.set(provider, {
      remaining: Math.max(0, Math.floor(remaining)),
      resetAtMs: Math.floor(resetAtMs),
    });
  }

  isExhausted(provider: string): boolean {
    const snap = this.snapshots.get(provider);
    if (!snap) return false;
    if (Date.now() >= snap.resetAtMs) {
      this.snapshots.delete(provider);
      return false;
    }
    return snap.remaining <= this.exhaustionThreshold;
  }

  getSnapshot(provider: string): RateLimitSnapshot | undefined {
    const snap = this.snapshots.get(provider);
    if (!snap) return undefined;
    if (Date.now() >= snap.resetAtMs) {
      this.snapshots.delete(provider);
      return undefined;
    }
    return { ...snap };
  }

  getAll(): Record<string, RateLimitSnapshot> {
    const now = Date.now();
    const result: Record<string, RateLimitSnapshot> = {};
    for (const [provider, snap] of this.snapshots) {
      if (snap.resetAtMs > now) {
        result[provider] = { ...snap };
      } else {
        this.snapshots.delete(provider);
      }
    }
    return result;
  }
}
