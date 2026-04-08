/**
 * Feature Flags Framework
 *
 * Provides centralized feature flag management for the upgrade workstreams.
 * Supports TOML config + environment variable overrides.
 *
 * Feature flags are designed to:
 * - Gate new subsystems
 * - Enable safe rollback
 * - Support gradual rollout
 */

import type { HairyClawLogger } from "@hairyclaw/observability";

/**
 * Feature flag definitions for Hairy platform upgrade
 */
export interface FeatureFlags {
  /** Execution metadata tracking: turn IDs, agent lineage, execution mode */
  executionMetadataTracking: boolean;

  /** Standardized telemetry event names and emission */
  standardizedTelemetry: boolean;

  /** Denial tracking and fallback for permission automation */
  denialTracking: boolean;

  /** Advanced subagent context: fork vs specialist modes */
  subagentContextForking: boolean;

  /** Verification worker pattern and verification flows */
  verificationWorker: boolean;

  /** Session memory extraction and mid-session compaction triggers */
  sessionMemoryExtraction: boolean;

  /** Typed memory support from hari-hive backend */
  typedMemory: boolean;

  /** Shared artifact scratchpad for parallel workers */
  sharedArtifacts: boolean;

  /** Tool deferred loading and discovery */
  deferredToolLoading: boolean;

  /** MCP connection lifecycle management (reconnect, health checks) */
  mcpLifecycleManagement: boolean;

  /** Tool scheduling with concurrency limits and priority queuing */
  toolScheduling: boolean;

  /** Memory observability: recall/ingest metrics wrapping */
  memoryObservability: boolean;

  /** Remote session and worktree execution modes */
  remoteExecution: boolean;

  /** Plugin manifest schema + registry system (M11) */
  pluginManifestEnabled: boolean;
}

/**
 * Default feature flag state (safe conservative defaults)
 */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  executionMetadataTracking: true, // Phase 1 foundation
  standardizedTelemetry: true, // Phase 1 foundation
  denialTracking: false, // Phase 2
  subagentContextForking: false, // Phase 3
  verificationWorker: false, // Phase 3
  sessionMemoryExtraction: false, // Phase 2
  typedMemory: true, // Phase 2 — backend deployed 2026-04-06
  sharedArtifacts: false, // Phase 3
  deferredToolLoading: false, // Phase 4
  mcpLifecycleManagement: false, // Phase 4 (M9)
  toolScheduling: false, // Phase 4 (M9)
  memoryObservability: true, // Phase 5 (M12) — enabled 2026-04-07
  remoteExecution: false, // Phase 4
  pluginManifestEnabled: true, // Phase 4 (M11) — enabled 2026-04-07
};

/**
 * Feature flag configuration from TOML
 */
export interface FeatureFlagsConfig {
  features?: Partial<FeatureFlags>;
}

/**
 * Centralized feature flag manager
 */
export class FeatureFlagManager {
  private flags: FeatureFlags;

  constructor(
    config: FeatureFlagsConfig = {},
    private logger?: HairyClawLogger,
  ) {
    // Start with defaults
    this.flags = { ...DEFAULT_FEATURE_FLAGS };

    // Override with config file values
    if (config.features) {
      this.flags = { ...this.flags, ...config.features };
    }

    // Override with environment variables
    // Pattern: FEATURE_<flag_name>=true|false
    this.flags = this.applyEnvOverrides(this.flags);

    if (this.logger) {
      this.logger.debug({ flags: this.flags }, "feature flags initialized");
    }
  }

  /**
   * Apply environment variable overrides
   * Pattern: FEATURE_EXECUTION_METADATA_TRACKING=true
   */
  private applyEnvOverrides(flags: FeatureFlags): FeatureFlags {
    const result = { ...flags };

    // Convert camelCase to UPPER_SNAKE_CASE
    const camelToSnake = (str: string): string => {
      return str
        .replace(/([a-z])([A-Z])/g, "$1_$2") // executionMetadata -> execution_Metadata
        .toUpperCase(); // execution_Metadata -> EXECUTION_METADATA
    };

    for (const [key] of Object.entries(flags)) {
      const envKey = `FEATURE_${camelToSnake(key)}`;
      const envValue = process.env[envKey];

      if (envValue !== undefined) {
        const boolValue = envValue.toLowerCase() === "true";
        // @ts-expect-error - we're updating the flags object dynamically
        result[key] = boolValue;

        if (this.logger) {
          this.logger.info(
            { flag: key, value: boolValue, source: "env" },
            "feature flag overridden by environment",
          );
        }
      }
    }

    return result;
  }

  /**
   * Check if a feature is enabled
   */
  isEnabled(feature: keyof FeatureFlags): boolean {
    return this.flags[feature];
  }

  /**
   * Check if a feature is disabled
   */
  isDisabled(feature: keyof FeatureFlags): boolean {
    return !this.flags[feature];
  }

  /**
   * Get all flags
   */
  getAll(): FeatureFlags {
    return { ...this.flags };
  }

  /**
   * Get flag status as a diagnostic object (for logs/metrics)
   */
  getDiagnostics(): Record<string, boolean> {
    return { ...this.flags };
  }
}

/**
 * Create a feature flag manager from runtime config
 */
export const createFeatureFlagManager = (
  config: FeatureFlagsConfig = {},
  logger?: HairyClawLogger,
): FeatureFlagManager => {
  return new FeatureFlagManager(config, logger);
};
