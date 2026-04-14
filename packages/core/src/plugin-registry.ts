/**
 * Plugin Registry
 *
 * Central registry for HairyClaw plugins + their manifests.
 * Provides trust-based auto-loading, feature flag gating, capability lookup,
 * and conflict detection.
 *
 * Backward-compatible: PluginRunner still accepts a plain HairyClawPlugin[].
 * The registry is an optional layer on top — it produces a filtered list
 * of plugins that can be passed directly to PluginRunner.
 */

import type { HairyClawLogger } from "@hairyclaw/observability";
import type { FeatureFlagManager, FeatureFlags } from "./feature-flags.js";
import type { PluginManifest, TrustLevel } from "./plugin-manifest.js";
import type { HairyClawPlugin } from "./plugin.js";

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  plugin: HairyClawPlugin;
  manifest: PluginManifest;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PluginRegistryOptions {
  logger?: HairyClawLogger;
  featureFlags?: FeatureFlagManager;
}

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

/**
 * Central plugin registry with trust-based loading and feature flag gating.
 *
 * Usage:
 *   const registry = new PluginRegistry({ featureFlags, logger });
 *   registry.register(myPlugin, MY_MANIFEST);
 *   const plugins = registry.getAutoLoadable().map(e => e.plugin);
 *   const runner  = new PluginRunner(plugins);
 */
export class PluginRegistry {
  private readonly entries: RegistryEntry[] = [];
  private readonly logger?: HairyClawLogger;
  private readonly featureFlags?: FeatureFlagManager;

  constructor(opts: PluginRegistryOptions = {}) {
    this.logger = opts.logger;
    this.featureFlags = opts.featureFlags;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a plugin along with its manifest.
   * Emits a warning if another registered plugin declares the same capability.
   */
  register(plugin: HairyClawPlugin, manifest: PluginManifest): void {
    // Capability conflict detection
    for (const cap of manifest.capabilities) {
      for (const existing of this.entries) {
        if (existing.manifest.capabilities.includes(cap)) {
          this.logger?.warn(
            {
              capability: cap,
              plugin: manifest.name,
              existingPlugin: existing.manifest.name,
            },
            `plugin capability conflict: "${cap}" already declared by "${existing.manifest.name}"`,
          );
        }
      }
    }

    this.entries.push({ plugin, manifest });
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Return all entries that declare the given capability. */
  getByCapability(capability: string): RegistryEntry[] {
    return this.entries.filter((e) => e.manifest.capabilities.includes(capability));
  }

  /** Return all entries at the given trust level. */
  getByTrustLevel(level: TrustLevel): RegistryEntry[] {
    return this.entries.filter((e) => e.manifest.trustLevel === level);
  }

  /** Return a snapshot of all registered entries (in registration order). */
  listAll(): RegistryEntry[] {
    return [...this.entries];
  }

  // -------------------------------------------------------------------------
  // Auto-loading
  // -------------------------------------------------------------------------

  /**
   * Return entries eligible for automatic loading:
   *
   * 1. Trust level must be 'builtin' or 'verified' — unless the plugin name
   *    appears in `opts.explicitlyEnabled`.
   * 2. If the manifest declares a `featureFlag`, that flag must be enabled in
   *    the FeatureFlagManager supplied at construction time.  If no manager was
   *    supplied the flag check is skipped (always pass).
   */
  getAutoLoadable(opts: { explicitlyEnabled?: string[] } = {}): RegistryEntry[] {
    const explicit = new Set(opts.explicitlyEnabled ?? []);

    return this.entries.filter(({ manifest }) => {
      // --- Trust level gate ---
      const isAutoTrust = manifest.trustLevel === "builtin" || manifest.trustLevel === "verified";
      if (!isAutoTrust && !explicit.has(manifest.name)) {
        return false;
      }

      // --- Feature flag gate ---
      if (manifest.featureFlag) {
        if (!this.featureFlags) {
          // No manager → treat unknown flags as disabled (safe default)
          return false;
        }
        const key = manifest.featureFlag as keyof FeatureFlags;
        if (!this.featureFlags.isEnabled(key)) {
          return false;
        }
      }

      return true;
    });
  }
}
