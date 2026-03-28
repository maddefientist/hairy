/**
 * Core sandbox abstraction types.
 *
 * SandboxProvider manages sandbox lifecycle (acquire/release).
 * Sandbox provides isolated execution environment with virtual path mapping.
 */

export interface SandboxProvider {
  readonly name: string;
  acquire(threadId: string): Promise<Sandbox>;
  get(sandboxId: string): Sandbox | undefined;
  release(sandboxId: string): Promise<void>;
}

export interface Sandbox {
  readonly id: string;
  readonly threadId: string;
  executeCommand(command: string, timeoutMs?: number): Promise<SandboxExecResult>;
  readFile(virtualPath: string): Promise<string>;
  writeFile(virtualPath: string, content: string, append?: boolean): Promise<void>;
  listDir(virtualPath: string, maxDepth?: number): Promise<string[]>;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PathMapping {
  /** Virtual path prefix visible to the agent, e.g. "/workspace" */
  virtual: string;
  /** Physical path on disk, e.g. "/data/threads/abc123/workspace" */
  physical: string;
}
