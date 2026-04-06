/**
 * Tests for Fork-vs-Fresh context modes in SubagentExecutor
 *
 * Validates:
 * - Fresh mode (default): clean slate messages
 * - Fork mode: inherits parent messages
 * - Feature flag gating of fork mode
 * - Metadata tags reflect the context mode
 */

import { describe, expect, it, vi } from "vitest";
import type {
  AgentLoopEvent,
  AgentLoopMessage,
  AgentLoopOptions,
  AgentLoopStreamOptions,
} from "../src/agent-loop.js";
import { createExecutionMetadata } from "../src/execution-metadata.js";
import { FeatureFlagManager } from "../src/feature-flags.js";
import { SubagentExecutor } from "../src/subagent-executor.js";
import { TELEMETRY_EVENTS } from "../src/telemetry-events.js";

const noopLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => noopLogger,
};

const mockProvider = (text: string, delayMs = 0) => ({
  async *stream(
    _msgs: AgentLoopMessage[],
    _opts: AgentLoopStreamOptions,
  ): AsyncIterable<AgentLoopEvent> {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    yield { type: "text_delta" as const, text };
    yield { type: "stop" as const, reason: "end" };
  },
});

const noopExecutor = vi.fn(async () => ({ content: "", isError: false }));

const baseSubmitOpts = (overrides: Record<string, unknown> = {}) => ({
  task: "do something",
  systemPrompt: "You are a helper.",
  provider: mockProvider("done"),
  executor: noopExecutor,
  tools: [],
  model: "test-model",
  parentTraceId: "trace-parent-1",
  logger: noopLogger,
  ...overrides,
});

