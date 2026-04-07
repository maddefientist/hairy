import { describe, expect, it, vi } from "vitest";
import type { FeatureFlagManager, FeatureFlags } from "../src/feature-flags.js";
import type { PluginManifest } from "../src/plugin-manifest.js";
import { PluginRegistry } from "../src/plugin-registry.js";
import type { HairyClawPlugin } from "../src/plugin.js";

// ---------------------------------------------------------------------------
// Built-in manifests
// ---------------------------------------------------------------------------
import { MANIFEST as ContentSafetyManifest } from "../src/plugins/content-safety.js";
import { MANIFEST as CostGuardManifest } from "../src/plugins/cost-guard.js";
import { MANIFEST as DenialTrackerManifest } from "../src/plugins/denial-tracker.js";
import { MANIFEST as GuardrailsManifest } from "../src/plugins/guardrails.js";
import { MANIFEST as LoopDetectionManifest } from "../src/plugins/loop-detection.js";
import { MANIFEST as SummarizationManifest } from "../src/plugins/summarization.js";
import { MANIFEST as TraceLoggerManifest } from "../src/plugins/trace-logger.js";
import { MANIFEST as UploadsManifest } from "../src/plugins/uploads.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makePlugin = (name: string): HairyClawPlugin => ({ name });

const makeManifest = (overrides: Partial<PluginManifest> = {}): PluginManifest => ({
  name: "test_plugin",
  version: "1.0.0",
  description: "A test plugin",
  capabilities: ["cap-a"],
  requiredPermissions: [],
  trustLevel: "builtin",
  ...overrides,
});

