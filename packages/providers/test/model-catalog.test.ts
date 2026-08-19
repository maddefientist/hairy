import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_CATALOG,
  ModelCatalog,
  reconcileCatalogWithProviders,
  resolveModelChain,
} from "../src/model-catalog.js";

describe("ModelCatalog", () => {
  it("lists all entries and only available entries", () => {
    const catalog = new ModelCatalog();
    expect(catalog.list().length).toBe(DEFAULT_MODEL_CATALOG.length);
    const available = catalog.listAvailable();
    expect(available.every((entry) => entry.available)).toBe(true);
    expect(available.some((entry) => entry.provider === "supergrok")).toBe(true);
  });

  it("catalogs Grok 4.6 as an available provider-bound model", () => {
    const catalog = new ModelCatalog();
    const grok = catalog.get("supergrok/grok-4.6");
    expect(grok).toBeDefined();
    expect(grok?.available).toBe(true);
    expect(grok?.unavailableReason).toBeUndefined();
  });

  it("catalogs the Kimi Ollama route, MiniMax M3, GLM 5.2, and local Qwen", () => {
    const catalog = new ModelCatalog();
    expect(catalog.get("ollama/kimi-k2.6:cloud")?.available).toBe(true);
    expect(catalog.isSelectable("ollama/minimax-m3:cloud")).toBe(true);
    expect(catalog.isSelectable("ollama/glm-5.2:cloud")).toBe(true);
    expect(catalog.isSelectable("ollama/qwen3.8:27b")).toBe(true);
  });

  it("isSelectable is false for unknown ids", () => {
    const catalog = new ModelCatalog();
    expect(catalog.isSelectable("made/up-model")).toBe(false);
  });

  it("catalogs generic DeepSeek Flash/Pro and Kimi coding entries, provider-bound to ollama", () => {
    const catalog = new ModelCatalog();
    expect(catalog.get("ollama/deepseek-v4-flash:cloud")?.provider).toBe("ollama");
    expect(catalog.get("ollama/deepseek-v4-pro:cloud")?.provider).toBe("ollama");
    expect(catalog.get("ollama/kimi-k2.6:cloud")?.provider).toBe("ollama");
  });
});

describe("reconcileCatalogWithProviders", () => {
  it("marks an entry unavailable when its provider was never constructed, even if the catalog says available: true", () => {
    const entries = reconcileCatalogWithProviders({
      constructedProviders: ["gemini"],
    });
    const ollamaEntry = entries.find((e) => e.id === "ollama/kimi-k2.6:cloud");
    expect(ollamaEntry?.available).toBe(false);
    expect(ollamaEntry?.unavailableReason).toMatch(/not constructed\/provisioned/);
  });

  it("requires the exact supergrok provider name before Grok becomes selectable", () => {
    const entries = reconcileCatalogWithProviders({
      constructedProviders: ["grok", "ollama"],
    });
    const grok = entries.find((e) => e.id === "supergrok/grok-4.6");
    expect(grok?.available).toBe(false);
    expect(grok?.unavailableReason).toBeTruthy();
  });

  it("makes Grok selectable when the SuperGrok provider is constructed", () => {
    const entries = reconcileCatalogWithProviders({ constructedProviders: ["supergrok"] });
    const catalog = new ModelCatalog(entries);
    expect(catalog.isSelectable("supergrok/grok-4.6")).toBe(true);
  });

  it("keeps an entry available only when both provisioned flag and constructed provider agree", () => {
    const entries = reconcileCatalogWithProviders({
      constructedProviders: ["ollama", "openrouter"],
    });
    expect(entries.find((e) => e.id === "ollama/kimi-k2.6:cloud")?.available).toBe(true);
    expect(entries.find((e) => e.id === "ollama/minimax-m3:cloud")?.available).toBe(true);
    expect(entries.find((e) => e.id === "ollama/qwen3.8:27b")?.available).toBe(true);
  });

  it("returns no available entries when no providers were constructed", () => {
    const entries = reconcileCatalogWithProviders({ constructedProviders: [] });
    expect(entries.every((e) => e.available === false)).toBe(true);
  });

  it("fails closed on DeepSeek/Kimi coding entries when ollama is not constructed", () => {
    const entries = reconcileCatalogWithProviders({ constructedProviders: ["supergrok"] });
    for (const id of [
      "ollama/deepseek-v4-flash:cloud",
      "ollama/deepseek-v4-pro:cloud",
      "ollama/kimi-k2.6:cloud",
    ]) {
      const found = entries.find((e) => e.id === id);
      expect(found?.available).toBe(false);
      expect(found?.unavailableReason).toMatch(/not constructed\/provisioned/);
    }
  });

  it("makes DeepSeek/Kimi coding entries selectable once ollama is constructed", () => {
    const entries = reconcileCatalogWithProviders({ constructedProviders: ["ollama"] });
    const catalog = new ModelCatalog(entries);
    expect(catalog.isSelectable("ollama/deepseek-v4-flash:cloud")).toBe(true);
    expect(catalog.isSelectable("ollama/deepseek-v4-pro:cloud")).toBe(true);
    expect(catalog.isSelectable("ollama/kimi-k2.6:cloud")).toBe(true);
  });

  it("adds the constructed provider's configured default model as an available entry even when absent from the static catalog", () => {
    const entries = reconcileCatalogWithProviders({
      constructedProviders: ["ollama"],
      providerDefaultModels: new Map([["ollama", "minimax-m2.7:cloud"]]),
    });
    const configured = entries.find((e) => e.id === "ollama/minimax-m2.7:cloud");
    expect(configured?.available).toBe(true);
    expect(configured?.provider).toBe("ollama");
    expect(configured?.model).toBe("minimax-m2.7:cloud");
  });

  it("does not add a configured default model entry for a provider that was never constructed", () => {
    const entries = reconcileCatalogWithProviders({
      constructedProviders: ["gemini"],
      providerDefaultModels: new Map([["ollama", "some-model:cloud"]]),
    });
    expect(entries.find((e) => e.id === "ollama/some-model:cloud")).toBeUndefined();
  });

  it("a ModelCatalog built from a fully-unavailable reconciled set has no selectable safe default", () => {
    const entries = reconcileCatalogWithProviders({ constructedProviders: [] });
    const catalog = new ModelCatalog(entries);
    expect(catalog.listAvailable()).toEqual([]);
    expect(catalog.isSelectable("ollama/kimi-k2.6:cloud")).toBe(false);
  });
});

