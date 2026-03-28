export interface McpServerConfig {
  name: string;
  enabled: boolean;
  transport: "stdio"; // future: "sse" | "http"
  command: string; // e.g., "npx"
  args?: string[]; // e.g., ["-y", "@modelcontextprotocol/server-filesystem"]
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
