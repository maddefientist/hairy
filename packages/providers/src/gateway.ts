import type { Metrics } from "@hairyclaw/observability";
import type { AuthProfile, AuthProfileManager } from "./auth-profiles.js";
import { CircuitBreakerRegistry } from "./circuit-breaker.js";
import type { CircuitBreakerOptions } from "./circuit-breaker.js";
import { classifyError } from "./error-classifier.js";
import { ModelRouter } from "./router.js";
import { RateLimitTracker } from "./rate-limit-tracker.js";
import type { RateLimitSnapshot } from "./rate-limit-tracker.js";
import type {
  Provider,
  ProviderMessage,
  RouteRequest,
  RoutingConfig,
  StreamEvent,
  StreamOptions,
} from "./types.js";

export type CredentialRefresher = (
  profile: AuthProfile,
) => Promise<{ credential: string; expiresAt?: number; refreshToken?: string } | null>;

interface ProviderGatewayOptions {
  providers: Provider[];
  routingConfig: RoutingConfig;
  metrics: Metrics;
  authProfiles?: AuthProfileManager;
  circuitBreaker?: CircuitBreakerOptions;
  credentialRefresher?: CredentialRefresher;
  /** Requests-remaining threshold below which a provider is considered exhausted (default: 5) */
  rateLimitExhaustionThreshold?: number;
}

interface StreamAttempt {
  provider: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;


export class ProviderGateway {
  private readonly providers = new Map<string, Provider>();
  private readonly router: ModelRouter;
  private readonly circuits: CircuitBreakerRegistry;
  private readonly rateLimits: RateLimitTracker;

  constructor(private readonly opts: ProviderGatewayOptions) {
    for (const provider of opts.providers) {
      this.providers.set(provider.name, provider);
    }
    this.router = new ModelRouter(opts.routingConfig);
    this.circuits = new CircuitBreakerRegistry(opts.circuitBreaker);
    this.rateLimits = new RateLimitTracker(opts.rateLimitExhaustionThreshold);
  }

  async *stream(
    messages: ProviderMessage[],
    opts: Omit<StreamOptions, "model"> & { model?: string; route?: RouteRequest },
  ): AsyncIterable<StreamEvent> {
    const routed = this.router.route(opts.route ?? {});
    const attempts = this.buildAttempts(routed.provider, routed.model, opts);

    if (attempts.length === 0) {
      yield { type: "error", error: "provider or model unavailable" };
      return;
    }

    const failures: string[] = [];
    const queue = [...attempts];
    const refreshedProfiles = new Set<string>();
    const seenCredentials = new Set<string>();
    let qi = 0;
    let totalRefreshes = 0;
    const MAX_REFRESHES = 2;

    while (qi < queue.length) {
      const attempt = queue[qi++];
      const provider = this.providers.get(attempt.provider);
      const attemptLabel = `${attempt.provider}/${attempt.model}`;

      if (!provider) {
        failures.push(`${attemptLabel}: provider unavailable`);
        continue;
      }

      const circuit = this.circuits.get(attempt.provider);
      if (!circuit.isCallAllowed()) {
        failures.push(`${attemptLabel}: circuit open (${Math.ceil(circuit.remainingCooldownMs / 1000)}s remaining)`);
        continue;
      }

      if (this.rateLimits.isExhausted(attempt.provider)) {
        const snap = this.rateLimits.getSnapshot(attempt.provider);
        const secsUntilReset = snap ? Math.ceil((snap.resetAtMs - Date.now()) / 1000) : 0;
        failures.push(`${attemptLabel}: rate limit exhausted (resets in ${secsUntilReset}s)`);
        continue;
      }

      const profile = this.resolveAuthProfile(attempt.provider);
      const needsProfile = !!this.opts.authProfiles;
      if (needsProfile && !profile) {
        failures.push(`${attemptLabel}: no auth profile available`);
        continue;
      }

      if (profile?.credential) seenCredentials.add(profile.credential);

      let hadError = false;
      let errorReason = "unknown provider failure";

      try {
        const streamOpts = {
          ...opts,
          model: attempt.model,
          timeoutMs: attempt.timeoutMs,
          ...(profile?.type === "api_key" ? { credential: profile.credential } : {}),
        };

        for await (const event of this.streamWithTimeout(provider.stream(messages, streamOpts), attempt.timeoutMs)) {
          if (event.type === "error") {
            hadError = true;
            errorReason = this.sanitizeErrorMessage(event.error ?? "provider returned error", ...seenCredentials);
            this.opts.metrics.increment("llm_requests", 1, {
              provider: attempt.provider,
              model: attempt.model,
              status: "error",
            });
            break;
          }

          // Consume rate limit headers — update tracker, don't forward to caller
          if (event.type === "rate_limit_headers") {
            if (event.rateLimitRemaining !== undefined && event.rateLimitResetAtMs !== undefined) {
              this.rateLimits.update(attempt.provider, event.rateLimitRemaining, event.rateLimitResetAtMs);
            }
            continue;
          }

          if (event.type === "usage" && event.usage) {
            this.opts.metrics.increment("llm_tokens_in", event.usage.input, {
              provider: attempt.provider,
              model: attempt.model,
            });
            this.opts.metrics.increment("llm_tokens_out", event.usage.output, {
              provider: attempt.provider,
              model: attempt.model,
            });
            this.opts.metrics.increment("llm_cost_usd", event.usage.costUsd, {
              provider: attempt.provider,
              model: attempt.model,
            });
          }

          yield event;
        }
      } catch (error: unknown) {
        hadError = true;
        const raw = error instanceof Error ? error.message : String(error);
        errorReason = this.sanitizeErrorMessage(raw, ...seenCredentials);
      }

      if (hadError) {
        const classified = classifyError(new Error(errorReason));

        // Surface context-length errors with a detectable prefix so the agent
        // loop can trigger compression and retry instead of failing hard.
        if (classified.reason === "context_length_exceeded") {
          yield { type: "error", error: `context_length_exceeded: ${errorReason}` };
          return;
        }

        // On auth failure, attempt credential refresh once per profile (global cap: MAX_REFRESHES)
        if (
          classified.reason === "auth_failure" &&
          profile &&
          profile.refreshToken &&
          this.opts.credentialRefresher &&
          this.opts.authProfiles &&
          !refreshedProfiles.has(profile.id) &&
          totalRefreshes < MAX_REFRESHES
        ) {
          const refreshed = await this.opts.credentialRefresher(profile).catch(() => null);
          if (refreshed) {
            const applied = this.opts.authProfiles.refreshCredential(
              profile.id,
              refreshed.credential,
              refreshed.expiresAt,
              refreshed.refreshToken,
            );
            if (applied) {
              seenCredentials.add(refreshed.credential);
              refreshedProfiles.add(profile.id);
              totalRefreshes++;
              queue.splice(qi, 0, attempt); // retry this attempt immediately
              continue;
            }
          }
        }

        circuit.recordFailure();
        failures.push(`${attemptLabel}: ${errorReason}`);
        if (profile && this.opts.authProfiles) {
          this.opts.authProfiles.reportFailure(profile.id, classified.reason === "auth_failure" ? "auth" : classified.reason === "rate_limit" ? "rate_limit" : "server");
        }
        continue;
      }

      circuit.recordSuccess();
      this.opts.metrics.increment("llm_requests", 1, {
        provider: attempt.provider,
        model: attempt.model,
        status: "ok",
      });

      if (profile && this.opts.authProfiles) {
        this.opts.authProfiles.reportSuccess(profile.id);
      }

      return;
    }

    const reason = failures.length > 0 ? failures.join("; ") : "no fallback candidates available";
    yield { type: "error", error: `all models failed: ${reason}` };
  }

