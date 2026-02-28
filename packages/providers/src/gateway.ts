import type { Metrics } from "@hairy/observability";
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
}

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
    const providerName = routed.provider;
    const model = opts.model ?? routed.model;

    const selected = this.providers.get(providerName);
    if (!selected || !model) {
      yield { type: "error", error: "provider or model unavailable" };
      return;
    }

    const fallbackChain = this.opts.routingConfig.fallbackChain;
    const candidates = [providerName, ...fallbackChain.filter((name) => name !== providerName)];

    for (const name of candidates) {
      const provider = this.providers.get(name);
      if (!provider) {
        continue;
      }

      let hadError = false;
      for await (const event of provider.stream(messages, { ...opts, model })) {
        if (event.type === "error") {
          hadError = true;
          this.opts.metrics.increment("llm_requests", 1, { provider: name, status: "error" });
          break;
        }

        if (event.type === "usage" && event.usage) {
          this.opts.metrics.increment("llm_tokens_in", event.usage.input, { provider: name });
          this.opts.metrics.increment("llm_tokens_out", event.usage.output, { provider: name });
          this.opts.metrics.increment("llm_cost_usd", event.usage.costUsd, { provider: name });
        }

        yield event;
      }

      if (!hadError) {
        this.opts.metrics.increment("llm_requests", 1, { provider: name, status: "ok" });
        return;
      }
    }

    yield { type: "error", error: "all providers failed" };
  }

  selectProvider(intent?: RouteRequest): { provider: string; model: string | undefined } {
    return this.router.route(intent ?? {});
  }

  getUsage(): ReturnType<Metrics["getAll"]> {
    return this.opts.metrics.getAll();
  }
}
