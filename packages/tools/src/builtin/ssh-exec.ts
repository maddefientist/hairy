import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Tool } from "../types.js";

const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  host: z.string().min(1).describe("Hostname or IP address of the target machine."),
  command: z.string().min(1).describe("Shell command to run on the remote host."),
  user: z.string().optional().describe("SSH user (defaults to current user)."),
  port: z.number().int().min(1).max(65535).default(22).optional().describe("SSH port (default 22)."),
  identityFile: z.string().optional().describe("Path to SSH private key file. Defaults to ~/.ssh/id_rsa or agent config."),
  timeoutMs: z.number().int().positive().default(30_000).optional(),
});

export interface SshExecOptions {
  /** Allowlist of hosts the agent may SSH to. If empty, all hosts are permitted. */
  allowedHosts?: string[];
}

export const createSshExecTool = (opts: SshExecOptions = {}): Tool => ({
  name: "ssh_exec",
  description:
    "Run a shell command on a remote machine over SSH. " +
    "Use for inspecting or managing LAN devices, servers, or VMs. " +
    "Returns stdout and stderr from the remote command.",
  parameters: inputSchema,
  timeout_ms: 60_000,
  async execute(args, ctx) {
    const input = inputSchema.parse(args);

    if (opts.allowedHosts && opts.allowedHosts.length > 0) {
      const allowed = opts.allowedHosts.some(
        (h) => h === input.host || input.host.endsWith(`.${h}`),
      );
      if (!allowed) {
        return {
          content: `ssh_exec: host '${input.host}' is not in the allowed hosts list`,
          isError: true,
        };
      }
    }

    const sshArgs: string[] = [
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-p", String(input.port ?? 22),
    ];

    if (input.identityFile) {
      sshArgs.push("-i", input.identityFile);
    }

    if (input.user) {
      sshArgs.push(`${input.user}@${input.host}`);
    } else {
      sshArgs.push(input.host);
    }

    sshArgs.push(input.command);

    ctx.logger.info({ host: input.host, command: input.command }, "ssh_exec");

    try {
      const { stdout, stderr } = await execFileAsync("ssh", sshArgs, {
        timeout: input.timeoutMs ?? 30_000,
      });

      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      return { content: output || "(no output)" };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `ssh_exec failed: ${msg}`, isError: true };
    }
  },
});
