import { describe, expect, it } from "vitest";
import {
  type PluginManifest,
  PluginManifestSchema,
  validateManifest,
} from "../src/plugin-manifest.js";

// ---------------------------------------------------------------------------
// Built-in plugin manifests
// ---------------------------------------------------------------------------
import { MANIFEST as ContentSafetyManifest } from "../src/plugins/content-safety.js";
import { MANIFEST as CostGuardManifest } from "../src/plugins/cost-guard.js";
import { MANIFEST as DenialTrackerManifest } from "../src/plugins/denial-tracker.js";
import { MANIFEST as GuardrailsManifest } from "../src/plugins/guardrails.js";
import { MANIFEST as LoopDetectionManifest } from "../src/plugins/loop-detection.js";
import { MANIFEST as SummarizationManifest } from "../src/plugins/summarization.js";
import { MANIFEST as TraceLoggerManifest } from "../src/plugins/trace-logger.js";
import { MANIFEST as UploadsManifest } from "../src/plugins/uploads.js";

const VALID_MANIFEST: PluginManifest = {
  name: "test_plugin",
  version: "1.0.0",
  description: "A test plugin",
  capabilities: ["cap-a", "cap-b"],
  requiredPermissions: [],
  trustLevel: "builtin",
};

// ---------------------------------------------------------------------------
// validateManifest — valid cases
// ---------------------------------------------------------------------------

describe("validateManifest — valid", () => {
  it("accepts a fully-populated valid manifest", () => {
    const result = validateManifest(VALID_MANIFEST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("test_plugin");
    }
  });

  it("accepts a manifest with all trust levels", () => {
    const levels = ["builtin", "verified", "community", "local"] as const;
    for (const trustLevel of levels) {
      const result = validateManifest({ ...VALID_MANIFEST, trustLevel });
      expect(result.success).toBe(true);
    }
  });

  it("accepts a manifest with an optional featureFlag", () => {
    const result = validateManifest({ ...VALID_MANIFEST, featureFlag: "denialTracking" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.featureFlag).toBe("denialTracking");
    }
  });

  it("accepts a manifest with empty capabilities and permissions arrays", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      capabilities: [],
      requiredPermissions: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts semver with patch version zero", () => {
    const result = validateManifest({ ...VALID_MANIFEST, version: "2.3.0" });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateManifest — invalid cases
// ---------------------------------------------------------------------------

describe("validateManifest — invalid", () => {
  it("rejects missing name", () => {
    const { name: _n, ...rest } = VALID_MANIFEST;
    const result = validateManifest(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.includes("name"))).toBe(true);
    }
  });

  it("rejects empty name string", () => {
    const result = validateManifest({ ...VALID_MANIFEST, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing version", () => {
    const { version: _v, ...rest } = VALID_MANIFEST;
    const result = validateManifest(rest);
    expect(result.success).toBe(false);
  });

  it("rejects non-semver version", () => {
    const result = validateManifest({ ...VALID_MANIFEST, version: "latest" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.includes("version"))).toBe(true);
    }
  });

  it("rejects missing description", () => {
    const { description: _d, ...rest } = VALID_MANIFEST;
    const result = validateManifest(rest);
    expect(result.success).toBe(false);
  });

  it("rejects empty description", () => {
    const result = validateManifest({ ...VALID_MANIFEST, description: "" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid trust level", () => {
    const result = validateManifest({ ...VALID_MANIFEST, trustLevel: "untrusted" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.includes("trustLevel"))).toBe(true);
    }
  });

  it("rejects non-array capabilities", () => {
    const result = validateManifest({ ...VALID_MANIFEST, capabilities: "cap-a" });
    expect(result.success).toBe(false);
  });

  it("rejects non-array requiredPermissions", () => {
    const result = validateManifest({ ...VALID_MANIFEST, requiredPermissions: "perm" });
    expect(result.success).toBe(false);
  });

  it("rejects null input", () => {
    const result = validateManifest(null);
    expect(result.success).toBe(false);
  });

  it("rejects primitive input", () => {
    const result = validateManifest(42);
    expect(result.success).toBe(false);
  });

  it("errors include field paths", () => {
    const result = validateManifest({ ...VALID_MANIFEST, trustLevel: "bad" });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Each error should have a path component
      expect(result.errors.every((e) => e.includes(":"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// PluginManifestSchema direct usage
// ---------------------------------------------------------------------------

describe("PluginManifestSchema", () => {
  it("parses a valid manifest", () => {
    const parsed = PluginManifestSchema.parse(VALID_MANIFEST);
    expect(parsed.name).toBe("test_plugin");
  });

  it("throws ZodError for invalid input", () => {
    expect(() => PluginManifestSchema.parse({ name: "" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Built-in plugin manifests — all must be valid
// ---------------------------------------------------------------------------

describe("built-in plugin MANIFESTs", () => {
  const builtins = [
    { label: "content-safety", manifest: ContentSafetyManifest },
    { label: "cost-guard", manifest: CostGuardManifest },
    { label: "denial-tracker", manifest: DenialTrackerManifest },
    { label: "guardrails", manifest: GuardrailsManifest },
    { label: "loop-detection", manifest: LoopDetectionManifest },
    { label: "summarization", manifest: SummarizationManifest },
    { label: "trace-logger", manifest: TraceLoggerManifest },
    { label: "uploads", manifest: UploadsManifest },
  ];

  for (const { label, manifest } of builtins) {
    it(`${label} MANIFEST is valid`, () => {
      const result = validateManifest(manifest);
      expect(result.success, JSON.stringify((result as { errors?: string[] }).errors)).toBe(true);
    });

    it(`${label} MANIFEST has trustLevel 'builtin'`, () => {
      expect(manifest.trustLevel).toBe("builtin");
    });

    it(`${label} MANIFEST has a non-empty name`, () => {
      expect(manifest.name.length).toBeGreaterThan(0);
    });

    it(`${label} MANIFEST has at least one capability`, () => {
      expect(manifest.capabilities.length).toBeGreaterThan(0);
    });
  }

  it("denial-tracker MANIFEST declares featureFlag 'denialTracking'", () => {
    expect(DenialTrackerManifest.featureFlag).toBe("denialTracking");
  });

  it("all built-in plugin names are unique", () => {
    const names = builtins.map((b) => b.manifest.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
