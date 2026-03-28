import type { HairyClawLogger } from "@hairyclaw/observability";
import { StdioTransport } from "./stdio-transport.js";
import type { McpCallResult, McpServerConfig, McpToolSchema } from "./types.js";

export class McpClient {
  private readonly transport: StdioTransport;
  private tools: McpToolSchema[] = [];
  private initialized = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly logger: HairyClawLogger,
  ) {
    this.transport = new StdioTransport({
      command: config.command,
      args: config.args,
      env: config.env,
    });
  }

  async connect(): Promise<void> {
    this.logger.info({ server: this.config.name }, "connecting to MCP server");

    await this.transport.start();

    // Step 1: Initialize handshake
    await this.transport.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "hairyclaw", version: "0.1.0" },
    });

    // Step 2: Send initialized notification
    this.transport.notify("notifications/initialized");

    // Step 3: Discover tools
    const listResult = (await this.transport.request("tools/list", {})) as {
      tools?: McpToolSchema[];
    };

    this.tools = listResult?.tools ?? [];
    this.initialized = true;

    this.logger.info(
      { server: this.config.name, toolCount: this.tools.length },
      "MCP server connected",
    );
  }

  async disconnect(): Promise<void> {
    this.logger.info({ server: this.config.name }, "disconnecting MCP server");
    await this.transport.close();
    this.initialized = false;
    this.tools = [];
  }

  getTools(): McpToolSchema[] {
    return [...this.tools];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.initialized) {
      throw new Error("MCP client not connected");
    }

    const result = (await this.transport.request("tools/call", {
      name,
      arguments: args,
    })) as McpCallResult;

    return result;
  }

  get isConnected(): boolean {
    return this.initialized && this.transport.isRunning;
  }

  get serverName(): string {
    return this.config.name;
  }
}
