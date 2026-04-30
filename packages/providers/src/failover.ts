import type { HairyClawLogger } from "@hairyclaw/observability";
import { type ClassifiedError, classifyError, jitteredBackoff } from "./error-classifier.js";
import type { ModelInfo, Provider, ProviderMessage, StreamEvent, StreamOptions } from "./types.js";

export interface FailoverConfig {
  /** Ordered list of {provider, model} to try */
  chain: Array<{ provider: string; model: string }>;
  /** Max retries per provider before moving to next */
  maxRetriesPerProvider?: number;
  /** Base delay for exponential backoff */
  backoffBaseMs?: number;
  /** Max backoff delay */
  backoffMaxMs?: number;
}

export interface FailoverProviderDeps {
  providers: Map<string, Provider>;
  config: FailoverConfig;
  logger: HairyClawLogger;
}

export const createFailoverProvider = (deps: FailoverProviderDeps): Provider => {
  const maxRetriesPerProvider = deps.config.maxRetriesPerProvider ?? 2;
  const backoffBaseMs = deps.config.backoffBaseMs ?? 2000;
  const backoffMaxMs = deps.config.backoffMaxMs ?? 60_000;

  return {
    name: "failover",
    supportsImages: true,
    supportsThinking: true,

    async *stream(messages: ProviderMessage[], opts: StreamOptions): AsyncIterable<StreamEvent> {
      const errors: ClassifiedError[] = [];

      for (const entry of deps.config.chain) {
        const provider = deps.providers.get(entry.provider);
        if (!provider) {
          deps.logger.warn({ provider: entry.provider }, "failover: provider not found, skipping");
          continue;
        }

        for (let attempt = 0; attempt < maxRetriesPerProvider; attempt++) {
          const streamOpts = { ...opts, model: entry.model ?? opts.model };

          try {
            let hasError = false;
            let errorMessage = "";

            for await (const event of provider.stream(messages, streamOpts)) {
              if (event.type === "error") {
                hasError = true;
                errorMessage = event.error ?? "unknown error";
                break;
              }
              yield event;
            }

            if (!hasError) return; // Success

            // Classify the error
            const classified = classifyError(new Error(errorMessage));
            errors.push(classified);

            deps.logger.warn(
              {
                provider: entry.provider,
                model: entry.model,
                attempt,
                reason: classified.reason,
                retryable: classified.retryable,
              },
              "failover: provider error",
            );

            // Auth failure → don't retry this provider
            if (classified.reason === "auth_failure") break;
            // Context length → don't retry at all (won't help with different provider)
            if (classified.reason === "context_length_exceeded") {
              yield { type: "error", error: "context_length_exceeded" };
              return;
            }

            // Retryable: use provider's suggested delay when present, else exponential backoff
            if (classified.retryable) {
              const delayMs = classified.suggestedDelayMs > 0
                ? classified.suggestedDelayMs
                : jitteredBackoff(backoffBaseMs, attempt, backoffMaxMs);
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          } catch (err: unknown) {
            const classified = classifyError(err instanceof Error ? err : new Error(String(err)));
            errors.push(classified);

            deps.logger.error(
              { provider: entry.provider, model: entry.model, attempt, reason: classified.reason },
              "failover: provider threw",
            );

            if (!classified.retryable) break;
            const delayMs = classified.suggestedDelayMs > 0
              ? classified.suggestedDelayMs
              : jitteredBackoff(backoffBaseMs, attempt, backoffMaxMs);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }

      // All providers exhausted
      yield {
        type: "error",
        error: `All providers failed: ${errors.map((e) => e.reason).join(" → ")}`,
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      const allModels: ModelInfo[] = [];
      for (const [, provider] of deps.providers) {
        try {
          const models = await provider.listModels();
          allModels.push(...models);
        } catch {
          /* skip unavailable providers */
        }
      }
      return allModels;
    },
  };
};
