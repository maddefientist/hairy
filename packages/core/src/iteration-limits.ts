/**
 * Single source of truth for iteration and retry bounds across HairyClaw.
 * Every caller (primary agent loop, spawn_agent, delegate, chain roles,
 * IterationBudget factories, config defaults) should import these constants
 * instead of hard-coding numbers, so the primary/child split and retry caps
 * stay consistent as the codebase grows.
 */

/** Max agent-loop iterations for the top-level, primary-operator agent. */
export const PRIMARY_MAX_ITERATIONS = 35;

/** Max agent-loop iterations for any spawned/child agent (spawn_agent, delegate, chain role). */
export const CHILD_MAX_ITERATIONS = 15;

/** Max retries against a single provider entry before the fallback chain advances (see ProviderGateway/failover). */
export const MAX_PROVIDER_RETRIES_PER_ATTEMPT = 2;

/**
 * Max number of times, per agent-loop iteration, that a context_length_exceeded
 * failure is allowed to trigger "compress and retry the same iteration" before
 * the loop gives up on that turn. Without this cap a compressor that can't
 * shrink the conversation below the provider's limit would retry forever
 * without ever advancing the iteration counter.
 */
export const MAX_COMPRESSION_RETRIES_PER_ITERATION = 2;
