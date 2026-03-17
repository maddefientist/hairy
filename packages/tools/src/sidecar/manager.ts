import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HairyClawLogger as Logger } from "@hairyclaw/observability";
import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Tool } from "../types.js";
import { SidecarConnection } from "./protocol.js";
import type { SidecarManifest } from "./types.js";

interface SidecarManagerOptions {
  logger: Logger;
  registry: ToolRegistry;
  autoBuild?: boolean;
  healthIntervalMs?: number;
}

interface SidecarProcess {
  manifest: SidecarManifest;
  connection: SidecarConnection;
  process: ReturnType<typeof spawn>;
  healthTimer?: NodeJS.Timeout;
}

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  binary: z.string(),
  build_cmd: z.string().optional(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      parameters: z.record(z.unknown()),
    }),
  ),
  health_check: z
    .object({
      method: z.string(),
      interval_ms: z.number().int().positive(),
    })
    .optional(),
  resource_limits: z
    .object({
      max_memory_mb: z.number().int().positive(),
      timeout_ms: z.number().int().positive(),
    })
    .optional(),
});

export class SidecarManager {
  private readonly sidecars = new Map<string, SidecarProcess>();

  constructor(private readonly opts: SidecarManagerOptions) {}

  async loadAll(sidecarsDir: string): Promise<void> {
    const candidateDirs = ["example-rust", "example-go", "browser"];
    for (const name of candidateDirs) {
      const dir = join(sidecarsDir, name);
      const manifestPath = join(dir, "manifest.json");

      try {
        const raw = await readFile(manifestPath, "utf8");
        const manifest = manifestSchema.parse(JSON.parse(raw)) as SidecarManifest;
        await this.start(manifest, dir);
      } catch (error: unknown) {
        this.opts.logger.warn({ err: error, sidecarDir: dir }, "failed to load sidecar; skipping");
      }
    }
  }

  async start(manifest: SidecarManifest, manifestDir: string): Promise<void> {
    const binaryPath = resolve(manifestDir, manifest.binary);

    if (!(await this.exists(binaryPath))) {
      if (!this.opts.autoBuild || !manifest.build_cmd) {
        this.opts.logger.warn(
          { sidecar: manifest.name },
          "sidecar binary missing and autobuild disabled",
        );
        return;
      }

      await this.runBuild(manifest.build_cmd, manifestDir);
    }

    const processHandle = spawn(binaryPath, [], {
      cwd: manifestDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const connection = new SidecarConnection(
      processHandle as unknown as import("node:child_process").ChildProcessWithoutNullStreams,
      this.opts.logger.child({ sidecar: manifest.name }),
    );

    this.sidecars.set(manifest.name, {
      manifest,
      connection,
      process: processHandle,
    });

    for (const definition of manifest.tools) {
      const sidecarTool: Tool = {
        name: definition.name,
        description: definition.description,
        parameters: z.record(z.unknown()),
        timeout_ms: manifest.resource_limits?.timeout_ms,
        execute: async (args) => {
          const result = await connection.call(
            definition.name,
            args,
            manifest.resource_limits?.timeout_ms,
          );
          return {
            content: typeof result === "string" ? result : JSON.stringify(result),
          };
        },
      };

      this.opts.registry.register(sidecarTool);
    }

    if (manifest.health_check) {
      const timer = setInterval(() => {
        void connection
          .call(manifest.health_check?.method ?? "health", {}, 5_000)
          .catch((error: unknown) => {
            this.opts.logger.error(
              { err: error, sidecar: manifest.name },
              "sidecar health check failed",
            );
          });
      }, manifest.health_check.interval_ms);

      const entry = this.sidecars.get(manifest.name);
      if (entry) {
        entry.healthTimer = timer;
      }
    }
  }

  async stop(name: string): Promise<void> {
    const entry = this.sidecars.get(name);
    if (!entry) {
      return;
    }

    if (entry.healthTimer) {
      clearInterval(entry.healthTimer);
    }

    entry.connection.notify("shutdown", {});
    entry.connection.close();
    entry.process.kill();
    this.sidecars.delete(name);
  }

  async stopAll(): Promise<void> {
    for (const name of Array.from(this.sidecars.keys())) {
      await this.stop(name);
    }
  }

  health(): Array<{ name: string; running: boolean }> {
    return Array.from(this.sidecars.entries()).map(([name, proc]) => ({
      name,
      running: !proc.process.killed,
    }));
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async runBuild(command: string, cwd: string): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const build = spawn("sh", ["-lc", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      build.on("exit", (code) => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(`sidecar build failed with code ${String(code)}`));
      });
    });
  }
}
