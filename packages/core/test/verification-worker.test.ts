/**
 * Tests for Verification Worker pattern
 *
 * Validates:
 * - Verdict parsing (valid JSON, markdown fences, malformed)
 * - Verification worker invocation via SubagentExecutor
 * - Feature flag gating (disabled = pass-through)
 * - Telemetry emission for verification events
 * - Error/timeout handling
 */

import { describe, expect, it, vi } from "vitest";
import type {
  AgentLoopEvent,
  AgentLoopMessage,
  AgentLoopStreamOptions,
} from "../src/agent-loop.js";
import { createExecutionMetadata } from "../src/execution-metadata.js";
import { FeatureFlagManager } from "../src/feature-flags.js";
import { SubagentExecutor } from "../src/subagent-executor.js";
import { TELEMETRY_EVENTS } from "../src/telemetry-events.js";
import { createVerificationWorker, parseVerificationVerdict } from "../src/verification-worker.js";

const noopLogger = () => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return logger;
};

const noopExecutor = vi.fn(async () => ({ content: "", isError: false }));

const mockProvider = (text: string) => ({
  async *stream(
    _msgs: AgentLoopMessage[],
    _opts: AgentLoopStreamOptions,
  ): AsyncIterable<AgentLoopEvent> {
    yield { type: "text_delta" as const, text };
    yield { type: "stop" as const, reason: "end" };
  },
});

describe("parseVerificationVerdict", () => {
  it("parses valid JSON verdict", () => {
    const verdict = parseVerificationVerdict(
      '{"passed": true, "issues": [], "suggestions": ["Consider adding tests"]}',
    );

    expect(verdict.passed).toBe(true);
    expect(verdict.issues).toEqual([]);
    expect(verdict.suggestions).toEqual(["Consider adding tests"]);
  });

  it("parses JSON with markdown fences", () => {
    const raw =
      '```json\n{"passed": false, "issues": ["Missing validation"], "suggestions": []}\n```';
    const verdict = parseVerificationVerdict(raw);

    expect(verdict.passed).toBe(false);
    expect(verdict.issues).toEqual(["Missing validation"]);
  });

  it("parses JSON with bare fences", () => {
    const raw = '```\n{"passed": true, "issues": [], "suggestions": []}\n```';
    const verdict = parseVerificationVerdict(raw);

    expect(verdict.passed).toBe(true);
  });

  it("returns failure for non-JSON text", () => {
    const verdict = parseVerificationVerdict("I think the output looks good!");

    expect(verdict.passed).toBe(false);
    expect(verdict.issues.length).toBeGreaterThan(0);
    expect(verdict.issues[0]).toContain("Failed to parse");
  });

  it("returns failure for non-object JSON", () => {
    const verdict = parseVerificationVerdict('"just a string"');

    expect(verdict.passed).toBe(false);
    expect(verdict.issues[0]).toContain("non-object");
  });

  it("defaults passed to false when missing", () => {
    const verdict = parseVerificationVerdict('{"issues": ["stuff"]}');
    expect(verdict.passed).toBe(false);
  });

  it("handles missing issues/suggestions arrays", () => {
    const verdict = parseVerificationVerdict('{"passed": true}');

    expect(verdict.passed).toBe(true);
    expect(verdict.issues).toEqual([]);
    expect(verdict.suggestions).toEqual([]);
  });

  it("filters non-string items from arrays", () => {
    const verdict = parseVerificationVerdict(
      '{"passed": false, "issues": ["real issue", 42, null], "suggestions": [true, "real suggestion"]}',
    );

    expect(verdict.issues).toEqual(["real issue"]);
    expect(verdict.suggestions).toEqual(["real suggestion"]);
  });
});

