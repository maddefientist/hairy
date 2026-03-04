import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Tool } from "../types.js";

const identityEvolveInputSchema = z.object({
  section: z.string().min(1).max(120),
  content: z.string().min(1).max(20000),
  reason: z.string().min(1).max(1000),
});

const normalizeSection = (section: string): string => {
  const cleaned = section.replace(/^#+\s*/, "").trim();
  return cleaned.length > 0 ? cleaned : "Notes";
};

const upsertSection = (
  doc: string,
  section: string,
  content: string,
): { updated: string; existed: boolean } => {
  const heading = `## ${section}`;
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRegex = new RegExp(`(^|\\n)${escapedHeading}\\n([\\s\\S]*?)(?=\\n## |$)`, "m");

  if (sectionRegex.test(doc)) {
    const updated = doc.replace(sectionRegex, `$1${heading}\n${content.trim()}\n`);
    return { updated: updated.trimEnd().concat("\n"), existed: true };
  }

  const separator = doc.trimEnd().length === 0 ? "" : "\n\n";
  return {
    updated: `${doc.trimEnd()}${separator}${heading}\n${content.trim()}\n`,
    existed: false,
  };
};

const nowIso = (): string => new Date().toISOString();

export const createIdentityEvolveTool = (): Tool => ({
  name: "identity_evolve",
  description:
    "Update a section in identity.md and append a timestamped rationale to identity-changelog.md.",
  parameters: identityEvolveInputSchema,
  async execute(args, ctx) {
    const input = identityEvolveInputSchema.parse(args);
    const section = normalizeSection(input.section);

    const memoryDir = join(ctx.dataDir, "memory");
    const identityPath = join(memoryDir, "identity.md");
    const changelogPath = join(memoryDir, "identity-changelog.md");

    await mkdir(memoryDir, { recursive: true });

    let currentIdentity = "# Identity\n";
    try {
      currentIdentity = await readFile(identityPath, "utf8");
    } catch {
      // start from default heading
    }

    const { updated, existed } = upsertSection(currentIdentity, section, input.content);
    await writeFile(identityPath, updated, "utf8");

    let currentChangelog = "# Identity Changelog\n";
    try {
      currentChangelog = await readFile(changelogPath, "utf8");
    } catch {
      // start from default heading
    }

    const entry = [
      `## ${nowIso()}`,
      `- Section: ${section}`,
      `- Action: ${existed ? "updated" : "added"}`,
      `- Reason: ${input.reason.trim()}`,
    ].join("\n");

    const nextChangelog = `${currentChangelog.trimEnd()}\n\n${entry}\n`;
    await writeFile(changelogPath, nextChangelog, "utf8");

    return {
      content: `identity section '${section}' ${existed ? "updated" : "added"}`,
    };
  },
});
