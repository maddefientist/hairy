import type { HairyClawLogger } from "@hairyclaw/observability";
import { z } from "zod";
import type { Tool } from "../types.js";
import { McpClient } from "./client.js";
import type { McpCallResult, McpServerConfig, McpToolSchema } from "./types.js";

const mcpToolToHairyClawTool = (
  client: McpClient,
  schema: McpToolSchema,
  serverName: string,
): Tool => ({
  name: `mcp_${serverName}_${schema.name}`,
  description: schema.description ?? `MCP tool: ${schema.name} (from ${serverName})`,
  parameters: z.record(z.unknown()),
  async execute(args) {
    try {
      const result: McpCallResult = await client.callTool(
        schema.name,
        args as Record<string, unknown>,
      );
      const text = result.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text as string)
        .join("\n");
      return { content: text || "Tool executed successfully.", isError: result.isError };
    } catch (error: unknown) {
      return {
        content: error instanceof Error ? error.message : "MCP tool call failed",
        isError: true,
      };
    }
  },
});

export class McpToolBridge {
  private readonly clients = new Map<string, McpClient>();

  constructor(private readonly logger: HairyClawLogger) {}

  async connectAll(configs: McpServerConfig[]): Promise<void> {
    const enabledConfigs = configs.filter((c) => c.enabled);

    for (const config of enabledConfigs) {
      try {
        const client = new McpClient(config, this.logger.child({ mcpServer: config.name }));
        await client.connect();
        this.clients.set(config.name, client);
        this.logger.info(
          { server: config.name, tools: client.getTools().length },
          "MCP server registered",
        );
      } catch (error: unknown) {
        this.logger.error({ err: error, server: config.name }, "failed to connect MCP server");
      }
    }
  }

  getTools(): Tool[] {
    const tools: Tool[] = [];

    for (const [serverName, client] of Array.from(this.clients.entries())) {
      for (const schema of client.getTools()) {
        tools.push(mcpToolToHairyClawTool(client, schema, serverName));
      }
    }

    return tools;
  }

  async disconnectAll(): Promise<void> {
    for (const [name, client] of Array.from(this.clients.entries())) {
      try {
        await client.disconnect();
      } catch (error: unknown) {
        this.logger.error({ err: error, server: name }, "failed to disconnect MCP server");
      }
    }
    this.clients.clear();
  }

  getClient(name: string): McpClient | undefined {
    return this.clients.get(name);
  }

  get connectedServers(): string[] {
    return Array.from(this.clients.keys());
  }
}
