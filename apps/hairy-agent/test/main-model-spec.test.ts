import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfiguredToolNames } from "@hairyclaw/tools";
import { describe, expect, it } from "vitest";
import {
  buildExecutorSystemPrompt,
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

describe("executor config tool names resolve to the registered web tools", () => {
  const REGISTERED = ["bash", "read", "write", "edit", "web-search", "web-fetch"];

  it("exposes the actual registered web-search/web-fetch tools from legacy web_search/web_fetch config", () => {
    const resolved = resolveConfiguredToolNames(
      ["bash", "read", "write", "edit", "web_search", "web_fetch"],
      REGISTERED,
    );
    expect(resolved).toEqual(["bash", "read", "write", "edit", "web-search", "web-fetch"]);
  });

  it("fails clearly (before startup) for a truly unknown configured executor tool", () => {
    expect(() => resolveConfiguredToolNames(["bash", "totally_unknown"], REGISTERED)).toThrow(
      /Unknown configured tool name/,
    );
  });
});

describe("buildExecutorSystemPrompt", () => {
  it("directs the executor to prefer web-search/web-fetch over bash curl/wget for network research", () => {
    const prompt = buildExecutorSystemPrompt([
      { name: "bash", description: "run shell", parameters: {} },
      { name: "web-search", description: "search the web", parameters: {} },
      { name: "web-fetch", description: "fetch a URL", parameters: {} },
    ]);

    expect(prompt).toContain("web-search / web-fetch tools directly");
    expect(prompt).toContain("Do NOT use bash with curl, wget");
  });

  it("instructs the executor not to retry a call that was denied/errored twice in a row", () => {
    const prompt = buildExecutorSystemPrompt([]);
    expect(prompt).toContain("do not retry it a third time");
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
