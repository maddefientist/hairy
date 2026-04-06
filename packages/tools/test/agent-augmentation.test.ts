import { describe, expect, it, vi } from "vitest";
import {
  type AgentMCPConfig,
  createDefaultAgentMCPConfig,
  filterServersForAgent,
  resolveAgentMCPTools,
} from "../src/mcp/agent-augmentation.js";
import type { McpToolBridge } from "../src/mcp/registry.js";
import type { McpServerConfig } from "../src/mcp/types.js";
import type { Tool } from "../src/types.js";

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

const makeTool = (name: string): Tool =>
  ({
    name,
    description: `Tool ${name}`,
    parameters: {},
    execute: vi.fn(),
  }) as unknown as Tool;

describe("resolveAgentMCPTools", () => {
  it("filters tools to only allowed servers", () => {
    const logger = createLogger();
    const bridge = {
      getTools: () => [
        makeTool("mcp_server1_read"),
        makeTool("mcp_server1_write"),
        makeTool("mcp_server2_search"),
        makeTool("mcp_server3_deploy"),
      ],
      connectedServers: ["server1", "server2", "server3"],
    } as unknown as McpToolBridge;

    const config: AgentMCPConfig = {
      agentId: "agent-1",
      mcpServers: ["server1", "server3"],
    };

    const result = resolveAgentMCPTools(config, bridge, logger);

    expect(result.agentId).toBe("agent-1");
    expect(result.tools).toHaveLength(3);
    expect(result.tools.map((t) => t.name)).toEqual([
      "mcp_server1_read",
      "mcp_server1_write",
      "mcp_server3_deploy",
    ]);
    expect(result.connectedServers).toContain("server1");
    expect(result.connectedServers).toContain("server3");
    expect(result.connectedServers).not.toContain("server2");
  });

  it("excludes specific tools", () => {
    const logger = createLogger();
    const bridge = {
      getTools: () => [
        makeTool("mcp_server1_read"),
        makeTool("mcp_server1_write"),
        makeTool("mcp_server1_delete"),
      ],
      connectedServers: ["server1"],
    } as unknown as McpToolBridge;

    const config: AgentMCPConfig = {
      agentId: "agent-safe",
      mcpServers: ["server1"],
      excludeTools: ["mcp_server1_delete"],
    };

    const result = resolveAgentMCPTools(config, bridge, logger);

    expect(result.tools).toHaveLength(2);
    expect(result.excludedToolCount).toBe(1);
    expect(result.tools.map((t) => t.name)).not.toContain("mcp_server1_delete");
  });

  it("returns empty when no servers match", () => {
    const logger = createLogger();
    const bridge = {
      getTools: () => [makeTool("mcp_server1_read")],
      connectedServers: ["server1"],
    } as unknown as McpToolBridge;

    const config: AgentMCPConfig = {
      agentId: "agent-isolated",
      mcpServers: ["nonexistent"],
    };

    const result = resolveAgentMCPTools(config, bridge, logger);
    expect(result.tools).toHaveLength(0);
    expect(result.connectedServers).toHaveLength(0);
  });

  it("ignores non-mcp-prefixed tools", () => {
    const logger = createLogger();
    const bridge = {
      getTools: () => [makeTool("builtin_bash"), makeTool("mcp_server1_read")],
      connectedServers: ["server1"],
    } as unknown as McpToolBridge;

    const config: AgentMCPConfig = {
      agentId: "agent-x",
      mcpServers: ["server1"],
    };

    const result = resolveAgentMCPTools(config, bridge, logger);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("mcp_server1_read");
  });
});

describe("filterServersForAgent", () => {
  it("returns only enabled servers matching agent config", () => {
    const servers: McpServerConfig[] = [
      { name: "s1", enabled: true, transport: "stdio", command: "cmd1" },
      { name: "s2", enabled: false, transport: "stdio", command: "cmd2" },
      { name: "s3", enabled: true, transport: "stdio", command: "cmd3" },
    ];

    const config: AgentMCPConfig = {
      agentId: "agent-1",
      mcpServers: ["s1", "s2", "s3"],
    };

    const filtered = filterServersForAgent(config, servers);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((s) => s.name)).toEqual(["s1", "s3"]);
  });
});

describe("createDefaultAgentMCPConfig", () => {
  it("creates config with all connected servers", () => {
    const bridge = {
      connectedServers: ["s1", "s2"],
    } as unknown as McpToolBridge;

    const config = createDefaultAgentMCPConfig("agent-default", bridge);
    expect(config.agentId).toBe("agent-default");
    expect(config.mcpServers).toEqual(["s1", "s2"]);
  });
});
