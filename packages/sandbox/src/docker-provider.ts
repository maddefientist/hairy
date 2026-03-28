import type { Sandbox, SandboxProvider } from "./types.js";

/**
 * Stub Docker sandbox provider.
 * Placeholder for future Docker-based sandbox isolation.
 */
export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker";

  async acquire(_threadId: string): Promise<Sandbox> {
    throw new Error("Docker sandbox not yet implemented");
  }

  get(_sandboxId: string): Sandbox | undefined {
    return undefined;
  }

  async release(_sandboxId: string): Promise<void> {
    throw new Error("Docker sandbox not yet implemented");
  }
}
