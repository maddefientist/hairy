import type { RouteRequest, RoutingConfig } from "./types.js";

export class ModelRouter {
  constructor(private readonly config: RoutingConfig) {}

  route(request: RouteRequest): { provider: string; model: string | undefined } {
    const rules = this.config.rules ?? {};

    if (request.hasImages && rules.image_input) {
      return {
        provider: rules.image_input.provider,
        model: rules.image_input.model,
      };
    }

    if (request.intent && rules[request.intent]) {
      return {
        provider: rules[request.intent].provider,
        model: rules[request.intent].model,
      };
    }

    const fallbackProvider = this.config.defaultProvider;
    const fallbackRule = Object.values(rules).find((rule) => rule.provider === fallbackProvider);

    return {
      provider: fallbackProvider,
      model: fallbackRule?.model,
    };
  }
}
