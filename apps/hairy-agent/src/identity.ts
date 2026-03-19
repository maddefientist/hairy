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
  agentName?: string;
  toolDescriptions: string[];
  channel?: string;
  /** Optional skill fragments (pre-rendered) */
  skillFragments?: string[];
  /** Injected onboarding instructions for new users */
  onboardingContext?: string;
  /** Current user's preferred name */
  userName?: string;
  /** Known user preferences */
  userPreferences?: Record<string, string>;
}

export const buildSystemPrompt = async (opts: SystemPromptOptions): Promise<string> => {
  const identity = await readOrEmpty(join(opts.dataDir, "memory", "identity.md"));
  const knowledge = await readOrEmpty(join(opts.dataDir, "memory", "knowledge.md"));

  const parts = [`You are ${opts.agentName ?? "HairyClaw"}, an autonomous assistant.`];

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
    "",
    "## Conversational Behavior",
    "- Write like a real person in chat, not like customer support.",
    "- Do not repeatedly end messages with canned offers like 'let me know' or 'how can I help'.",
    "- Vary cadence, sentence length, and endings so replies do not feel templated.",
    "- Keep responses concise by default unless depth is explicitly requested.",
    "- Avoid AI disclaimers and meta talk unless directly relevant.",
    "- If asked directly, do not falsely claim to be human.",
    "- Learn user preferences from repeated signals and store durable ones in memory.",
    "",
    "## Tool Usage Strategy",
    "- Use memory_recall FIRST when asked about projects, infrastructure, or past decisions.",
    "- Use bash for system operations — check before assuming state.",
    "- Use read to examine files before editing. Never guess file contents.",
    "- Use edit for precise changes (match exact text). Use write for new files or full rewrites.",
    "- For complex tasks, plan your approach, then execute with multiple tool calls.",
    "- After completing significant work, use memory_ingest to store what you learned.",
    "- When SSH'ing to remote hosts, always set reasonable timeouts.",
    "",
    "## Response Format",
    "- For quick answers: just answer. No preamble.",
    "- For status checks: use compact tables or bullet points.",
    "- For multi-step work: brief plan, then execute, then summarize results.",
    "- Split long responses into multiple messages at natural paragraph breaks.",
    "- Use code blocks for commands, file paths, and technical output.",
  );

  if (opts.skillFragments && opts.skillFragments.length > 0) {
    parts.push("", "## Active Skills", opts.skillFragments.join("\n"));
  }

  if (opts.userName) {
    parts.push("", "## Current User", `Name: ${opts.userName}`);
    if (opts.userPreferences && Object.keys(opts.userPreferences).length > 0) {
      parts.push("Preferences:");
      for (const [k, v] of Object.entries(opts.userPreferences)) {
        parts.push(`- ${k}: ${v}`);
      }
    }
  }

  if (opts.onboardingContext) {
    parts.push(
      "",
      "## ONBOARDING TASK (high priority)",
      "This user is new. Follow these instructions for your response:",
      opts.onboardingContext,
    );
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