  selectProvider(intent?: RouteRequest): { provider: string; model: string | undefined } {
    return this.router.route(intent ?? {});
  }

  getUsage(): ReturnType<Metrics["getAll"]> {
    return this.opts.metrics.getAll();
  }

  getRateLimitState(): Record<string, RateLimitSnapshot> {
    return this.rateLimits.getAll();
  }

  private buildAttempts(
    routedProvider: string,
    routedModel: string | undefined,
    opts: Omit<StreamOptions, "model"> & { model?: string },
  ): StreamAttempt[] {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const modelFallback = this.opts.routingConfig.modelFallbackChain;
    if (modelFallback && modelFallback.length > 0) {
      const deduped: StreamAttempt[] = [];
      const seen = new Set<string>();

      for (const entry of modelFallback) {
        const model = entry.model.trim();
        if (model.length === 0) continue;

        const key = `${entry.provider}/${model}`;
        if (seen.has(key)) continue;

        seen.add(key);
        deduped.push({
          provider: entry.provider,
          model,
          timeoutMs: entry.timeoutMs ?? timeoutMs,
        });
      }

      return deduped;
    }

    const selectedModel = opts.model ?? routedModel;
    if (!selectedModel) {
      return [];
    }

    const providers = [
      routedProvider,
      ...this.opts.routingConfig.fallbackChain.filter((name) => name !== routedProvider),
    ];

    const deduped: StreamAttempt[] = [];
    const seen = new Set<string>();
    for (const provider of providers) {
      const key = `${provider}/${selectedModel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({ provider, model: selectedModel, timeoutMs });
    }

    return deduped;
  }

  private sanitizeErrorMessage(message: string, ...credentials: Array<string | undefined>): string {
    // Redact before truncating so credentials near the boundary aren't partially exposed
    let sanitized = message;
    for (const cred of credentials) {
      if (cred && cred.length > 4) {
        sanitized = sanitized.split(cred).join("[REDACTED]");
      }
    }
    sanitized = sanitized.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
    sanitized = sanitized.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
    sanitized = sanitized.replace(/AIza[A-Za-z0-9_-]{35}/g, "[REDACTED]");
    return sanitized.length > 500 ? `${sanitized.slice(0, 500)}...` : sanitized;
  }

  private resolveAuthProfile(provider: string): AuthProfile | null {
    if (!this.opts.authProfiles) {
      return null;
    }
    return this.opts.authProfiles.getAvailable(provider);
  }

  private async *streamWithTimeout(
    stream: AsyncIterable<StreamEvent>,
    timeoutMs: number,
  ): AsyncIterable<StreamEvent> {
    const iterator = stream[Symbol.asyncIterator]();
    const deadline = Date.now() + timeoutMs;

    try {
      while (true) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error(`request timed out after ${timeoutMs}ms`);
        }

        const next = await this.withTimeout(iterator.next(), remainingMs, timeoutMs);
        if (next.done) {
          return;
        }
        yield next.value;
      }
    } catch (error: unknown) {
      if (typeof iterator.return === "function") {
        await iterator.return();
      }
      throw error;
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    totalTimeoutMs: number,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`request timed out after ${totalTimeoutMs}ms`));
      }, timeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