describe("createVerificationWorker", () => {
  it("returns pass-through verdict when feature flag is disabled", async () => {
    const logger = noopLogger();
    const featureFlags = new FeatureFlagManager({
      features: { verificationWorker: false },
    });

    const executor = new SubagentExecutor({ maxConcurrent: 3 });

    const worker = createVerificationWorker(executor, {
      provider: mockProvider("irrelevant"),
      executor: noopExecutor,
      model: "test-model",
      logger,
      featureFlags,
    });

    const verdict = await worker.verify({
      task: "build a widget",
      output: "here is a widget",
      criteria: ["Must be shiny"],
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.issues).toEqual([]);
    expect(verdict.suggestions).toEqual([]);
  });

  it("invokes subagent and returns parsed verdict on success", async () => {
    const logger = noopLogger();
    const featureFlags = new FeatureFlagManager({
      features: {
        verificationWorker: true,
        standardizedTelemetry: true,
      },
    });

    const verdictJson = JSON.stringify({
      passed: false,
      issues: ["Missing error handling"],
      suggestions: ["Add try-catch blocks"],
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
    });

    const worker = createVerificationWorker(executor, {
      provider: mockProvider(verdictJson),
      executor: noopExecutor,
      model: "test-model",
      logger,
      featureFlags,
      parentTraceId: "trace-verify",
    });

    const verdict = await worker.verify({
      task: "implement error handling",
      output: "function doStuff() { return 42; }",
      criteria: ["Must have try-catch", "Must log errors"],
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.issues).toEqual(["Missing error handling"]);
    expect(verdict.suggestions).toEqual(["Add try-catch blocks"]);
  });

  it("emits verification telemetry events", async () => {
    const logger = noopLogger();
    const featureFlags = new FeatureFlagManager({
      features: {
        verificationWorker: true,
        standardizedTelemetry: true,
      },
    });

    const verdictJson = JSON.stringify({
      passed: true,
      issues: [],
      suggestions: [],
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
    });

    const worker = createVerificationWorker(executor, {
      provider: mockProvider(verdictJson),
      executor: noopExecutor,
      model: "test-model",
      logger,
      featureFlags,
    });

    await worker.verify({
      task: "simple task",
      output: "simple output",
      criteria: ["Must exist"],
    });

    const calls = logger.info.mock.calls;
    const events = calls
      .map((c: unknown[]) => (c[0] as Record<string, unknown>)?.event)
      .filter(Boolean);

    expect(events).toContain(TELEMETRY_EVENTS.verification.start);
    expect(events).toContain(TELEMETRY_EVENTS.verification.pass);
  });

  it("emits verification.fail when verdict fails", async () => {
    const logger = noopLogger();
    const featureFlags = new FeatureFlagManager({
      features: {
        verificationWorker: true,
        standardizedTelemetry: true,
      },
    });

    const verdictJson = JSON.stringify({
      passed: false,
      issues: ["Nope"],
      suggestions: [],
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
    });

    const worker = createVerificationWorker(executor, {
      provider: mockProvider(verdictJson),
      executor: noopExecutor,
      model: "test-model",
      logger,
      featureFlags,
    });

    const verdict = await worker.verify({
      task: "task",
      output: "bad output",
      criteria: ["Must be good"],
    });

    expect(verdict.passed).toBe(false);

    const calls = logger.info.mock.calls;
    const events = calls
      .map((c: unknown[]) => (c[0] as Record<string, unknown>)?.event)
      .filter(Boolean);

    expect(events).toContain(TELEMETRY_EVENTS.verification.fail);
    expect(events).not.toContain(TELEMETRY_EVENTS.verification.pass);
  });

  it("handles subagent failure gracefully", async () => {
    const logger = noopLogger();
    const featureFlags = new FeatureFlagManager({
      features: {
        verificationWorker: true,
        standardizedTelemetry: true,
      },
    });

    const failingRunLoop = vi.fn(async () => {
      throw new Error("model crashed");
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
      runLoop: failingRunLoop,
    });

    const worker = createVerificationWorker(executor, {
      provider: mockProvider("irrelevant"),
      executor: noopExecutor,
      model: "test-model",
      logger,
      featureFlags,
    });

    const verdict = await worker.verify({
      task: "task",
      output: "output",
      criteria: ["anything"],
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.issues.length).toBeGreaterThan(0);
    expect(verdict.issues[0]).toContain("model crashed");
  });

  it("uses custom system prompt when provided", async () => {
    let capturedMessages: AgentLoopMessage[] = [];
    let capturedOpts: Record<string, unknown> = {};

    const capturingRunLoop = vi.fn(
      async (messages: AgentLoopMessage[], opts: Record<string, unknown>) => {
        capturedMessages = messages;
        capturedOpts = opts;
        return {
          text: '{"passed": true, "issues": [], "suggestions": []}',
          toolCalls: [],
          totalUsage: { input: 0, output: 0, costUsd: 0 },
          iterations: 1,
        };
      },
    );

    const logger = noopLogger();
    const featureFlags = new FeatureFlagManager({
      features: { verificationWorker: true },
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
      runLoop: capturingRunLoop,
    });

    const worker = createVerificationWorker(executor, {
      provider: mockProvider("irrelevant"),
      executor: noopExecutor,
      model: "test-model",
      logger,
      featureFlags,
      systemPrompt: "Custom verification prompt: be strict.",
    });

    await worker.verify({
      task: "task",
      output: "output",
      criteria: ["criteria"],
    });

    // The system prompt is passed through streamOpts
    const streamOpts = (capturedOpts as Record<string, unknown>).streamOpts as Record<
      string,
      unknown
    >;
    expect(streamOpts.systemPrompt).toBe("Custom verification prompt: be strict.");
  });

  it("always uses fresh mode for verification subagents", async () => {
    let capturedMessages: AgentLoopMessage[] = [];

    const capturingRunLoop = vi.fn(async (messages: AgentLoopMessage[]) => {
      capturedMessages = messages;
      return {
        text: '{"passed": true, "issues": [], "suggestions": []}',
        toolCalls: [],
        totalUsage: { input: 0, output: 0, costUsd: 0 },
        iterations: 1,
      };
    });

    const logger = noopLogger();
    const featureFlags = new FeatureFlagManager({
      features: { verificationWorker: true },
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
      runLoop: capturingRunLoop,
    });

    const worker = createVerificationWorker(executor, {
      provider: mockProvider("irrelevant"),
      executor: noopExecutor,
      model: "test-model",
      logger,
      featureFlags,
    });

    await worker.verify({
      task: "task",
      output: "output",
      criteria: ["criteria"],
    });

    // Fresh mode: only one user message with the verification prompt
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].role).toBe("user");
    expect(capturedMessages[0].content[0].text).toContain("Original Task");
    expect(capturedMessages[0].content[0].text).toContain("Verification Criteria");
  });
});
