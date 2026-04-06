/**
 * Tests for M2 foundations wiring into orchestrator and subagent-executor.
 *
 * Validates:
 * - ExecutionMetadata creation and propagation
 * - Telemetry event emission (orchestrator.process.start/complete, subagent.*)
 * - Feature flag gating of metadata and telemetry
 * - PluginContext carries executionMetadata
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentLoopEvent,
  AgentLoopMessage,
  AgentLoopStreamOptions,
} from "../src/agent-loop.js";
import { type ExecutionMetadata, createExecutionMetadata } from "../src/execution-metadata.js";
import { FeatureFlagManager } from "../src/feature-flags.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { PluginContext } from "../src/plugin.js";
import { PluginRunner } from "../src/plugin.js";
import { SubagentExecutor } from "../src/subagent-executor.js";
import { TaskQueue } from "../src/task-queue.js";
import { TELEMETRY_EVENTS } from "../src/telemetry-events.js";
import type { AgentResponse, HairyClawMessage } from "../src/types.js";

// ── Test helpers ──

const mockLogger = () => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return logger;
};

const mockMetrics = () => ({
  increment: vi.fn(),
  gauge: vi.fn(),
  getAll: vi.fn(() => ({ counters: [], gauges: [] })),
  toPrometheus: vi.fn(() => ""),
});

const message = (text: string): HairyClawMessage => ({
  id: randomUUID(),
  channelId: "chat-1",
  channelType: "cli",
  senderId: "user-1",
  senderName: "User",
  content: { text },
  timestamp: new Date().toISOString(),
});

const queuePath = (): string => join(tmpdir(), `hairy-telemetry-${randomUUID()}.json`);

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
  task: "test task",
  systemPrompt: "You are a helper.",
  provider: mockProvider("done"),
  executor: noopExecutor,
  tools: [],
  model: "test-model",
  parentTraceId: "trace-parent-1",
  logger: mockLogger(),
  ...overrides,
});

// ── Orchestrator telemetry wiring ──

describe("orchestrator telemetry wiring", () => {
  it("emits orchestrator.process.start and orchestrator.process.complete on successful run", async () => {
    const logger = mockLogger();
    const orchestrator = new Orchestrator({
      logger,
      metrics: mockMetrics() as never,
      queue: new TaskQueue(queuePath()),
      handleRun: async () => ({ text: "ok" }),
      featureFlags: new FeatureFlagManager({
        features: { executionMetadataTracking: true, standardizedTelemetry: true },
      }),
    });

    await orchestrator.start();
    await orchestrator.handleMessage(message("hello"));

    await vi.waitFor(
      () => {
        const calls = logger.info.mock.calls;
        const events = calls
          .map((c: unknown[]) => (c[0] as Record<string, unknown>)?.event)
          .filter(Boolean);
        expect(events).toContain(TELEMETRY_EVENTS.orchestrator.processStart);
        expect(events).toContain(TELEMETRY_EVENTS.orchestrator.processComplete);
      },
      { timeout: 1_000 },
    );

    await orchestrator.stop();
  });

  it("includes turnId and traceId in telemetry events", async () => {
    const logger = mockLogger();
    const orchestrator = new Orchestrator({
      logger,
      metrics: mockMetrics() as never,
      queue: new TaskQueue(queuePath()),
      handleRun: async () => ({ text: "ok" }),
      featureFlags: new FeatureFlagManager({
        features: { executionMetadataTracking: true, standardizedTelemetry: true },
      }),
    });

    await orchestrator.start();
    await orchestrator.handleMessage(message("hello"));

    await vi.waitFor(
      () => {
        const calls = logger.info.mock.calls;
        const startCall = calls.find(
          (c: unknown[]) =>
            (c[0] as Record<string, unknown>)?.event === TELEMETRY_EVENTS.orchestrator.processStart,
        );
        expect(startCall).toBeDefined();
        const payload = startCall?.[0] as Record<string, unknown>;
        expect(payload.turnId).toBeTypeOf("string");
        expect(payload.traceId).toBeTypeOf("string");
        expect(payload.agentId).toBe("orchestrator");
        expect(payload.executionMode).toBe("unified");
      },
      { timeout: 1_000 },
    );

    await orchestrator.stop();
  });

  it("emits orchestrator.process.complete with error info on failure", async () => {
    const logger = mockLogger();
    const orchestrator = new Orchestrator({
      logger,
      metrics: mockMetrics() as never,
      queue: new TaskQueue(queuePath()),
      handleRun: async () => {
        throw new Error("kaboom");
      },
      featureFlags: new FeatureFlagManager({
        features: { executionMetadataTracking: true, standardizedTelemetry: true },
      }),
    });

    await orchestrator.start();
    await orchestrator.handleMessage(message("fail"));

    await vi.waitFor(
      () => {
        const calls = logger.info.mock.calls;
        const completeCall = calls.find(
          (c: unknown[]) =>
            (c[0] as Record<string, unknown>)?.event ===
            TELEMETRY_EVENTS.orchestrator.processComplete,
        );
        expect(completeCall).toBeDefined();
        const payload = completeCall?.[0] as Record<string, unknown>;
        expect(payload.error).toBe("kaboom");
        expect(payload.status).toBe("error");
      },
      { timeout: 1_000 },
    );

    await orchestrator.stop();
  });

  it("does not emit telemetry when standardizedTelemetry flag is disabled", async () => {
    const logger = mockLogger();
    const orchestrator = new Orchestrator({
      logger,
      metrics: mockMetrics() as never,
      queue: new TaskQueue(queuePath()),
      handleRun: async () => ({ text: "ok" }),
      featureFlags: new FeatureFlagManager({
        features: { executionMetadataTracking: true, standardizedTelemetry: false },
      }),
    });

    await orchestrator.start();
    await orchestrator.handleMessage(message("silent"));

    // Wait for processing to complete
    await vi.waitFor(
      () => {
        const calls = logger.info.mock.calls;
        const runComplete = calls.find((c: unknown[]) => c[1] === "orchestrator run completed");
        expect(runComplete).toBeDefined();
      },
      { timeout: 1_000 },
    );

    // Verify no telemetry events emitted
    const calls = logger.info.mock.calls;
    const telemetryEvents = calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.event !== undefined,
    );
    expect(telemetryEvents).toHaveLength(0);

    await orchestrator.stop();
  });

  it("passes executionMetadata to PluginContext when feature enabled", async () => {
    const logger = mockLogger();
    let capturedCtx: PluginContext | undefined;

    const plugins = new PluginRunner([
      {
        name: "meta-capture",
        onRunStart: async (ctx) => {
          capturedCtx = ctx;
        },
      },
    ]);

    const orchestrator = new Orchestrator({
      logger,
      metrics: mockMetrics() as never,
      queue: new TaskQueue(queuePath()),
      plugins,
      handleRun: async () => ({ text: "ok" }),
      featureFlags: new FeatureFlagManager({
        features: { executionMetadataTracking: true, standardizedTelemetry: true },
      }),
    });

    await orchestrator.start();
    await orchestrator.handleMessage(message("meta"));

    await vi.waitFor(
      () => {
        expect(capturedCtx).toBeDefined();
      },
      { timeout: 1_000 },
    );

    expect(capturedCtx?.executionMetadata).toBeDefined();
    expect(capturedCtx?.executionMetadata?.traceId).toBe(capturedCtx?.traceId);
    expect(capturedCtx?.executionMetadata?.agentId).toBe("orchestrator");
    expect(capturedCtx?.executionMetadata?.executionMode).toBe("unified");
    expect(capturedCtx?.executionMetadata?.turnId).toBeTypeOf("string");

    await orchestrator.stop();
  });

  it("does not attach executionMetadata to PluginContext when feature disabled", async () => {
    const logger = mockLogger();
    let capturedCtx: PluginContext | undefined;

    const plugins = new PluginRunner([
      {
        name: "meta-capture",
        onRunStart: async (ctx) => {
          capturedCtx = ctx;
        },
      },
    ]);

    const orchestrator = new Orchestrator({
      logger,
      metrics: mockMetrics() as never,
      queue: new TaskQueue(queuePath()),
      plugins,
      handleRun: async () => ({ text: "ok" }),
      featureFlags: new FeatureFlagManager({
        features: { executionMetadataTracking: false, standardizedTelemetry: true },
      }),
    });

    await orchestrator.start();
    await orchestrator.handleMessage(message("no-meta"));

    await vi.waitFor(
      () => {
        expect(capturedCtx).toBeDefined();
      },
      { timeout: 1_000 },
    );

    expect(capturedCtx?.executionMetadata).toBeUndefined();

    await orchestrator.stop();
  });

  it("works without featureFlags (backward compat, defaults to enabled)", async () => {
    const logger = mockLogger();
    let capturedCtx: PluginContext | undefined;

    const plugins = new PluginRunner([
      {
        name: "meta-capture",
        onRunStart: async (ctx) => {
          capturedCtx = ctx;
        },
      },
    ]);

    const orchestrator = new Orchestrator({
      logger,
      metrics: mockMetrics() as never,
      queue: new TaskQueue(queuePath()),
      plugins,
      handleRun: async () => ({ text: "ok" }),
      // No featureFlags provided
    });

    await orchestrator.start();
    await orchestrator.handleMessage(message("compat"));

    await vi.waitFor(
      () => {
        expect(capturedCtx).toBeDefined();
      },
      { timeout: 1_000 },
    );

    // When no feature flags manager, metadata should be created (default-on)
    expect(capturedCtx?.executionMetadata).toBeDefined();

    // Telemetry should also be emitted (default-on)
    const calls = logger.info.mock.calls;
    const events = calls
      .map((c: unknown[]) => (c[0] as Record<string, unknown>)?.event)
      .filter(Boolean);
    expect(events).toContain(TELEMETRY_EVENTS.orchestrator.processStart);

    await orchestrator.stop();
  });
});

// ── SubagentExecutor telemetry wiring ──

describe("subagent-executor telemetry wiring", () => {
  it("emits subagent.start and subagent.complete on successful task", async () => {
    const logger = mockLogger();
    const featureFlags = new FeatureFlagManager({
      features: { executionMetadataTracking: true, standardizedTelemetry: true },
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
    });

    const parentMetadata = createExecutionMetadata("trace-1", "orchestrator", "unified").build();

    const taskId = await executor.submit(baseSubmitOpts({ logger, parentMetadata }) as never);
    await executor.waitFor(taskId);

    const calls = logger.info.mock.calls;
    const events = calls
      .map((c: unknown[]) => (c[0] as Record<string, unknown>)?.event)
      .filter(Boolean);

    expect(events).toContain(TELEMETRY_EVENTS.subagent.start);
    expect(events).toContain(TELEMETRY_EVENTS.subagent.complete);
  });

  it("creates child metadata with correct lineage", async () => {
    const logger = mockLogger();
    const featureFlags = new FeatureFlagManager({
      features: { executionMetadataTracking: true, standardizedTelemetry: true },
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
    });

    const parentMetadata = createExecutionMetadata("trace-abc", "orchestrator", "unified").build();

    const taskId = await executor.submit(
      baseSubmitOpts({
        logger,
        parentMetadata,
        taskId: "child-task-1",
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
    // Child metadata should reference parent's trace
    expect(payload.traceId).toBe("trace-abc");
    // agentId should be the taskId (the child's identity)
    expect(payload.agentId).toBe("child-task-1");
    expect(payload.executorType).toBe("subagent");
  });

  it("emits subagent.error on task failure", async () => {
    const logger = mockLogger();
    const featureFlags = new FeatureFlagManager({
      features: { executionMetadataTracking: true, standardizedTelemetry: true },
    });

    const failingRunLoop = vi.fn(async () => {
      throw new Error("model exploded");
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
      runLoop: failingRunLoop,
    });

    const parentMetadata = createExecutionMetadata("trace-err", "orchestrator", "unified").build();

    const taskId = await executor.submit(baseSubmitOpts({ logger, parentMetadata }) as never);
    await executor.waitFor(taskId);

    const calls = logger.info.mock.calls;
    const events = calls
      .map((c: unknown[]) => (c[0] as Record<string, unknown>)?.event)
      .filter(Boolean);

    expect(events).toContain(TELEMETRY_EVENTS.subagent.start);
    expect(events).toContain(TELEMETRY_EVENTS.subagent.error);
    expect(events).not.toContain(TELEMETRY_EVENTS.subagent.complete);

    // Verify error details
    const errorCall = calls.find(
      (c: unknown[]) =>
        (c[0] as Record<string, unknown>)?.event === TELEMETRY_EVENTS.subagent.error,
    );
    expect((errorCall?.[0] as Record<string, unknown>).error).toBe("model exploded");
  });

  it("emits subagent.timeout on timeout", async () => {
    const logger = mockLogger();
    const featureFlags = new FeatureFlagManager({
      features: { executionMetadataTracking: true, standardizedTelemetry: true },
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
    });

    const parentMetadata = createExecutionMetadata("trace-to", "orchestrator", "unified").build();

    const taskId = await executor.submit(
      baseSubmitOpts({
        logger,
        parentMetadata,
        provider: mockProvider("slow", 500),
        timeoutMs: 20,
      }) as never,
    );
    await executor.waitFor(taskId);

    const calls = logger.info.mock.calls;
    const events = calls
      .map((c: unknown[]) => (c[0] as Record<string, unknown>)?.event)
      .filter(Boolean);

    expect(events).toContain(TELEMETRY_EVENTS.subagent.start);
    expect(events).toContain(TELEMETRY_EVENTS.subagent.timeout);
    expect(events).not.toContain(TELEMETRY_EVENTS.subagent.complete);
  });

  it("does not emit telemetry when standardizedTelemetry is disabled", async () => {
    const logger = mockLogger();
    const featureFlags = new FeatureFlagManager({
      features: { executionMetadataTracking: true, standardizedTelemetry: false },
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
    });

    const parentMetadata = createExecutionMetadata("trace-q", "orchestrator", "unified").build();

    const taskId = await executor.submit(baseSubmitOpts({ logger, parentMetadata }) as never);
    await executor.waitFor(taskId);

    const calls = logger.info.mock.calls;
    const telemetryEvents = calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.event !== undefined,
    );
    expect(telemetryEvents).toHaveLength(0);
  });

  it("does not create child metadata when executionMetadataTracking is disabled", async () => {
    const logger = mockLogger();
    const featureFlags = new FeatureFlagManager({
      features: { executionMetadataTracking: false, standardizedTelemetry: true },
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
    });

    const parentMetadata = createExecutionMetadata("trace-nope", "orchestrator", "unified").build();

    const taskId = await executor.submit(baseSubmitOpts({ logger, parentMetadata }) as never);
    await executor.waitFor(taskId);

    // Telemetry events emitted but without metadata labels
    const calls = logger.info.mock.calls;
    const startCall = calls.find(
      (c: unknown[]) =>
        (c[0] as Record<string, unknown>)?.event === TELEMETRY_EVENTS.subagent.start,
    );

    expect(startCall).toBeDefined();
    // No turnId or agentId because child metadata was not created
    expect((startCall?.[0] as Record<string, unknown>).turnId).toBeUndefined();
    expect((startCall?.[0] as Record<string, unknown>).agentId).toBeUndefined();
  });

  it("works without parentMetadata (no child metadata, still emits events)", async () => {
    const logger = mockLogger();
    const featureFlags = new FeatureFlagManager({
      features: { executionMetadataTracking: true, standardizedTelemetry: true },
    });

    const executor = new SubagentExecutor({
      maxConcurrent: 3,
      featureFlags,
    });

    // No parentMetadata
    const taskId = await executor.submit(baseSubmitOpts({ logger }) as never);
    await executor.waitFor(taskId);

    const calls = logger.info.mock.calls;
    const events = calls
      .map((c: unknown[]) => (c[0] as Record<string, unknown>)?.event)
      .filter(Boolean);

    // Events still emitted (without metadata labels)
    expect(events).toContain(TELEMETRY_EVENTS.subagent.start);
    expect(events).toContain(TELEMETRY_EVENTS.subagent.complete);
  });

  it("backward compatible: works without featureFlags (defaults to no telemetry emission)", async () => {
    const logger = mockLogger();
    const executor = new SubagentExecutor({ maxConcurrent: 3 });

    const taskId = await executor.submit(baseSubmitOpts({ logger }) as never);
    const result = await executor.waitFor(taskId);

    // Basic functionality still works
    expect(result.status).toBe("completed");
    expect(result.result).toBe("done");
  });
});
