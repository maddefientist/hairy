import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { HairyClawLogger } from "@hairyclaw/observability";
import { PathMapper } from "./path-mapper.js";
import type { PathMapping, Sandbox, SandboxExecResult, SandboxProvider } from "./types.js";

const execAsync = promisify(exec);

export interface LocalSandboxOptions {
  baseDir: string;
  allowedCommands?: string[];
  blockedCommands?: string[];
  maxOutputBytes?: number;
  commandTimeoutMs?: number;
  logger?: HairyClawLogger;
}

/** Shell metacharacters that enable command chaining / injection. */
const SHELL_OPERATORS = /[;|&`$(){}><\n\\]/;

const VIRTUAL_DIRS = ["workspace", "uploads", "outputs"] as const;

export class LocalSandboxProvider implements SandboxProvider {
  readonly name = "local";
  private readonly sandboxes = new Map<string, LocalSandbox>();
  private readonly options: LocalSandboxOptions;
  private readonly logger: HairyClawLogger | undefined;

  constructor(options: LocalSandboxOptions) {
    this.options = {
      ...options,
      baseDir: resolve(options.baseDir),
    };
    this.logger = options.logger;
  }

  async acquire(threadId: string): Promise<Sandbox> {
    const id = randomUUID();
    const threadDir = join(this.options.baseDir, threadId);

    // Create per-thread directories
    const mappings: PathMapping[] = [];
    for (const dir of VIRTUAL_DIRS) {
      const physicalDir = join(threadDir, dir);
      await mkdir(physicalDir, { recursive: true });
      mappings.push({
        virtual: `/${dir}`,
        physical: physicalDir,
      });
    }

    const pathMapper = new PathMapper(mappings);
    const sandbox = new LocalSandbox(id, threadId, pathMapper, this.options);
    this.sandboxes.set(id, sandbox);

    this.logger?.info({ sandboxId: id, threadId }, "sandbox acquired");
    return sandbox;
  }

  get(sandboxId: string): Sandbox | undefined {
    return this.sandboxes.get(sandboxId);
  }

  async release(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      return;
    }
    // Remove from active map but keep files on disk for debugging
    this.sandboxes.delete(sandboxId);
    this.logger?.info({ sandboxId }, "sandbox released");
  }
}

class LocalSandbox implements Sandbox {
  readonly id: string;
  readonly threadId: string;
  private readonly pathMapper: PathMapper;
  private readonly options: LocalSandboxOptions;

  constructor(id: string, threadId: string, pathMapper: PathMapper, options: LocalSandboxOptions) {
    this.id = id;
    this.threadId = threadId;
    this.pathMapper = pathMapper;
    this.options = options;
  }

  async executeCommand(command: string, timeoutMs?: number): Promise<SandboxExecResult> {
    // Block shell operators to prevent injection
    if (SHELL_OPERATORS.test(command)) {
      return {
        stdout: "",
        stderr: "command rejected: shell operators (;|&`$(){}><) are not allowed in sandbox",
        exitCode: 1,
      };
    }

    // Check allow/block lists
    const firstToken = command.trim().split(/\s+/)[0] ?? "";

    if (this.options.allowedCommands && !this.options.allowedCommands.includes(firstToken)) {
      return {
        stdout: "",
        stderr: `command '${firstToken}' is not in the allowed commands list`,
        exitCode: 1,
      };
    }

    if (this.options.blockedCommands?.includes(firstToken)) {
      return {
        stdout: "",
        stderr: `command '${firstToken}' is blocked`,
        exitCode: 1,
      };
    }

    // Execute in the workspace directory
    const cwd = this.pathMapper.toPhysical("/workspace");
    const timeout = timeoutMs ?? this.options.commandTimeoutMs ?? 30_000;
    const maxBuffer = this.options.maxOutputBytes ?? 1_048_576;

    try {
      const result = await execAsync(command, { cwd, timeout, maxBuffer });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
      };
    } catch (error: unknown) {
      if (isExecError(error)) {
        return {
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? error.message,
          exitCode: error.code ?? 1,
        };
      }
      const message = error instanceof Error ? error.message : "command execution failed";
      return {
        stdout: "",
        stderr: message,
        exitCode: 1,
      };
    }
  }

  async readFile(virtualPath: string): Promise<string> {
    const physical = this.pathMapper.toPhysical(virtualPath);
    return readFile(physical, "utf8");
  }

  async writeFile(virtualPath: string, content: string, append?: boolean): Promise<void> {
    const physical = this.pathMapper.toPhysical(virtualPath);
    // Ensure parent directory exists
    const parentDir = physical.substring(0, physical.lastIndexOf("/"));
    if (parentDir) {
      await mkdir(parentDir, { recursive: true });
    }

    if (append) {
      await appendFile(physical, content, "utf8");
    } else {
      await writeFile(physical, content, "utf8");
    }
  }

  async listDir(virtualPath: string, maxDepth?: number): Promise<string[]> {
    const physical = this.pathMapper.toPhysical(virtualPath);
    return this.walkDir(physical, virtualPath, maxDepth ?? 3, 0);
  }

  private async walkDir(
    physicalDir: string,
    virtualDir: string,
    maxDepth: number,
    currentDepth: number,
  ): Promise<string[]> {
    if (currentDepth >= maxDepth) {
      return [];
    }

    const entries = await readdir(physicalDir, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      const virtualEntry = `${virtualDir}/${entry.name}`;
      results.push(virtualEntry);

      if (entry.isDirectory()) {
        const subEntries = await this.walkDir(
          join(physicalDir, entry.name),
          virtualEntry,
          maxDepth,
          currentDepth + 1,
        );
        results.push(...subEntries);
      }
    }

    return results;
  }
}

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number;
}

function isExecError(error: unknown): error is ExecError {
  return error instanceof Error && ("stdout" in error || "stderr" in error || "code" in error);
}
