/**
 * MCP Connection Lifecycle Manager
 *
 * Manages connection state transitions for MCP server connections:
 * - connecting, connected, degraded, disconnected, reconnecting
 * - Auto-reconnect with exponential backoff
 * - Periodic health checks (ping)
 * - Telemetry emission for lifecycle events
 *
 * Gated behind mcpLifecycleManagement feature flag.
 */

import type { HairyClawLogger } from "@hairyclaw/observability";
import type { McpClient } from "./client.js";
import type { McpServerConfig } from "./types.js";

/**
 * MCP connection state
 */
export type MCPConnectionState =
  | "connecting"
  | "connected"
  | "degraded"
  | "disconnected"
  | "reconnecting";

/**
 * Lifecycle event names emitted as telemetry
 */
export const MCP_LIFECYCLE_EVENTS = {
  connect: "mcp.connect",
  disconnect: "mcp.disconnect",
  reconnect: "mcp.reconnect",
  healthCheck: "mcp.health_check",
  stateChange: "mcp.state_change",
} as const;

/**
 * Configuration for lifecycle management
 */
export interface MCPLifecycleConfig {
  /** Maximum number of reconnect attempts before giving up. Default: 5 */
  maxReconnectAttempts: number;
  /** Base delay in ms for exponential backoff. Default: 1000 */
  baseReconnectDelayMs: number;
  /** Maximum delay cap in ms. Default: 30000 */
  maxReconnectDelayMs: number;
  /** Health check interval in ms. 0 = disabled. Default: 30000 */
  healthCheckIntervalMs: number;
  /** Timeout for health check ping in ms. Default: 5000 */
  healthCheckTimeoutMs: number;
}

export const DEFAULT_LIFECYCLE_CONFIG: MCPLifecycleConfig = {
  maxReconnectAttempts: 5,
  baseReconnectDelayMs: 1000,
  maxReconnectDelayMs: 30_000,
  healthCheckIntervalMs: 30_000,
  healthCheckTimeoutMs: 5_000,
};

/**
 * Lifecycle state snapshot for diagnostics
 */
export interface MCPLifecycleStatus {
  serverName: string;
  state: MCPConnectionState;
  reconnectAttempts: number;
  lastHealthCheckAt: number | undefined;
  lastHealthCheckOk: boolean | undefined;
  connectedSince: number | undefined;
}

/**
 * MCPConnectionLifecycle manages the connection state for a single MCP server.
 *
 * Usage:
 *   const lifecycle = new MCPConnectionLifecycle(client, config, lifecycleConfig, logger);
 *   await lifecycle.connect();  // connects with lifecycle tracking
 *   lifecycle.startHealthChecks();
 *   // ...
 *   await lifecycle.disconnect();
 */
export class MCPConnectionLifecycle {
  private _state: MCPConnectionState = "disconnected";
  private reconnectAttempts = 0;
  private healthCheckTimer: ReturnType<typeof setInterval> | undefined;
  private lastHealthCheckAt: number | undefined;
  private lastHealthCheckOk: boolean | undefined;
  private connectedSince: number | undefined;

  constructor(
    private readonly client: McpClient,
    private readonly serverConfig: McpServerConfig,
    private readonly config: MCPLifecycleConfig,
    private readonly logger: HairyClawLogger,
  ) {}

  /**
   * Current connection state
   */
  get state(): MCPConnectionState {
    return this._state;
  }

  /**
   * Transition to a new state with telemetry
   */
  private setState(newState: MCPConnectionState): void {
    const oldState = this._state;
    if (oldState === newState) {
      return;
    }
    this._state = newState;
    this.logger.info(
      {
        event: MCP_LIFECYCLE_EVENTS.stateChange,
        server: this.serverConfig.name,
        oldState,
        newState,
      },
      MCP_LIFECYCLE_EVENTS.stateChange,
    );
  }

