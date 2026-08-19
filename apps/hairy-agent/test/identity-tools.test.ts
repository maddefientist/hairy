import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/identity.js";

describe("buildSystemPrompt tool guidance", () => {
  it("teaches a controller to delegate without advertising hidden execution tools", async () => {
    const prompt = await buildSystemPrompt({
      dataDir: mkdtempSync(join(tmpdir(), "hairy-identity-")),
      toolDescriptions: [
        "- memory_recall: recall",
        "- memory_ingest: store",
        "- delegate: execute",
      ],
    });

    expect(prompt).toContain("Delegate coding, system design, debugging");
    expect(prompt).not.toContain("Use bash for system operations");
    expect(prompt).not.toContain("Use read to examine files");
    expect(prompt).toContain("Voice transcript (authoritative user speech)");
    expect(prompt).toContain("the voice note was transcribed");
  });

  it("keeps execution guidance when those tools are actually exposed", async () => {
    const prompt = await buildSystemPrompt({
      dataDir: mkdtempSync(join(tmpdir(), "hairy-identity-")),
      toolDescriptions: ["- bash: shell", "- read: files", "- edit: patch", "- write: create"],
    });

    expect(prompt).toContain("Use bash for system operations");
    expect(prompt).toContain("Use read to examine files");
  });
});
