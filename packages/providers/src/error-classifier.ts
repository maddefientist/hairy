export type FailoverReason =
  | "rate_limit"
  | "auth_failure"
  | "context_length_exceeded"
  | "server_error"
  | "timeout"
  | "network_error"
  | "unknown";

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
  if (typeof status === "number" && status >= 500 && status < 600)
    return {
      reason: "server_error",
      retryable: true,
      suggestedDelayMs: 2000,
      originalError: error,
    };

  // Pattern matching on message
  if (RATE_LIMIT_PATTERNS.some((p) => p.test(message)))
    return { reason: "rate_limit", retryable: true, suggestedDelayMs: 5000, originalError: error };
  if (AUTH_PATTERNS.some((p) => p.test(message)))
    return { reason: "auth_failure", retryable: false, suggestedDelayMs: 0, originalError: error };
  if (CONTEXT_LENGTH_PATTERNS.some((p) => p.test(message)))
    return {
      reason: "context_length_exceeded",
      retryable: false,
      suggestedDelayMs: 0,
      originalError: error,
    };
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
