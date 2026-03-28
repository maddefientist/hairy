import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import { McpToolBridge } from "../src/mcp/registry.js";
import { StdioTransport } from "../src/mcp/stdio-transport.js";
import type { McpServerConfig, McpToolSchema } from "../src/mcp/types.js";

// ---------------------------------------------------------------------------
// Mock logger
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

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------
interface MockProcess {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  emitter: EventEmitter;
  killed: boolean;
}

let spawnedProcesses: MockProcess[] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((): unknown => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = new EventEmitter();
    const mock: MockProcess = { stdin, stdout, stderr, emitter, killed: false };
    spawnedProcesses.push(mock);

    return Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      pid: 12345,
      get killed() {
        return mock.killed;
      },
      kill: vi.fn(() => {
        mock.killed = true;
      }),
      connected: true,
      exitCode: null,
      signalCode: null,
      spawnargs: [] as string[],
      spawnfile: "",
      ref: vi.fn(),
      unref: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    });
  }),
}));

/**
 * Set up a JSON-RPC responder on a mock process.
 * Uses setImmediate to defer stdout writes (avoids re-entrancy issue with
 * PassThrough streams when writing to stdout from within a stdin data handler).
 */
function setupResponder(
  mock: MockProcess,
  handler: (req: { id: number; method: string; params?: unknown }) => unknown,
): void {
  mock.stdin.on("data", (chunk: Buffer) => {
    const lines = chunk.toString("utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let req: { id?: number; method: string; params?: unknown };
      try {
        req = JSON.parse(line) as typeof req;
      } catch {
        continue;
      }
      if (req.id === undefined) continue; // notification
      const id = req.id;
      const result = handler(req as { id: number; method: string; params?: unknown });
      setImmediate(() => {
        const response = JSON.stringify({ jsonrpc: "2.0", id, result });
        mock.stdout.write(`${response}\n`);
      });
    }
  });
}

/** Standard MCP handshake + tools/list + tools/call responder */
function setupMcpResponder(
  mock: MockProcess,
  tools: McpToolSchema[],
  callHandler?: (name: string, args: Record<string, unknown>) => unknown,
): void {
  setupResponder(mock, (req) => {
    if (req.method === "initialize") {
      return { protocolVersion: "2024-11-05", capabilities: {} };
    }
    if (req.method === "tools/list") {
      return { tools };
    }
    if (req.method === "tools/call") {
      const params = req.params as { name: string; arguments: Record<string, unknown> };
      if (callHandler) {
        return callHandler(params.name, params.arguments);
      }
      return { content: [{ type: "text", text: JSON.stringify(params.arguments) }] };
    }
    return {};
  });
}

/** Helper: spy on start to wire up mock responder before requests are sent */
function spyOnStartWith(
  tools: McpToolSchema[],
  callHandler?: (name: string, args: Record<string, unknown>) => unknown,
) {
  const originalStart = StdioTransport.prototype.start;
  return vi.spyOn(StdioTransport.prototype, "start").mockImplementation(async function (
    this: StdioTransport,
  ) {
    await originalStart.call(this);
    const mock = spawnedProcesses[spawnedProcesses.length - 1];
    setupMcpResponder(mock, tools, callHandler);
  });
}

