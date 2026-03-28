import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

interface StdioTransportConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class StdioTransport {
  private process: ChildProcess | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";

  constructor(private readonly config: StdioTransportConfig) {}

  async start(): Promise<void> {
    if (this.process) {
      throw new Error("transport already started");
    }

    const childProcess = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
    });

    this.process = childProcess;

    const { stdout, stderr } = childProcess;
    if (!stdout || !stderr) {
      throw new Error("failed to open stdio pipes");
    }

    const rl = createInterface({ input: stdout });
    rl.on("line", (line: string) => {
      this.handleLine(line);
    });

    stderr.on("data", () => {
      // stderr data is intentionally ignored — callers handle logging
    });

    childProcess.on("exit", () => {
      for (const entry of Array.from(this.pending.values())) {
        clearTimeout(entry.timer);
        entry.reject(new Error("MCP server process exited"));
      }
      this.pending.clear();
      this.process = null;
    });

    childProcess.on("error", (err: Error) => {
      for (const entry of Array.from(this.pending.values())) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      this.pending.clear();
      this.process = null;
    });
  }

  async request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.process?.stdin) {
      throw new Error("transport not started");
    }

    const id = ++this.nextId;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    this.process.stdin.write(`${payload}\n`);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout for ${method} after ${String(timeoutMs)}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.process?.stdin) {
      throw new Error("transport not started");
    }

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });

    this.process.stdin.write(`${payload}\n`);
  }

  async close(): Promise<void> {
    if (!this.process) {
      return;
    }

    for (const entry of Array.from(this.pending.values())) {
      clearTimeout(entry.timer);
      entry.reject(new Error("transport closed"));
    }
    this.pending.clear();

    this.process.stdin?.end();
    this.process.kill();
    this.process = null;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  private handleLine(line: string): void {
    let payload: {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };

    try {
      payload = JSON.parse(line) as typeof payload;
    } catch {
      return;
    }

    if (payload.id === undefined) {
      // Notification from server, ignore
      return;
    }

    const pending = this.pending.get(payload.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(payload.id);

    if (payload.error) {
      pending.reject(new Error(payload.error.message));
      return;
    }

    pending.resolve(payload.result);
  }
}
