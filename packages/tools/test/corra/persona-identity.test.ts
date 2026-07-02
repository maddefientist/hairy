import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CORRA_IDENTITY_MARKER, ensureCorraIdentity } from "../../src/corra/persona-identity.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("ensureCorraIdentity", () => {
  it("seeds the persona at {dataDir}/memory/identity.md when missing and reports loaded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-id-"));
    const loaded = await ensureCorraIdentity(dir, logger);
    expect(loaded).toBe(true);
    const written = await readFile(join(dir, "memory", "identity.md"), "utf8");
    expect(written).toContain(CORRA_IDENTITY_MARKER);
  });

  it("leaves an existing Corra identity untouched and reports loaded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-id-"));
    await mkdir(join(dir, "memory"), { recursive: true });
    const custom = `# ${CORRA_IDENTITY_MARKER}\n\nedited by identity_evolve`;
    await writeFile(join(dir, "memory", "identity.md"), custom, "utf8");
    const loaded = await ensureCorraIdentity(dir, logger);
    expect(loaded).toBe(true);
    expect(await readFile(join(dir, "memory", "identity.md"), "utf8")).toBe(custom);
  });

  it("does not clobber a non-Corra identity but reports NOT loaded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corra-id-"));
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeFile(join(dir, "memory", "identity.md"), "# Some Other Agent\n", "utf8");
    const loaded = await ensureCorraIdentity(dir, logger);
    expect(loaded).toBe(false);
    expect(await readFile(join(dir, "memory", "identity.md"), "utf8")).toBe("# Some Other Agent\n");
  });
});
