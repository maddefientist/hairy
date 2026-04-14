export * from "./types.js";
export * from "./task-queue.js";
export * from "./scheduler.js";
export * from "./orchestrator.js";
export * from "./agent-loop.js";
export * from "./config.js";
export * from "./plugin.js";
export * from "./workflows.js";
export * from "./commands.js";

// Plugin re-exports — named exports to avoid MANIFEST name collision
export {
  MANIFEST as costGuardManifest,
  createCostGuardPlugin,
} from "./plugins/cost-guard.js";
export type { CostGuardOptions as CostGuardOpts } from "./plugins/cost-guard.js";
export {
  MANIFEST as traceLoggerManifest,
  createTraceLoggerPlugin,
} from "./plugins/trace-logger.js";
export type { TraceLoggerOptions } from "./plugins/trace-logger.js";
export {
  MANIFEST as contentSafetyManifest,
  createContentSafetyPlugin,
} from "./plugins/content-safety.js";
export type { ContentSafetyOptions } from "./plugins/content-safety.js";
export {
  MANIFEST as loopDetectionManifest,
  createLoopDetectionPlugin,
} from "./plugins/loop-detection.js";
export type { LoopDetectionOptions } from "./plugins/loop-detection.js";
export {
  MANIFEST as guardrailsManifest,
  AllowlistProvider,
  createGuardrailPlugin,
} from "./plugins/guardrails.js";
export type {
  GuardrailRequest,
  GuardrailDecision,
  GuardrailProvider,
  AllowlistConfig,
  GuardrailPluginOptions,
} from "./plugins/guardrails.js";
export {
  MANIFEST as summarizationManifest,
  estimateTokens,
  truncateText,
  createSummarizationPlugin,
} from "./plugins/summarization.js";
export type { SummarizationOptions } from "./plugins/summarization.js";
export {
  MANIFEST as uploadsManifest,
  createUploadsPlugin,
} from "./plugins/uploads.js";
export type { UploadsPromptProvider, UploadsPluginOptions } from "./plugins/uploads.js";
export {
  MANIFEST as denialTrackerManifest,
  DenialTracker,
  createDenialTrackerPlugin,
} from "./plugins/denial-tracker.js";
export type {
  DenialRecord,
  DenialPattern,
  DenialAnalytics,
  DenialTrackerConfig,
  DiagnosticRule,
  ShadowedRuleFinding,
  ConflictFinding,
  RuleDiagnosticReport,
} from "./plugins/denial-tracker.js";

export * from "./subagent-executor.js";
export * from "./feature-flags.js";
export * from "./execution-metadata.js";
export * from "./telemetry-events.js";
export * from "./verification-worker.js";
export * from "./agent-snapshot.js";
export * from "./artifact-scratchpad.js";
export * from "./worker-status.js";
export * from "./plugin-manifest.js";
export * from "./plugin-registry.js";
export * from "./iteration-budget.js";
