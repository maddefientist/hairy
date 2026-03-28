# TASK-07: MCP Server Integration

## Goal
Add Model Context Protocol (MCP) client support so HairyClaw can connect to external MCP servers and register their tools alongside built-in tools.

## Location
- New directory: `packages/tools/src/mcp/`
- New files:
  - `packages/tools/src/mcp/types.ts`
  - `packages/tools/src/mcp/client.ts`
  - `packages/tools/src/mcp/stdio-transport.ts`
  - `packages/tools/src/mcp/registry.ts`
- Update: `packages/tools/src/index.ts` (add exports)
- New test: `packages/tools/test/mcp.test.ts`
- Update: `config/default.toml` (add MCP section)

## Read First
- `packages/tools/src/registry.ts` — existing ToolRegistry
- `packages/tools/src/types.ts` — Tool interface
- `packages/tools/src/sidecar/protocol.ts` — existing JSON-RPC implementation (reuse patterns)
- `packages/tools/src/sidecar/manager.ts` — sidecar lifecycle management

## Design

### MCP Protocol Basics
MCP uses JSON-RPC 2.0 over stdio (like our sidecar protocol). The key operations:
1. `initialize` — handshake with capabilities
2. `tools/list` — discover available tools
3. `tools/call` — execute a tool

### types.ts
```typescript
export interface McpServerConfig {
  name: string;
  enabled: boolean;
  transport: "stdio";       // future: "sse" | "http"
  command: string;           // e.g., "npx"
  args?: string[];           // e.g., ["-y", "@modelcontextprotocol/server-filesystem"]
  env?: Record<string, string>;
  description?: string;
}

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpCallResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}
```

### stdio-transport.ts
Wraps spawning a child process and communicating via JSON-RPC over stdin/stdout.

```typescript
import { spawn, type ChildProcess } from "node:child_process";

export class StdioTransport {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: Function; reject: Function }>();
  private buffer = "";

  constructor(private readonly config: { command: string; args?: string[]; env?: Record<string, string> });

  async start(): Promise<void>;
  async request(method: string, params?: unknown): Promise<unknown>;
  async close(): Promise<void>;
  get isRunning(): boolean;
}
```

Key implementation details:
- Spawn process with `{ stdio: ["pipe", "pipe", "pipe"] }`
- Read stdout line-by-line, parse JSON-RPC responses
- Match responses to pending requests by `id`
- Handle process exit/error gracefully
- Buffer partial lines (messages may span multiple data events)

### client.ts
```typescript
export class McpClient {
  private transport: StdioTransport;
  private tools: McpToolSchema[] = [];
  private initialized = false;

  constructor(private readonly config: McpServerConfig, private readonly logger: HairyClawLogger);

  async connect(): Promise<void>;     // start transport + initialize + list tools
  async disconnect(): Promise<void>;  // close transport

  getTools(): McpToolSchema[];

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;

  get isConnected(): boolean;
}
```

The `connect` method:
1. Start stdio transport
2. Send `initialize` with `{ protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hairyclaw", version: "0.1.0" } }`
3. Send `notifications/initialized`
4. Send `tools/list` to discover tools
5. Cache tool schemas

### registry.ts — MCP Tool Registry Bridge
Converts MCP tools into HairyClaw Tool objects and registers them.

```typescript
export class McpToolBridge {
  private clients = new Map<string, McpClient>();

  constructor(private readonly logger: HairyClawLogger);

  // Connect to all configured MCP servers
  async connectAll(configs: McpServerConfig[]): Promise<void>;

  // Get all MCP tools as HairyClaw Tool objects
  getTools(): Tool[];

  // Disconnect all
  async disconnectAll(): Promise<void>;
}
```

Converting MCP tool → HairyClaw Tool:
```typescript
const mcpToolToHairyClawTool = (client: McpClient, schema: McpToolSchema, serverName: string): Tool => ({
  name: `mcp_${serverName}_${schema.name}`,  // namespaced to avoid collisions
  description: schema.description ?? `MCP tool: ${schema.name} (from ${serverName})`,
  parameters: z.record(z.unknown()),  // MCP tools validate on the server side
  async execute(args, ctx) {
    try {
      const result = await client.callTool(schema.name, args as Record<string, unknown>);
      const text = result.content
        .filter(c => c.type === "text" && c.text)
        .map(c => c.text!)
        .join("\n");
      return { content: text || "Tool executed successfully.", isError: result.isError };
    } catch (error) {
      return { content: error instanceof Error ? error.message : "MCP tool call failed", isError: true };
    }
  }
});
```

## Config Addition (config/default.toml)
```toml
[mcp]
enabled = false

# Example MCP server configurations (uncomment to use):
# [[mcp.servers]]
# name = "filesystem"
# enabled = true
# transport = "stdio"
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
# description = "Filesystem access via MCP"
```

## Tests (Vitest)

### mcp.test.ts
1. StdioTransport: start and close lifecycle
2. StdioTransport: send request and receive response (mock process)
3. StdioTransport: handle process exit gracefully
4. StdioTransport: timeout on unresponsive server
5. McpClient: connect performs handshake sequence
6. McpClient: getTools returns discovered tools after connect
7. McpClient: callTool sends correct JSON-RPC and parses result
8. McpClient: error handling when tool call fails
9. McpToolBridge: converts MCP tools to HairyClaw Tool objects
10. McpToolBridge: tool names are namespaced with server name
11. McpToolBridge: disconnectAll closes all clients

For testing, create mock child processes using a simple in-process mock:
```typescript
// Mock a JSON-RPC server for testing
const createMockMcpProcess = () => {
  // Return a mock that responds to initialize, tools/list, tools/call
};
```

Since actual MCP servers require npx/network, focus tests on:
- Protocol correctness (JSON-RPC framing)
- Tool conversion logic
- Error handling

Use `vi.mock("node:child_process")` to mock `spawn`.

## Validation
```bash
cd /Users/admin/agenticharnes/hairy && pnpm check && pnpm build && pnpm test
```
