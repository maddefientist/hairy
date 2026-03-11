export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export const success = (id: string | number | null, result: unknown): JsonRpcSuccess => ({
  jsonrpc: "2.0",
  id,
  result,
});

export const failure = (
  id: string | number | null,
  message: string,
  code = -32000,
  data?: unknown,
): JsonRpcFailure => ({
  jsonrpc: "2.0",
  id,
  error: {
    code,
    message,
    ...(data !== undefined ? { data } : {}),
  },
});