describe("Fork-vs-Fresh Context Modes", () => {
  describe("fresh mode (default)", () => {
    it("sends only the task as a single user message", async () => {
      let capturedMessages: AgentLoopMessage[] = [];

      const capturingRunLoop = vi.fn(async (messages: AgentLoopMessage[]) => {
        capturedMessages = messages;
        return {
          text: "done",
          toolCalls: [],
          totalUsage: { input: 0, output: 0, costUsd: 0 },
          iterations: 1,
        };
      });

      const executor = new SubagentExecutor({
        maxConcurrent: 3,
        runLoop: capturingRunLoop,
      });

      const taskId = await executor.submit(
        baseSubmitOpts({
          task: "analyze this code",
          mode: "fresh",
        }) as never,
      );
      await executor.waitFor(taskId);

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0].role).toBe("user");
      expect(capturedMessages[0].content[0].text).toBe("analyze this code");
    });

    it("defaults to fresh mode when no mode specified", async () => {
      let capturedMessages: AgentLoopMessage[] = [];

      const capturingRunLoop = vi.fn(async (messages: AgentLoopMessage[]) => {
        capturedMessages = messages;
        return {
          text: "done",
          toolCalls: [],
          totalUsage: { input: 0, output: 0, costUsd: 0 },
          iterations: 1,
        };
      });

      const executor = new SubagentExecutor({
        maxConcurrent: 3,
        runLoop: capturingRunLoop,
      });

      const taskId = (await executor.submit(baseSubmitOpts())) as string;
      await executor.waitFor(taskId);

      // Should be fresh (just one user message)
      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0].role).toBe("user");
    });
  });

  describe("fork mode", () => {
    it("includes parent messages before task when fork mode is enabled", async () => {
      let capturedMessages: AgentLoopMessage[] = [];

      const capturingRunLoop = vi.fn(async (messages: AgentLoopMessage[]) => {
        capturedMessages = messages;
        return {
          text: "done",
          toolCalls: [],
          totalUsage: { input: 0, output: 0, costUsd: 0 },
          iterations: 1,
        };
      });

      const parentMessages: AgentLoopMessage[] = [
        { role: "user", content: [{ type: "text", text: "first message" }] },
        { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      ];

      const featureFlags = new FeatureFlagManager({
        features: { subagentContextForking: true },
      });

      const executor = new SubagentExecutor({
        maxConcurrent: 3,
        runLoop: capturingRunLoop,
        featureFlags,
      });

      const taskId = await executor.submit(
        baseSubmitOpts({
          task: "continue from here",
          mode: "fork",
          parentMessages,
        }) as never,
      );
      await executor.waitFor(taskId);

      // Should have parent messages + new task message
      expect(capturedMessages).toHaveLength(3);
      expect(capturedMessages[0].role).toBe("user");
      expect(capturedMessages[0].content[0].text).toBe("first message");
      expect(capturedMessages[1].role).toBe("assistant");
      expect(capturedMessages[1].content[0].text).toBe("first reply");
      expect(capturedMessages[2].role).toBe("user");
      expect(capturedMessages[2].content[0].text).toBe("continue from here");
    });

    it("falls back to fresh mode when subagentContextForking flag is disabled", async () => {
      let capturedMessages: AgentLoopMessage[] = [];

      const capturingRunLoop = vi.fn(async (messages: AgentLoopMessage[]) => {
        capturedMessages = messages;
        return {
          text: "done",
          toolCalls: [],
          totalUsage: { input: 0, output: 0, costUsd: 0 },
          iterations: 1,
        };
      });

      const parentMessages: AgentLoopMessage[] = [
        { role: "user", content: [{ type: "text", text: "old context" }] },
      ];

      const featureFlags = new FeatureFlagManager({
        features: { subagentContextForking: false },
      });

      const executor = new SubagentExecutor({
        maxConcurrent: 3,
        runLoop: capturingRunLoop,
        featureFlags,
      });

      const taskId = await executor.submit(
        baseSubmitOpts({
          task: "my task",
          mode: "fork",
          parentMessages,
        }) as never,
      );
      await executor.waitFor(taskId);

      // Should fall back to fresh (ignoring parent messages)
      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0].content[0].text).toBe("my task");
    });

    it("uses fresh mode when fork requested but no parent messages provided", async () => {
      let capturedMessages: AgentLoopMessage[] = [];

      const capturingRunLoop = vi.fn(async (messages: AgentLoopMessage[]) => {
        capturedMessages = messages;
        return {
          text: "done",
          toolCalls: [],
          totalUsage: { input: 0, output: 0, costUsd: 0 },
          iterations: 1,
        };
      });

      const featureFlags = new FeatureFlagManager({
        features: { subagentContextForking: true },
      });

      const executor = new SubagentExecutor({
        maxConcurrent: 3,
        runLoop: capturingRunLoop,
        featureFlags,
      });

      const taskId = await executor.submit(
        baseSubmitOpts({
          task: "orphan task",
          mode: "fork",
          // No parentMessages
        }) as never,
      );
      await executor.waitFor(taskId);

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0].content[0].text).toBe("orphan task");
    });
  });

  describe("metadata tagging by context mode", () => {
    it("tags fork mode metadata with contextMode=fork", async () => {
      const logger = { ...noopLogger, info: vi.fn() };

      const featureFlags = new FeatureFlagManager({
        features: {
          subagentContextForking: true,
          executionMetadataTracking: true,
          standardizedTelemetry: true,
        },
      });

      const parentMetadata = createExecutionMetadata(
        "trace-fork",
        "orchestrator",
        "unified",
      ).build();

      const executor = new SubagentExecutor({
        maxConcurrent: 3,
        featureFlags,
      });

      const taskId = await executor.submit(
        baseSubmitOpts({
          logger,
          parentMetadata,
          taskId: "fork-task",
          mode: "fork",
          parentMessages: [{ role: "user", content: [{ type: "text", text: "parent msg" }] }],
        }) as never,
      );
      await executor.waitFor(taskId);

      const calls = logger.info.mock.calls;
      const startCall = calls.find(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.event === TELEMETRY_EVENTS.subagent.start,
      );

      expect(startCall).toBeDefined();
      const payload = startCall?.[0] as Record<string, unknown>;
      expect(payload.contextMode).toBe("fork");
    });

    it("tags fresh mode metadata with contextMode=fresh", async () => {
      const logger = { ...noopLogger, info: vi.fn() };

      const featureFlags = new FeatureFlagManager({
        features: {
          executionMetadataTracking: true,
          standardizedTelemetry: true,
        },
      });

      const parentMetadata = createExecutionMetadata(
        "trace-fresh",
        "orchestrator",
        "unified",
      ).build();

      const executor = new SubagentExecutor({
        maxConcurrent: 3,
        featureFlags,
      });

      const taskId = await executor.submit(
        baseSubmitOpts({
          logger,
          parentMetadata,
          taskId: "fresh-task",
          mode: "fresh",
        }) as never,
      );
      await executor.waitFor(taskId);

      const calls = logger.info.mock.calls;
      const startCall = calls.find(
        (c: unknown[]) =>
          (c[0] as Record<string, unknown>)?.event === TELEMETRY_EVENTS.subagent.start,
      );

      expect(startCall).toBeDefined();
      const payload = startCall?.[0] as Record<string, unknown>;
      expect(payload.contextMode).toBe("fresh");
    });
  });
});
