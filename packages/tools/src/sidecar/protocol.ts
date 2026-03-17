import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { HairyClawLogger as Logger } from "@hairyclaw/observability";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

export class SidecarConnection {
  private id = 0;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly logger: Logger,
  ) {
    const lineReader = createInterface({ input: process.stdout });
    lineReader.on("line", (line) => {
      this.handleLine(line);
    });

    process.stderr.on("data", (chunk: Buffer) => {
      this.logger.warn({ line: chunk.toString("utf8") }, "sidecar stderr");
    });

    process.on("exit", () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timeout);
        entry.reject(new Error("sidecar process exited"));
      }
      this.pending.clear();
    });
  }

  async call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = ++this.id;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const payload = JSON.stringify(request);
    this.process.stdin.write(`${payload}\n`);

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar call timeout for ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  notify(method: string, params: unknown): void {
    const request = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.process.stdin.write(`${JSON.stringify(request)}\n`);
  }

  close(): void {
    this.process.stdin.end();
  }

  private handleLine(line: string): void {
    let payload: JsonRpcResponse;

    try {
      payload = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.logger.warn({ line }, "invalid sidecar json line");
      return;
    }

    const id = payload.id;
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(id);

    if (payload.error) {
      pending.reject(new Error(payload.error.message));
      return;
    }

    pending.resolve(payload.result);
  }
}