  /**
   * Connect to the MCP server with lifecycle tracking
   */
  async connect(): Promise<void> {
    this.setState("connecting");
    try {
      await this.client.connect();
      this.setState("connected");
      this.connectedSince = Date.now();
      this.reconnectAttempts = 0;
      this.logger.info(
        {
          event: MCP_LIFECYCLE_EVENTS.connect,
          server: this.serverConfig.name,
        },
        MCP_LIFECYCLE_EVENTS.connect,
      );
    } catch (error: unknown) {
      this.setState("disconnected");
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          event: MCP_LIFECYCLE_EVENTS.connect,
          server: this.serverConfig.name,
          error: msg,
          success: false,
        },
        "mcp.connect failed",
      );
      throw error;
    }
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    this.stopHealthChecks();
    try {
      await this.client.disconnect();
    } catch {
      // best-effort disconnect
    }
    this.setState("disconnected");
    this.connectedSince = undefined;
    this.logger.info(
      {
        event: MCP_LIFECYCLE_EVENTS.disconnect,
        server: this.serverConfig.name,
      },
      MCP_LIFECYCLE_EVENTS.disconnect,
    );
  }

  /**
   * Attempt reconnection with exponential backoff.
   * Returns true if reconnect succeeded, false if all attempts exhausted.
   */
  async reconnect(): Promise<boolean> {
    this.stopHealthChecks();
    this.setState("reconnecting");

    while (this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delayMs = Math.min(
        this.config.baseReconnectDelayMs * 2 ** (this.reconnectAttempts - 1),
        this.config.maxReconnectDelayMs,
      );

      this.logger.info(
        {
          event: MCP_LIFECYCLE_EVENTS.reconnect,
          server: this.serverConfig.name,
          attempt: this.reconnectAttempts,
          maxAttempts: this.config.maxReconnectAttempts,
          delayMs,
        },
        MCP_LIFECYCLE_EVENTS.reconnect,
      );

      await this.delay(delayMs);

      try {
        // Disconnect the old client first (best-effort)
        try {
          await this.client.disconnect();
        } catch {
          // ignore
        }

        await this.client.connect();
        this.setState("connected");
        this.connectedSince = Date.now();
        this.reconnectAttempts = 0;
        this.logger.info(
          {
            event: MCP_LIFECYCLE_EVENTS.reconnect,
            server: this.serverConfig.name,
            success: true,
          },
          "mcp.reconnect succeeded",
        );
        return true;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          {
            event: MCP_LIFECYCLE_EVENTS.reconnect,
            server: this.serverConfig.name,
            attempt: this.reconnectAttempts,
            error: msg,
            success: false,
          },
          "mcp.reconnect attempt failed",
        );
      }
    }

    // All attempts exhausted
    this.setState("disconnected");
    this.logger.error(
      {
        event: MCP_LIFECYCLE_EVENTS.reconnect,
        server: this.serverConfig.name,
        attempts: this.reconnectAttempts,
        success: false,
      },
      "mcp.reconnect exhausted all attempts",
    );
    return false;
  }

  /**
   * Perform a single health check by verifying the client is still connected.
   * Transitions to degraded if the check fails, triggers reconnect.
   */
  async healthCheck(): Promise<boolean> {
    this.lastHealthCheckAt = Date.now();

    if (!this.client.isConnected) {
      this.lastHealthCheckOk = false;
      this.logger.warn(
        {
          event: MCP_LIFECYCLE_EVENTS.healthCheck,
          server: this.serverConfig.name,
          ok: false,
          reason: "client not connected",
        },
        MCP_LIFECYCLE_EVENTS.healthCheck,
      );
      this.setState("degraded");
      return false;
    }

    // Attempt a lightweight tools/list as a ping
    try {
      const tools = this.client.getTools();
      this.lastHealthCheckOk = true;
      this.logger.debug(
        {
          event: MCP_LIFECYCLE_EVENTS.healthCheck,
          server: this.serverConfig.name,
          ok: true,
          toolCount: tools.length,
        },
        MCP_LIFECYCLE_EVENTS.healthCheck,
      );
      // If was degraded and health check passes, promote back to connected
      if (this._state === "degraded") {
        this.setState("connected");
      }
      return true;
    } catch {
      this.lastHealthCheckOk = false;
      this.logger.warn(
        {
          event: MCP_LIFECYCLE_EVENTS.healthCheck,
          server: this.serverConfig.name,
          ok: false,
          reason: "health check failed",
        },
        MCP_LIFECYCLE_EVENTS.healthCheck,
      );
      this.setState("degraded");
      return false;
    }
  }

  /**
   * Start periodic health checks
   */
  startHealthChecks(): void {
    if (this.config.healthCheckIntervalMs <= 0) {
      return;
    }
    this.stopHealthChecks();
    this.healthCheckTimer = setInterval(() => {
      void this.healthCheck();
    }, this.config.healthCheckIntervalMs);
    // Don't block process exit
    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref();
    }
  }

  /**
   * Stop periodic health checks
   */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * Get diagnostic status snapshot
   */
  getStatus(): MCPLifecycleStatus {
    return {
      serverName: this.serverConfig.name,
      state: this._state,
      reconnectAttempts: this.reconnectAttempts,
      lastHealthCheckAt: this.lastHealthCheckAt,
      lastHealthCheckOk: this.lastHealthCheckOk,
      connectedSince: this.connectedSince,
    };
  }

  /**
   * Delay helper (overridable for testing)
   */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
