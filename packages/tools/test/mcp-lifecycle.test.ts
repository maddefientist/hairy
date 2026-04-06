import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpClient } from "../src/mcp/client.js";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  type MCPLifecycleConfig,
  MCPConnectionLifecycle,
} from "../src/mcp/lifecycle.js";
import type { McpServerConfig } from "../src/mcp/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const createLogger = () => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return logger;
};

const createMockClient = (overrides?: Partial<McpClient>): McpClient => {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    getTools: vi.fn().mockReturnValue([]),
    isConnected: true,
    serverName: "test-server",
    ...overrides,
  } as unknown as McpClient;
};

const serverConfig: McpServerConfig = {
  name: "test-server",
  enabled: true,
  transport: "stdio",
  command: "test-cmd",
};

/**
 * Testable subclass that resolves delay instantly
 */
class TestableLifecycle extends MCPConnectionLifecycle {
  protected override delay(_ms: number): Promise<void> {
    return Promise.resolve();
  }
}

describe("MCPConnectionLifecycle", () => {
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts in disconnected state", () => {
    const client = createMockClient();
    const lifecycle = new MCPConnectionLifecycle(client, serverConfig, DEFAULT_LIFECYCLE_CONFIG, logger);
    expect(lifecycle.state).toBe("disconnected");
  });

  it("connect transitions through connecting -> connected", async () => {
    const client = createMockClient();
    const lifecycle = new MCPConnectionLifecycle(client, serverConfig, DEFAULT_LIFECYCLE_CONFIG, logger);

    await lifecycle.connect();

    expect(lifecycle.state).toBe("connected");
    expect(client.connect).toHaveBeenCalledOnce();
    // Telemetry was emitted
    const events = logger.info.mock.calls.map((c) => c[0]?.event).filter(Boolean);
    expect(events).toContain("mcp.state_change");
    expect(events).toContain("mcp.connect");
  });

  it("connect failure transitions to disconnected", async () => {
    const client = createMockClient({
      connect: vi.fn().mockRejectedValue(new Error("spawn failed")),
    } as unknown as Partial<McpClient>);
    const lifecycle = new MCPConnectionLifecycle(client, serverConfig, DEFAULT_LIFECYCLE_CONFIG, logger);

    await expect(lifecycle.connect()).rejects.toThrow("spawn failed");
    expect(lifecycle.state).toBe("disconnected");
  });

  it("disconnect transitions to disconnected", async () => {
    const client = createMockClient();
    const lifecycle = new MCPConnectionLifecycle(client, serverConfig, DEFAULT_LIFECYCLE_CONFIG, logger);

    await lifecycle.connect();
    await lifecycle.disconnect();

    expect(lifecycle.state).toBe("disconnected");
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it("reconnect with exponential backoff succeeds on second attempt", async () => {
    let attempt = 0;
    const client = createMockClient({
      connect: vi.fn().mockImplementation(() => {
        attempt++;
        if (attempt <= 2) {
          return Promise.reject(new Error("not yet"));
        }
        return Promise.resolve();
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as Partial<McpClient>);

    const config: MCPLifecycleConfig = {
      ...DEFAULT_LIFECYCLE_CONFIG,
      maxReconnectAttempts: 5,
      baseReconnectDelayMs: 10,
    };
    const lifecycle = new TestableLifecycle(client, serverConfig, config, logger);

    const success = await lifecycle.reconnect();
    expect(success).toBe(true);
    expect(lifecycle.state).toBe("connected");
    // connect called: attempt 1 (fail), attempt 2 (fail), attempt 3 (success)
    expect(attempt).toBe(3);
  });

  it("reconnect exhausts all attempts and fails", async () => {
    const client = createMockClient({
      connect: vi.fn().mockRejectedValue(new Error("always fails")),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as Partial<McpClient>);

    const config: MCPLifecycleConfig = {
      ...DEFAULT_LIFECYCLE_CONFIG,
      maxReconnectAttempts: 3,
      baseReconnectDelayMs: 1,
    };
    const lifecycle = new TestableLifecycle(client, serverConfig, config, logger);

    const success = await lifecycle.reconnect();
    expect(success).toBe(false);
    expect(lifecycle.state).toBe("disconnected");
  });

  it("healthCheck returns true when client is connected", async () => {
    const client = createMockClient();
    const lifecycle = new MCPConnectionLifecycle(client, serverConfig, DEFAULT_LIFECYCLE_CONFIG, logger);

    await lifecycle.connect();
    const ok = await lifecycle.healthCheck();

    expect(ok).toBe(true);
    const status = lifecycle.getStatus();
    expect(status.lastHealthCheckOk).toBe(true);
    expect(status.lastHealthCheckAt).toBeGreaterThan(0);
  });

  it("healthCheck returns false and sets degraded when disconnected", async () => {
    const client = createMockClient({
      isConnected: false,
    } as unknown as Partial<McpClient>);
    const lifecycle = new MCPConnectionLifecycle(client, serverConfig, DEFAULT_LIFECYCLE_CONFIG, logger);

    const ok = await lifecycle.healthCheck();

    expect(ok).toBe(false);
    expect(lifecycle.state).toBe("degraded");
  });

  it("healthCheck promotes from degraded back to connected", async () => {
    const client = createMockClient();
    const lifecycle = new MCPConnectionLifecycle(client, serverConfig, DEFAULT_LIFECYCLE_CONFIG, logger);

    // Force into degraded state
    await lifecycle.connect();
    // Manually set client to appear disconnected then back
    Object.defineProperty(client, "isConnected", { value: false, writable: true });
    await lifecycle.healthCheck();
    expect(lifecycle.state).toBe("degraded");

    // Now it's connected again
    Object.defineProperty(client, "isConnected", { value: true });
    await lifecycle.healthCheck();
    expect(lifecycle.state).toBe("connected");
  });

  it("getStatus returns a diagnostic snapshot", async () => {
    const client = createMockClient();
    const lifecycle = new MCPConnectionLifecycle(client, serverConfig, DEFAULT_LIFECYCLE_CONFIG, logger);

    await lifecycle.connect();
    const status = lifecycle.getStatus();

    expect(status.serverName).toBe("test-server");
    expect(status.state).toBe("connected");
    expect(status.reconnectAttempts).toBe(0);
    expect(status.connectedSince).toBeGreaterThan(0);
  });

  it("stopHealthChecks is safe to call without starting", () => {
    const client = createMockClient();
    const lifecycle = new MCPConnectionLifecycle(client, serverConfig, DEFAULT_LIFECYCLE_CONFIG, logger);
    // Should not throw
    lifecycle.stopHealthChecks();
  });
});
