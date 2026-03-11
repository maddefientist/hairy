import type { Metrics } from "@hairy/observability";
import type { AuthProfile, AuthProfileManager } from "./auth-profiles.js";
import { ModelRouter } from "./router.js";
import type {
  Provider,
  ProviderMessage,
  RouteRequest,
  RoutingConfig,
  StreamEvent,
  StreamOptions,
} from "./types.js";

interface ProviderGatewayOptions {
  providers: Provider[];
  routingConfig: RoutingConfig;
  metrics: Metrics;
  authProfiles?: AuthProfileManager;
}

interface StreamAttempt {
  provider: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const envVarForProvider = (provider: string): string | null => {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "gemini") return "GEMINI_API_KEY";
  return null;
};

export const classifyError = (error: unknown): "timeout" | "rate_limit" | "auth" | "server" => {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted")) {
    return "timeout";
  }
  if (lower.includes("429") || lower.includes("rate")) return "rate_limit";
  if (lower.includes("401") || lower.includes("403") || lower.includes("auth")) return "auth";
  return "server";
};

export class ProviderGateway {
  private readonly providers = new Map<string, Provider>();
  private readonly router: ModelRouter;

  constructor(private readonly opts: ProviderGatewayOptions) {
    for (const provider of opts.providers) {
      this.providers.set(provider.name, provider);
    }
    this.router = new ModelRouter(opts.routingConfig);
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

    for (const attempt of attempts) {
      const provider = this.providers.get(attempt.provider);
      const attemptLabel = `${attempt.provider}/${attempt.model}`;

      if (!provider) {
        failures.push(`${attemptLabel}: provider unavailable`);
        continue;
      }

      const profile = this.resolveAuthProfile(attempt.provider);
      const needsProfile = this.opts.authProfiles && envVarForProvider(attempt.provider) !== null;
      if (needsProfile && !profile) {
        failures.push(`${attemptLabel}: no auth profile available`);
        continue;
      }

      let hadError = false;
      let errorReason = "unknown provider failure";

      try {
        const stream = this.streamWithProfileCredential(attempt.provider, profile, () =>
          provider.stream(messages, {
            ...opts,
            model: attempt.model,
            timeoutMs: attempt.timeoutMs,
          }),
        );

        for await (const event of this.streamWithTimeout(stream, attempt.timeoutMs)) {
          if (event.type === "error") {
            hadError = true;
            errorReason = event.error ?? "provider returned error";
            this.opts.metrics.increment("llm_requests", 1, {
              provider: attempt.provider,
              model: attempt.model,
              status: "error",
            });
            break;
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
        errorReason = error instanceof Error ? error.message : String(error);
      }

      if (hadError) {
        failures.push(`${attemptLabel}: ${errorReason}`);
        if (profile && this.opts.authProfiles) {
          this.opts.authProfiles.reportFailure(profile.id, classifyError(errorReason));
        }
        continue;
      }

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

  private resolveAuthProfile(provider: string): AuthProfile | null {
    if (!this.opts.authProfiles) {
      return null;
    }
    return this.opts.authProfiles.getAvailable(provider);
  }

  private async *streamWithProfileCredential(
    provider: string,
    profile: AuthProfile | null,
    factory: () => AsyncIterable<StreamEvent>,
  ): AsyncIterable<StreamEvent> {
    if (!profile || profile.type === "none") {
      for await (const event of factory()) {
        yield event;
      }
      return;
    }

    const envVar = envVarForProvider(provider);
    if (!envVar) {
      for await (const event of factory()) {
        yield event;
      }
      return;
    }

    const previous = process.env[envVar];
    process.env[envVar] = profile.credential;

    try {
      for await (const event of factory()) {
        yield event;
      }
    } finally {
      if (previous === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = previous;
      }
    }
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