// ---------------------------------------------------------------------------
// StdioTransport tests
// ---------------------------------------------------------------------------
describe("StdioTransport", () => {
  beforeEach(() => {
    spawnedProcesses = [];
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("start and close lifecycle", async () => {
    const transport = new StdioTransport({ command: "echo", args: ["test"] });
    expect(transport.isRunning).toBe(false);
    await transport.start();
    expect(transport.isRunning).toBe(true);
    await transport.close();
    expect(transport.isRunning).toBe(false);
  });

  it("throws when starting an already-started transport", async () => {
    const transport = new StdioTransport({ command: "echo" });
    await transport.start();
    await expect(transport.start()).rejects.toThrow("already started");
    await transport.close();
  });

  it("send request and receive response", async () => {
    const transport = new StdioTransport({ command: "echo" });
    await transport.start();

    const mock = spawnedProcesses[0];
    setupResponder(mock, (req) => {
      if (req.method === "test/method") {
        return { greeting: "hello" };
      }
      return null;
    });

    const result = await transport.request("test/method", { key: "value" });
    expect(result).toEqual({ greeting: "hello" });
    await transport.close();
  });

  it("handle process exit gracefully", async () => {
    const transport = new StdioTransport({ command: "echo" });
    await transport.start();

    const mock = spawnedProcesses[0];
    const requestPromise = transport.request("test/method", {}, 5000);

    mock.killed = true;
    mock.emitter.emit("exit", 1, null);

    await expect(requestPromise).rejects.toThrow("MCP server process exited");
  });

  it("timeout on unresponsive server", async () => {
    const transport = new StdioTransport({ command: "echo" });
    await transport.start();
    await expect(transport.request("slow/method", {}, 50)).rejects.toThrow("timeout");
    await transport.close();
  });

  it("throws when sending request on stopped transport", async () => {
    const transport = new StdioTransport({ command: "echo" });
    await expect(transport.request("test", {})).rejects.toThrow("not started");
  });

  it("throws when sending notification on stopped transport", () => {
    const transport = new StdioTransport({ command: "echo" });
    expect(() => transport.notify("test", {})).toThrow("not started");
  });

  it("close is a no-op when not started", async () => {
    const transport = new StdioTransport({ command: "echo" });
    await transport.close();
  });
});

// ---------------------------------------------------------------------------
// McpClient tests
// ---------------------------------------------------------------------------
describe("McpClient", () => {
  const baseConfig: McpServerConfig = {
    name: "test-server",
    enabled: true,
    transport: "stdio",
    command: "test-mcp-server",
    description: "Test MCP server",
  };

  beforeEach(() => {
    spawnedProcesses = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("connect performs handshake sequence", async () => {
    const logger = createLogger();
    const client = new McpClient(baseConfig, logger);

    const receivedMethods: string[] = [];
    const originalStart = StdioTransport.prototype.start;
    vi.spyOn(StdioTransport.prototype, "start").mockImplementation(async function (
      this: StdioTransport,
    ) {
      await originalStart.call(this);
      const mock = spawnedProcesses[spawnedProcesses.length - 1];
      setupResponder(mock, (req) => {
        receivedMethods.push(req.method);
        if (req.method === "initialize") {
          return { protocolVersion: "2024-11-05", capabilities: {} };
        }
        if (req.method === "tools/list") {
          return { tools: [] };
        }
        return {};
      });
    });

    await client.connect();

    expect(receivedMethods).toContain("initialize");
    expect(receivedMethods).toContain("tools/list");
    expect(client.isConnected).toBe(true);

    await client.disconnect();
  });

  it("getTools returns discovered tools after connect", async () => {
    const logger = createLogger();
    const client = new McpClient(baseConfig, logger);

    const testTools: McpToolSchema[] = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write to a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ];

    const spy = spyOnStartWith(testTools);
    await client.connect();

    const tools = client.getTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("read_file");
    expect(tools[1].name).toBe("write_file");

    await client.disconnect();
    spy.mockRestore();
  });

  it("callTool sends correct JSON-RPC and parses result", async () => {
    const logger = createLogger();
    const client = new McpClient(baseConfig, logger);

    const spy = spyOnStartWith(
      [{ name: "greet", description: "Greet", inputSchema: { type: "object" } }],
      (_name, args) => ({
        content: [{ type: "text", text: `Hello, ${String(args.name)}!` }],
      }),
    );

    await client.connect();
    const result = await client.callTool("greet", { name: "World" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("Hello, World!");

    await client.disconnect();
    spy.mockRestore();
  });

  it("error handling when client is not connected", async () => {
    const logger = createLogger();
    const client = new McpClient(baseConfig, logger);
    await expect(client.callTool("test", {})).rejects.toThrow("not connected");
  });

  it("disconnect resets state", async () => {
    const logger = createLogger();
    const client = new McpClient(baseConfig, logger);

    const spy = spyOnStartWith([{ name: "test_tool", inputSchema: { type: "object" } }]);

    await client.connect();
    expect(client.getTools()).toHaveLength(1);

    await client.disconnect();
    expect(client.getTools()).toHaveLength(0);
    expect(client.isConnected).toBe(false);

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// McpToolBridge tests
// ---------------------------------------------------------------------------
describe("McpToolBridge", () => {
  beforeEach(() => {
    spawnedProcesses = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("converts MCP tools to HairyClaw Tool objects", async () => {
    const logger = createLogger();
    const bridge = new McpToolBridge(logger);

    const spy = spyOnStartWith([
      { name: "do_thing", description: "Does a thing", inputSchema: { type: "object" } },
    ]);

    await bridge.connectAll([
      { name: "test", enabled: true, transport: "stdio", command: "test-server" },
    ]);

    const tools = bridge.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toBe("Does a thing");
    expect(tools[0].parameters).toBeDefined();

    await bridge.disconnectAll();
    spy.mockRestore();
  });

  it("tool names are namespaced with server name", async () => {
    const logger = createLogger();
    const bridge = new McpToolBridge(logger);

    const spy = spyOnStartWith([
      { name: "read_file", inputSchema: { type: "object" } },
      { name: "write_file", inputSchema: { type: "object" } },
    ]);

    await bridge.connectAll([
      { name: "myserver", enabled: true, transport: "stdio", command: "test-server" },
    ]);

    const tools = bridge.getTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("mcp_myserver_read_file");
    expect(tools[1].name).toBe("mcp_myserver_write_file");

    await bridge.disconnectAll();
    spy.mockRestore();
  });

  it("disconnectAll closes all clients", async () => {
    const logger = createLogger();
    const bridge = new McpToolBridge(logger);

    const spy = spyOnStartWith([]);

    await bridge.connectAll([
      { name: "server1", enabled: true, transport: "stdio", command: "test-server-1" },
      { name: "server2", enabled: true, transport: "stdio", command: "test-server-2" },
    ]);

    expect(bridge.connectedServers).toHaveLength(2);

    await bridge.disconnectAll();
    expect(bridge.connectedServers).toHaveLength(0);
    expect(bridge.getTools()).toHaveLength(0);

    spy.mockRestore();
  });

  it("skips disabled servers", async () => {
    const logger = createLogger();
    const bridge = new McpToolBridge(logger);

    await bridge.connectAll([
      { name: "disabled", enabled: false, transport: "stdio", command: "should-not-run" },
    ]);

    expect(bridge.connectedServers).toHaveLength(0);
    expect(spawnedProcesses).toHaveLength(0);
  });

  it("handles connection failures gracefully", async () => {
    const logger = createLogger();
    const bridge = new McpToolBridge(logger);

    vi.spyOn(StdioTransport.prototype, "start").mockImplementation(async () => {
      throw new Error("spawn failed");
    });

    await bridge.connectAll([
      { name: "bad-server", enabled: true, transport: "stdio", command: "nonexistent" },
    ]);

    expect(bridge.connectedServers).toHaveLength(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it("tool execute delegates to MCP client callTool", async () => {
    const logger = createLogger();
    const bridge = new McpToolBridge(logger);

    const spy = spyOnStartWith(
      [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }],
      (_name, args) => ({
        content: [{ type: "text", text: String(args.text) }],
      }),
    );

    await bridge.connectAll([
      { name: "exec", enabled: true, transport: "stdio", command: "test-server" },
    ]);

    const tools = bridge.getTools();
    expect(tools).toHaveLength(1);

    const ctx = { traceId: "trace-123", cwd: "/tmp", dataDir: "/tmp/data", logger };
    const result = await tools[0].execute({ text: "hello world" }, ctx);

    expect(result.content).toBe("hello world");
    expect(result.isError).toBeFalsy();

    await bridge.disconnectAll();
    spy.mockRestore();
  });
});
