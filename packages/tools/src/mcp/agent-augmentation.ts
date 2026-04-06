/**
 * Per-Agent MCP Augmentation
 *
 * Defines which MCP servers a specific agent/subagent should connect to,
 * allowing the orchestrator to spawn subagents with different MCP tool sets.
 *
 * The resolver takes a global pool of available MCP servers and produces
 * a filtered, agent-specific tool set.
 */

import type { HairyClawLogger } from "@hairyclaw/observability";
import type { Tool } from "../types.js";
import type { McpToolBridge } from "./registry.js";
import type { McpServerConfig } from "./types.js";

/**
 * Per-agent MCP configuration
 */
export interface AgentMCPConfig {
  /** Agent or subagent identifier */
  agentId: string;
  /** Names of MCP servers this agent should connect to */
  mcpServers: string[];
  /** Tool names to exclude even if provided by an allowed server */
  excludeTools?: string[];
}

/**
 * Resolved MCP tool set for a specific agent
 */
export interface ResolvedAgentMCPTools {
  agentId: string;
  tools: Tool[];
  connectedServers: string[];
  excludedToolCount: number;
}

/**
 * Resolve MCP tools for a specific agent given a connected bridge.
 *
 * Filters bridge tools to only those from servers listed in the agent's config,
 * then removes any explicitly excluded tools.
 */
export const resolveAgentMCPTools = (
  config: AgentMCPConfig,
  bridge: McpToolBridge,
  logger: HairyClawLogger,
): ResolvedAgentMCPTools => {
  const allTools = bridge.getTools();
  const allowedServerSet = new Set(config.mcpServers);
  const excludeSet = new Set(config.excludeTools ?? []);

  // Tools are named `mcp_<serverName>_<toolName>` — extract server name
  const serverFiltered = allTools.filter((tool) => {
    const parts = tool.name.split("_");
    // mcp_<serverName>_<rest...>
    if (parts.length < 3 || parts[0] !== "mcp") {
      return false;
    }
    const serverName = parts[1];
    return allowedServerSet.has(serverName);
  });

  let excludedCount = 0;
  const finalTools = serverFiltered.filter((tool) => {
    if (excludeSet.has(tool.name)) {
      excludedCount++;
      return false;
    }
    return true;
  });

  // Determine which servers actually contributed tools
  const connectedServers = [
    ...new Set(
      finalTools
        .map((t) => {
          const parts = t.name.split("_");
          return parts.length >= 3 ? parts[1] : undefined;
        })
        .filter((s): s is string => s !== undefined),
    ),
  ];

  logger.debug(
    {
      agentId: config.agentId,
      requestedServers: config.mcpServers,
      connectedServers,
      totalTools: finalTools.length,
      excludedTools: excludedCount,
    },
    "resolved agent MCP tools",
  );

  return {
    agentId: config.agentId,
    tools: finalTools,
    connectedServers,
    excludedToolCount: excludedCount,
  };
};

/**
 * Filter MCP server configs for a specific agent.
 *
 * Given the full list of available MCP server configs and an agent's config,
 * return only the server configs the agent should connect to.
 */
export const filterServersForAgent = (
  agentConfig: AgentMCPConfig,
  allServers: McpServerConfig[],
): McpServerConfig[] => {
  const allowedSet = new Set(agentConfig.mcpServers);
  return allServers.filter((s) => s.enabled && allowedSet.has(s.name));
};

/**
 * Create a default AgentMCPConfig that includes all available servers
 */
export const createDefaultAgentMCPConfig = (
  agentId: string,
  bridge: McpToolBridge,
): AgentMCPConfig => ({
  agentId,
  mcpServers: bridge.connectedServers,
});
