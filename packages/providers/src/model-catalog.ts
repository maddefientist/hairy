/**
 * Provider/model catalog — the single source of truth for which
 * {provider, model} pairs HairyClaw is allowed to select as primary or
 * fallback. Replaces ad-hoc string parsing of "provider/model" specs
 * scattered through the app: every catalog entry is a bound pair, so a
 * model id can never be silently applied to the wrong provider.
 */

export interface ModelCatalogEntry {
  /** Stable identifier, "<provider>/<model>" */
  id: string;
  provider: string;
  model: string;
  label: string;
  /** False = catalogued but not selectable yet (no provider/credentials provisioned). */
  available: boolean;
  /** Human-readable reason, required when available === false. */
  unavailableReason?: string;
}

const entry = (
  provider: string,
  model: string,
  label: string,
  available = true,
  unavailableReason?: string,
): ModelCatalogEntry => ({
  id: `${provider}/${model}`,
  provider,
  model,
  label,
  available,
  ...(unavailableReason ? { unavailableReason } : {}),
});

/**
 * Default catalog for this release. Order here has no bearing on selection —
 * ordering of an active chain is decided by resolveModelChain / the model
 * selection store, never by catalog position.
 */
export const DEFAULT_MODEL_CATALOG: ModelCatalogEntry[] = [
  entry("supergrok", "grok-4.6", "Grok 4.6 (SuperGrok OAuth)"),
  entry("ollama", "kimi-k2.6:cloud", "Kimi K2.6 (Ollama fallback)"),
  entry("ollama", "minimax-m3:cloud", "MiniMax M3 (Ollama Cloud)"),
  entry("ollama", "glm-5.2:cloud", "GLM 5.2 (Ollama Cloud)"),
  entry("ollama", "qwen3.8:27b", "Qwen3.8 27B (Hari local)"),
  // Generic, provider-bound coding-oriented catalog entries, routed through
  // Ollama like the other cloud-hosted entries above. These are only ever
  // selectable when the "ollama" provider is actually constructed for this
  // deployment (see reconcileCatalogWithProviders) — there is no implicit
  // assumption that any given Ollama endpoint actually serves these models.
  entry("ollama", "deepseek-v4-flash:cloud", "DeepSeek V4 Flash (Ollama Cloud, fast coding)"),
  entry("ollama", "deepseek-v4-pro:cloud", "DeepSeek V4 Pro (Ollama Cloud, deep coding/reasoning)"),
];

/**
 * Reconcile a static catalog against the providers actually constructed for
 * this deployment (e.g. `providers.map(p => p.name)` in main.ts, built only
 * from providers that are enabled AND have valid credentials/config). An
 * entry can only be `available` when BOTH its own explicit provisioning flag
 * is true AND its provider was actually constructed — so a catalog entry can
 * never be selectable just because it's hard-coded `available: true` while
 * the real provider was never built (missing API key, disabled, etc.), and a
 * provider that is genuinely never built in code (Grok) always stays
 * unavailable regardless of catalog contents.
 *
 * Also ensures each constructed provider's *configured* default model (as
 * resolved from runtime config, which may not match any static catalog
 * entry — e.g. a deployment-specific Ollama model) is present and available,
 * so there is always a real, provisioned candidate to select as a safe
 * default instead of a hard-pinned id that may not exist for this
 * deployment.
 */
export const reconcileCatalogWithProviders = (opts: {
  entries?: ModelCatalogEntry[];
  constructedProviders: Iterable<string>;
  /** provider name -> the currently configured default model for that provider */
  providerDefaultModels?: ReadonlyMap<string, string>;
}): ModelCatalogEntry[] => {
  const constructed = new Set(opts.constructedProviders);
  const base = opts.entries ?? DEFAULT_MODEL_CATALOG;
  const byId = new Map<string, ModelCatalogEntry>();

  for (const item of base) {
    const provisioned = constructed.has(item.provider);
    const available = item.available && provisioned;
    const unavailableReason = available
      ? undefined
      : !provisioned
        ? `provider "${item.provider}" is not constructed/provisioned in this deployment`
        : item.unavailableReason;
    byId.set(item.id, {
      ...item,
      available,
      ...(unavailableReason ? { unavailableReason } : {}),
    });
  }

  if (opts.providerDefaultModels) {
    for (const [provider, model] of opts.providerDefaultModels) {
      if (!constructed.has(provider) || !model) continue;
      const id = `${provider}/${model}`;
      if (byId.has(id)) continue;
      byId.set(id, entry(provider, model, `${provider}/${model} (configured default)`, true));
    }
  }

  return Array.from(byId.values());
};

export class ModelCatalog {
  private readonly byId = new Map<string, ModelCatalogEntry>();

  constructor(entries: ModelCatalogEntry[] = DEFAULT_MODEL_CATALOG) {
    for (const item of entries) {
      this.byId.set(item.id, item);
    }
  }

  list(): ModelCatalogEntry[] {
    return Array.from(this.byId.values());
  }

  listAvailable(): ModelCatalogEntry[] {
    return this.list().filter((item) => item.available);
  }

  get(id: string): ModelCatalogEntry | undefined {
    return this.byId.get(id);
  }

  /** True only for entries that exist in the catalog AND are marked available. */
  isSelectable(id: string): boolean {
    return this.byId.get(id)?.available === true;
  }
}

export interface ResolvedModelChain {
  primary: ModelCatalogEntry;
  chain: Array<{ provider: string; model: string }>;
  warnings: string[];
}

/**
 * Build an ordered {provider, model} chain whose first element is always the
 * requested primary. Rejects any requested primary that is not a catalog
 * entry, or is catalogued-but-unavailable (e.g. Grok before provisioning),
 * falling back to `safeDefaultId`. Fallback candidates that are unknown to
 * the catalog or unavailable are dropped (never silently paired with the
 * wrong provider) and reported via `warnings`.
 */
export const resolveModelChain = (opts: {
  catalog: ModelCatalog;
  requestedPrimaryId: string;
  fallbackIds?: string[];
  safeDefaultId: string;
}): ResolvedModelChain => {
  const warnings: string[] = [];
  const catalog = opts.catalog;

  let primary = catalog.get(opts.requestedPrimaryId);
  if (!primary) {
    warnings.push(
      `requested primary "${opts.requestedPrimaryId}" is not in the model catalog; using safe default`,
    );
    primary = catalog.get(opts.safeDefaultId);
  } else if (!primary.available) {
    warnings.push(
      `requested primary "${opts.requestedPrimaryId}" is catalogued but unavailable (${primary.unavailableReason ?? "unavailable"}); using safe default`,
    );
    primary = catalog.get(opts.safeDefaultId);
  }

  if (!primary) {
    throw new Error(`safe default model "${opts.safeDefaultId}" is missing from the model catalog`);
  }
  if (!primary.available) {
    throw new Error(`safe default model "${opts.safeDefaultId}" is not available`);
  }

  const chain: Array<{ provider: string; model: string }> = [
    { provider: primary.provider, model: primary.model },
  ];
  const seen = new Set([primary.id]);

  for (const id of opts.fallbackIds ?? []) {
    if (seen.has(id)) continue;
    const candidate = catalog.get(id);
    if (!candidate) {
      warnings.push(`fallback "${id}" is not in the model catalog; skipped`);
      continue;
    }
    if (!candidate.available) {
      warnings.push(
        `fallback "${id}" is unavailable (${candidate.unavailableReason ?? "unavailable"}); skipped`,
      );
      continue;
    }
    seen.add(id);
    chain.push({ provider: candidate.provider, model: candidate.model });
  }

  return { primary, chain, warnings };
};
