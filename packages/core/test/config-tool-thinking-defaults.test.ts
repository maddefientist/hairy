import { existsSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("executor tool defaults use canonical hyphenated tool names", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    dir = undefined;
  });

  it("executor.tools defaults to web-search/web-fetch (not the legacy underscore spelling)", async () => {
    dir = mkdtempSync(join(tmpdir(), "hairy-config-"));
    writeFileSync(join(dir, "default.toml"), '[agent]\nname = "t"\n');

    const config = await loadConfig(dir);

    expect(config.executor.tools).toContain("web-search");
    expect(config.executor.tools).toContain("web-fetch");
    expect(config.executor.tools).not.toContain("web_search");
    expect(config.executor.tools).not.toContain("web_fetch");
  });

  it("accepts an explicitly configured legacy underscore tool name in TOML (canonicalization happens downstream)", async () => {
    dir = mkdtempSync(join(tmpdir(), "hairy-config-"));
    writeFileSync(
      join(dir, "default.toml"),
      '[agent]\nname = "t"\n\n[executor]\ntools = ["bash", "web_search"]\n',
    );

    const config = await loadConfig(dir);

    expect(config.executor.tools).toEqual(["bash", "web_search"]);
  });
});

describe("role thinking_level config", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    dir = undefined;
  });

  it("orchestrator.thinking_level is unset by default (no forced default)", async () => {
    dir = mkdtempSync(join(tmpdir(), "hairy-config-"));
    writeFileSync(join(dir, "default.toml"), '[agent]\nname = "t"\n');

    const config = await loadConfig(dir);

    expect(config.orchestrator.thinking_level).toBeUndefined();
    expect(config.executor.thinking_level).toBeUndefined();
  });

  it("parses an explicit off thinking_level for the brain role", async () => {
    dir = mkdtempSync(join(tmpdir(), "hairy-config-"));
    writeFileSync(
      join(dir, "default.toml"),
      '[agent]\nname = "t"\n\n[orchestrator]\nthinking_level = "off"\n',
    );

    const config = await loadConfig(dir);

    expect(config.orchestrator.thinking_level).toBe("off");
    expect(config.executor.thinking_level).toBeUndefined();
  });

  it("rejects an invalid thinking_level value", async () => {
    dir = mkdtempSync(join(tmpdir(), "hairy-config-"));
    writeFileSync(
      join(dir, "default.toml"),
      '[agent]\nname = "t"\n\n[orchestrator]\nthinking_level = "nonsense"\n',
    );

    await expect(loadConfig(dir)).rejects.toThrow();
  });
});
