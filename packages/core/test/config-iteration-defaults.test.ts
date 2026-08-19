import { existsSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CHILD_MAX_ITERATIONS, PRIMARY_MAX_ITERATIONS } from "../src/iteration-limits.js";

describe("config iteration-limit defaults (single source of truth)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    dir = undefined;
  });

  it("agent.max_iterations_per_run defaults to PRIMARY_MAX_ITERATIONS (35) when unset", async () => {
    dir = mkdtempSync(join(tmpdir(), "hairy-config-"));
    writeFileSync(join(dir, "default.toml"), '[agent]\nname = "t"\n');

    const config = await loadConfig(dir);

    expect(config.agent.max_iterations_per_run).toBe(35);
    expect(config.agent.max_iterations_per_run).toBe(PRIMARY_MAX_ITERATIONS);
  });

  it("executor.max_iterations defaults to CHILD_MAX_ITERATIONS (15) when unset", async () => {
    dir = mkdtempSync(join(tmpdir(), "hairy-config-"));
    writeFileSync(join(dir, "default.toml"), '[agent]\nname = "t"\n');

    const config = await loadConfig(dir);

    expect(config.executor.max_iterations).toBe(15);
    expect(config.executor.max_iterations).toBe(CHILD_MAX_ITERATIONS);
  });
});
