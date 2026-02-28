export interface SidecarToolManifest {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SidecarHealthCheck {
  method: string;
  interval_ms: number;
}

export interface SidecarResourceLimits {
  max_memory_mb: number;
  timeout_ms: number;
}

export interface SidecarManifest {
  name: string;
  version: string;
  binary: string;
  build_cmd?: string;
  tools: SidecarToolManifest[];
  health_check?: SidecarHealthCheck;
  resource_limits?: SidecarResourceLimits;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
