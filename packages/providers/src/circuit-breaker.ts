/**
 * Circuit breaker for provider calls.
 *
 * States:
 *  CLOSED  — normal operation; failures are counted
 *  OPEN    — fail-fast; no calls allowed until cooldown expires
 *  HALF_OPEN — one probe call allowed; success → CLOSED, failure → OPEN
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening (default: 5) */
  failureThreshold?: number;
  /** Milliseconds to stay open before probing (default: 30_000) */
  cooldownMs?: number;
  /** Label for logging */
  name?: string;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  readonly name: string;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.name = opts.name ?? "circuit";
  }

  /** Returns true if a call should be attempted right now. */
  isCallAllowed(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = "half_open";
        return true;
      }
      return false;
    }

    // half_open: allow exactly one probe
    return true;
  }

  /** Call after a successful request. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  /** Call after a failed request. */
  recordFailure(): void {
    this.consecutiveFailures++;

    if (this.state === "half_open" || this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  get currentState(): CircuitState {
    // Re-evaluate open→half_open lazily so callers don't have to call isCallAllowed first
    if (this.state === "open" && Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = "half_open";
    }
    return this.state;
  }

  /** Remaining cooldown in ms (0 if not open) */
  get remainingCooldownMs(): number {
    if (this.state !== "open") return 0;
    return Math.max(0, this.cooldownMs - (Date.now() - this.openedAt));
  }
}

/** Registry: one breaker per provider */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly defaults: CircuitBreakerOptions;

  constructor(defaults: CircuitBreakerOptions = {}) {
    this.defaults = defaults;
  }

  get(provider: string): CircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new CircuitBreaker({ ...this.defaults, name: provider });
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  /** Snapshot of all breaker states for observability */
  snapshot(): Record<string, { state: CircuitState; failures: number; remainingCooldownMs: number }> {
    const out: Record<string, { state: CircuitState; failures: number; remainingCooldownMs: number }> = {};
    for (const [name, breaker] of this.breakers) {
      out[name] = {
        state: breaker.currentState,
        failures: (breaker as unknown as { consecutiveFailures: number }).consecutiveFailures,
        remainingCooldownMs: breaker.remainingCooldownMs,
      };
    }
    return out;
  }
}
