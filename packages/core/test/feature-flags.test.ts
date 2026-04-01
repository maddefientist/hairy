import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FEATURE_FLAGS,
  FeatureFlagManager,
  type FeatureFlagsConfig,
  createFeatureFlagManager,
} from "../src/feature-flags.js";

describe("FeatureFlagManager", () => {
  const ENV_KEYS = [
    "FEATURE_EXECUTION_METADATA_TRACKING",
    "FEATURE_STANDARDIZED_TELEMETRY",
    "FEATURE_DENIAL_TRACKING",
    "FEATURE_SUBAGENT_CONTEXT_FORKING",
  ];

  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Save original env vars
    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
    }
    // Clear all feature flag env vars before each test
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it("should use default feature flags when no config is provided", () => {
    const manager = new FeatureFlagManager();
    expect(manager.isEnabled("executionMetadataTracking")).toBe(
      DEFAULT_FEATURE_FLAGS.executionMetadataTracking,
    );
    expect(manager.isEnabled("standardizedTelemetry")).toBe(
      DEFAULT_FEATURE_FLAGS.standardizedTelemetry,
    );
  });

  it("should override defaults with config file values", () => {
    const config: FeatureFlagsConfig = {
      features: {
        denialTracking: true,
        subagentContextForking: true,
      },
    };
    const manager = new FeatureFlagManager(config);
    expect(manager.isEnabled("denialTracking")).toBe(true);
    expect(manager.isEnabled("subagentContextForking")).toBe(true);
    // Other flags should still have defaults
    expect(manager.isEnabled("executionMetadataTracking")).toBe(
      DEFAULT_FEATURE_FLAGS.executionMetadataTracking,
    );
  });

  it("should override with environment variables", () => {
    process.env.FEATURE_EXECUTION_METADATA_TRACKING = "false";
    process.env.FEATURE_DENIAL_TRACKING = "true";

    const manager = new FeatureFlagManager();
    expect(manager.isEnabled("executionMetadataTracking")).toBe(false);
    expect(manager.isEnabled("denialTracking")).toBe(true);
  });

  it("should prefer environment variables over config file", () => {
    const config: FeatureFlagsConfig = {
      features: {
        denialTracking: false,
        subagentContextForking: false,
      },
    };
    process.env.FEATURE_DENIAL_TRACKING = "true";

    const manager = new FeatureFlagManager(config);
    expect(manager.isEnabled("denialTracking")).toBe(true);
    expect(manager.isEnabled("subagentContextForking")).toBe(false);
  });

  it("should handle isDisabled correctly", () => {
    const manager = new FeatureFlagManager({
      features: {
        denialTracking: true,
        verificationWorker: false,
      },
    });
    expect(manager.isDisabled("denialTracking")).toBe(false);
    expect(manager.isDisabled("verificationWorker")).toBe(true);
  });

  it("should return all flags via getAll()", () => {
    const config: FeatureFlagsConfig = {
      features: {
        denialTracking: true,
      },
    };
    const manager = new FeatureFlagManager(config);
    const flags = manager.getAll();

    expect(flags.denialTracking).toBe(true);
    expect(flags.executionMetadataTracking).toBe(DEFAULT_FEATURE_FLAGS.executionMetadataTracking);
  });

  it("should provide diagnostics", () => {
    const manager = new FeatureFlagManager({
      features: {
        denialTracking: true,
        verificationWorker: false,
      },
    });
    const diagnostics = manager.getDiagnostics();

    expect(diagnostics.denialTracking).toBe(true);
    expect(diagnostics.verificationWorker).toBe(false);
    expect(typeof diagnostics.executionMetadataTracking).toBe("boolean");
  });

  it("should create manager via factory function", () => {
    const manager = createFeatureFlagManager({
      features: { denialTracking: true },
    });

    expect(manager.isEnabled("denialTracking")).toBe(true);
  });

  it("should handle invalid env values gracefully", () => {
    process.env.FEATURE_DENIAL_TRACKING = "maybe";
    const manager = new FeatureFlagManager();
    // Invalid values should not override
    expect(manager.isEnabled("denialTracking")).toBe(false);
  });

  it("should handle case-insensitive env values", () => {
    process.env.FEATURE_DENIAL_TRACKING = "TRUE";
    const manager = new FeatureFlagManager();
    expect(manager.isEnabled("denialTracking")).toBe(true);

    process.env.FEATURE_DENIAL_TRACKING = "False";
    const manager2 = new FeatureFlagManager();
    expect(manager2.isEnabled("denialTracking")).toBe(false);
  });
});