describe("resolveModelChain", () => {
  const catalog = new ModelCatalog();
  const safeDefaultId = "ollama/kimi-k2.6:cloud";

  it("requested primary that is valid and available becomes attempt zero", () => {
    const result = resolveModelChain({
      catalog,
      requestedPrimaryId: "ollama/glm-5.2:cloud",
      safeDefaultId,
    });
    expect(result.chain[0]).toEqual({ provider: "ollama", model: "glm-5.2:cloud" });
    expect(result.primary.id).toBe("ollama/glm-5.2:cloud");
    expect(result.warnings).toEqual([]);
  });

  it("falls back to the safe default when the requested primary is unknown", () => {
    const result = resolveModelChain({
      catalog,
      requestedPrimaryId: "nonexistent/model",
      safeDefaultId,
    });
    expect(result.chain[0]).toEqual({ provider: "ollama", model: "kimi-k2.6:cloud" });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("selects Grok 4.6 as the requested primary", () => {
    const result = resolveModelChain({
      catalog,
      requestedPrimaryId: "supergrok/grok-4.6",
      safeDefaultId,
    });
    expect(result.chain[0]).toEqual({ provider: "supergrok", model: "grok-4.6" });
    expect(result.warnings).toEqual([]);
  });

  it("preserves provider/model pairing and never mixes a model id with the wrong provider", () => {
    const result = resolveModelChain({
      catalog,
      requestedPrimaryId: "ollama/kimi-k2.6:cloud",
      fallbackIds: ["ollama/minimax-m3:cloud", "ollama/glm-5.2:cloud", "ollama/qwen3.8:27b"],
      safeDefaultId,
    });
    expect(result.chain).toEqual([
      { provider: "ollama", model: "kimi-k2.6:cloud" },
      { provider: "ollama", model: "minimax-m3:cloud" },
      { provider: "ollama", model: "glm-5.2:cloud" },
      { provider: "ollama", model: "qwen3.8:27b" },
    ]);
  });

  it("keeps an available provider-bound Grok fallback and drops an unknown fallback", () => {
    const result = resolveModelChain({
      catalog,
      requestedPrimaryId: "ollama/kimi-k2.6:cloud",
      fallbackIds: ["supergrok/grok-4.6", "made/up"],
      safeDefaultId,
    });
    expect(result.chain).toEqual([
      { provider: "ollama", model: "kimi-k2.6:cloud" },
      { provider: "supergrok", model: "grok-4.6" },
    ]);
    expect(result.warnings.length).toBe(1);
  });

  it("deduplicates fallback ids already selected as primary", () => {
    const result = resolveModelChain({
      catalog,
      requestedPrimaryId: "ollama/kimi-k2.6:cloud",
      fallbackIds: ["ollama/kimi-k2.6:cloud", "ollama/minimax-m3:cloud"],
      safeDefaultId,
    });
    expect(result.chain).toEqual([
      { provider: "ollama", model: "kimi-k2.6:cloud" },
      { provider: "ollama", model: "minimax-m3:cloud" },
    ]);
  });
});
