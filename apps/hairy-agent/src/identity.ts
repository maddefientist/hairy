import { readFile } from "node:fs/promises";
import { join } from "node:path";

const readOrEmpty = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
};

export interface SystemPromptOptions {
  dataDir: string;
  toolDescriptions: string[];
  channel?: string;
  /** Optional skill fragments (pre-rendered) */
  skillFragments?: string[];
}

export const buildSystemPrompt = async (opts: SystemPromptOptions): Promise<string> => {
  const identity = await readOrEmpty(join(opts.dataDir, "memory", "identity.md"));
  const knowledge = await readOrEmpty(join(opts.dataDir, "memory", "knowledge.md"));

  const parts = ["You are Hairy, an autonomous assistant."];

  if (opts.channel) {
    parts.push(`Current channel: ${opts.channel}`);
  }

  parts.push(
    "",
    "## Identity",
    identity || "No identity file found.",
    "",
    "## Knowledge",
    knowledge || "No knowledge file found.",
  );

  if (opts.skillFragments && opts.skillFragments.length > 0) {
    parts.push("", "## Active Skills", opts.skillFragments.join("\n"));
  }

  parts.push(
    "",
    "## Available Tools",
    "You can call these tools to accomplish tasks:",
    opts.toolDescriptions.join("\n"),
    "",
    "When you need to perform actions (read files, run commands, edit files, search the web), use the appropriate tool.",
    "You may call multiple tools in sequence to complete complex tasks.",
  );

  return parts.join("\n");
};
