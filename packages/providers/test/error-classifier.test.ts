import { describe, expect, it } from "vitest";
import { classifyError, jitteredBackoff } from "../src/error-classifier.js";

const makeError = (message: string, extra: Record<string, unknown> = {}): Error => {
  const err = new Error(message);
  Object.assign(err, extra);
  return err;
};

describe("classifyError", () => {
  describe("status code classification", () => {
    it("classifies 429 as rate_limit", () => {
      const err = makeError("slow down", { status: 429 });
      const result = classifyError(err);
      expect(result.reason).toBe("rate_limit");
      expect(result.retryable).toBe(true);
      expect(result.suggestedDelayMs).toBe(5000);
    });

    it("classifies 401 as auth_failure", () => {
      const err = makeError("nope", { status: 401 });
      const result = classifyError(err);
      expect(result.reason).toBe("auth_failure");
      expect(result.retryable).toBe(false);
    });

    it("classifies 403 as auth_failure", () => {
      const err = makeError("forbidden", { status: 403 });
      const result = classifyError(err);
      expect(result.reason).toBe("auth_failure");
      expect(result.retryable).toBe(false);
    });

    it("classifies 400 with context message as context_length_exceeded", () => {
      const err = makeError("context length exceeded", { status: 400 });
      const result = classifyError(err);
      expect(result.reason).toBe("context_length_exceeded");
      expect(result.retryable).toBe(false);
    });

    it("classifies 500 as server_error", () => {
      const err = makeError("oops", { status: 500 });
      const result = classifyError(err);
      expect(result.reason).toBe("server_error");
      expect(result.retryable).toBe(true);
      expect(result.suggestedDelayMs).toBe(2000);
    });

    it("classifies 502 as server_error", () => {
      const err = makeError("bad gateway", { status: 502 });
      const result = classifyError(err);
      expect(result.reason).toBe("server_error");
    });

    it("classifies 503 as server_error", () => {
      const err = makeError("unavailable", { status: 503 });
      const result = classifyError(err);
      expect(result.reason).toBe("server_error");
    });
  });

  describe("message pattern classification", () => {
    it("classifies rate limit messages", () => {
      expect(classifyError(new Error("Rate limit exceeded")).reason).toBe("rate_limit");
      expect(classifyError(new Error("Too many requests")).reason).toBe("rate_limit");
    });

    it("classifies auth messages", () => {
      expect(classifyError(new Error("Invalid API key provided")).reason).toBe("auth_failure");
      expect(classifyError(new Error("Unauthorized access")).reason).toBe("auth_failure");
    });

    it("classifies context length messages", () => {
      expect(classifyError(new Error("Context length exceeded")).reason).toBe(
        "context_length_exceeded",
      );
      expect(classifyError(new Error("Token limit reached")).reason).toBe(
        "context_length_exceeded",
      );
      expect(classifyError(new Error("Too many tokens")).reason).toBe("context_length_exceeded");
    });

    it("classifies timeout messages", () => {
      expect(classifyError(new Error("Request timed out")).reason).toBe("timeout");
      expect(classifyError(new Error("timeout after 30s")).reason).toBe("timeout");
      expect(classifyError(new Error("Request abort")).reason).toBe("timeout");
    });

    it("classifies network error messages", () => {
      expect(classifyError(new Error("ECONNREFUSED")).reason).toBe("network_error");
      expect(classifyError(new Error("ENOTFOUND")).reason).toBe("network_error");
      expect(classifyError(new Error("network error")).reason).toBe("network_error");
      expect(classifyError(new Error("fetch failed")).reason).toBe("network_error");
    });

    it("classifies server error messages", () => {
      expect(classifyError(new Error("server error")).reason).toBe("server_error");
      expect(classifyError(new Error("internal server error")).reason).toBe("server_error");
      expect(classifyError(new Error("service unavailable")).reason).toBe("server_error");
      expect(classifyError(new Error("gateway timeout")).reason).toBe("timeout");
    });

    it("classifies unknown errors", () => {
      const err = new Error("something completely unexpected");
      const result = classifyError(err);
      expect(result.reason).toBe("unknown");
      expect(result.retryable).toBe(false);
      expect(result.suggestedDelayMs).toBe(0);
    });
  });

  it("preserves the original error", () => {
    const err = new Error("test");
    const result = classifyError(err);
    expect(result.originalError).toBe(err);
  });
});

describe("jitteredBackoff", () => {
  it("returns baseMs for attempt 0", () => {
    const result = jitteredBackoff(1000, 0, 60_000);
    // 1000 * 2^0 = 1000, + up to 20% jitter = up to 1200
    expect(result).toBeGreaterThanOrEqual(1000);
    expect(result).toBeLessThanOrEqual(1200);
  });

  it("returns baseMs * 2 for attempt 1", () => {
    const result = jitteredBackoff(1000, 1, 60_000);
    // 1000 * 2^1 = 2000, + up to 20% jitter = up to 2400
    expect(result).toBeGreaterThanOrEqual(2000);
    expect(result).toBeLessThanOrEqual(2400);
  });

  it("respects maxMs cap", () => {
    const result = jitteredBackoff(1000, 20, 5000);
    // Would be 1000 * 2^20 = ~1M, capped at 5000
    expect(result).toBeGreaterThanOrEqual(5000);
    expect(result).toBeLessThanOrEqual(6000); // 5000 + 20% jitter
  });

  it("returns integer values", () => {
    const result = jitteredBackoff(1000, 3, 60_000);
    expect(Number.isInteger(result)).toBe(true);
  });
});
