import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPersistedUserTurn,
  formatVoiceTranscriptForModel,
  isEntrypointModule,
  parseModelSpec,
} from "../src/main.js";

describe("voice transcript contract", () => {
  it("labels successful speech as authoritative input and persists voice-only turns", () => {
    expect(formatVoiceTranscriptForModel("Check the server.")).toBe(
      "[Voice transcript (authoritative user speech): Check the server.]",
    );
    expect(buildPersistedUserTurn(undefined, ["Check the server."])).toContain(
      "authoritative user speech",
    );
    expect(buildPersistedUserTurn("A caption", ["Spoken detail"])).toBe(
      "A caption\n\n[Voice transcript (authoritative user speech): Spoken detail]",
    );
  });
});

describe("parseModelSpec", () => {
  it("rejects empty and incomplete model specs", () => {
    expect(() => parseModelSpec("", "ollama")).toThrow(/non-empty/);
    expect(() => parseModelSpec("ollama/", "ollama")).toThrow(/invalid model spec/);
    expect(() => parseModelSpec("/model", "ollama")).toThrow(/invalid model spec/);
  });

  it("binds explicit and bare model specs correctly", () => {
    expect(parseModelSpec("supergrok/grok-4.6", "ollama")).toEqual({
      provider: "supergrok",
      model: "grok-4.6",
    });
    expect(parseModelSpec("deepseek-v4-flash:cloud", "ollama")).toEqual({
      provider: "ollama",
      model: "deepseek-v4-flash:cloud",
    });
  });
});

describe("isEntrypointModule", () => {
  it("recognizes an entrypoint reached through a deployment symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "hairy-entrypoint-"));
    const real = join(dir, "main.js");
    const linked = join(dir, "linked-main.js");
    writeFileSync(real, "");
    symlinkSync(real, linked);

    expect(isEntrypointModule(pathToFileURL(real).href, linked)).toBe(true);
  });
});