/** Minimal FeatureFlagManager stub */
const makeFlags = (enabled: Partial<FeatureFlags> = {}): FeatureFlagManager => {
  const store: Partial<FeatureFlags> = {
    denialTracking: false,
    pluginManifestEnabled: false,
    ...enabled,
  };
  return {
    isEnabled: (key: keyof FeatureFlags) => Boolean(store[key]),
    isDisabled: (key: keyof FeatureFlags) => !Boolean(store[key]),
    getAll: () => store as FeatureFlags,
    getDiagnostics: () => store as Record<string, boolean>,
  } as unknown as FeatureFlagManager;
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("PluginRegistry — construction", () => {
  it("creates an empty registry", () => {
    const reg = new PluginRegistry();
    expect(reg.listAll()).toHaveLength(0);
  });

  it("accepts logger and featureFlags options", () => {
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
    const flags = makeFlags();
    expect(() => new PluginRegistry({ logger, featureFlags: flags })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// register + listAll
// ---------------------------------------------------------------------------

describe("PluginRegistry — register / listAll", () => {
  it("registers a plugin and lists it", () => {
    const reg = new PluginRegistry();
    const plugin = makePlugin("alpha");
    const manifest = makeManifest({ name: "alpha" });

    reg.register(plugin, manifest);

    const all = reg.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.manifest.name).toBe("alpha");
    expect(all[0]?.plugin.name).toBe("alpha");
  });

  it("listAll returns a copy — mutations don't affect registry", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("alpha"), makeManifest({ name: "alpha" }));

    const all = reg.listAll();
    all.pop();

    expect(reg.listAll()).toHaveLength(1);
  });

  it("preserves registration order", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("a"), makeManifest({ name: "a" }));
    reg.register(makePlugin("b"), makeManifest({ name: "b" }));
    reg.register(makePlugin("c"), makeManifest({ name: "c" }));

    const names = reg.listAll().map((e) => e.manifest.name);
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("allows multiple registrations", () => {
    const reg = new PluginRegistry();
    for (let i = 0; i < 5; i++) {
      reg.register(makePlugin(`p${i}`), makeManifest({ name: `p${i}`, capabilities: [`cap-${i}`] }));
    }
    expect(reg.listAll()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Capability conflict detection
// ---------------------------------------------------------------------------

describe("PluginRegistry — conflict detection", () => {
  it("warns when two plugins declare the same capability", () => {
    const warnFn = vi.fn();
    const logger = { warn: warnFn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
    const reg = new PluginRegistry({ logger });

    reg.register(makePlugin("plugin-a"), makeManifest({ name: "plugin-a", capabilities: ["cap-x"] }));
    reg.register(makePlugin("plugin-b"), makeManifest({ name: "plugin-b", capabilities: ["cap-x"] }));

    expect(warnFn).toHaveBeenCalledOnce();
    const [obj, msg] = warnFn.mock.calls[0] as [Record<string, unknown>, string];
    expect(obj).toMatchObject({ capability: "cap-x", plugin: "plugin-b", existingPlugin: "plugin-a" });
    expect(msg).toContain("conflict");
  });

  it("warns once per conflicting capability", () => {
    const warnFn = vi.fn();
    const logger = { warn: warnFn } as never;
    const reg = new PluginRegistry({ logger });

    reg.register(makePlugin("a"), makeManifest({ name: "a", capabilities: ["shared", "unique-a"] }));
    reg.register(makePlugin("b"), makeManifest({ name: "b", capabilities: ["shared", "unique-b"] }));

    // Only 'shared' should trigger a warning
    expect(warnFn).toHaveBeenCalledOnce();
  });

  it("does not warn for distinct capabilities", () => {
    const warnFn = vi.fn();
    const logger = { warn: warnFn } as never;
    const reg = new PluginRegistry({ logger });

    reg.register(makePlugin("a"), makeManifest({ name: "a", capabilities: ["cap-a"] }));
    reg.register(makePlugin("b"), makeManifest({ name: "b", capabilities: ["cap-b"] }));

    expect(warnFn).not.toHaveBeenCalled();
  });

  it("still registers the plugin even when conflict is detected", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("a"), makeManifest({ name: "a", capabilities: ["shared"] }));
    reg.register(makePlugin("b"), makeManifest({ name: "b", capabilities: ["shared"] }));

    expect(reg.listAll()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getByCapability
// ---------------------------------------------------------------------------

describe("PluginRegistry — getByCapability", () => {
  it("returns entries that declare the capability", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("a"), makeManifest({ name: "a", capabilities: ["cap-x", "cap-y"] }));
    reg.register(makePlugin("b"), makeManifest({ name: "b", capabilities: ["cap-y", "cap-z"] }));
    reg.register(makePlugin("c"), makeManifest({ name: "c", capabilities: ["cap-z"] }));

    expect(reg.getByCapability("cap-y")).toHaveLength(2);
    expect(reg.getByCapability("cap-x")).toHaveLength(1);
    expect(reg.getByCapability("cap-z")).toHaveLength(2);
    expect(reg.getByCapability("cap-unknown")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getByTrustLevel
// ---------------------------------------------------------------------------

describe("PluginRegistry — getByTrustLevel", () => {
  it("filters by trust level", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("builtin"), makeManifest({ name: "builtin", trustLevel: "builtin" }));
    reg.register(makePlugin("verified"), makeManifest({ name: "verified", trustLevel: "verified" }));
    reg.register(makePlugin("community"), makeManifest({ name: "community", trustLevel: "community", capabilities: ["cap-c"] }));
    reg.register(makePlugin("local"), makeManifest({ name: "local", trustLevel: "local", capabilities: ["cap-l"] }));

    expect(reg.getByTrustLevel("builtin")).toHaveLength(1);
    expect(reg.getByTrustLevel("verified")).toHaveLength(1);
    expect(reg.getByTrustLevel("community")).toHaveLength(1);
    expect(reg.getByTrustLevel("local")).toHaveLength(1);
  });

  it("returns empty array when no entries at that trust level", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("a"), makeManifest({ name: "a", trustLevel: "builtin" }));
    expect(reg.getByTrustLevel("community")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getAutoLoadable — trust level filtering
// ---------------------------------------------------------------------------

describe("PluginRegistry — getAutoLoadable trust filtering", () => {
  it("auto-loads builtin plugins", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("a"), makeManifest({ name: "a", trustLevel: "builtin" }));
    expect(reg.getAutoLoadable()).toHaveLength(1);
  });

  it("auto-loads verified plugins", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("a"), makeManifest({ name: "a", trustLevel: "verified" }));
    expect(reg.getAutoLoadable()).toHaveLength(1);
  });

  it("does NOT auto-load community plugins by default", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("a"), makeManifest({ name: "a", trustLevel: "community", capabilities: ["cap-c"] }));
    expect(reg.getAutoLoadable()).toHaveLength(0);
  });

  it("does NOT auto-load local plugins by default", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("a"), makeManifest({ name: "a", trustLevel: "local", capabilities: ["cap-l"] }));
    expect(reg.getAutoLoadable()).toHaveLength(0);
  });

  it("loads community plugin when explicitly enabled", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("community-x"), makeManifest({ name: "community-x", trustLevel: "community", capabilities: ["cap-cx"] }));
    const loaded = reg.getAutoLoadable({ explicitlyEnabled: ["community-x"] });
    expect(loaded).toHaveLength(1);
  });

  it("loads local plugin when explicitly enabled", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("local-x"), makeManifest({ name: "local-x", trustLevel: "local", capabilities: ["cap-lx"] }));
    const loaded = reg.getAutoLoadable({ explicitlyEnabled: ["local-x"] });
    expect(loaded).toHaveLength(1);
  });

  it("mixes auto-trust and explicit correctly", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("builtin"), makeManifest({ name: "builtin", trustLevel: "builtin" }));
    reg.register(makePlugin("community"), makeManifest({ name: "community", trustLevel: "community", capabilities: ["cap-c2"] }));
    reg.register(makePlugin("local"), makeManifest({ name: "local", trustLevel: "local", capabilities: ["cap-l2"] }));

    const loaded = reg.getAutoLoadable({ explicitlyEnabled: ["community"] });
    const names = loaded.map((e) => e.plugin.name);
    expect(names).toContain("builtin");
    expect(names).toContain("community");
    expect(names).not.toContain("local");
  });
});

// ---------------------------------------------------------------------------
// getAutoLoadable — feature flag gating
// ---------------------------------------------------------------------------

describe("PluginRegistry — getAutoLoadable feature flag gating", () => {
  it("skips plugin whose featureFlag is disabled", () => {
    const flags = makeFlags({ denialTracking: false });
    const reg = new PluginRegistry({ featureFlags: flags });

    reg.register(
      makePlugin("denial-tracker"),
      makeManifest({ name: "denial-tracker", featureFlag: "denialTracking", capabilities: ["cap-dt"] }),
    );

    expect(reg.getAutoLoadable()).toHaveLength(0);
  });

  it("includes plugin whose featureFlag is enabled", () => {
    const flags = makeFlags({ denialTracking: true });
    const reg = new PluginRegistry({ featureFlags: flags });

    reg.register(
      makePlugin("denial-tracker"),
      makeManifest({ name: "denial-tracker", featureFlag: "denialTracking", capabilities: ["cap-dt2"] }),
    );

    expect(reg.getAutoLoadable()).toHaveLength(1);
  });

  it("skips flagged plugin when no FeatureFlagManager is provided", () => {
    // No featureFlags → treat unknown flags as disabled
    const reg = new PluginRegistry();
    reg.register(
      makePlugin("flagged"),
      makeManifest({ name: "flagged", featureFlag: "denialTracking", capabilities: ["cap-fg"] }),
    );
    expect(reg.getAutoLoadable()).toHaveLength(0);
  });

  it("loads plugin with no featureFlag regardless of manager state", () => {
    const flags = makeFlags(); // no flags enabled
    const reg = new PluginRegistry({ featureFlags: flags });
    reg.register(makePlugin("plain"), makeManifest({ name: "plain" }));
    expect(reg.getAutoLoadable()).toHaveLength(1);
  });

  it("combines trust and flag filtering correctly", () => {
    const flags = makeFlags({ denialTracking: true });
    const reg = new PluginRegistry({ featureFlags: flags });

    // builtin + no flag → auto-load
    reg.register(makePlugin("builtin-plain"), makeManifest({ name: "builtin-plain" }));
    // builtin + flag enabled → auto-load
    reg.register(
      makePlugin("builtin-flagged"),
      makeManifest({ name: "builtin-flagged", featureFlag: "denialTracking", capabilities: ["cap-bf"] }),
    );
    // community + flag enabled → NOT auto-load (wrong trust)
    reg.register(
      makePlugin("community-flagged"),
      makeManifest({ name: "community-flagged", trustLevel: "community", featureFlag: "denialTracking", capabilities: ["cap-cf2"] }),
    );

    const loaded = reg.getAutoLoadable();
    const names = loaded.map((e) => e.plugin.name);
    expect(names).toContain("builtin-plain");
    expect(names).toContain("builtin-flagged");
    expect(names).not.toContain("community-flagged");
  });
});

// ---------------------------------------------------------------------------
// Built-in plugin MANIFESTs through registry
// ---------------------------------------------------------------------------

describe("PluginRegistry — built-in plugins integration", () => {
  const builtinEntries = [
    { plugin: makePlugin("content_safety"), manifest: ContentSafetyManifest },
    { plugin: makePlugin("cost_guard"), manifest: CostGuardManifest },
    { plugin: makePlugin("guardrails"), manifest: GuardrailsManifest },
    { plugin: makePlugin("loop_detection"), manifest: LoopDetectionManifest },
    { plugin: makePlugin("summarization"), manifest: SummarizationManifest },
    { plugin: makePlugin("trace_logger"), manifest: TraceLoggerManifest },
    { plugin: makePlugin("uploads"), manifest: UploadsManifest },
  ];

  it("registers all built-in plugins without error", () => {
    const reg = new PluginRegistry();
    for (const { plugin, manifest } of builtinEntries) {
      reg.register(plugin, manifest);
    }
    expect(reg.listAll()).toHaveLength(builtinEntries.length);
  });

  it("all non-flagged builtins auto-load without featureFlags manager", () => {
    const reg = new PluginRegistry(); // no flags
    for (const { plugin, manifest } of builtinEntries) {
      reg.register(plugin, manifest);
    }
    // All these have no featureFlag (no manager needed)
    const loaded = reg.getAutoLoadable();
    expect(loaded).toHaveLength(builtinEntries.length);
  });

  it("denial-tracker loads when denialTracking flag is enabled", () => {
    const flags = makeFlags({ denialTracking: true });
    const reg = new PluginRegistry({ featureFlags: flags });
    reg.register(makePlugin("denial-tracker"), DenialTrackerManifest);
    expect(reg.getAutoLoadable()).toHaveLength(1);
  });

  it("denial-tracker is excluded when denialTracking flag is disabled", () => {
    const flags = makeFlags({ denialTracking: false });
    const reg = new PluginRegistry({ featureFlags: flags });
    reg.register(makePlugin("denial-tracker"), DenialTrackerManifest);
    expect(reg.getAutoLoadable()).toHaveLength(0);
  });

  it("getByCapability finds content-filtering plugin", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("content_safety"), ContentSafetyManifest);
    expect(reg.getByCapability("content-filtering")).toHaveLength(1);
  });

  it("getByCapability finds policy-enforcement plugin", () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin("guardrails"), GuardrailsManifest);
    expect(reg.getByCapability("policy-enforcement")).toHaveLength(1);
  });

  it("getByTrustLevel returns all builtins as 'builtin'", () => {
    const reg = new PluginRegistry();
    for (const { plugin, manifest } of builtinEntries) {
      reg.register(plugin, manifest);
    }
    expect(reg.getByTrustLevel("builtin")).toHaveLength(builtinEntries.length);
  });
});
