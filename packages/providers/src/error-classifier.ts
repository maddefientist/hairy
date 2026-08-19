export type FailoverReason =
  | "rate_limit"
  | "auth_failure"
  | "context_length_exceeded"
  | "server_error"
  | "timeout"
  | "network_error"
  | "schema_error"
  | "configuration_error"
  | "unknown";

/**
 * Reasons that represent a genuinely transient failure — retrying the same
 * attempt, or trying the next entry in a fallback chain, can plausibly
 * succeed. Every other reason (auth, schema, configuration, unknown) must
 * fail closed: callers should stop advancing the chain and surface the
 * failure rather than silently trying more providers.
 */
export const ADVANCING_FAILOVER_REASONS: ReadonlySet<FailoverReason> = new Set([
  "rate_limit",
  "server_error",
  "network_error",
  "timeout",
]);

export interface ClassifiedError {
  reason: FailoverReason;
  retryable: boolean;
  suggestedDelayMs: number;
  originalError: Error;
}

const RATE_LIMIT_PATTERNS = [/rate.?limit/i, /too.?many.?requests/i, /429/];

const AUTH_PATTERNS = [/invalid.?api.?key/i, /unauthorized/i, /401/, /403/, /authentication/i];

const CONTEXT_LENGTH_PATTERNS = [
  /context.?length/i,
  /maximum.?context/i,
  /token.?limit/i,
  /context.?window/i,
  /too.?many.?tokens/i,
  /max.+tokens/i,
];

const SERVER_ERROR_PATTERNS = [
  /5\d{2}/,
  /server.?error/i,
  /internal.?server/i,
  /service.?unavailable/i,
  /bad.?gateway/i,
  /gateway.?timeout/i,
];

const SCHEMA_ERROR_PATTERNS = [
  /invalid.?(request.?body|json|schema|parameter|argument)/i,
  /schema.?validation/i,
  /unprocessable.?entity/i,
  /malformed/i,
  /400\b/,
  /422\b/,
];

const CONFIGURATION_ERROR_PATTERNS = [
  /no.?auth.?profile/i,
  /provider.?(not.?found|unavailable|not.?configured)/i,
  /model.?(not.?found|unknown|not.?configured)/i,
  /missing.?(api.?key|credential|configuration)/i,
  /unknown.?provider/i,
];

export const classifyError = (error: Error): ClassifiedError => {
  const message = error.message.toLowerCase();
  const status =
    (error as unknown as Record<string, unknown>)?.status ??
    (error as unknown as Record<string, unknown>)?.statusCode;

  // Check status codes first (most reliable)
  if (status === 429)
    return { reason: "rate_limit", retryable: true, suggestedDelayMs: 5000, originalError: error };
  if (status === 401 || status === 403)
    return { reason: "auth_failure", retryable: false, suggestedDelayMs: 0, originalError: error };
  if (status === 400 && CONTEXT_LENGTH_PATTERNS.some((p) => p.test(message)))
    return {
      reason: "context_length_exceeded",
      retryable: false,
      suggestedDelayMs: 0,
      originalError: error,
    };
  if (status === 400 || status === 422)
    return { reason: "schema_error", retryable: false, suggestedDelayMs: 0, originalError: error };
  if (status === 404)
    return {
      reason: "configuration_error",
      retryable: false,
      suggestedDelayMs: 0,
      originalError: error,
    };
  if (typeof status === "number" && status >= 500 && status < 600)
    return {
      reason: "server_error",
      retryable: true,
      suggestedDelayMs: 2000,
      originalError: error,
    };

  // Pattern matching on message
  if (RATE_LIMIT_PATTERNS.some((p) => p.test(message))) {
    // Honour Retry-After header when provider encoded it as "retry_after:N" (seconds)
    const retryAfterMatch = message.match(/retry_after:(\d+)/);
    const suggestedDelayMs = retryAfterMatch
      ? Number.parseInt(retryAfterMatch[1], 10) * 1000
      : 5000;
    return { reason: "rate_limit", retryable: true, suggestedDelayMs, originalError: error };
  }
  if (AUTH_PATTERNS.some((p) => p.test(message)))
    return { reason: "auth_failure", retryable: false, suggestedDelayMs: 0, originalError: error };
  if (CONTEXT_LENGTH_PATTERNS.some((p) => p.test(message)))
    return {
      reason: "context_length_exceeded",
      retryable: false,
      suggestedDelayMs: 0,
      originalError: error,
    };
  if (CONFIGURATION_ERROR_PATTERNS.some((p) => p.test(message)))
    return {
      reason: "configuration_error",
      retryable: false,
      suggestedDelayMs: 0,
      originalError: error,
    };
  if (SCHEMA_ERROR_PATTERNS.some((p) => p.test(message)))
    return { reason: "schema_error", retryable: false, suggestedDelayMs: 0, originalError: error };
  if (/timeout|timed?\s*out|abort/i.test(message))
    return { reason: "timeout", retryable: true, suggestedDelayMs: 1000, originalError: error };
  if (/econnrefused|enotfound|network|fetch\s*failed|unreachable/i.test(message))
    return {
      reason: "network_error",
      retryable: true,
      suggestedDelayMs: 2000,
      originalError: error,
    };
  if (SERVER_ERROR_PATTERNS.some((p) => p.test(message)))
    return {
      reason: "server_error",
      retryable: true,
      suggestedDelayMs: 2000,
      originalError: error,
    };

  return { reason: "unknown", retryable: false, suggestedDelayMs: 0, originalError: error };
};

/** Exponential backoff with jitter: baseMs * 2^attempt ± jitter */
export const jitteredBackoff = (baseMs: number, attempt: number, maxMs = 60_000): number => {
  const delay = Math.min(baseMs * 2 ** attempt, maxMs);
  const jitter = delay * 0.2 * Math.random(); // ±20% jitter
  return Math.floor(delay + jitter);
};
