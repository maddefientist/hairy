/**
 * Plugin Manifest Schema
 *
 * Declares structured metadata for each HairyClaw plugin:
 * capabilities, required permissions, trust level, and optional feature flag.
 *
 * Gated behind the pluginManifestEnabled feature flag — existing plugin loading
 * is unchanged when the flag is off.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const TrustLevelSchema = z.enum(["builtin", "verified", "community", "local"]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

export const PluginManifestSchema = z.object({
  /** Unique plugin identifier — must match HairyClawPlugin.name */
  name: z.string().min(1, "name is required"),
  /** Semver-compatible version string */
  version: z.string().regex(/^\d+\.\d+\.\d+/, "version must start with semver (e.g. 1.0.0)"),
  /** Human-readable description */
  description: z.string().min(1, "description is required"),
  /** Capabilities this plugin provides (used for lookup and conflict detection) */
  capabilities: z.array(z.string()),
  /** Permissions the plugin requires to operate correctly */
  requiredPermissions: z.array(z.string()),
  /** Optional feature flag name — plugin is skipped when the flag is disabled */
  featureFlag: z.string().optional(),
  /** Trust level controls auto-loading behaviour */
  trustLevel: TrustLevelSchema,
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidateManifestResult =
  | { success: true; data: PluginManifest }
  | { success: false; errors: string[] };

/**
 * Validate an unknown value against the PluginManifest schema.
 * Returns a discriminated-union result — never throws.
 */
export const validateManifest = (manifest: unknown): ValidateManifestResult => {
  const result = PluginManifestSchema.safeParse(manifest);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.errors.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  return { success: false, errors };
};
